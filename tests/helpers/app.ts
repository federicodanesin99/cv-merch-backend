import { pino } from 'pino';
import { createApp, type AppDeps } from '../../src/app.js';

export function buildTestApp(overrides: Partial<AppDeps> = {}) {
  return createApp({
    env: { CORS_ORIGINS: ['https://www.classeveneta.it'] },
    logger: pino({ level: 'silent' }),
    checkDb: () => Promise.resolve(),
    ...overrides,
  });
}
