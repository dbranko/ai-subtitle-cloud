import { pino, type Logger, type LoggerOptions } from 'pino';
import type { ServiceName } from './version.js';

/**
 * Paths that must never reach the logs. Applied to every logger in the system
 * (Fastify request loggers included) so API keys and tokens cannot leak.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.apiKey',
  '*.api_key',
  '*.authToken',
  '*.token',
  '*.password',
  '*.secret',
  'apiKey',
  'authToken',
  'token',
  'password',
  'secret',
];

/** Query parameters whose values never reach the logs (`?token=` is used by the event stream). */
const SECRET_QUERY_RE = /([?&](?:token|api_?key|key|password|secret)=)[^&#]*/gi;

/** A request URL with secret query values replaced. */
export function redactUrl(url: string): string {
  return url.replace(SECRET_QUERY_RE, '$1[redacted]');
}

interface LoggedRequest {
  method?: string;
  url?: string;
  host?: string;
  hostname?: string;
  ip?: string;
  socket?: { remoteAddress?: string; remotePort?: number };
}

export function loggerOptions(service: ServiceName, level: string): LoggerOptions {
  return {
    level,
    base: { service },
    redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
    // Fastify logs every request's URL; strip secrets from it (same fields as Fastify's own).
    serializers: {
      req(req: LoggedRequest) {
        return {
          method: req.method,
          url: req.url === undefined ? undefined : redactUrl(req.url),
          host: req.host ?? req.hostname,
          remoteAddress: req.ip ?? req.socket?.remoteAddress,
          remotePort: req.socket?.remotePort,
        };
      },
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export function createLogger(service: ServiceName, level: string): Logger {
  return pino(loggerOptions(service, level));
}

export type { Logger };
