import crypto from 'node:crypto';

// Idempotent by design: setupFiles runs once per test FILE, but env.js reads
// process.env only on its first import for the whole Jest run (the parsed result is
// cached). Regenerating secrets on every file would make them diverge from what env.js
// already cached — set each one only if it isn't already set, so every test file sees
// the same values env.js is using.
function setDefault(key, value) {
  if (process.env[key] === undefined) process.env[key] = value;
}

process.env.NODE_ENV = 'test';
// Force-cleared (not defaulted) — dotenv already loaded the real .env by the time this
// runs, so if real Cloudinary credentials exist there (as they do once uploads are
// actually configured for the running app), the "uploads not configured" test path
// would otherwise silently stop being exercised. Tests must never hit the real
// Cloudinary account regardless of what the developer's local .env has.
process.env.CLOUDINARY_CLOUD_NAME = '';
process.env.CLOUDINARY_API_KEY = '';
process.env.CLOUDINARY_API_SECRET = '';
setDefault('MONGO_URI', 'mongodb://127.0.0.1:27017');
setDefault('MONGO_DB_NAME', 'nailsbymandisa_test');
setDefault('JWT_ACCESS_SECRET', crypto.randomBytes(32).toString('hex'));
setDefault('JWT_REFRESH_SECRET', crypto.randomBytes(32).toString('hex'));
setDefault('CORS_ORIGINS', 'http://localhost:5173');
setDefault('CLIENT_URL', 'http://localhost:5173');
setDefault('YOCO_SECRET_KEY', 'sk_test_' + crypto.randomBytes(16).toString('hex'));
setDefault('YOCO_WEBHOOK_SECRET', crypto.randomBytes(16).toString('hex'));
setDefault('SMTP_HOST', 'localhost');
setDefault('SMTP_PORT', '587');
setDefault('SMTP_USER', 'test');
setDefault('SMTP_PASS', 'test');
setDefault('EMAIL_FROM', 'test@example.com');
setDefault('LOG_LEVEL', 'silent');
