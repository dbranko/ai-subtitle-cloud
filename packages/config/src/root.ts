import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';

const ROOT_MARKER = 'pnpm-workspace.yaml';

/**
 * Locate the repository root so relative paths (data directory, .env) resolve
 * identically no matter which app or working directory a process starts from.
 * `ASC_ROOT` overrides detection (used in Docker and tests).
 */
export function findWorkspaceRoot(startDir: string = process.cwd(), env = process.env): string {
  if (env.ASC_ROOT) return resolve(env.ASC_ROOT);
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, ROOT_MARKER))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

/**
 * Read `<root>/.env` if present. Real environment variables always win over
 * the file, so Docker / shell configuration is never silently overridden.
 */
export function readEnvFile(rootDir: string): Record<string, string> {
  const file = join(rootDir, '.env');
  if (!existsSync(file)) return {};
  const parsed = parseEnv(readFileSync(file, 'utf8'));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
