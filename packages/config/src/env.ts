import * as z from 'zod';

export const environmentEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production'], {
    error: (issue) =>
      issue.input === undefined
        ? 'NODE_ENV is required'
        : 'NODE_ENV must be development, test, or production',
  }),
});

export type NodeEnvironment = z.output<typeof environmentEnvSchema>['NODE_ENV'];

export const loggerEnvSchema = z.object({
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: z
    .enum(['true', 'false'], { error: 'LOG_PRETTY must be true or false' })
    .default('false')
    .transform((value) => value === 'true'),
});

type LoggerRuleInput = z.output<typeof environmentEnvSchema> & z.output<typeof loggerEnvSchema>;

// Call from superRefine on the merged schema: spreading .shape drops refinements.
export const applyLoggerRules = (env: LoggerRuleInput, context: z.RefinementCtx): void => {
  if (env.NODE_ENV === 'production' && env.LOG_PRETTY) {
    context.addIssue({
      code: 'custom',
      path: ['LOG_PRETTY'],
      message: 'Pretty logging is not allowed in production',
    });
  }

  if (env.NODE_ENV !== 'test' && env.LOG_LEVEL === 'silent') {
    context.addIssue({
      code: 'custom',
      path: ['LOG_LEVEL'],
      message: 'Silent logging is allowed only during tests',
    });
  }
};
