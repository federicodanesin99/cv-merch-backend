import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../lib/errors.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Endpoint non trovato: ${req.method} ${req.path}`));
};

/** Errors raised by express.json() carry an HTTP status and a `type`. */
function isBodyParserError(err: unknown): err is { status: number; type: string } {
  return typeof err === 'object' && err !== null && 'type' in err && 'status' in err;
}

function toAppError(err: unknown): AppError | undefined {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) return new ValidationError(err.issues);
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') return new ConflictError();
    if (err.code === 'P2025') return new NotFoundError();
  }
  if (isBodyParserError(err)) {
    if (err.type === 'entity.too.large')
      return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Richiesta troppo grande');
    if (err.status === 400) return new ValidationError(undefined, 'JSON non valido');
  }
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appError = toAppError(err);
  if (appError) {
    res.status(appError.status).json({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details === undefined ? {} : { details: appError.details }),
      },
    });
    return;
  }
  req.log.error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Errore interno del server' } });
};
