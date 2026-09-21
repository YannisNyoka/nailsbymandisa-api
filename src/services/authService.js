import bcrypt from 'bcrypt';
import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { usersCollection, toPublicUser } from '../models/users.js';
import { refreshTokensCollection } from '../models/refreshTokens.js';
import { passwordResetTokensCollection } from '../models/passwordResetTokens.js';
import { generateToken, hashToken } from '../utils/crypto.js';
import { signAccessToken } from '../utils/jwt.js';
import { parseDurationMs } from '../utils/duration.js';
import { sendMail } from '../config/mailer.js';
import { env } from '../config/env.js';
import { BCRYPT_COST_FACTOR, ROLES, PASSWORD_RESET_TOKEN_BYTES } from '../config/constants.js';
import { AppError, unauthorized, conflict } from '../utils/AppError.js';
import { generateUniqueReferralCode, linkReferralOnRegistration } from './referralService.js';

const REFRESH_TTL_MS = parseDurationMs(env.JWT_REFRESH_TTL);
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

async function issueRefreshToken(userId, family = crypto.randomUUID()) {
  const raw = generateToken();
  await refreshTokensCollection().insertOne({
    userId: new ObjectId(userId),
    tokenHash: hashToken(raw),
    family,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    createdAt: new Date(),
    revokedAt: null,
    replacedByTokenHash: null,
  });
  return raw;
}

async function issueTokenPair(userId) {
  const accessToken = signAccessToken(userId);
  const refreshToken = await issueRefreshToken(userId);
  return { accessToken, refreshToken };
}

// §4.2 — logging out or changing a password must actually invalidate existing refresh
// tokens. Revoking every non-revoked token for the user is the single place that
// guarantee lives; call this from logout-all, password change, and password reset.
export async function revokeAllRefreshTokensForUser(userId) {
  await refreshTokensCollection().updateMany(
    { userId: new ObjectId(userId), revokedAt: null },
    { $set: { revokedAt: new Date() } }
  );
}

export async function register({ email, password, firstName, lastName, phone, referralCode }) {
  const normalizedEmail = email.trim().toLowerCase();
  const existing = await usersCollection().findOne({ email: normalizedEmail });
  if (existing) throw conflict('An account with this email already exists.');

  const [passwordHash, ownReferralCode] = await Promise.all([
    bcrypt.hash(password, BCRYPT_COST_FACTOR),
    generateUniqueReferralCode(),
  ]);
  const now = new Date();
  const { insertedId } = await usersCollection().insertOne({
    email: normalizedEmail,
    passwordHash,
    firstName,
    lastName,
    phone: phone ?? null,
    role: ROLES.CUSTOMER,
    permissions: [],
    isActive: true,
    emailVerified: false,
    referralCode: ownReferralCode,
    referredBy: null,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  });

  // §4.6 — a referral code supplied at signup creates the pending referral link and the
  // friend's welcome discount immediately; the referrer's points are only awarded once
  // the friend completes their first booking (referralService.completeReferralIfPending).
  let welcomeDiscountCode = null;
  if (referralCode) {
    const created = await linkReferralOnRegistration({ newUserId: insertedId, referralCodeUsed: referralCode });
    if (created) {
      welcomeDiscountCode = created.code;
      await usersCollection().updateOne({ _id: insertedId }, { $set: { referredBy: referralCode } });
    }
  }

  const user = await usersCollection().findOne({ _id: insertedId });
  const tokens = await issueTokenPair(insertedId);
  return { user: toPublicUser(user), welcomeDiscountCode, ...tokens };
}

export async function updateProfile({ userId, firstName, lastName, phone }) {
  const update = { updatedAt: new Date() };
  if (firstName !== undefined) update.firstName = firstName;
  if (lastName !== undefined) update.lastName = lastName;
  if (phone !== undefined) update.phone = phone;

  const result = await usersCollection().findOneAndUpdate({ _id: new ObjectId(userId) }, { $set: update });
  if (!result) throw new AppError('User not found.', 404);
  return toPublicUser(await usersCollection().findOne({ _id: new ObjectId(userId) }));
}

export async function login({ email, password }) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await usersCollection().findOne({ email: normalizedEmail });

  // Constant-shape failure for both "no such user" and "wrong password" — don't leak
  // which one it was. Always run bcrypt.compare even on a miss so response timing
  // doesn't reveal whether the email exists.
  const passwordHash = user?.passwordHash ?? '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltinvalidsa';
  const valid = await bcrypt.compare(password, passwordHash);
  if (!user || !valid) throw unauthorized('Invalid email or password.');
  if (!user.isActive) throw unauthorized('This account has been deactivated.');

  await usersCollection().updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });

  const tokens = await issueTokenPair(user._id);
  return { user: toPublicUser(user), ...tokens };
}

// Two refresh calls can legitimately race off the same still-valid token — two browser
// tabs open at once, or a client retrying after a slow response — without either being
// theft. Within this window of a token's own rotation, a second presentation of it is
// treated as that benign race rather than reuse; a presentation *after* this window (or
// of a token whose replacement is itself already gone) still trips theft detection.
const REFRESH_REUSE_GRACE_MS = 10_000;

async function rotateFrom(stored, user) {
  const newRawToken = generateToken();
  const newTokenHash = hashToken(newRawToken);

  // Atomic consume-and-replace: only succeeds if this token is still the unconsumed
  // tip of its family, preventing a race where two refreshes off the same token both succeed.
  const result = await refreshTokensCollection().findOneAndUpdate(
    { tokenHash: stored.tokenHash, revokedAt: null },
    { $set: { revokedAt: new Date(), replacedByTokenHash: newTokenHash } }
  );
  if (!result) return null; // lost the race — caller decides how to respond

  await refreshTokensCollection().insertOne({
    userId: stored.userId,
    tokenHash: newTokenHash,
    family: stored.family,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    createdAt: new Date(),
    revokedAt: null,
    replacedByTokenHash: null,
  });

  const accessToken = signAccessToken(stored.userId);
  return { accessToken, refreshToken: newRawToken, user: toPublicUser(user) };
}

// Refresh-token rotation with reuse detection: each refresh consumes the presented
// token and issues a new one in the same family. If a token that's already been
// consumed is presented again well outside the benign-race grace window above, that's
// treated as token theft and the whole family is revoked defensively.
export async function refresh({ rawRefreshToken }) {
  if (!rawRefreshToken) throw unauthorized('Refresh token required.');
  const tokenHash = hashToken(rawRefreshToken);
  const stored = await refreshTokensCollection().findOne({ tokenHash });

  if (!stored) throw unauthorized('Invalid refresh token.');

  if (stored.revokedAt || stored.expiresAt < new Date()) {
    // Within the grace window, walk forward through however many times this token's
    // family has since rotated — not just one hop. A single stale presentation can
    // legitimately be several rotations behind (e.g. a backgrounded tab waking up while
    // another tab kept the session alive, or several near-simultaneous reloads each
    // triggering their own refresh) — checking only `stored.replacedByTokenHash` finds
    // that replacement *also* already revoked and wrongly falls through to theft
    // detection, logging a real, still-active user out (found via a real repro: 8 quick
    // page loads in a row). The grace window is still anchored to the originally
    // presented token's own revocation time, so this doesn't widen the actual theft
    // window — it only follows the chain to whatever the *current* tip is.
    if (stored.revokedAt && stored.replacedByTokenHash && Date.now() - stored.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
      let tip = stored;
      while (tip.replacedByTokenHash) {
        // eslint-disable-next-line no-await-in-loop -- bounded by how many times this one token family has rotated, not a collection scan
        const next = await refreshTokensCollection().findOne({ tokenHash: tip.replacedByTokenHash });
        if (!next) break;
        tip = next;
      }
      if (!tip.revokedAt && tip.expiresAt > new Date()) {
        const user = await usersCollection().findOne({ _id: tip.userId });
        if (user && user.isActive) {
          const rotated = await rotateFrom(tip, user);
          if (rotated) return rotated;
        }
      }
    }

    await refreshTokensCollection().updateMany(
      { family: stored.family, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    throw unauthorized('Refresh token has already been used or expired. Please log in again.');
  }

  const user = await usersCollection().findOne({ _id: stored.userId });
  if (!user || !user.isActive) throw unauthorized('This account is no longer active.');

  const rotated = await rotateFrom(stored, user);
  if (!rotated) throw unauthorized('Refresh token has already been used. Please log in again.');
  return rotated;
}

export async function logout({ rawRefreshToken }) {
  if (!rawRefreshToken) return;
  const tokenHash = hashToken(rawRefreshToken);
  await refreshTokensCollection().updateOne({ tokenHash, revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await usersCollection().findOne({ _id: new ObjectId(userId) });
  if (!user) throw new AppError('User not found.', 404);

  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw unauthorized('Current password is incorrect.');

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
  await usersCollection().updateOne({ _id: user._id }, { $set: { passwordHash, updatedAt: new Date() } });
  await revokeAllRefreshTokensForUser(user._id);
}

export async function requestPasswordReset({ email }) {
  const normalizedEmail = email.trim().toLowerCase();
  const user = await usersCollection().findOne({ email: normalizedEmail });

  // Always behave the same whether or not the account exists — don't let this endpoint
  // be used to enumerate registered emails.
  if (!user) return;

  const raw = generateToken(PASSWORD_RESET_TOKEN_BYTES);
  await passwordResetTokensCollection().insertOne({
    userId: user._id,
    tokenHash: hashToken(raw),
    expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    createdAt: new Date(),
    usedAt: null,
  });

  const resetUrl = `${env.CLIENT_URL}/reset-password?token=${raw}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your NailsByMandisa password',
    html: `<p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>If you didn't request this, you can safely ignore this email.</p>`,
    text: `Reset your password: ${resetUrl} (expires in 1 hour)`,
  });
}

export async function resetPassword({ rawToken, newPassword }) {
  const tokenHash = hashToken(rawToken);
  const stored = await passwordResetTokensCollection().findOneAndUpdate(
    { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } }
  );
  if (!stored) throw new AppError('This password reset link is invalid or has expired.', 400);

  const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST_FACTOR);
  await usersCollection().updateOne({ _id: stored.userId }, { $set: { passwordHash, updatedAt: new Date() } });
  await revokeAllRefreshTokensForUser(stored.userId);
}
