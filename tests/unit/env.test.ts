import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';

const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/cv_merch_dev' };

describe('loadEnv', () => {
  it('applies defaults', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3001,
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
    });
  });

  it('coerces PORT and splits CORS_ORIGINS', () => {
    const env = loadEnv({ ...base, PORT: '8080', CORS_ORIGINS: 'https://a.it, https://b.com ,' });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['https://a.it', 'https://b.com']);
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => loadEnv({ DATABASE_URL: 'mysql://localhost/db' })).toThrow(/DATABASE_URL/);
  });

  it('requires CORS_ORIGINS in production', () => {
    expect(() => loadEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /CORS_ORIGINS: required in production/,
    );
  });
});
