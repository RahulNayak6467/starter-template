import pino, { type Level, type Logger } from 'pino';

import { serializeError } from './error-serializer.js';
import { createRedactionOptions } from './redaction.js';

export type LogLevel = Level | 'silent';

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly pretty: boolean;
  readonly service: string;
  readonly environment: string;
}

export const createLogger = (options: LoggerOptions): Logger =>
  pino({
    level: options.level,
    ...(options.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname',
              messageFormat: '{msg}',
              colorizeObjects: true,
            },
          },
        }
      : {
          formatters: {
            level: (label: string) => ({ severity: label.toUpperCase() }),
          },
        }),
    base: {
      service: options.service,
      env: options.environment,
    },
    serializers: {
      err: serializeError,
      error: serializeError,
    },
    redact: createRedactionOptions(),
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'msg',
  });
