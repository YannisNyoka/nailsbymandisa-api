import { getDb } from '../config/db.js';

export const COLLECTION = 'refreshTokens';

export const refreshTokensJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'tokenHash', 'family', 'expiresAt', 'createdAt'],
    properties: {
      userId: { bsonType: 'objectId' },
      tokenHash: { bsonType: 'string' },
      // Tokens issued from the same login are chained by `family`. Presenting a token
      // that's already been rotated away (revoked but not the current tip of its family)
      // means it was stolen — see authService.refresh() — so the whole family gets revoked.
      family: { bsonType: 'string' },
      expiresAt: { bsonType: 'date' },
      createdAt: { bsonType: 'date' },
      revokedAt: { bsonType: ['date', 'null'] },
      replacedByTokenHash: { bsonType: ['string', 'null'] },
    },
  },
};

export const refreshTokensIndexes = [
  { key: { tokenHash: 1 }, unique: true, name: 'uniq_token_hash' },
  { key: { userId: 1 }, name: 'idx_user' },
  { key: { family: 1 }, name: 'idx_family' },
  // TTL index — Mongo auto-deletes expired tokens; no cron/cleanup job needed.
  { key: { expiresAt: 1 }, expireAfterSeconds: 0, name: 'ttl_expires_at' },
];

export function refreshTokensCollection() {
  return getDb().collection(COLLECTION);
}
