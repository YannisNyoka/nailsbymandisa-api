import { ObjectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import { usersCollection, toPublicUser } from '../models/users.js';
import { verifyAccessToken } from '../utils/jwt.js';
import { unauthorized, forbidden } from '../utils/AppError.js';
import { ROLES } from '../config/constants.js';

function extractToken(req) {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

// §5.4 — role/active-status is re-verified from the database on every request, never
// trusted from the JWT claim alone (the access token carries only the user id). A
// demoted or deactivated account loses access on its very next request, not whenever
// its short-lived access token happens to expire.
export async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw unauthorized();

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw unauthorized('Access token expired.');
      throw unauthorized('Invalid access token.');
    }

    const user = await usersCollection().findOne({ _id: new ObjectId(payload.sub) });
    if (!user || !user.isActive) throw unauthorized('This account is no longer active.');

    req.user = toPublicUser(user);
    next();
  } catch (err) {
    next(err);
  }
}

// Like authenticate(), but doesn't fail the request when no/invalid token is present —
// for endpoints usable by both guests and logged-in users (e.g. public booking wizard).
export async function optionalAuthenticate(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  return authenticate(req, res, next);
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (!roles.includes(req.user.role)) return next(forbidden());
    next();
  };
}

// §4.2/§5.3 — granular per-permission checks for admin routes rather than one global
// "is admin" boolean. A staff/admin account only gets access to the specific admin
// surfaces its `permissions` list grants.
export function requirePermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role !== ROLES.ADMIN) return next(forbidden());
    const granted = new Set(req.user.permissions || []);
    const hasAll = permissions.every((p) => granted.has(p));
    if (!hasAll) return next(forbidden());
    next();
  };
}

// Lets a linked staff account (role 'staff', SETTINGS.employeeId set) into a handful of
// read endpoints an admin with `permissions` would also need — appointments list,
// overview stats, trends, availability. The route handler is still responsible for
// scoping the actual query to req.user.employeeId; this middleware only decides who gets
// in, never what they see once inside. A staff account with no employeeId (shouldn't
// happen — invites require one) is refused rather than silently seeing nothing scoped.
export function requirePermissionOrStaffSelf(...permissions) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === ROLES.ADMIN) {
      const granted = new Set(req.user.permissions || []);
      if (!permissions.every((p) => granted.has(p))) return next(forbidden());
      return next();
    }
    if (req.user.role === ROLES.STAFF && req.user.employeeId) return next();
    return next(forbidden());
  };
}

// IDOR guard (§5.3) — for routes shaped like /me/... or scoped by owner id, confirms
// the authenticated user matches the resource owner unless they're an admin.
export function requireOwnerOrAdmin(getOwnerId) {
  return (req, res, next) => {
    if (!req.user) return next(unauthorized());
    if (req.user.role === ROLES.ADMIN) return next();
    const ownerId = getOwnerId(req);
    if (String(ownerId) !== String(req.user._id)) return next(forbidden());
    next();
  };
}
