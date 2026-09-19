import request from 'supertest';
import { createApp } from '../src/app.js';
import { setTestDb } from '../src/config/db.js';
import { createFakeDb } from './helpers/fakeDb.js';

describe('app scaffold', () => {
  const app = createApp();

  beforeEach(() => {
    setTestDb(createFakeDb());
  });

  it('responds to /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('responds to /api/status', async () => {
    const res = await request(app).get('/api/status');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('responds to /api/health with a real DB ping', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ name: 'nailsbymandisa-api', status: 'ok', db: 'ok' });
  });

  it('returns 404 for unknown routes without leaking internals', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Route not found');
  });
});
