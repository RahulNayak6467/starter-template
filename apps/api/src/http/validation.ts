import type * as z from 'zod';

export class RequestValidationError extends Error {
  readonly issues: z.ZodError['issues'];

  constructor(issues: z.ZodError['issues']) {
    super('Request validation failed');
    this.name = 'RequestValidationError';
    this.issues = issues;
  }
}

export const parseRequest = <Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> => {
  const result = schema.safeParse(input);
  if (!result.success) throw new RequestValidationError(result.error.issues);
  return result.data;
};
