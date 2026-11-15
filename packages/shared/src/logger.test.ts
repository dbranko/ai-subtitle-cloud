import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions, redactUrl } from './logger.js';

describe('logger redaction', () => {
  it('never writes secrets to the log output', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino(loggerOptions('api', 'info'), sink);
    log.info(
      {
        apiKey: 'sk-top-secret',
        provider: { apiKey: 'sk-nested-secret', name: 'anthropic' },
        req: { headers: { authorization: 'Bearer abc123' } },
      },
      'configured',
    );
    const out = lines.join('');
    expect(out).not.toContain('sk-top-secret');
    expect(out).not.toContain('sk-nested-secret');
    expect(out).not.toContain('abc123');
    expect(out).toContain('anthropic');
    expect(out).toContain('"service":"api"');
  });
});

describe('request URLs in the log', () => {
  it('replaces secret query values', () => {
    expect(redactUrl('/api/v1/events?token=abc123&lastEventId=4')).toBe(
      '/api/v1/events?token=[redacted]&lastEventId=4',
    );
    expect(redactUrl('/x?a=1&API_KEY=k&password=p#h')).toBe(
      '/x?a=1&API_KEY=[redacted]&password=[redacted]#h',
    );
    expect(redactUrl('/api/v1/jobs?scope=active')).toBe('/api/v1/jobs?scope=active');
  });

  it('applies to the request a web server logs', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino(loggerOptions('api', 'info'), sink);
    log.info({ req: { method: 'GET', url: '/api/v1/events?token=abc123' } }, 'incoming request');
    expect(lines.join('')).not.toContain('abc123');
    expect(lines.join('')).toContain('/api/v1/events?token=[redacted]');
  });
});
