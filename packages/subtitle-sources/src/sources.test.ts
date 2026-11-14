import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  createOpenSubtitlesSource,
  fromProviderLanguage,
  imdbNumber,
  isPrivateAddress,
  parseRelease,
  rankCandidates,
  resolveContentLanguage,
  safeDownload,
  sameLanguage,
  SourceError,
  SourceValidationError,
  toProviderLanguage,
  validateSourceBytes,
  type FetchLike,
  type MediaQuery,
  type SourceCandidate,
} from './index.js';

const FIXTURES = new URL('../../../fixtures/subtitles/', import.meta.url);
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));
const publicHost = () => Promise.resolve(['93.184.216.34']);

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SourceError);
  return error as SourceError;
}

// ---------------------------------------------------------------------------
describe('language codes', () => {
  it('maps registry ids to source codes and back', () => {
    expect(toProviderLanguage('sr-Latn')).toBe('sr');
    expect(toProviderLanguage('sr-Cyrl')).toBe('sr');
    expect(toProviderLanguage('pt-BR')).toBe('pt-br');
    expect(toProviderLanguage('zh-Hans')).toBe('zh-cn');
    expect(toProviderLanguage('en')).toBe('en');
    expect(fromProviderLanguage('pt-br')).toBe('pt-BR');
    expect(fromProviderLanguage('zh-tw')).toBe('zh-Hant');
    expect(fromProviderLanguage('EN')).toBe('en');
  });

  it('reads the script of a Serbian subtitle from its text', () => {
    expect(resolveContentLanguage('sr', 'Добро вече, господине Петровићу.')).toBe('sr-Cyrl');
    expect(resolveContentLanguage('sr', 'Dobro veče, gospodine Petroviću.')).toBe('sr-Latn');
    expect(resolveContentLanguage('en', 'Добро вече')).toBe('en');
  });

  it('compares languages regardless of script and regional code', () => {
    expect(sameLanguage('sr', 'sr-Latn')).toBe(true);
    expect(sameLanguage('sr-Cyrl', 'sr-Latn')).toBe(true);
    expect(sameLanguage('pt-BR', 'pt')).toBe(true);
    expect(sameLanguage('hr', 'sr-Latn')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('matching', () => {
  const movie: MediaQuery = {
    type: 'movie',
    imdbId: 'tt0111161',
    year: 1994,
    fileName: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS.mkv',
  };
  const candidate = (id: string, extra: Partial<SourceCandidate> = {}): SourceCandidate => ({
    source: 'opensubtitles',
    id,
    language: 'en',
    hashMatch: false,
    ...extra,
  });
  const order = (list: SourceCandidate[], query = movie, languages = ['en']) =>
    rankCandidates(query, list, { languages }).map((c) => c.id);

  it('parses release names', () => {
    expect(parseRelease(movie.fileName)).toMatchObject({
      resolution: '1080p',
      origin: 'bluray',
      codec: 'h264',
      group: 'sparks',
    });
    expect(parseRelease('Show.S01E02.720p.WEB-DL.H.264-NTb')).toMatchObject({
      origin: 'web',
      group: 'ntb',
    });
    expect(parseRelease(undefined).tokens.size).toBe(0);
  });

  it('prefers an exact video hash match over everything else', () => {
    const ranked = rankCandidates(
      movie,
      [
        candidate('popular', { downloads: 900_000, release: movie.fileName, trusted: true }),
        candidate('exact', { hashMatch: true, release: 'unknown.release' }),
      ],
      { languages: ['en'] },
    );
    expect(ranked.map((c) => c.id)).toEqual(['exact', 'popular']);
    expect(ranked[0]?.reasons[0]).toBe('matches the exact video file');
  });

  it('prefers the same release, then the same source type', () => {
    expect(
      order([
        candidate('web', { release: 'The.Shawshank.Redemption.1994.1080p.WEB-DL.x264-OTHER' }),
        candidate('same', { release: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS' }),
        candidate('bluray', { release: 'The.Shawshank.Redemption.1994.720p.BluRay.x265-GROUP' }),
      ]),
    ).toEqual(['same', 'bluray', 'web']);
  });

  it('follows the language preference order', () => {
    const list = [candidate('german', { language: 'de' }), candidate('english')];
    expect(order(list, movie, ['en', 'de'])).toEqual(['english', 'german']);
    expect(order(list, movie, ['de', 'en'])).toEqual(['german', 'english']);
  });

  it('drops languages that were not asked for and never uses the target language as a source', () => {
    const list = [
      candidate('en'),
      candidate('fr', { language: 'fr' }),
      candidate('sr', { language: 'sr' }),
    ];
    expect(order(list, movie, ['en', 'sr'])).toEqual(['en', 'sr']);
    const ranked = rankCandidates(movie, list, {
      languages: ['en', 'sr'],
      excludeLanguage: 'sr-Latn',
    });
    expect(ranked.map((c) => c.id)).toEqual(['en']);
  });

  it('avoids machine translations and slightly prefers trusted, popular, non-SDH subtitles', () => {
    expect(
      order([
        candidate('machine', { machineTranslated: true, downloads: 500_000 }),
        candidate('plain'),
        candidate('sdh', { hearingImpaired: true }),
        candidate('trusted', { trusted: true, downloads: 20_000 }),
      ]),
    ).toEqual(['trusted', 'plain', 'sdh', 'machine']);
  });

  it('prefers a subtitle the owner uploaded for the title', () => {
    const list = [
      candidate('download', { release: movie.fileName, downloads: 100_000 }),
      { source: 'library', id: 'mine', language: '', hashMatch: false, local: true },
    ];
    expect(order(list)).toEqual(['mine', 'download']);
  });

  it('rejects subtitles for another episode and penalises another year', () => {
    const episode: MediaQuery = { type: 'series', imdbId: 'tt0903747', season: 2, episode: 5 };
    expect(
      order(
        [
          candidate('s02e05', { season: 2, episode: 5 }),
          candidate('s02e06', { season: 2, episode: 6 }),
          candidate('unknown'),
        ],
        episode,
      ),
    ).toEqual(['s02e05', 'unknown']);
    expect(
      order([candidate('remake', { year: 2015 }), candidate('right', { year: 1994 })]),
    ).toEqual(['right', 'remake']);
  });

  it('is deterministic and removes duplicates', () => {
    const list = [candidate('b'), candidate('a'), candidate('a')];
    expect(order(list)).toEqual(['a', 'b']);
    expect(order([...list].reverse())).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
describe('safeDownload (SSRF protection)', () => {
  const ok =
    (body = 'data'): FetchLike =>
    () =>
      Promise.resolve(new Response(body, { status: 200 }));
  const options = (fetch: FetchLike, extra = {}) => ({
    source: 'test',
    allowedDomains: ['opensubtitles.com'],
    maxBytes: 1000,
    fetch,
    resolveHost: publicHost,
    ...extra,
  });

  it('downloads from an allowed host over HTTPS', async () => {
    const bytes = await safeDownload(
      'https://www.opensubtitles.com/download/abc/file.srt',
      options(ok('hello')),
    );
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it.each([
    ['plain HTTP', 'http://www.opensubtitles.com/file.srt'],
    ['a foreign host', 'https://evil.example.com/file.srt'],
    ['a look-alike host', 'https://opensubtitles.com.evil.example/file.srt'],
    ['a suffix trick', 'https://notopensubtitles.com/file.srt'],
    ['an IP address', 'https://93.184.216.34/file.srt'],
    ['localhost', 'https://localhost/file.srt'],
    ['an unusual port', 'https://www.opensubtitles.com:8443/file.srt'],
    ['embedded credentials', 'https://user:pass@www.opensubtitles.com/file.srt'],
    ['a non-URL', 'not a url'],
    ['a file URL', 'file:///etc/passwd'],
  ])('refuses %s', async (_name, url) => {
    let called = false;
    const fetch: FetchLike = () => {
      called = true;
      return Promise.resolve(new Response('x'));
    };
    expect((await failure(safeDownload(url, options(fetch)))).kind).toBe('blocked');
    expect(called).toBe(false);
  });

  it.each([
    '127.0.0.1',
    '10.0.0.5',
    '192.168.1.10',
    '172.16.4.4',
    '169.254.169.254',
    '100.64.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '0.0.0.0',
  ])('refuses an allowed host that resolves to the private address %s', async (address) => {
    let called = false;
    const fetch: FetchLike = () => {
      called = true;
      return Promise.resolve(new Response('x'));
    };
    const error = await failure(
      safeDownload(
        'https://dl.opensubtitles.com/f.srt',
        options(fetch, { resolveHost: () => Promise.resolve([address]) }),
      ),
    );
    expect(error.kind).toBe('blocked');
    expect(called).toBe(false);
  });

  it('classifies addresses', () => {
    for (const a of ['8.8.8.8', '93.184.216.34', '2606:4700::1111'])
      expect(isPrivateAddress(a), a).toBe(false);
    for (const a of ['10.1.2.3', '127.0.0.1', '192.168.0.1', '224.0.0.1', 'not-an-ip'])
      expect(isPrivateAddress(a), a).toBe(true);
  });

  it('checks every redirect hop and limits their number', async () => {
    const redirectTo = (location: string): FetchLike => {
      let first = true;
      return () => {
        if (!first) return Promise.resolve(new Response('final'));
        first = false;
        return Promise.resolve(new Response(null, { status: 302, headers: { location } }));
      };
    };
    const good = await safeDownload(
      'https://www.opensubtitles.com/a',
      options(redirectTo('https://dl.opensubtitles.com/b')),
    );
    expect(new TextDecoder().decode(good)).toBe('final');
    expect(
      (
        await failure(
          safeDownload(
            'https://www.opensubtitles.com/a',
            options(redirectTo('https://evil.example.com/b')),
          ),
        )
      ).kind,
    ).toBe('blocked');
    expect(
      (
        await failure(
          safeDownload(
            'https://www.opensubtitles.com/a',
            options(redirectTo('http://169.254.169.254/latest/meta-data')),
          ),
        )
      ).kind,
    ).toBe('blocked');
    const loop: FetchLike = () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://www.opensubtitles.com/a' },
        }),
      );
    expect(
      (await failure(safeDownload('https://www.opensubtitles.com/a', options(loop)))).message,
    ).toMatch(/Too many redirects/);
  });

  it('enforces the size limit, declared or not', async () => {
    const declared: FetchLike = () =>
      Promise.resolve(new Response('x', { headers: { 'content-length': '5000' } }));
    expect(
      (await failure(safeDownload('https://www.opensubtitles.com/a', options(declared)))).kind,
    ).toBe('blocked');
    expect(
      (
        await failure(
          safeDownload('https://www.opensubtitles.com/a', options(ok('y'.repeat(2000)))),
        )
      ).kind,
    ).toBe('blocked');
  });

  it('reports HTTP and network failures', async () => {
    const status =
      (code: number): FetchLike =>
      () =>
        Promise.resolve(new Response('no', { status: code }));
    expect(
      (await failure(safeDownload('https://www.opensubtitles.com/a', options(status(404))))).kind,
    ).toBe('not_found');
    expect(
      (await failure(safeDownload('https://www.opensubtitles.com/a', options(status(500))))).kind,
    ).toBe('unavailable');
    const offline: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    expect(
      (await failure(safeDownload('https://www.opensubtitles.com/a', options(offline)))).kind,
    ).toBe('unavailable');
  });
});

// ---------------------------------------------------------------------------
describe('validateSourceBytes', () => {
  const rejects = (bytes: Uint8Array, code: string, options = {}) => {
    try {
      validateSourceBytes(bytes, { maxBytes: 1_000_000, ...options });
    } catch (err) {
      expect(err).toBeInstanceOf(SourceValidationError);
      expect((err as SourceValidationError).code).toBe(code);
      return;
    }
    throw new Error('expected validation to fail');
  };
  const text = (s: string) => new TextEncoder().encode(s);

  it('accepts real subtitles, including messy and legacy-encoded ones', () => {
    expect(
      validateSourceBytes(fixture('basic-movie.srt'), { maxBytes: 1_000_000 }).entries,
    ).toHaveLength(12);
    const messy = validateSourceBytes(fixture('messy.srt'), { maxBytes: 1_000_000 });
    expect(messy.entries).toHaveLength(6);
    expect(messy.warnings.length).toBeGreaterThan(0);
    const legacy = validateSourceBytes(fixture('legacy-cp1250.srt'), {
      maxBytes: 1_000_000,
      legacyEncoding: 'windows-1250',
    });
    expect(legacy.encoding).toBe('windows-1250');
    expect(legacy.srt).toContain('Što se događa');
  });

  it('rejects what sources sometimes send instead of a subtitle', () => {
    rejects(new Uint8Array(), 'empty');
    rejects(text('<!DOCTYPE html><html><body>Download limit reached</body></html>'), 'not_srt');
    rejects(text('{"error":"quota exceeded"}'), 'not_srt');
    rejects(text('WEBVTT\n\n00:01.000 --> 00:02.000\nHi'), 'not_srt');
    rejects(text('Just some text, no cues.'), 'not_srt');
    rejects(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'not_srt'); // zip
    rejects(new Uint8Array([0x1f, 0x8b, 8, 0, 0]), 'not_srt'); // gzip
    rejects(fixture('basic-movie.srt'), 'too_large', { maxBytes: 100 });
  });

  it('rejects structurally broken and implausibly short subtitles', () => {
    rejects(text('1\n00:00:05,000 --> 00:00:01,000\nBackwards\n'), 'broken');
    rejects(text('1\n00:00:01,000 --> 00:00:02,000\nOnly one\n'), 'too_short', { minEntries: 3 });
  });
});

// ---------------------------------------------------------------------------
describe('OpenSubtitles adapter', () => {
  interface Call {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }
  const SRT =
    '1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nGoodbye.\n';
  const searchResult = {
    total_count: 2,
    data: [
      {
        id: '1',
        type: 'subtitle',
        attributes: {
          language: 'en',
          release: 'Movie.1994.1080p.BluRay.x264-SPARKS',
          download_count: 54321,
          hearing_impaired: false,
          ai_translated: false,
          machine_translated: false,
          from_trusted: true,
          moviehash_match: true,
          ratings: 8.5,
          feature_details: { year: 1994, season_number: null, episode_number: null },
          files: [{ file_id: 111, cd_number: 1, file_name: 'Movie.1994.srt' }],
        },
      },
      {
        id: '2',
        type: 'subtitle',
        attributes: {
          language: 'pt-br',
          release: null,
          ai_translated: true,
          files: [{ file_id: 222, file_name: null }],
        },
      },
      { id: '3', type: 'subtitle', attributes: { language: 'en', files: [] } },
    ],
  };

  function setup(
    handler: (call: Call) => Response | undefined = () => undefined,
    account: { username?: string; password?: string } = {},
  ) {
    const calls: Call[] = [];
    const fetch: FetchLike = async (input, init) => {
      const request = new Request(input, init);
      const text = await request.text();
      const call: Call = {
        url: request.url,
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
        body: text ? JSON.parse(text) : undefined,
      };
      calls.push(call);
      const custom = handler(call);
      if (custom) return custom;
      const path = new URL(call.url).pathname;
      if (path.endsWith('/subtitles')) return Response.json(searchResult);
      if (path.endsWith('/login')) return Response.json({ token: 'jwt-token', status: 200 });
      if (path.endsWith('/download')) {
        return Response.json({
          link: 'https://www.opensubtitles.com/download/XYZ/subfile/Movie.srt',
          file_name: 'Movie.srt',
          remaining: 19,
        });
      }
      return new Response(SRT);
    };
    const source = createOpenSubtitlesSource({
      apiKey: 'os-secret-api-key',
      userAgent: 'AISubtitleCloud v0.1.0',
      maxBytes: 100_000,
      fetch,
      resolveHost: publicHost,
      ...account,
    });
    return { source, calls };
  }

  it('converts IMDb ids', () => {
    expect(imdbNumber('tt0111161')).toBe('111161');
    expect(imdbNumber('903747')).toBe('903747');
    expect(imdbNumber('nonsense')).toBeUndefined();
  });

  it('searches a movie by IMDb id, hash and languages using the official endpoint', async () => {
    const { source, calls } = setup();
    const found = await source.search(
      { type: 'movie', imdbId: 'tt0111161', videoHash: 'ABCDEF0123456789' },
      ['en', 'pt-BR', 'sr-Latn'],
    );
    const call = calls[0]!;
    expect(call.method).toBe('GET');
    // Lower-case, alphabetically sorted parameters, as the API asks.
    expect(call.url).toBe(
      'https://api.opensubtitles.com/api/v1/subtitles?imdb_id=111161&languages=en%2Cpt-br%2Csr&moviehash=abcdef0123456789',
    );
    expect(call.headers['api-key']).toBe('os-secret-api-key');
    expect(call.headers['user-agent']).toBe('AISubtitleCloud v0.1.0');
    expect(call.url).not.toContain('os-secret-api-key');

    expect(found).toEqual([
      {
        source: 'opensubtitles',
        id: '111',
        language: 'en',
        release: 'Movie.1994.1080p.BluRay.x264-SPARKS',
        fileName: 'Movie.1994.srt',
        hashMatch: true,
        hearingImpaired: false,
        machineTranslated: false,
        trusted: true,
        downloads: 54321,
        rating: 8.5,
        season: undefined,
        episode: undefined,
        year: 1994,
      },
      expect.objectContaining({
        id: '222',
        language: 'pt-BR',
        machineTranslated: true,
        hashMatch: false,
      }),
    ]);
  });

  it('searches an episode through the series id, season and episode', async () => {
    const { source, calls } = setup();
    await source.search({ type: 'series', imdbId: 'tt0903747', season: 2, episode: 5 }, ['en']);
    expect(calls[0]?.url).toBe(
      'https://api.opensubtitles.com/api/v1/subtitles?episode_number=5&languages=en&parent_imdb_id=903747&season_number=2',
    );
  });

  it('falls back to a title search and does nothing without any identifier', async () => {
    const { source, calls } = setup();
    await source.search({ type: 'movie', title: 'The Shawshank Redemption', year: 1994 }, ['en']);
    expect(calls[0]?.url).toContain('query=the%20shawshank%20redemption');
    expect(calls[0]?.url).toContain('year=1994');
    expect(await source.search({ type: 'movie' }, ['en'])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('downloads through the official download endpoint, asking for SRT', async () => {
    const { source, calls } = setup();
    const [candidate] = await source.search({ type: 'movie', imdbId: 'tt0111161' }, ['en']);
    const file = await source.download(candidate!);
    expect(new TextDecoder().decode(file.bytes)).toBe(SRT);
    expect(file.fileName).toBe('Movie.srt');

    const download = calls.find((c) => c.url.endsWith('/download'))!;
    expect(download.method).toBe('POST');
    expect(download.body).toEqual({ file_id: 111, sub_format: 'srt' });
    expect(download.headers['api-key']).toBe('os-secret-api-key');
    // No account configured: no login request, no bearer token.
    expect(calls.some((c) => c.url.endsWith('/login'))).toBe(false);
    expect(download.headers.authorization).toBeUndefined();
    // The file itself is fetched without the API key.
    const fileCall = calls[calls.length - 1]!;
    expect(fileCall.url).toBe('https://www.opensubtitles.com/download/XYZ/subfile/Movie.srt');
    expect(fileCall.headers['api-key']).toBeUndefined();
  });

  it('logs in once when an account is configured and sends the token', async () => {
    const { source, calls } = setup(undefined, { username: 'owner', password: 'pw' });
    const candidate: SourceCandidate = {
      source: 'opensubtitles',
      id: '111',
      language: 'en',
      hashMatch: false,
    };
    await source.download(candidate);
    await source.download(candidate);
    const logins = calls.filter((c) => c.url.endsWith('/login'));
    expect(logins).toHaveLength(1);
    expect(logins[0]?.body).toEqual({ username: 'owner', password: 'pw' });
    for (const c of calls.filter((x) => x.url.endsWith('/download'))) {
      expect(c.headers.authorization).toBe('Bearer jwt-token');
    }
  });

  it('logs in again when the stored token has expired', async () => {
    let downloads = 0;
    const { source, calls } = setup(
      (call) => {
        if (!call.url.endsWith('/download')) return undefined;
        downloads++;
        return downloads === 2 ? new Response('{}', { status: 401 }) : undefined;
      },
      { username: 'owner', password: 'pw' },
    );
    const candidate: SourceCandidate = {
      source: 'opensubtitles',
      id: '111',
      language: 'en',
      hashMatch: false,
    };
    await source.download(candidate);
    await source.download(candidate);
    expect(calls.filter((c) => c.url.endsWith('/login'))).toHaveLength(2);
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [406, 'quota'],
    [429, 'rate_limit'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('maps HTTP %i to "%s"', async (status, kind) => {
    const { source } = setup(() => new Response('{"message":"x"}', { status }));
    expect((await failure(source.search({ type: 'movie', imdbId: 'tt1' }, ['en']))).kind).toBe(
      kind,
    );
  });

  it('reports unexpected answers and network failures clearly, without the API key', async () => {
    const garbage = setup(() => Response.json({ unexpected: true }));
    expect(
      (await failure(garbage.source.search({ type: 'movie', imdbId: 'tt1' }, ['en']))).kind,
    ).toBe('invalid_response');
    const html = setup(() => new Response('<html>down</html>'));
    expect((await failure(html.source.search({ type: 'movie', imdbId: 'tt1' }, ['en']))).kind).toBe(
      'invalid_response',
    );
    const offline = createOpenSubtitlesSource({
      apiKey: 'os-secret-api-key',
      userAgent: 'x',
      maxBytes: 1000,
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const error = await failure(offline.search({ type: 'movie', imdbId: 'tt1' }, ['en']));
    expect(error.kind).toBe('unavailable');
    expect(error.message).not.toContain('os-secret-api-key');
  });

  it('refuses a download link that points outside OpenSubtitles', async () => {
    const { source } = setup((call) =>
      call.url.endsWith('/download')
        ? Response.json({ link: 'https://169.254.169.254/latest/meta-data' })
        : undefined,
    );
    const candidate: SourceCandidate = {
      source: 'opensubtitles',
      id: '111',
      language: 'en',
      hashMatch: false,
    };
    expect((await failure(source.download(candidate))).kind).toBe('blocked');
  });
});
