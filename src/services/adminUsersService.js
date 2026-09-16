import bcrypt from 'bcrypt';
import { ObjectId } from 'mongodb';
import { usersCollection, toPublicUser } from '../models/users.js';
import { passwordResetTokensCollection } from '../models/passwordResetTokens.js';
import { generateToken, hashToken } from '../utils/crypto.js';
import { sendMail } from '../config/mailer.js';
import { env } from '../config/env.js';
import { BCRYPT_COST_FACTOR, ROLES, PASSWORD_RESET_TOKEN_BYTES, PERMISSIONS } from '../config/constants.js';
import { badRequest, conflict, notFound } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { paginate } from '../utils/pagination.js';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour — same window as the customer-facing flow
const VALID_PERMISSIONS = new Set(Object.values(PERMISSIONS));

function assertValidPermissions(permissions) {
  const invalid = permissions.filter((p) => !VALID_PERMISSIONS.has(p));
  if (invalid.length > 0) throw badRequest(`Unknown permission(s): ${invalid.join(', ')}`);
}

export async function listAdminUsers({ page = 1, pageSize = 20 } = {}) {
  const all = await (await usersCollection().find({ role: ROLES.ADMIN })).toArray();
  const sorted = sortByCreatedAtDesc(all);
  const { items, total } = paginate(sorted, { page, pageSize });
  return { adminUsers: items.map(toPublicUser), total, page, pageSize };
}

// Inviting an email that isn't registered yet creates a brand-new admin account with an
// unusable random password and emails them a set-password link (reusing the same
// password-reset token mechanism/page the customer-facing flow already has — no separate
// "activate your account" page needed). Inviting an email that already has an account
// promotes it in place instead of erroring on the duplicate — the common real case is
// "make my existing customer/staff login an admin", not always a stranger.
export async function inviteAdminUser({ email, firstName, lastName, permissions = [] }) {
  assertValidPermissions(permissions);
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await usersCollection().findOne({ email: normalizedEmail });

  if (existing) {
    if (existing.role === ROLES.ADMIN) throw conflict('This person is already an admin.');
    await usersCollection().updateOne(
      { _id: existing._id },
      { $set: { role: ROLES.ADMIN, permissions, updatedAt: new Date() } }
    );
    return toPublicUser(await usersCollection().findOne({ _id: existing._id }));
  }

  if (!firstName?.trim() || !lastName?.trim()) {
    throw badRequest('First and last name are required to create a new admin account.');
  }

  // Never-usable placeholder hash — this account can only be accessed by completing the
  // set-password email flow below, never by guessing/brute-forcing a password no one was
  // ever given.
  const unusablePasswordHash = await bcrypt.hash(generateToken(), BCRYPT_COST_FACTOR);
  const now = new Date();
  const { insertedId } = await usersCollection().insertOne({
    email: normalizedEmail,
    passwordHash: unusablePasswordHash,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    phone: null,
    role: ROLES.ADMIN,
    permissions,
    isActive: true,
    emailVerified: false,
    referralCode: null,
    referredBy: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });

  const raw = generateToken(PASSWORD_RESET_TOKEN_BYTES);
  await passwordResetTokensCollection().insertOne({
    userId: insertedId,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    createdAt: now,
    usedAt: null,
  });
  const setupUrl = `${env.CLIENT_URL}/reset-password?token=${raw}`;
  await sendMail({
    to: normalizedEmail,
    subject: "You've been added as a NailsByMandisa admin",
    html: `<p>You've been given admin access to the NailsByMandisa dashboard. Click below to set your password and log in. This link expires in 1 hour.</p><p><a href="${setupUrl}">${setupUrl}</a></p>`,
    text: `You've been given admin access to NailsByMandisa. Set your password: ${setupUrl} (expires in 1 hour)`,
  });

  return toPublicUser(await usersCollection().findOne({ _id: insertedId }));
}

// Blocking self-service on your own admin record (both here and in revokeAdminAccess) is
// what guarantees a non-empty admin set without needing a separate "don't revoke the last
// admin" counter check: whoever performs either action necessarily remains an admin
// themselves afterwards, so the set can never reach zero through this UI.
export async function updateAdminPermissions({ id, permissions, requestingUserId }) {
  if (String(id) === String(requestingUserId)) {
    throw conflict("You can't change your own admin permissions — ask another admin to do it.");
  }
  assertValidPermissions(permissions);
  const targetId = new ObjectId(id);
  const before = await usersCollection().findOneAndUpdate(
    { _id: targetId, role: ROLES.ADMIN },
    { $set: { permissions, updatedAt: new Date() } }
  );
  if (!before) throw notFound('Admin user');
  return toPublicUser(await usersCollection().findOne({ _id: targetId }));
}

export async function revokeAdminAccess({ id, requestingUserId }) {
  if (String(id) === String(requestingUserId)) {
    throw conflict("You can't revoke your own admin access — ask another admin to do it.");
  }
  const targetId = new ObjectId(id);
  const before = await usersCollection().findOneAndUpdate(
    { _id: targetId, role: ROLES.ADMIN },
    { $set: { role: ROLES.CUSTOMER, permissions: [], updatedAt: new Date() } }
  );
  if (!before) throw notFound('Admin user');
  return toPublicUser(await usersCollection().findOne({ _id: targetId }));
}
