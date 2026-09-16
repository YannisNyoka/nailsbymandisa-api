import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('POST /api/client-gallery + moderation queue', () => {
  it('rejects a non-admin reading the moderation queue', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app).get('/api/client-gallery/queue').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('a pending submission is not visible on the public list, only after approval', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const submitRes = await request(app)
      .post('/api/client-gallery')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ imageUrl: 'https://example.com/before-after.jpg' });
    expect(submitRes.status).toBe(201);

    const publicListBefore = await request(app).get('/api/client-gallery');
    expect(publicListBefore.body.submissions).toHaveLength(0);

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_GALLERY] });
    const moderateRes = await request(app)
      .patch(`/api/client-gallery/${submitRes.body.submission._id}/moderate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'approved' });
    expect(moderateRes.status).toBe(200);

    const publicListAfter = await request(app).get('/api/client-gallery');
    expect(publicListAfter.body.submissions).toHaveLength(1);
  });
});
