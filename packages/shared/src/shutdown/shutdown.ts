export type ShutdownReason = 'SIGTERM' | 'SIGINT' | 'uncaught_exception' | 'unhandled_rejection';

type ShutdownState = 'running' | 'shutting-down' | 'stopped';

let state: ShutdownState = 'running';

let failed = false;

export const isDraining = (): boolean => state !== 'running';

export interface ShutdownLogger {
  fatal(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export type Steps = {
  name: string;
  run: () => Promise<void>;
}[];

export const cleanupResources = async (logger: ShutdownLogger, steps: Steps) => {
  for (const step of steps) {
    try {
      await step.run();
      logger.info({ event: 'step_done', step: step.name }, 'Step done');
    } catch (error) {
      failed = true;
      logger.error({ event: 'step_failed', step: step.name, err: error }, 'Step failed');
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
};

export type CrashReason = 'uncaught_exception' | 'unhandled_rejection';

export const handleCrash = async (
  crash: CrashReason,
  error: unknown,
  logger: ShutdownLogger,
  steps: Steps,
  timeoutMs: number,
): Promise<void> => {
  if (crash === 'uncaught_exception') {
    logger.fatal({ event: 'uncaught_exception', err: error }, 'Uncaught exception; shutting down');
  } else if (crash === 'unhandled_rejection') {
    logger.fatal(
      { event: 'unhandled_rejection', err: error },
      'Unhandled promise rejection; shutting down',
    );
  }
  process.exitCode = 1;
  await handleShutdown(crash, logger, steps, timeoutMs);
};

export const handleShutdown = async (
  signal: ShutdownReason,
  logger: ShutdownLogger,
  steps: Steps,
  timeoutMs: number,
) => {
  if (state === 'shutting-down') {
    logger.warn({ event: 'prevent_duplicate_shutdown' }, 'Preventing duplicate shutdown');
    return;
  }
  if (state === 'stopped') {
    logger.warn({ event: 'server_already_shutdown' }, 'Server already shutdown');
    return;
  }
  state = 'shutting-down';

  logger.info({ event: 'shutdown_signal_received' }, `${signal} received`);

  const timeout = setTimeout(() => {
    logger.error(
      { event: 'shutdown_deadline_exceeded', timeoutMs },
      'Shutdown deadline exceeded forcing exit',
    );
    process.exit(1);
  }, timeoutMs);

  try {
    await cleanupResources(logger, steps);
    state = 'stopped';

    logger.info({ event: 'server_shutdown_successfully' }, 'server graceful shutdown successful');
  } catch (error) {
    logger.error({ event: 'shutdown_failed', error }, 'Server shutdown failed');
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
  }
};

export const installShutdownHandlers = (
  logger: ShutdownLogger,
  steps: Steps,
  timeoutMs: number,
) => {
  process.on('SIGINT', () => void handleShutdown('SIGINT', logger, steps, timeoutMs));
  process.on('SIGTERM', () => void handleShutdown('SIGTERM', logger, steps, timeoutMs));
  process.on('uncaughtException', (error) => {
    void handleCrash('uncaught_exception', error, logger, steps, timeoutMs);
  });
  process.on('unhandledRejection', (reason) => {
    void handleCrash('unhandled_rejection', reason, logger, steps, timeoutMs);
  });
};
