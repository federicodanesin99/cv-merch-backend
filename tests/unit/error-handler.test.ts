import express from 'express';
import { pino } from 'pino';
import { pinoHttp } from 'pino-http';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConflictError } from '../../src/lib/errors.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { validate } from '../../src/middleware/validate.js';

function appWith(register: (app: express.Express) => void) {
  const app = express();
  app.use(pinoHttp({ logger: pino({ level: 'silent' }) }));
  app.use(express.json());
  register(app);
  app.use(errorHandler);
  return app;
}

describe('errorHandler', () => {
  it('maps AppError subclasses to their status and code', async () => {
    const app = appWith((a) =>
      a.get('/boom', () => {
        throw new ConflictError();
      }),
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('hides unexpected errors behind a generic 500', async () => {
    const app = appWith((a) =>
      a.get('/boom', () => {
        throw new Error('secret connection string');
      }),
    );
    const res = await request(app).get('/boom');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Errore interno del server' },
    });
    expect(res.text).not.toContain('secret');
  });

  it('catches rejected promises from async handlers (Express 5)', async () => {
    const app = appWith((a) =>
      a.get('/async', async () => {
        await Promise.resolve();
        throw new ConflictError();
      }),
    );
    const res = await request(app).get('/async');
    expect(res.status).toBe(409);
  });
});

describe('validate', () => {
  const app = appWith((a) =>
    a.post(
      '/items',
      validate({
        body: z.object({ quantity: z.number().int().min(1).max(20) }),
        query: z.object({ page: z.coerce.number().int().min(1).default(1) }),
      }),
      (req, res) => {
        res.json({ body: req.body as unknown, query: req.query });
      },
    ),
  );

  it('passes parsed values to the handler', async () => {
    const res = await request(app).post('/items?page=3').send({ quantity: 2 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ body: { quantity: 2 }, query: { page: 3 } });
  });

  it('rejects invalid input with 400 and the zod issues', async () => {
    const res = await request(app).post('/items').send({ quantity: -1 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: { code: 'VALIDATION_ERROR', details: [{ path: ['quantity'] }] },
    });
  });
});
