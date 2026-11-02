import type { Clock, ERROR_KIND } from '@starter/shared';
import type { RequestHandler, Response } from 'express';

import { requireRequestContext } from './request-id.middleware.js';

type RequestLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ResponseError {
  readonly code: string;
  readonly kind: ERROR_KIND;
}

const responseErrors = new WeakMap<Response, ResponseError>();

export const recordResponseError = (response: Response, error: ResponseError) => {
  responseErrors.set(response, error);
};

export interface RequestLoggerOptions {
  readonly quietPaths?: readonly string[];
}

export const requestLogLevel = (statusCode: number | null): RequestLogLevel => {
  if (statusCode === null) return 'warn';
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
};
export const createRequestLoggerMiddleware = (
  clock: Clock,
  { quietPaths = [] }: RequestLoggerOptions = {},
): RequestHandler => {
  const quiet = new Set(quietPaths);

  return (request, response, next) => {
    const startTime = clock.monotonicMs();
    const { logger } = requireRequestContext(request);
    // Capture the original path before routers change request.path.
    // Omit query parameters because they may contain secrets.
    const path = request.originalUrl.split('?', 1)[0] ?? request.originalUrl;
    let logged = false;

    const log = (aborted: boolean, statusCode: number | null): void => {
      if (logged) return;
      logged = true;

      const durationMs = Math.max(0, clock.monotonicMs() - startTime);
      const isProbe = request.method === 'GET' && quiet.has(path);
      const level = isProbe ? 'debug' : aborted ? 'warn' : requestLogLevel(statusCode);
      const error = responseErrors.get(response);

      logger[level](
        {
          event: 'http_request_completed',
          method: request.method,
          path,
          statusCode,
          durationMs,
          outcome: aborted ? 'aborted' : 'completed',
          ...(error === undefined ? {} : { errorCode: error.code, errorKind: error.kind }),
        },
        aborted ? 'HTTP request aborted' : 'HTTP request completed',
      );
    };

    response.once('finish', () => {
      log(false, response.statusCode);
    });

    response.once('close', () => {
      const aborted = !response.writableFinished;
      log(aborted, aborted && !response.headersSent ? null : response.statusCode);
    });

    next();
  };
};
