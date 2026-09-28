import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Env } from './config/env.js';
import type { Logger } from './lib/logger.js';
import { buildOpenApiDocument, OpenAPIRegistry } from './lib/openapi.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import {
  healthRouter,
  registerHealthDocs,
  type HealthDeps,
} from './modules/health/health.routes.js';

export interface AppDeps extends HealthDeps {
  env: Pick<Env, 'CORS_ORIGINS'>;
  logger: Logger;
}

/** Builds the Express app. No I/O here: everything external arrives through deps (tests pass stubs). */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.set('trust proxy', 1); // Render sits behind one proxy: req.ip = client IP
  app.use(pinoHttp({ logger: deps.logger }));
  app.use(helmet());
  app.use(cors({ origin: deps.env.CORS_ORIGINS }));
  app.use(express.json({ limit: '100kb' }));

  const registry = new OpenAPIRegistry();
  registerHealthDocs(registry);
  const openApiDocument = buildOpenApiDocument(registry);

  const v2 = express.Router();
  v2.use(healthRouter(deps));
  v2.get('/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  v2.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.use('/api/v2', v2);
  app.use(healthRouter(deps)); // plain /health for Render health check and keep-alive

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
