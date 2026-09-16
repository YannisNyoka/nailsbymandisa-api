import { getDb } from '../config/db.js';

export const COLLECTION = 'clientNotifications';

// Customer-facing in-app notification center (§4.11). Distinct from the admin activity
// feed (NOTIFICATIONS, built alongside the admin dashboard) — this collection is what a
// logged-in customer sees in their own notification center.
export const CLIENT_NOTIFICATION_TYPES = Object.freeze([
  'booking_confirmed',
  'booking_cancelled',
  'payment_failed',
  'admin_message',
  'broadcast',
]);

export const clientNotificationsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'type', 'title', 'body', 'isRead', 'createdAt'],
    properties: {
      userId: { bsonType: 'objectId' },
      type: { enum: CLIENT_NOTIFICATION_TYPES },
      title: { bsonType: 'string' },
      body: { bsonType: 'string' },
      link: { bsonType: ['string', 'null'] },
      isRead: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
    },
  },
};

export const clientNotificationsIndexes = [
  { key: { userId: 1, createdAt: -1 }, name: 'idx_user_created' },
  { key: { userId: 1, isRead: 1 }, name: 'idx_user_unread' },
];

export function clientNotificationsCollection() {
  return getDb().collection(COLLECTION);
}
