import { getDb } from '../config/db.js';
import { ROLES } from '../config/constants.js';

export const COLLECTION = 'users';

export const usersJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['email', 'passwordHash', 'firstName', 'lastName', 'role', 'isActive', 'createdAt', 'updatedAt'],
    properties: {
      email: { bsonType: 'string', pattern: '^.+@.+\\..+$' },
      passwordHash: { bsonType: 'string' },
      firstName: { bsonType: 'string', minLength: 1 },
      lastName: { bsonType: 'string', minLength: 1 },
      phone: { bsonType: ['string', 'null'] },
      role: { enum: Object.values(ROLES) },
      // Only meaningful when role === 'admin' — §4.2 requires granular checks, never a
      // single global "is admin" boolean, so an admin's actual access is this list.
      permissions: { bsonType: 'array', items: { bsonType: 'string' } },
      // Only meaningful when role === 'staff' — links the login to the employees record
      // that identifies which appointments/schedule/overview belong to them, so the admin
      // panel can be scoped to just their own data (see requirePermissionOrStaffSelf).
      employeeId: { bsonType: ['objectId', 'null'] },
      isActive: { bsonType: 'bool' },
      emailVerified: { bsonType: 'bool' },
      referralCode: { bsonType: ['string', 'null'] },
      referredBy: { bsonType: ['objectId', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      lastLoginAt: { bsonType: ['date', 'null'] },
    },
  },
};

export const usersIndexes = [
  { key: { email: 1 }, unique: true, name: 'uniq_email' },
  { key: { referralCode: 1 }, unique: true, sparse: true, name: 'uniq_referral_code' },
];

export function usersCollection() {
  return getDb().collection(COLLECTION);
}

// Never project passwordHash out to a client response — §5.10. Callers that need the
// full document (e.g. auth service verifying a password) use usersCollection() directly;
// everything else should go through this projection.
export const PUBLIC_PROJECTION = {
  passwordHash: 0,
};

export function toPublicUser(user) {
  if (!user) return null;
  // eslint-disable-next-line no-unused-vars
  const { passwordHash, ...rest } = user;
  return rest;
}
