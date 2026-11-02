import { createLogger } from '@starter/logger';
import { vi } from 'vitest';

export type LogRecord = Record<string, unknown>;

const isLogRecord = (value: unknown): value is LogRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const silentLogger = () =>
  createLogger({ level: 'silent', pretty: false, service: 'test', environment: 'test' });

export const captureLogs = () => {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
  const logger = createLogger({
    level: 'debug',
    pretty: false,
    service: 'test',
    environment: 'test',
  });

  const raw = () => chunks.join('');
  const records = (): LogRecord[] =>
    raw()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        const parsed: unknown = JSON.parse(line);

        if (!isLogRecord(parsed)) {
          throw new Error('Expected a structured JSON log object');
        }

        return parsed;
      });

  return { logger, raw, records };
};
