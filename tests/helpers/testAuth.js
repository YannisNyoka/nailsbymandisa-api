import { usersCollection } from '../../src/models/users.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { ROLES } from '../../src/config/constants.js';

// Test-only shortcut for getting an authenticated request without going through the
// full register/login flow — inserts a user directly (role/permissions as given) and
// signs a real access token for it, matching what authenticate() middleware expects.
export async function createUserAndToken({ role = ROLES.CUSTOMER, permissions = [] } = {}) {
  const now = new Date();
  const { insertedId } = await usersCollection().insertOne({
    email: `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'not-a-real-hash',
    firstName: 'Test',
    lastName: 'User',
    phone: null,
    role,
    permissions,
    isActive: true,
    emailVerified: true,
    referralCode: null,
    referredBy: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });
  return { userId: insertedId, accessToken: signAccessToken(insertedId) };
}
