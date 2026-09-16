import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import * as clientNotificationsService from '../../src/services/clientNotificationsService.js';
import { ROLES } from '../../src/config/constants.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('notifications', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/notifications');
    expect(res.status).toBe(401);
  });

  it('lists only the caller\'s own notifications with an unread count', async () => {
    const { userId, accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { userId: otherUserId } = await createUserAndToken({ role: ROLES.CUSTOMER });

    await clientNotificationsService.createClientNotification({
      userId,
      type: 'booking_confirmed',
      title: 'Booking confirmed',
      body: 'See you soon!',
    });
    await clientNotificationsService.createClientNotification({
      userId: otherUserId,
      type: 'booking_confirmed',
      title: 'Not yours',
      body: 'Should not appear',
    });

    const res = await request(app).get('/api/notifications').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.notifications[0].title).toBe('Booking confirmed');
  });

  it('marks a notification read and rejects marking someone else\'s', async () => {
    const { userId, accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: strangerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const notification = await clientNotificationsService.createClientNotification({
      userId,
      type: 'booking_confirmed',
      title: 'Booking confirmed',
      body: 'See you soon!',
    });

    const strangerRes = await request(app)
      .patch(`/api/notifications/${notification._id}/read`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(strangerRes.status).toBe(404);

    const ownerRes = await request(app)
      .patch(`/api/notifications/${notification._id}/read`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(ownerRes.status).toBe(204);

    const list = await request(app).get('/api/notifications').set('Authorization', `Bearer ${accessToken}`);
    expect(list.body.unreadCount).toBe(0);
  });
});
