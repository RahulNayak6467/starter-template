import { type Logger } from '@starter/logger';
import type { Request, RequestHandler } from 'express';
import * as z from 'zod';

export const REQUEST_ID_HEADER = 'x-request-id';
export const REQUEST_ID_MAX_LENGTH = 128;

export const requestIdSchema = z
  .string()
  .min(1)
  .max(REQUEST_ID_MAX_LENGTH)
  .regex(/^[A-Za-z0-9._-]+$/u);

export interface RequestContext {
  requestId: string;
  readonly clientRequestId: string | undefined;
  readonly logger: Logger;
}

declare global {
  namespace Express {
    interface Request {
      requestContext?: RequestContext;
    }
  }
}

export const requireRequestContext = (request: Request): RequestContext => {
  if (request.requestContext === undefined) {
    throw new Error('requestContext is missing: the request ID middleware must run first');
  }
  return request.requestContext;
};

export const createRequestIdMiddleware = (rootLogger: Logger): RequestHandler => {
  return (request, response, next) => {
    const requestId = crypto.randomUUID();
    const incoming = requestIdSchema.safeParse(request.get(REQUEST_ID_HEADER));
    const clientRequestId = incoming.success ? incoming.data : undefined;

    request.requestContext = {
      requestId,
      clientRequestId,
      logger: rootLogger.child(
        clientRequestId === undefined ? { requestId } : { requestId, clientRequestId },
      ),
    };
    requireRequestContext(request);
    response.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  };
};
