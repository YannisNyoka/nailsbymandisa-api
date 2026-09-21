import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { refreshCookieAttributes } from '../../src/routes/auth.js';

const app = createApp();

const credentials = {
  email: 'route-test@example.com',
  password: 'supersecret123',
  firstName: 'Naledi',
  lastName: 'Dube',
};

function extractCookie(res, name) {
  const raw = res.headers['set-cookie']?.find((c) => c.startsWith(`${name}=`));
  return raw?.split(';')[0];
}

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('refreshCookieAttributes', () => {
  it('uses SameSite=None + Secure in production (Vercel frontend, Render API — genuinely cross-site)', () => {
    expect(refreshCookieAttributes(true)).toEqual({ secure: true, sameSite: 'none' });
  });

  it('uses SameSite=Lax + not-Secure outside production (localhost ports are same-site)', () => {
    expect(refreshCookieAttributes(false)).toEqual({ secure: false, sameSite: 'lax' });
  });
});

describe('POST /api/auth/register', () => {
  it('creates an account and sets an httpOnly refresh cookie', async () => {
    const res = await request(app).post('/api/auth/register').send(credentials);
    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe(credentials.email);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.accessToken).toEqual(expect.any(String));
    const cookie = res.headers['set-cookie']?.find((c) => c.startsWith('refreshToken='));
    expect(cookie).toBeDefined();
    expect(cookie).toMatch(/HttpOnly/i);
    // Outside production, localhost:5173 <-> localhost:4000 count as the same site
    // (SameSite ignores port), so Lax + no Secure is correct here.
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);
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
  it('rotates the refresh cookie, tolerates a benign near-simultaneous reuse, and rejects it after logout', async () => {
    const registerRes = await request(app).post('/api/auth/register').send(credentials);
    const firstCookie = extractCookie(registerRes, 'refreshToken');

    const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', firstCookie);
    expect(refreshRes.status).toBe(200);
    const secondCookie = extractCookie(refreshRes, 'refreshToken');
    expect(secondCookie).not.toBe(firstCookie);

    // A near-simultaneous reuse of the just-rotated cookie (e.g. two browser tabs both
    // refreshing around the same time) is tolerated as a benign race, not treated as
    // theft — it still rotates forward to a new cookie rather than erroring.
    const reuseRes = await request(app).post('/api/auth/refresh').set('Cookie', firstCookie);
    expect(reuseRes.status).toBe(200);
    const thirdCookie = extractCookie(reuseRes, 'refreshToken');

    const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', thirdCookie);
    expect(logoutRes.status).toBe(204);

    const afterLogoutRes = await request(app).post('/api/auth/refresh').set('Cookie', thirdCookie);
    expect(afterLogoutRes.status).toBe(401);
  });
});

describe('POST /api/auth/login', () => {
  it('logs in with correct credentials and rejects wrong ones', async () => {
    await request(app).post('/api/auth/register').send(credentials);

    const ok = await request(app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: credentials.password });
    expect(ok.status).toBe(200);

    const bad = await request(app)
      .post('/api/auth/login')
      .send({ email: credentials.email, password: 'wrong-password' });
    expect(bad.status).toBe(401);
  });
});
