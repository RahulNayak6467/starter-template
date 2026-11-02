import { checkDatabaseHealth, type Pool } from '@starter/database';
import type { Logger } from '@starter/logger';

type FailureReason = 'database_unavailable' | 'redis_unavailable' | 'timeout';

type DependencyResult =
  | { readonly status: 'ready' }
  | {
      readonly status: 'not_ready';
      readonly reason: Exclude<FailureReason, 'timeout'>;
      readonly error: unknown;
    };

export type ReadinessResult =
  | { readonly status: 'ready' }
  | { readonly status: 'not_ready'; readonly reason: 'draining' | FailureReason };

export type ReadinessChecker = () => Promise<ReadinessResult>;

export interface ReadinessOptions {
  readonly databasePool: Pick<Pool, 'query'>;
  readonly checkRedis: () => Promise<unknown>;
  readonly isDraining: () => boolean;
  readonly timeoutMs: number;
  readonly logger: Pick<Logger, 'warn' | 'info'>;
}

export const createReadinessChecker = ({
  databasePool,
  checkRedis,
  isDraining,
  timeoutMs,
  logger,
}: ReadinessOptions): ReadinessChecker => {
  // Overlapping probes share dependency checks, so a slow dependency can't exhaust clients.
  let inFlight: Promise<DependencyResult> | undefined;
  let failing = false;

  const sharedDependencyCheck = (): Promise<DependencyResult> => {
    if (inFlight !== undefined) return inFlight;

    const check = (async (): Promise<DependencyResult> => {
      const [database, redis] = await Promise.allSettled([
        checkDatabaseHealth(databasePool),
        Promise.resolve().then(checkRedis),
      ]);
      if (database.status === 'rejected') {
        return { status: 'not_ready', reason: 'database_unavailable', error: database.reason };
      }
      if (redis.status === 'rejected') {
        return { status: 'not_ready', reason: 'redis_unavailable', error: redis.reason };
      }
      return { status: 'ready' };
    })();
    inFlight = check;
    const clear = () => {
      if (inFlight === check) inFlight = undefined;
    };
    void check.then(clear, clear);
    return check;
  };

  const fail = (reason: FailureReason, error?: unknown): ReadinessResult => {
    if (!failing) {
      failing = true;
      logger.warn(
        {
          event: 'readiness_failed',
          reason,
          ...(reason === 'timeout' ? { timeoutMs } : {}),
          ...(error === undefined ? {} : { err: error }),
        },
        'Readiness check started failing',
      );
    }
    return { status: 'not_ready', reason };
  };

  const succeed = (): ReadinessResult => {
    if (failing) {
      failing = false;
      logger.info({ event: 'readiness_recovered' }, 'Readiness check recovered');
    }
    return { status: 'ready' };
  };

  return async () => {
    if (isDraining()) return { status: 'not_ready', reason: 'draining' };

    let timer: NodeJS.Timeout | undefined;
    try {
      // The deadline doesn't cancel the query; statement_timeout and query_timeout bound it.
      const deadline = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([sharedDependencyCheck(), deadline]);
      if (isDraining()) return { status: 'not_ready', reason: 'draining' };
      if (outcome === 'timeout') return fail('timeout');
      return outcome.status === 'not_ready' ? fail(outcome.reason, outcome.error) : succeed();
    } catch (error) {
      return fail('database_unavailable', error);
    } finally {
      clearTimeout(timer);
    }
  };
};
