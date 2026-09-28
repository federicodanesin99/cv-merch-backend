import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.js';

describe('GET /api/v2/health', () => {
  it('returns 200 when the database answers', async () => {
    const res = await request(buildTestApp()).get('/api/v2/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok' });
  });

  it('returns 503 when the database is down', async () => {
    const app = buildTestApp({ checkDb: () => Promise.reject(new Error('connection refused')) });
    const res = await request(app).get('/api/v2/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'down' });
  });

  it('is also exposed as plain /health for the platform health check', async () => {
    const res = await request(buildTestApp()).get('/health');
    expect(res.status).toBe(200);
  });
});

describe('error handling', () => {
  it('answers unknown routes with a JSON 404', async () => {
    const res = await request(buildTestApp()).get('/api/v2/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Endpoint non trovato: GET /api/v2/nope' },
    });
  });

  it('answers malformed JSON with a 400', async () => {
    const res = await request(buildTestApp())
      .post('/api/v2/health')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('answers oversized bodies with a 413', async () => {
    const res = await request(buildTestApp())
      .post('/api/v2/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200_000) }));
    expect(res.status).toBe(413);
  });
});

describe('CORS', () => {
  it('allows listed origins only', async () => {
    const app = buildTestApp();
    const allowed = await request(app).get('/health').set('Origin', 'https://www.classeveneta.it');
    const denied = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://www.classeveneta.it');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('OpenAPI', () => {
  it('serves a 3.1 document that includes /health', async () => {
    const res = await request(buildTestApp()).get('/api/v2/openapi.json');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ openapi: '3.1.0' });
    expect(res.body).toHaveProperty(['paths', '/health']);
  });

  it('serves the docs UI', async () => {
    const res = await request(buildTestApp()).get('/api/v2/docs/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
