import nodeProcess from 'node:process';

import * as z from 'zod';

export interface ConfigValidationIssue {
  readonly field: string;
  readonly reason: string;
}

export const toConfigValidationIssues = (
  error: unknown,
): readonly ConfigValidationIssue[] | null => {
  if (!(error instanceof z.ZodError)) {
    return null;
  }

  return error.issues.map((issue) => ({
    field: issue.path.length === 0 ? 'configuration' : issue.path.map(String).join('.'),
    reason: issue.message,
  }));
};

export interface ConfigExitTarget {
  readonly stderr: { write(chunk: string): unknown };
  exit(code: number): never;
}

export const loadConfigOrExit = <Config>(
  serviceName: string,
  load: () => Config,
  processTarget: ConfigExitTarget = nodeProcess,
): Config => {
  try {
    return load();
  } catch (error) {
    const issues = toConfigValidationIssues(error);

    if (issues === null) {
      throw error;
    }

    processTarget.stderr.write(
      `${JSON.stringify({
        severity: 'FATAL',
        service: serviceName,
        event: 'config_invalid',
        issues,
        msg: 'Invalid configuration; refusing to start',
      })}\n`,
    );

    return processTarget.exit(1);
  }
};
