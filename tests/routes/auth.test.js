import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';

const app = createApp();

const credentials = {
  email: 'route-test@example.com',
  password: 'supersecret123',
  firstName: 'Naledi',
  lastName: 'Dube',
};

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('POST /api/auth/register', () => {
  it('creates an account and returns a refresh token in the body', async () => {
    const res = await request(app).post('/api/auth/register').send(credentials);
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(credentials.email);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.refreshToken).toEqual(expect.any(String));
    // Never a cookie — a real repro showed mobile browsers silently refusing to store/send
    // a cookie set by a different domain than the one being browsed (Vercel frontend,
    // Render API), so the frontend now holds this token itself instead.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a short password with 400', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...credentials, password: 'short' });
    expect(res.status).toBe(400);
  });

  it('rejects a duplicate email with 409', async () => {
    await request(app).post('/api/auth/register').send(credentials);
    const res = await request(app).post('/api/auth/register').send(credentials);
    expect(res.status).toBe(409);
  });
});

describe('GET /api/auth/me', () => {
  it('rejects a request with no access token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  it('returns the current user for a valid access token', async () => {
    const registerRes = await request(app).post('/api/auth/register').send(credentials);
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${registerRes.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(credentials.email);
  });
});

describe('POST /api/auth/refresh + /api/auth/logout', () => {
  it('rejects a refresh with no token in the body', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(400);
  });

  it('rotates the refresh token, tolerates a benign near-simultaneous reuse, and rejects it after logout', async () => {
    const registerRes = await request(app).post('/api/auth/register').send(credentials);
    const firstToken = registerRes.body.refreshToken;

    const refreshRes = await request(app).post('/api/auth/refresh').send({ refreshToken: firstToken });
    expect(refreshRes.status).toBe(200);
    const secondToken = refreshRes.body.refreshToken;
    expect(secondToken).not.toBe(firstToken);

    // A near-simultaneous reuse of the just-rotated token (e.g. two browser tabs both
    // refreshing around the same time) is tolerated as a benign race, not treated as
    // theft — it still rotates forward to a new token rather than erroring.
    const reuseRes = await request(app).post('/api/auth/refresh').send({ refreshToken: firstToken });
    expect(reuseRes.status).toBe(200);
    const thirdToken = reuseRes.body.refreshToken;

    const logoutRes = await request(app).post('/api/auth/logout').send({ refreshToken: thirdToken });
    expect(logoutRes.status).toBe(204);

    const afterLogoutRes = await request(app).post('/api/auth/refresh').send({ refreshToken: thirdToken });
    expect(afterLogoutRes.status).toBe(401);
  });

  it('logout no-ops cleanly with no stored token (e.g. already-lost session)', async () => {
    const res = await request(app).post('/api/auth/logout').send({});
    expect(res.status).toBe(204);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials and rejects wrong ones', async () => {
    await request(app).post('/api/auth/register').send(credentials);

    const ok = await request(app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    expect(ok.status).toBe(200);
    expect(ok.body.refreshToken).toEqual(expect.any(String));

    const bad = await request(app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
  });
});
