import { getDb } from '../config/db.js';

export const COLLECTION = 'enquiries';

// Public contact-form submissions (routes/contact.js). Persisted, not just emailed — a
// failed/delayed email (Resend outage, spam-folder) would otherwise silently lose a real
// enquiry with no record it ever happened; this is the source of truth admins can always
// check, the email is just the fast-path notification on top of it.
export const enquiriesJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['name', 'email', 'message', 'isRead', 'createdAt'],
    properties: {
      name: { bsonType: ['string', 'null'] },
      email: { bsonType: 'string' },
      message: { bsonType: 'string' },
      isRead: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
    },
  },
};

export const enquiriesIndexes = [
  { key: { createdAt: -1 }, name: 'idx_created' },
  { key: { isRead: 1, createdAt: -1 }, name: 'idx_unread_created' },
];

export function enquiriesCollection() {
  return getDb().collection(COLLECTION);
}
