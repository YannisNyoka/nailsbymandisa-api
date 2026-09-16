import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createUserAndToken } from '../helpers/testAuth.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('POST /api/uploads/image', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/uploads/image').attach('file', Buffer.from('fake'), { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-image file with a clean 400', async () => {
    const { accessToken } = await createUserAndToken();
    const res = await request(app)
      .post('/api/uploads/image')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
  });

  it('rejects a request with no file', async () => {
    const { accessToken } = await createUserAndToken();
    const res = await request(app).post('/api/uploads/image').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  // Cloudinary is never configured in the test environment (no real credentials to test
  // against) — this confirms the "not configured" path fails loudly with a clear 503
  // rather than a confusing crash deeper in the SDK, per config/cloudinaryClient.js.
  it('returns a clean 503 when Cloudinary is not configured, for an otherwise-valid image', async () => {
    const { accessToken } = await createUserAndToken();
    const res = await request(app)
      .post('/api/uploads/image')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('UPLOADS_NOT_CONFIGURED');
  });
});
