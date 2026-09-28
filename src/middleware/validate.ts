import type { RequestHandler } from 'express';
import type { z } from 'zod';

interface Schemas {
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
}

/**
 * Validates and replaces req.body / req.query / req.params with the parsed values.
 * A ZodError propagates to the error handler (→ 400).
 */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    if (schemas.params) req.params = schemas.params.parse(req.params) as typeof req.params;
    if (schemas.body) req.body = schemas.body.parse(req.body);
    if (schemas.query) {
      // Express 5: req.query is a getter on the prototype, plain assignment throws.
      Object.defineProperty(req, 'query', { value: schemas.query.parse(req.query) });
    }
    next();
  };
}
