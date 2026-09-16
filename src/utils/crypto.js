import crypto from 'node:crypto';

// §5.8 — CSPRNG for anything security-adjacent. Never Math.random() for tokens/codes.
export function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids ambiguity when read aloud/typed

export function generateCode(length = 8) {
  const bytes = crypto.randomBytes(length);
  let code = '';
  for (let i = 0; i < length; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}
