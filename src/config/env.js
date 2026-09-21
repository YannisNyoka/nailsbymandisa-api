import 'dotenv/config';
import { z } from 'zod';

// Every env var the app actually reads must be declared here. Boot fails loudly
// (process.exit) if anything is missing or malformed — see README "Environment config".

const WEAK_SECRET_PATTERNS = [
  /^(secret|password|changeme|placeholder|example|test|dev|admin|letmein)/i,
];

const secret = (minLength) =>
  z
    .string()
    .min(minLength, `must be at least ${minLength} characters — generate with e.g. openssl rand -hex 32`)
    .refine(
      (val) => !WEAK_SECRET_PATTERNS.some((re) => re.test(val)),
      'looks like a guessable placeholder, not a generated secret'
    )
    .refine((val) => new Set(val).size > 4, 'looks too low-entropy to be a generated secret');

const csvUrls = z
  .string()
  .min(1)
  .transform((val) => val.split(',').map((s) => s.trim()).filter(Boolean));

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    MONGO_URI: z.string().min(1, 'MongoDB connection string is required'),
    MONGO_DB_NAME: z.string().min(1).default('nailsbymandisa'),

    JWT_ACCESS_SECRET: secret(32),
    JWT_REFRESH_SECRET: secret(32),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL: z.string().default('30d'),

    CORS_ORIGINS: csvUrls,
    CLIENT_URL: z.string().url(),

    YOCO_SECRET_KEY: z.string().min(1, 'Yoco secret key is required (dashboard → Settings → API Keys)'),
    YOCO_WEBHOOK_SECRET: secret(16),

    // Resend (https://resend.com) — transactional email (booking confirmations,
    // reminders, gift cards, password resets, admin invites). Free tier: 3,000
    // emails/month, 100/day. EMAIL_FROM's domain must be verified in the Resend
    // dashboard before it can send to anyone other than the account owner.
    RESEND_API_KEY: z.string().min(1, 'Resend API key is required (resend.com → API Keys)'),
    EMAIL_FROM: z.string().min(1),
    // Where a public contact-form submission (routes/contact.js) gets emailed. Optional
    // with a hardcoded fallback (the salon's own published address, also in the site
    // footer) so this doesn't become a new required var on an already-deployed Render
    // service — a missing required var fails startup outright (see loadEnv() below).
    CONTACT_INBOX_EMAIL: z.string().email().optional().or(z.literal('')),

    // Shared secret the reminders cron workflow presents via the X-Cron-Secret header —
    // see routes/cron.js. Deliberately separate from the JWT secrets: this authenticates
    // a scheduled job, not a person, and never expires/rotates on its own.
    CRON_SECRET: secret(16),

    SENTRY_DSN: z.string().url().optional().or(z.literal('')),

    TWILIO_ACCOUNT_SID: z.string().optional().or(z.literal('')),
    TWILIO_AUTH_TOKEN: z.string().optional().or(z.literal('')),
    TWILIO_FROM_NUMBER: z.string().optional().or(z.literal('')),

    VAPID_PUBLIC_KEY: z.string().optional().or(z.literal('')),
    VAPID_PRIVATE_KEY: z.string().optional().or(z.literal('')),

    // Optional — image uploads for the gallery (admin posts + client submissions). See
    // config/cloudinaryClient.js: uploads are a documented, clearly-errored no-op when
    // these are unset, same pattern as Twilio SMS above.
    CLOUDINARY_CLOUD_NAME: z.string().optional().or(z.literal('')),
    CLOUDINARY_API_KEY: z.string().optional().or(z.literal('')),
    CLOUDINARY_API_SECRET: z.string().optional().or(z.literal('')),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  })
  .superRefine((val, ctx) => {
    if (val.NODE_ENV === 'production') {
      if (val.CORS_ORIGINS.some((o) => /localhost|127\.0\.0\.1/.test(o))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'CORS_ORIGINS must not include localhost in production',
        });
      }
      if (!val.SENTRY_DSN) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['SENTRY_DSN'],
          message: 'SENTRY_DSN is required in production for error tracking',
        });
      }
    }
  });

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error('\n✖ Invalid environment configuration:\n');
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    // eslint-disable-next-line no-console
    console.error('\nSee .env.example for the full list of required variables.\n');
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
