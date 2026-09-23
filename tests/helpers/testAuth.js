import { usersCollection } from '../../src/models/users.js';
import { signAccessToken } from '../../src/utils/jwt.js';
import { ROLES } from '../../src/config/constants.js';

// Test-only shortcut for getting an authenticated request without going through the
// full register/login flow — inserts a user directly (role/permissions as given) and
// signs a real access token for it, matching what authenticate() middleware expects.
export async function createUserAndToken({
  role = ROLES.CUSTOMER,
  permissions = [],
  employeeId = null,
  firstName = 'Test',
  lastName = 'User',
} = {}) {
  const now = new Date();
  const { insertedId } = await usersCollection().insertOne({
    email: `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    passwordHash: 'not-a-real-hash',
    firstName,
    lastName,
    phone: null,
    role,
    permissions,
    employeeId,
    isActive: true,
    emailVerified: true,
    // Unique per call, not null — referralCode is unique+sparse in real Mongo, and a
    // *sparse* index still indexes an explicit null (only a genuinely missing field is
    // skipped), so a fixed `null` here would only let one caller register per test run
    // once a test also enables usersIndexes (see admin.test.js's invite regression test).
    referralCode: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    referredBy: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });
  return { userId: insertedId, accessToken: signAccessToken(insertedId) };
}
