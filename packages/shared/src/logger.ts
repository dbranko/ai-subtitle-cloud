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

export function loggerOptions(service: ServiceName, level: string): LoggerOptions {
  return {
    level,
    base: { service },
    redact: { paths: REDACTED_LOG_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

export function createLogger(service: ServiceName, level: string): Logger {
  return pino(loggerOptions(service, level));
}

export type { Logger };
