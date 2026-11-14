import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { loggerOptions } from './logger.js';

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
