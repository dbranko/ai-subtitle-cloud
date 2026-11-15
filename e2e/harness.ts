import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = resolve(import.meta.dirname, '..');
export const API_PORT = 7411;
export const WORKER_PORT = 7412;
export const ADDON_PORT = 7410;
export const ADDON_URL = `http://127.0.0.1:${ADDON_PORT}`;
export const BASE_URL = `http://127.0.0.1:${API_PORT}`;
export const LONG_SUBTITLE = join(ROOT, 'fixtures', 'subtitles', 'long-episode.srt');

export interface Job {
  id: string;
  state: string;
  attempt: number;
  percentage: number;
  completedSegments: number;
  totalSegments: number;
}

/**
 * A complete, isolated installation: its own data directory and database, a
 * real API process and a real worker process, with the mock AI translator.
 * Processes can be stopped (gracefully or with SIGKILL) and started again.
 */
export class Stack {
  readonly dataDir = mkdtempSync(join(tmpdir(), 'asc-e2e-'));
  private api: ChildProcess | undefined;
  private worker: ChildProcess | undefined;
  private addon: ChildProcess | undefined;
  private readonly env: NodeJS.ProcessEnv;

  constructor(overrides: Record<string, string> = {}) {
    this.env = {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      DATA_DIR: this.dataDir,
      DATABASE_URL: `file:${join(this.dataDir, 'db', 'asc.sqlite')}`,
      API_HOST: '127.0.0.1',
      API_PORT: String(API_PORT),
      WORKER_HEALTH_PORT: String(WORKER_PORT),
      ADDON_HOST: '127.0.0.1',
      ADDON_PORT: String(ADDON_PORT),
      MOCK_AI: 'true',
      // ~7 segments of ~0.7 s: long enough to observe, short enough to test.
      MOCK_AI_DELAY_MS: '700',
      AI_MAX_SEGMENT_ENTRIES: '20',
      WORKER_POLL_INTERVAL_MS: '200',
      WORKER_LEASE_MS: '2000',
      AUTH_TOKEN: '',
      ...overrides,
    };
  }

  async start(): Promise<void> {
    execFileSync('pnpm', ['db:migrate'], {
      cwd: ROOT,
      env: this.env,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });
    await this.startApi();
    await this.startWorker();
  }

  private launch(script: string): ChildProcess {
    const child = spawn(process.execPath, [join(ROOT, script)], {
      cwd: ROOT,
      env: this.env,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    return child;
  }

  async startApi(): Promise<void> {
    this.api = this.launch('apps/api/dist/main.js');
    await waitForHttp(`${BASE_URL}/health`);
  }

  async startWorker(): Promise<void> {
    this.worker = this.launch('apps/worker/dist/main.js');
    await waitForHttp(`http://127.0.0.1:${WORKER_PORT}/health`);
  }

  /** The Stremio add-on process (only the tests that need it start it). */
  async startAddon(): Promise<void> {
    this.addon = this.launch('apps/addon/dist/main.js');
    await waitForHttp(`${ADDON_URL}/health`);
  }

  /** Stop a process the hard way (SIGKILL): no cleanup code runs, exactly like a crash. */
  async killWorker(): Promise<void> {
    await terminate(this.worker, 'SIGKILL');
    this.worker = undefined;
  }

  async killAddon(): Promise<void> {
    await terminate(this.addon, 'SIGKILL');
    this.addon = undefined;
  }

  /** True while the add-on process is running (it has not crashed). */
  addonAlive(): boolean {
    return (
      this.addon !== undefined && this.addon.exitCode === null && this.addon.signalCode === null
    );
  }

  async killApi(): Promise<void> {
    await terminate(this.api, 'SIGKILL');
    this.api = undefined;
  }

  async stop(): Promise<void> {
    await Promise.all([
      terminate(this.api, 'SIGKILL'),
      terminate(this.worker, 'SIGKILL'),
      terminate(this.addon, 'SIGKILL'),
    ]);
    rmSync(this.dataDir, { recursive: true, force: true, maxRetries: 5 });
  }

  async job(id: string): Promise<Job> {
    const res = await fetch(`${BASE_URL}/api/v1/jobs/${id}`);
    return ((await res.json()) as { job: Job }).job;
  }

  async jobs(): Promise<Job[]> {
    const res = await fetch(`${BASE_URL}/api/v1/jobs`);
    return ((await res.json()) as { jobs: Job[] }).jobs;
  }

  async waitForJob(id: string, done: (job: Job) => boolean, timeoutMs = 60_000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = await this.job(id).catch(() => undefined);
      if (job && done(job)) return job;
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for job ${id} (${job?.state ?? 'unreachable'})`);
      await sleep(100);
    }
  }
}

async function terminate(child: ChildProcess | undefined, signal: NodeJS.Signals): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill(signal);
  await exited;
}

async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`Service did not start: ${url}`);
    await sleep(100);
  }
}
