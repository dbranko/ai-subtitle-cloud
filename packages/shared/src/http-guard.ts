/**
 * Browser-facing protections shared by the API and the add-on.
 *
 * Both services listen on 127.0.0.1 and, without an AUTH_TOKEN, trust any
 * request that reaches them. A web page the owner happens to visit can still
 * reach them through the owner's browser:
 *
 *  - **DNS rebinding:** `evil.example` is re-pointed at 127.0.0.1 after the page
 *    loads, so the page can call the API "same-origin" and read its answers.
 *    Defence: answer only to known Host names (`hostAllowed`).
 *  - **Cross-site requests (CSRF):** a page can send a POST to
 *    `http://127.0.0.1:…` without reading the answer (cancel or retry a job…).
 *    Defence: refuse state-changing requests that a browser marks as coming
 *    from another site (`crossSiteWrite`).
 */

/** Host name from a Host header: lower case, without port or IPv6 brackets. */
export function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  const value = hostHeader.trim().toLowerCase();
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : undefined;
  }
  return value.split(':')[0] || undefined;
}

/** True when the Host header names one of the allowed hosts. */
export function hostAllowed(hostHeader: string | undefined, allowed: readonly string[]): boolean {
  const host = hostnameOf(hostHeader);
  return host !== undefined && allowed.includes(host);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * True for a state-changing request that a browser sent on behalf of another
 * site: `Sec-Fetch-Site: cross-site`, or an `Origin` whose host differs from
 * the Host the request was sent to. Requests without these headers (curl,
 * scripts, old browsers) are not cross-site requests from a page.
 */
export function crossSiteWrite(
  method: string,
  headers: Record<string, string | string[] | undefined>,
): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return false;
  const site = headers['sec-fetch-site'];
  if (site === 'cross-site') return true;
  const origin = headers.origin;
  if (typeof origin !== 'string' || origin === '') return false;
  if (origin === 'null') return true; // sandboxed frames, file:// pages, redirects
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const host = typeof headers.host === 'string' ? headers.host.trim().toLowerCase() : '';
  return originHost !== host;
}

/** Headers for every response the owner's browser renders or downloads. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  // Add-on and download URLs can carry the access token: never pass them on as a referrer.
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

/** Content Security Policy for the dashboard: only its own scripts, styles and API. */
export const DASHBOARD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; " +
  "frame-ancestors 'none'";

/** The message given when a Host is refused, with the fix. */
export function hostRefusedMessage(hostHeader: string | undefined): string {
  return (
    `This address (${hostnameOf(hostHeader) ?? 'no host'}) is not one this service answers to. ` +
    'Open it through 127.0.0.1 or localhost, set AUTH_TOKEN, or add the host name to ALLOWED_HOSTS.'
  );
}
