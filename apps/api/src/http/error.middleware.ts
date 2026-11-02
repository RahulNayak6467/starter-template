import { serializeError, type Logger } from '@starter/logger';
import { AppError, RETRYABLE_BY_KIND, type ERROR_KIND } from '@starter/shared';
import type { Request, Response, NextFunction } from 'express';
import * as z from 'zod';
import { recordResponseError } from './request-logger.middleware.js';
import { RequestValidationError } from './validation.js';

const STATUS_BY_KIND = {
  invalid_input: 400,
  not_found: 404,
  payload_too_large: 413,
  internal: 500,
} as const satisfies Record<ERROR_KIND, number>;

const MAX_ISSUES = 10;
const MAX_ISSUE_TEXT_LENGTH = 200;

interface BodyParserErrorDefinition {
  kind: ERROR_KIND;
  code: string;
  message: string;
}

const BODY_PARSER_ERRORS: Record<string, BodyParserErrorDefinition> = {
  'entity.parse.failed': {
    kind: 'invalid_input',
    code: 'INVALID_JSON',
    message: 'Request body is not valid JSON',
  },
  'entity.too.large': {
    kind: 'payload_too_large',
    code: 'PAYLOAD_TOO_LARGE',
    message: 'Request body is too large',
  },
  'encoding.unsupported': {
    kind: 'invalid_input',
    code: 'UNSUPPORTED_CONTENT_ENCODING',
    message: 'Request Content-Encoding is not supported',
  },
  'charset.unsupported': {
    kind: 'invalid_input',
    code: 'UNSUPPORTED_CHARSET',
    message: 'Request charset is not supported',
  },
  'request.aborted': {
    kind: 'invalid_input',
    code: 'REQUEST_ABORTED',
    message: 'Request was aborted by the client',
  },
  'request.size.invalid': {
    kind: 'invalid_input',
    code: 'INVALID_REQUEST_BODY',
    message: 'Request body size does not match Content-Length',
  },
};

const toBodyParserError = (error: unknown): AppError | undefined => {
  if (typeof error !== 'object' || error === null || !('type' in error)) {
    return undefined;
  }

  const type = error.type;
  if (typeof type !== 'string') {
    return undefined;
  }

  const definition = BODY_PARSER_ERRORS[type];
  if (definition !== undefined) {
    return new AppError(definition);
  }

  const isOtherClientError =
    'status' in error &&
    typeof error.status === 'number' &&
    error.status >= 400 &&
    error.status < 500 &&
    'expose' in error &&
    error.expose === true;

  if (isOtherClientError) {
    return new AppError({
      kind: 'invalid_input',
      code: 'INVALID_REQUEST_BODY',
      message: 'Request body could not be read',
    });
  }

  return undefined;
};

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      requestId: z.string().nullable(),
      retryable: z.boolean().meta({
        description: 'Whether the same request may succeed if retried later.',
      }),
      issues: z
        .array(z.object({ path: z.string(), message: z.string() }))
        .max(MAX_ISSUES)
        .optional(),
    }),
  })
  .meta({
    id: 'ErrorResponse',
    description: 'Every error response. `issues` is present only for request validation errors.',
  });

type ErrorResponse = z.infer<typeof errorResponseSchema>;
type ValidationIssue = NonNullable<ErrorResponse['error']['issues']>[number];

const truncate = (text: string, maxLength: number): string =>
  text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;

const internalErrorResponse = (requestId: string | null): ErrorResponse => ({
  error: {
    code: 'INTERNAL_ERROR',
    message: 'Internal error',
    requestId,
    retryable: RETRYABLE_BY_KIND.internal,
  },
});

const mapToPublicError = (
  error: unknown,
  requestId: string | null,
  issues?: ValidationIssue[],
): ErrorResponse => {
  if (error instanceof AppError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        requestId,
        retryable: error.retryable,
        ...(issues === undefined ? {} : { issues }),
      },
    };
  }
  return internalErrorResponse(requestId);
};

const logHandledError = (
  logger: Logger,
  res: Response,
  appError: AppError,
  status: number,
): void => {
  recordResponseError(res, { code: appError.code, kind: appError.kind });
  if (status < 500) return;

  logger.error(
    {
      event: 'request_failed',
      code: appError.code,
      kind: appError.kind,
      status,
      errorDetails: serializeError(appError),
    },
    'Request failed',
  );
};

const handleError = (
  rootLogger: Logger,
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const logger = req.requestContext?.logger ?? rootLogger;

  if (res.headersSent) {
    logger.error(
      { event: 'error_after_response_started', errorDetails: serializeError(error) },
      'Error after the response had started',
    );
    next(error);
    return;
  }
  const requestId = req.requestContext?.requestId ?? null;

  if (error instanceof AppError) {
    const status = STATUS_BY_KIND[error.kind];
    logHandledError(logger, res, error, status);
    res.status(status).json(mapToPublicError(error, requestId));
    return;
  }

  const bodyParserError = toBodyParserError(error);
  if (bodyParserError !== undefined) {
    const status = STATUS_BY_KIND[bodyParserError.kind];
    logHandledError(logger, res, bodyParserError, status);
    res.status(status).json(mapToPublicError(bodyParserError, requestId));
    return;
  }

  if (error instanceof RequestValidationError) {
    const issues = error.issues.slice(0, MAX_ISSUES).map((issue) => ({
      path: truncate(issue.path.join('.'), MAX_ISSUE_TEXT_LENGTH),
      message: truncate(issue.message, MAX_ISSUE_TEXT_LENGTH),
    }));
    const validationError = new AppError({
      kind: 'invalid_input',
      code: 'INVALID_INPUT',
      message: 'Request validation failed',
    });

    const status = STATUS_BY_KIND.invalid_input;
    logHandledError(logger, res, validationError, status);
    res.status(status).json(mapToPublicError(validationError, requestId, issues));
    return;
  }

  recordResponseError(res, { code: 'INTERNAL_ERROR', kind: 'internal' });
  logger.error(
    { event: 'request_failed_unexpectedly', errorDetails: serializeError(error) },
    'Unexpected error while handling request',
  );
  res.status(STATUS_BY_KIND.internal).json(mapToPublicError(error, requestId));
};

export const createErrorMiddleware =
  (rootLogger: Logger) => (error: unknown, req: Request, res: Response, next: NextFunction) => {
    try {
      handleError(rootLogger, error, req, res, next);
    } catch {
      const requestId = req.requestContext?.requestId ?? null;

      if (!res.headersSent) {
        recordResponseError(res, { code: 'INTERNAL_ERROR', kind: 'internal' });
        res.status(STATUS_BY_KIND.internal).json(internalErrorResponse(requestId));
      }

      (req.requestContext?.logger ?? rootLogger).error(
        { event: 'error_middleware_failed' },
        'Error middleware failed while handling an error',
      );
    }
  };
