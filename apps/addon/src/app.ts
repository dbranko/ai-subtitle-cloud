import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import middie from '@fastify/middie';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as StremioSdk from 'stremio-addon-sdk';
import type { AppConfig } from '@asc/config';
import { pingDatabase, type Database } from '@asc/database';
import { outputPath } from '@asc/jobs';
import { buildLiveness, buildReadiness, loggerOptions, type ReadinessCheck } from '@asc/shared';
import { findLanguage } from '@asc/translation-engine';
import { buildManifest, createSubtitlesHandler, stremioTargets } from './stremio.js';

// The SDK is a CommonJS package: load it with require so it works in a plain Node
// process as well as under the test runner.
const { addonBuilder, getRouter } = createRequire(import.meta.url)(
  'stremio-addon-sdk',
) as typeof StremioSdk;

export interface AddonDeps {
  config: AppConfig;
  db: Database;
  startedAt?: Date;
}

/** Health endpoints are polled constantly; only log them when something is wrong. */
const QUIET = { logLevel: 'warn' } as const;

/** Translated files are named `<job id>.<language>.srt`; nothing else is ever served. */
const FILE_NAME = /^[A-Za-z0-9-]{1,64}\.[A-Za-z-]{2,12}\.srt$/;

type RawRequest = IncomingMessage & { ascAuthorized?: boolean };

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Path prefix that carries the access token, when one is configured. */
export function tokenPrefix(config: AppConfig): string {
  return config.security.authToken ? `/${encodeURIComponent(config.security.authToken)}` : '';
}

/** The address to paste into Stremio. */
export function manifestUrl(config: AppConfig): string {
  return `${config.stremio.publicUrl}${tokenPrefix(config)}/manifest.json`;
}

/**
 * The Stremio add-on server, built on the official Stremio Add-on SDK.
 *
 *  - `/manifest.json` and `/subtitles/...` are served by the SDK's router;
 *  - `/files/<name>.srt` serves finished translations (real SRT files only);
 *  - `/` and `/configure` point the owner to the dashboard, the progress page.
 *
 * When AUTH_TOKEN is configured the add-on is reachable only under
 * `/<token>/...`, so the address installed in Stremio is itself the secret.
 */
export async function buildAddonApp(deps: AddonDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const startedAt = deps.startedAt ?? new Date();
  const token = config.security.authToken;

  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : loggerOptions('addon', config.logLevel),
    // `/<token>/manifest.json` → `/manifest.json`, remembering that the token was presented.
    rewriteUrl(req: RawRequest) {
      const url = req.url ?? '/';
      if (!token) return url;
      const match = /^\/([^/?]+)(\/.*|\?.*|$)/.exec(url);
      if (match?.[1] && sameToken(decodeURIComponent(match[1]), token)) {
        req.ascAuthorized = true;
        return match[2] === '' || match[2]?.startsWith('?')
          ? `/${match[2] ?? ''}`
          : (match[2] ?? '/');
      }
      return url;
    },
  });

  // Stremio's own interface is a web page served from the internet that calls this add-on on
  // 127.0.0.1. Chromium-based shells ask permission for such "private network" requests in a
  // preflight; without this header they refuse to load the manifest.
  app.addHook('onRequest', (_req, reply, done) => {
    reply.raw.setHeader('access-control-allow-private-network', 'true');
    done();
  });

  // Authentication. Registered before the SDK router so that it runs first.
  app.addHook('onRequest', async (req, reply) => {
    if (!token || req.url.startsWith('/health')) return;
    if (!(req.raw as RawRequest).ascAuthorized) {
      await reply.code(401).send({ err: 'unauthorized' });
    }
  });

  app.get('/health', QUIET, () => buildLiveness('addon', startedAt));
  app.get('/health/ready', QUIET, async (_req, reply) => {
    const checks: Record<string, ReadinessCheck> = {};
    try {
      await pingDatabase(db);
      checks.database = { status: 'ok' };
    } catch {
      checks.database = { status: 'fail', detail: 'database is not reachable' };
    }
    const report = buildReadiness('addon', checks);
    return reply.code(report.status === 'fail' ? 503 : 200).send(report);
  });

  // --- Stremio protocol, through the official SDK ---------------------------
  const fileUrl = (file: string) =>
    `${config.stremio.publicUrl}${tokenPrefix(config)}/files/${file}`;
  const builder = new addonBuilder(buildManifest(config));
  builder.defineSubtitlesHandler(createSubtitlesHandler({ config, db, logger: app.log, fileUrl }));
  await app.register(middie);
  // The SDK router answers /manifest.json and /subtitles/...; everything else falls through.
  // (The SDK's type declarations give the router no type; it is a connect-style handler.)
  const sdkRouter = getRouter(builder.getInterface()) as (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ) => void;
  app.use(sdkRouter);

  // --- Translated subtitle files --------------------------------------------
  app.get<{ Params: { name: string } }>('/files/:name', async (req, reply) => {
    const { name } = req.params;
    // Only files that are known, finished translations are served — never a path from the request.
    const entry = FILE_NAME.test(name)
      ? await db.translation.findFirst({ where: { file: name } })
      : null;
    const path = entry ? outputPath(config, entry.file) : undefined;
    if (!entry || !path || !existsSync(path)) {
      return reply.code(404).header('access-control-allow-origin', '*').send({ err: 'not found' });
    }
    await db.translation.updateMany({ where: { id: entry.id }, data: { lastUsedAt: new Date() } });
    return (
      reply
        .header('content-type', 'application/x-subrip; charset=utf-8')
        // Stremio's web player loads subtitles from another origin.
        .header('access-control-allow-origin', '*')
        // A file name belongs to one finished translation and never changes content.
        .header('cache-control', 'public, max-age=86400')
        .send(createReadStream(path))
    );
  });

  // --- Pages for the owner ---------------------------------------------------
  // Stremio's "Configure" button opens /configure: send the owner to the dashboard.
  app.get('/configure', (_req, reply) => reply.redirect(config.stremio.dashboardUrl));

  app.get('/', (_req, reply) => {
    const url = manifestUrl(config);
    const languages = stremioTargets(config).map((id) => findLanguage(id)?.name ?? id);
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Subtitle Cloud — Stremio add-on</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#1b1f24}
code{background:#eef0f3;padding:2px 6px;border-radius:4px;word-break:break-all}a.button{display:inline-block;margin:8px 8px 8px 0;padding:8px 14px;border-radius:8px;background:#2f6fed;color:#fff;text-decoration:none;font-weight:600}
@media (prefers-color-scheme: dark){body{background:#14171a;color:#e6e9ec}code{background:#262b31}}</style></head>
<body>
<h1>AI Subtitle Cloud</h1>
<p>Stremio add-on. Translates subtitles into: <strong>${escapeHtml(languages.join(', ') || 'no language configured')}</strong>.</p>
<p>Automatic translation: <strong>${config.stremio.autoTranslate ? 'on' : 'off'}</strong></p>
<p><a class="button" href="${escapeHtml(url.replace(/^https?:\/\//, 'stremio://'))}">Install in Stremio</a>
<a class="button" href="${escapeHtml(config.stremio.dashboardUrl)}">Open dashboard (progress)</a></p>
<p>Or paste this address into Stremio's add-on search box:<br><code>${escapeHtml(url)}</code></p>
<p>Translations run in the background. A subtitle appears in Stremio once it is finished; progress is shown in the dashboard.</p>
</body></html>`;
    return reply.type('text/html; charset=utf-8').send(html);
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ err: 'not found' }));
  return app;
}
