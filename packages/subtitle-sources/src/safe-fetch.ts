import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SourceError, type FetchLike } from './types.js';

/** True for addresses that must never be reached by a server-side download. */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return isPrivateV4(address);
  if (kind === 6) {
    const a = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
    if (mapped?.[1]) return isPrivateV4(mapped[1]);
    return (
      a === '::' ||
      a === '::1' ||
      a.startsWith('fc') || // unique local fc00::/7
      a.startsWith('fd') ||
      /^fe[89ab]/.test(a) || // link-local fe80::/10
      a.startsWith('ff') || // multicast
      a.startsWith('::ffff:') ||
      a.startsWith('64:ff9b:') // NAT64
    );
  }
  return true; // not an IP address at all
}

function isPrivateV4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast and reserved
  );
}

export interface SafeDownloadOptions {
  /** Source id, for error messages. */
  source: string;
  /** Host names (exact or parent domains) downloads may come from, e.g. `opensubtitles.com`. */
  allowedDomains: readonly string[];
  maxBytes: number;
  signal?: AbortSignal | undefined;
  /** Test seams. */
  fetch?: FetchLike | undefined;
  resolveHost?: ((host: string) => Promise<string[]>) | undefined;
  maxRedirects?: number;
}

function hostAllowed(host: string, domains: readonly string[]): boolean {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith(`.${d}`));
}

async function defaultResolve(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((r) => r.address);
}

/**
 * Download a file from a URL that came from a third party, defensively
 * (protection against server-side request forgery):
 *  - HTTPS only, default port only, no credentials in the URL;
 *  - the host must belong to an allow-listed domain;
 *  - the host must not resolve to a private, loopback or link-local address;
 *  - redirects are followed manually and every hop is checked again;
 *  - the body is read with a hard size limit.
 */
export async function safeDownload(url: string, options: SafeDownloadOptions): Promise<Uint8Array> {
  const fetchImpl = options.fetch ?? fetch;
  const resolveHost = options.resolveHost ?? defaultResolve;
  const blocked = (message: string) => new SourceError(options.source, 'blocked', message);
  let current = url;

  for (let hop = 0; hop <= (options.maxRedirects ?? 3); hop++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      throw blocked('The download address is not a valid URL.');
    }
    if (parsed.protocol !== 'https:') throw blocked('Only HTTPS downloads are allowed.');
    if (parsed.port !== '' && parsed.port !== '443')
      throw blocked('Unexpected port in the download address.');
    if (parsed.username !== '' || parsed.password !== '')
      throw blocked('Credentials in the download address are not allowed.');
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0) throw blocked('Downloads from a bare IP address are not allowed.');
    if (!hostAllowed(host, options.allowedDomains))
      throw blocked(`Downloads from "${host}" are not allowed.`);

    let addresses: string[];
    try {
      addresses = await resolveHost(host);
    } catch (err) {
      throw new SourceError(options.source, 'unavailable', `Could not resolve "${host}".`, {
        cause: err,
      });
    }
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw blocked(`"${host}" resolves to a private or invalid address.`);
    }

    let response: Response;
    try {
      response = await fetchImpl(parsed, {
        redirect: 'manual',
        headers: { accept: 'text/plain, application/x-subrip, */*' },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (err) {
      if (options.signal?.aborted) throw err;
      throw new SourceError(options.source, 'unavailable', 'The download failed.', { cause: err });
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw blocked('Redirect without a target.');
      current = new URL(location, parsed).toString();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new SourceError(
        options.source,
        response.status === 404 ? 'not_found' : 'unavailable',
        `The download failed with HTTP ${response.status}.`,
      );
    }

    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw blocked('The file is larger than the allowed size.');
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const chunk = (await reader.read()) as { done: boolean; value?: Uint8Array };
        if (chunk.done || !chunk.value) break;
        const value = chunk.value;
        total += value.byteLength;
        if (total > options.maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw blocked('The file is larger than the allowed size.');
        }
        chunks.push(value);
      }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  throw blocked('Too many redirects.');
}
