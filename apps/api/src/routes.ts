import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { describeProviders } from '@asc/ai-providers';
import { AI_PROVIDER_IDS, type AppConfig } from '@asc/config';
import type { Database } from '@asc/database';
import {
  cacheStats,
  countJobsSince,
  cleanupCache,
  createJob,
  createLibrarySource,
  createSourcesFromConfig,
  JobConflictError,
  JobNotFoundError,
  JobRequestError,
  listJobsPage,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  outputPath,
  requestCancel,
  requestMediaTranslation,
  requireJob,
  SettingsError,
  SettingsProvider,
  retryJob,
  toJobView,
  toNotificationView,
} from '@asc/jobs';
import { decodeSubtitleBytes } from '@asc/subtitle-parser';
import { rankCandidates, SourceError, type SubtitleSource } from '@asc/subtitle-sources';
import {
  findLanguage,
  listProfiles,
  sourceLanguages,
  targetLanguages,
  TRANSLATION_PROFILES,
} from '@asc/translation-engine';
import type { EventHub } from './events.js';

export interface ApiRouteDeps {
  config: AppConfig;
  db: Database;
  events: EventHub;
  /** Dashboard settings; defaults to a provider over the given configuration. */
  settings?: SettingsProvider | undefined;
  /** Remote subtitle sources (default: those configured). */
  sources?: SubtitleSource[] | undefined;
}

const createJobSchema = z.object({
  /** The subtitle file's bytes, base64-encoded (any encoding; decoded on the server). */
  contentBase64: z.string().min(1).optional(),
  /** Alternatively, the subtitle as already-decoded text. */
  srt: z.string().min(1).optional(),
  fileName: z.string().max(300).optional(),
  title: z.string().max(300).optional(),
  mediaType: z.enum(['movie', 'series']).optional(),
  imdbId: z
    .string()
    .regex(/^tt\d{5,12}$/)
    .optional(),
  season: z.number().int().min(0).max(1000).optional(),
  episode: z.number().int().min(0).max(100_000).optional(),
  sourceLanguage: z.string().max(20).optional(),
  targetLanguage: z.string().min(1).max(20),
  profile: z.enum(TRANSLATION_PROFILES).optional(),
  customInstructions: z.string().max(2000).optional(),
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  model: z.string().max(100).optional(),
  force: z.boolean().optional(),
});

const mediaSchema = z.object({
  type: z.enum(['movie', 'series']),
  imdbId: z
    .string()
    .regex(/^tt\d{5,12}$/)
    .optional(),
  title: z.string().max(300).optional(),
  year: z.number().int().min(1880).max(2200).optional(),
  season: z.number().int().min(0).max(1000).optional(),
  episode: z.number().int().min(0).max(100_000).optional(),
  videoHash: z
    .string()
    .regex(/^[0-9a-fA-F]{16}$/)
    .optional(),
  videoSize: z.number().int().min(0).optional(),
  fileName: z.string().max(500).optional(),
});

const candidateSchema = z.object({
  source: z.string().min(1).max(40),
  id: z.string().min(1).max(100),
  language: z.string().max(20),
  release: z.string().max(500).optional(),
  fileName: z.string().max(500).optional(),
  hashMatch: z.boolean().default(false),
  local: z.boolean().optional(),
});

const mediaJobSchema = z.object({
  media: mediaSchema,
  targetLanguage: z.string().min(1).max(20),
  profile: z.enum(TRANSLATION_PROFILES).optional(),
  customInstructions: z.string().max(2000).optional(),
  sourceLanguages: z.array(z.string().max(20)).max(10).optional(),
  /** A source picked by the owner from a search result; used instead of searching. */
  source: candidateSchema.optional(),
  provider: z.enum(AI_PROVIDER_IDS).optional(),
  model: z.string().max(100).optional(),
  force: z.boolean().optional(),
});

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Token from `Authorization: Bearer …`, or `?token=…` (EventSource cannot set headers). */
function presentedToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  const query = (req.query as Record<string, unknown> | undefined)?.token;
  return typeof query === 'string' ? query : undefined;
}

export function registerApiRoutes(app: FastifyInstance, deps: ApiRouteDeps): void {
  const { db, events } = deps;
  // `base` is the environment configuration (ports, paths, limits, access token).
  // Everything the owner can change in the dashboard is read through `settings`.
  const base = deps.config;
  const settings = deps.settings ?? new SettingsProvider(db, base);
  const remoteSourcesFor = (config: AppConfig) => deps.sources ?? createSourcesFromConfig(config);
  const allSourcesFor = (config: AppConfig) => [
    createLibrarySource(db, config),
    ...remoteSourcesFor(config),
  ];

  // --- Authentication -------------------------------------------------------
  // Required for every /api route as soon as an AUTH_TOKEN is configured (which
  // the bind guard demands before the API may listen beyond localhost).
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    const expected = base.security.authToken;
    if (expected === undefined) return;
    const given = presentedToken(req);
    if (given === undefined || !sameToken(given, expected)) {
      await reply.code(401).send({ error: 'unauthorized', message: 'A valid token is required.' });
    }
  });

  // --- Errors ---------------------------------------------------------------
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof JobRequestError) {
      return reply.code(400).send({ error: err.code, message: err.message });
    }
    if (err instanceof JobNotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
    if (err instanceof JobConflictError) {
      return reply.code(409).send({ error: 'conflict', message: err.message });
    }
    if (err instanceof SourceError) {
      // The subtitle source failed, not this application: say which and why.
      const status =
        err.kind === 'auth' || err.kind === 'quota' || err.kind === 'rate_limit' ? 502 : 503;
      return reply.code(status).send({ error: `source_${err.kind}`, message: err.message });
    }
    if (err instanceof SettingsError) {
      return reply.code(400).send({ error: 'invalid_settings', message: err.message });
    }
    if (err instanceof z.ZodError) {
      const issue = err.issues[0];
      const where = issue?.path.join('.') || 'request';
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: `${where}: ${issue?.message ?? 'invalid'}` });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = status === 413 ? 'too_large' : status === 429 ? 'rate_limited' : 'bad_request';
      const message = err instanceof Error ? err.message : 'Bad request.';
      return reply.code(status).send({ error: code, message });
    }
    req.log.error({ err }, 'unhandled API error');
    return reply.code(500).send({ error: 'internal_error', message: 'Unexpected server error.' });
  });

  // --- Metadata for the UI --------------------------------------------------
  app.get('/api/v1/meta', async () => {
    const config = await settings.config();
    const remoteSources = remoteSourcesFor(config);
    const defaults = await settings.defaults();
    const language = (l: { id: string; name: string; nativeName: string }) => ({
      id: l.id,
      name: l.name,
      nativeName: l.nativeName,
    });
    return {
      targetLanguages: targetLanguages().map(language),
      sourceLanguages: sourceLanguages().map(language),
      profiles: listProfiles().map((p) => ({ id: p.id, name: p.name, description: p.description })),
      providers: describeProviders(config),
      defaults: {
        provider: config.ai.provider,
        model: config.ai.model ?? null,
        profile: config.ai.translationProfile,
        targetLanguage: defaults.targetLanguage,
        customInstructions: defaults.customInstructions,
      },
      sources: [
        { id: 'library', name: 'Your uploads', configured: true },
        {
          id: 'opensubtitles',
          name: 'OpenSubtitles',
          configured: remoteSources.some((s) => s.id === 'opensubtitles'),
        },
      ],
      defaultSourceLanguages: config.sources.languages,
      mockAi: config.mockAi.enabled,
      maxUploadBytes: base.jobs.maxUploadBytes,
    };
  });

  // --- Jobs -----------------------------------------------------------------
  app.post(
    '/api/v1/jobs',
    // Base64 inflates the upload by a third; leave room for the other fields.
    { bodyLimit: Math.ceil(base.jobs.maxUploadBytes * 1.4) + 16_384 },
    async (req, reply) => {
      const config = await settings.config();
      const body = createJobSchema.parse(req.body);
      let srt: string;
      if (body.contentBase64 !== undefined) {
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length === 0) {
          throw new JobRequestError('source_invalid', 'The uploaded file is empty.');
        }
        if (bytes.length > config.jobs.maxUploadBytes) {
          throw new JobRequestError(
            'too_large',
            `The subtitle is larger than the ${Math.round(config.jobs.maxUploadBytes / 1024)} KB limit.`,
          );
        }
        const legacy = body.sourceLanguage
          ? findLanguage(body.sourceLanguage)?.legacyEncoding
          : undefined;
        srt = decodeSubtitleBytes(bytes, legacy ?? 'windows-1252').text;
      } else if (body.srt !== undefined) {
        if (Buffer.byteLength(body.srt) > config.jobs.maxUploadBytes) {
          throw new JobRequestError('too_large', 'The subtitle is too large.');
        }
        srt = body.srt;
      } else {
        throw new JobRequestError(
          'source_invalid',
          'Provide the subtitle as "contentBase64" or "srt".',
        );
      }

      const result = await createJob(db, config, {
        srt,
        sourceName: body.fileName,
        mediaTitle: body.title,
        mediaType: body.mediaType,
        imdbId: body.imdbId,
        season: body.season,
        episode: body.episode,
        sourceLanguage: body.sourceLanguage,
        targetLanguage: body.targetLanguage,
        profile: body.profile,
        customInstructions: body.customInstructions,
        provider: body.provider,
        model: body.model,
        force: body.force,
      });
      return reply
        .code(result.created ? 201 : 200)
        .send({ job: toJobView(result.job), created: result.created, reason: result.reason });
    },
  );

  // Translate a title without uploading a subtitle: the job finds a source itself.
  app.post('/api/v1/jobs/from-media', async (req, reply) => {
    const config = await settings.config();
    const body = mediaJobSchema.parse(req.body);
    const result = await requestMediaTranslation(db, config, {
      query: body.media,
      targetLanguage: body.targetLanguage,
      profile: body.profile,
      customInstructions: body.customInstructions,
      sourceLanguages: body.sourceLanguages,
      pinned: body.source,
      provider: body.provider,
      model: body.model,
      force: body.force,
    });
    return reply.code(result.status === 'created' ? 201 : 200).send({
      status: result.status,
      job: result.job ? toJobView(result.job) : null,
      translation: result.translation
        ? {
            id: result.translation.id,
            targetLanguage: result.translation.targetLanguage,
            entries: result.translation.entries,
            createdAt: result.translation.createdAt.toISOString(),
            jobId: result.translation.jobId,
          }
        : null,
    });
  });

  // Manual mode: show the owner which source subtitles exist, best match first.
  app.post('/api/v1/sources/search', async (req) => {
    const config = await settings.config();
    const body = z
      .object({
        media: mediaSchema,
        languages: z.array(z.string().max(20)).max(10).optional(),
        targetLanguage: z.string().max(20).optional(),
      })
      .parse(req.body);
    const languages = body.languages?.length ? body.languages : config.sources.languages;
    const found = [];
    const failures: { source: string; error: string; message: string }[] = [];
    for (const source of allSourcesFor(config)) {
      try {
        found.push(...(await source.search(body.media, languages)));
      } catch (err) {
        failures.push({
          source: source.id,
          error: err instanceof SourceError ? `source_${err.kind}` : 'source_unavailable',
          message: err instanceof Error ? err.message : 'Search failed.',
        });
      }
    }
    return {
      candidates: rankCandidates(body.media, found, {
        languages,
        excludeLanguage: body.targetLanguage,
      }).slice(0, 50),
      failures,
    };
  });

  app.get('/api/v1/jobs', async (req) => {
    const query = z
      .object({
        scope: z.enum(['active', 'finished', 'all']).default('all'),
        /** Only jobs in this final state (history filter). */
        status: z.enum(['completed', 'failed', 'cancelled']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const { jobs, total } = await listJobsPage(db, query);
    return { jobs: jobs.map(toJobView), total };
  });

  // Recent activity: what was started, finished, failed or cancelled, newest first.
  app.get('/api/v1/activity', async (req) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
      .parse(req.query);
    const rows = await db.jobEvent.findMany({
      where: { type: { in: ['job.created', 'job.completed', 'job.failed', 'job.cancelled'] } },
      orderBy: { id: 'desc' },
      take: limit,
    });
    return {
      activity: rows.map((row) => {
        const job = JSON.parse(row.payload) as {
          id: string;
          mediaTitle: string;
          targetLanguage: string;
          origin: string;
        };
        return {
          id: row.id,
          type: row.type,
          at: row.createdAt.toISOString(),
          jobId: job.id,
          title: job.mediaTitle,
          targetLanguage: job.targetLanguage,
          origin: job.origin,
        };
      }),
    };
  });

  const idParams = (req: FastifyRequest) =>
    z.object({ id: z.string().min(1).max(64) }).parse(req.params);

  app.get('/api/v1/jobs/:id', async (req) => ({
    job: toJobView(await requireJob(db, idParams(req).id)),
  }));

  app.post('/api/v1/jobs/:id/cancel', async (req) => ({
    job: toJobView(await requestCancel(db, idParams(req).id)),
  }));

  app.post('/api/v1/jobs/:id/retry', async (req) => ({
    job: toJobView(await retryJob(db, idParams(req).id)),
  }));

  app.get('/api/v1/jobs/:id/download', async (req, reply: FastifyReply) => {
    const job = await requireJob(db, idParams(req).id);
    if (job.state !== 'completed' || !job.outputFile) {
      throw new JobConflictError('The translation is not finished yet.');
    }
    const file = outputPath(deps.config, job.outputFile);
    if (!existsSync(file)) throw new JobNotFoundError(job.id);
    // Serving a translation counts as using it, for least-recently-used cache cleanup.
    await db.translation.updateMany({
      where: { file: job.outputFile },
      data: { lastUsedAt: new Date() },
    });
    const base = job.mediaTitle.replace(/[^\p{L}\p{N} ._()-]+/gu, ' ').trim() || 'subtitle';
    const name = `${base}.${job.targetLanguage}.srt`;
    return reply
      .header('content-type', 'application/x-subrip; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename="subtitle.${job.targetLanguage}.srt"; filename*=UTF-8''${encodeURIComponent(name)}`,
      )
      .header('cache-control', 'private, no-store')
      .send(createReadStream(file));
  });

  // --- Stremio integration -----------------------------------------------------
  // What the owner needs to install the add-on and understand what it will do.
  app.get('/api/v1/stremio', async () => {
    const config = await settings.config();
    const { stremio } = config;
    const token = base.security.authToken;
    const manifestUrl = `${stremio.publicUrl}${token ? `/${encodeURIComponent(token)}` : ''}/manifest.json`;
    const local = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(stremio.publicUrl);
    return {
      manifestUrl,
      installUrl: manifestUrl.replace(/^https?:\/\//, 'stremio://'),
      // Stremio only loads add-ons from 127.0.0.1 or over HTTPS.
      reachable: local
        ? 'this-computer'
        : stremio.publicUrl.startsWith('https://')
          ? 'https'
          : 'unsupported',
      targetLanguages: stremio.targetLanguages.filter((id) => findLanguage(id)?.target === true),
      profile: stremio.profile,
      dailyJobLimit: stremio.dailyJobLimit,
      startedLast24h: await countJobsSince(db, 'stremio', new Date(Date.now() - 24 * 60 * 60_000)),
      sourceConfigured: remoteSourcesFor(config).length > 0,
    };
  });

  // --- Settings ---------------------------------------------------------------
  // Secrets are write-only: they can be set or removed, never read back.
  app.get('/api/v1/settings', async () => settings.view());
  app.put('/api/v1/settings', async (req) => settings.update(req.body));

  // --- Cache -----------------------------------------------------------------
  app.get('/api/v1/cache', async () => ({
    ...(await cacheStats(db)),
    limits: (await settings.config()).cache,
  }));

  app.post('/api/v1/cache/cleanup', async (req) => {
    const config = await settings.config();
    const body = z
      .object({
        maxAgeDays: z.number().int().min(0).optional(),
        maxSizeMb: z.number().int().min(0).optional(),
      })
      .parse(req.body ?? {});
    return cleanupCache(db, config, {
      maxAgeDays: body.maxAgeDays ?? config.cache.maxAgeDays,
      maxSizeMb: body.maxSizeMb ?? config.cache.maxSizeMb,
    });
  });

  // --- Notifications --------------------------------------------------------
  app.get('/api/v1/notifications', async (req) => {
    const query = z
      .object({
        unread: z.enum(['true', 'false']).default('false'),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    const rows = await listNotifications(db, {
      unreadOnly: query.unread === 'true',
      limit: query.limit,
    });
    return { notifications: rows.map(toNotificationView) };
  });

  app.post('/api/v1/notifications/:id/read', async (req) => {
    const row = await markNotificationRead(db, idParams(req).id);
    if (!row) throw new JobNotFoundError(idParams(req).id);
    return { notification: toNotificationView(row) };
  });

  app.post('/api/v1/notifications/read-all', async () => ({
    marked: await markAllNotificationsRead(db),
  }));

  // --- Real-time updates (Server-Sent Events) -------------------------------
  app.get('/api/v1/events', { config: { rateLimit: false } }, async (_req, reply) => {
    // The stream is written directly; Fastify must not try to send a response itself.
    reply.hijack();
    await events.connect(reply.raw);
  });
}
