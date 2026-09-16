import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// Access tokens carry only the user id — never role/permissions. §5.4 requires role to
// be re-verified from the database on every request rather than trusted from a JWT
// claim that could be stale (a demoted/deactivated user must lose access immediately).
export function signAccessToken(userId) {
  return jwt.sign({ sub: String(userId) }, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
}
