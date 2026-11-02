import { AppError } from '@starter/shared';
import type { RequestHandler } from 'express';

export const notFoundMiddleware: RequestHandler = (_req, res, next) => {
  next(
    new AppError({
      kind: 'not_found',
      code: 'ROUTE_NOT_FOUND',
      message: 'Route not found',
    }),
  );
};

export const createBodyLimitMiddleware =
  (limitBytes: number): RequestHandler =>
  (req, res, next) => {
    const declared = req.headers['content-length'];
    if (declared === undefined || Number(declared) <= limitBytes) {
      next();
      return;
    }

    res.setHeader('Connection', 'close');
    next(
      new AppError({
        kind: 'payload_too_large',
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
      }),
    );
  };
