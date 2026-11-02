export type ERROR_KIND = 'invalid_input' | 'not_found' | 'payload_too_large' | 'internal';

export interface AppErrorOptions {
  readonly kind: ERROR_KIND;
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

export const RETRYABLE_BY_KIND = {
  invalid_input: false,
  not_found: false,
  payload_too_large: false,
  internal: false,
} as const satisfies Record<ERROR_KIND, boolean>;

export class AppError extends Error {
  readonly code: string;
  readonly kind: ERROR_KIND;

  constructor({ kind, code, message, cause }: AppErrorOptions) {
    super(message, cause === undefined ? undefined : { cause });
    this.code = code;
    this.kind = kind;
    this.name = 'AppError';
  }

  get retryable(): boolean {
    return RETRYABLE_BY_KIND[this.kind];
  }
}
