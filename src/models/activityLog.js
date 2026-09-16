import { getDb } from '../config/db.js';

export const COLLECTION = 'activityLog';

// Internal admin activity feed (§4.12) — distinct from clientNotifications.js, which is
// the customer-facing notification center. Named activityLog (not "notifications", the
// name used in the project brief's data model list) specifically to avoid colliding with
// the already-built customer-facing /api/notifications route.
export const activityLogJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['type', 'message', 'createdAt'],
    properties: {
      type: { bsonType: 'string' },
      message: { bsonType: 'string' },
      actorUserId: { bsonType: ['objectId', 'null'] },
      metadata: { bsonType: ['object', 'null'] },
      createdAt: { bsonType: 'date' },
    },
  },
};

export const activityLogIndexes = [{ key: { createdAt: -1 }, name: 'idx_created' }];

export function activityLogCollection() {
  return getDb().collection(COLLECTION);
}
