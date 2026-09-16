import { getDb } from '../config/db.js';

export const COLLECTION = 'passwordResetTokens';

export const passwordResetTokensJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'tokenHash', 'expiresAt', 'createdAt'],
    properties: {
      userId: { bsonType: 'objectId' },
      tokenHash: { bsonType: 'string' },
      expiresAt: { bsonType: 'date' },
      createdAt: { bsonType: 'date' },
      usedAt: { bsonType: ['date', 'null'] },
    },
  },
};

export const passwordResetTokensIndexes = [
  { key: { tokenHash: 1 }, unique: true, name: 'uniq_token_hash' },
  { key: { userId: 1 }, name: 'idx_user' },
  { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_expires_at' },
];

export function passwordResetTokensCollection() {
  return getDb().collection(COLLECTION);
}
