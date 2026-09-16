import pino from 'pino';
import { env } from './env.js';

// Pretty-printing spins up a worker thread — only worth it in local dev. Production
// wants JSON on stdout for log aggregation, and tests want neither (the worker thread
// otherwise leaks an open handle past the test run).
const usePrettyTransport = env.NODE_ENV === 'development';

export const logger = pino({
  level: env.LOG_LEVEL,
  transport: usePrettyTransport
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      }
    : undefined,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.token',
    ],
    remove: true,
  },
});
