import { Router } from 'express';
import { z } from 'zod';
import type { OpenAPIRegistry } from '../../lib/openapi.js';

export interface HealthDeps {
  /** Resolves if the database answers, rejects otherwise. */
  checkDb: () => Promise<void>;
}

const HealthResponseSchema = z
  .object({
    status: z.enum(['ok', 'degraded']),
    db: z.enum(['ok', 'down']),
    timestamp: z.iso.datetime(),
  })
  .meta({ id: 'HealthResponse' });

type HealthResponse = z.infer<typeof HealthResponseSchema>;

export function registerHealthDocs(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/health',
    summary: 'Stato del servizio e del database',
    tags: ['ops'],
    responses: {
      200: {
        description: 'Servizio e database ok',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
      503: {
        description: 'Database non raggiungibile',
        content: { 'application/json': { schema: HealthResponseSchema } },
      },
    },
  });
}

export function healthRouter({ checkDb }: HealthDeps): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const dbOk = await checkDb().then(
      () => true,
      () => false,
    );
    const body: HealthResponse = {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'down',
      timestamp: new Date().toISOString(),
    };
    res.status(dbOk ? 200 : 503).json(body);
  });

  return router;
}
