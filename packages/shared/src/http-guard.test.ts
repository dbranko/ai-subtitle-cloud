import { describe, expect, it } from 'vitest';
import { crossSiteWrite, hostAllowed, hostnameOf } from './http-guard.js';

const LOCAL = ['localhost', '127.0.0.1', '::1'];

describe('host check (DNS rebinding)', () => {
  it('reads the host name from a Host header', () => {
    expect(hostnameOf('127.0.0.1:7001')).toBe('127.0.0.1');
    expect(hostnameOf('LocalHost')).toBe('localhost');
    expect(hostnameOf('[::1]:7001')).toBe('::1');
    expect(hostnameOf('')).toBeUndefined();
    expect(hostnameOf(undefined)).toBeUndefined();
    expect(hostnameOf('[::1')).toBeUndefined();
  });

  it('accepts only the allowed names', () => {
    expect(hostAllowed('127.0.0.1:7001', LOCAL)).toBe(true);
    expect(hostAllowed('localhost', LOCAL)).toBe(true);
    expect(hostAllowed('[::1]:7000', LOCAL)).toBe(true);
    expect(hostAllowed('evil.example:7001', LOCAL)).toBe(false);
    expect(hostAllowed('127.0.0.1.evil.example', LOCAL)).toBe(false);
    expect(hostAllowed('localhost.evil.example', LOCAL)).toBe(false);
    expect(hostAllowed(undefined, LOCAL)).toBe(false);
  });
});

describe('cross-site write check (CSRF)', () => {
  const host = '127.0.0.1:7001';
  it('never blocks reads', () => {
    expect(crossSiteWrite('GET', { host, origin: 'https://evil.example' })).toBe(false);
    expect(crossSiteWrite('HEAD', { host, 'sec-fetch-site': 'cross-site' })).toBe(false);
  });

  it('blocks writes a browser marks as coming from another site', () => {
    expect(crossSiteWrite('POST', { host, origin: 'https://evil.example' })).toBe(true);
    expect(crossSiteWrite('PUT', { host, origin: 'http://127.0.0.1:9999' })).toBe(true);
    expect(crossSiteWrite('POST', { host, 'sec-fetch-site': 'cross-site' })).toBe(true);
    expect(crossSiteWrite('POST', { host, origin: 'null' })).toBe(true);
    expect(crossSiteWrite('DELETE', { host, origin: 'not a url' })).toBe(true);
  });

  it('allows the dashboard itself and clients that are not browsers', () => {
    expect(crossSiteWrite('POST', { host, origin: 'http://127.0.0.1:7001' })).toBe(false);
    expect(crossSiteWrite('POST', { host, 'sec-fetch-site': 'same-origin' })).toBe(false);
    expect(crossSiteWrite('POST', { host })).toBe(false); // curl, scripts
    expect(
      crossSiteWrite('POST', { host: 'subs.example.com', origin: 'https://subs.example.com' }),
    ).toBe(false);
  });
});
