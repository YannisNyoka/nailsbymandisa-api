import { getDb } from '../config/db.js';

export const COLLECTION = 'settings';
export const SETTINGS_DOC_ID = 'main';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const dayHoursSchema = {
  bsonType: 'object',
  required: ['closed'],
  properties: {
    closed: { bsonType: 'bool' },
    open: { bsonType: ['string', 'null'] },
    close: { bsonType: ['string', 'null'] },
  },
};

export const settingsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'businessName',
      'contact',
      'hours',
      'bookingDepositCents',
      'offPeakSurchargeCents',
      'offPeakHours',
      'cancellationNoticeHours',
      'rescheduleLockoutHours',
      'lateArrival',
      'loyalty',
      'referral',
      'updatedAt',
    ],
    properties: {
      businessName: { bsonType: 'string' },
      contact: {
        bsonType: 'object',
        required: ['address', 'phone', 'whatsapp', 'email'],
        properties: {
          address: { bsonType: 'string' },
          phone: { bsonType: 'string' },
          whatsapp: { bsonType: 'string' },
          email: { bsonType: 'string' },
        },
      },
      socialLinks: { bsonType: 'object' },
      hours: {
        bsonType: 'object',
        required: WEEKDAYS,
        properties: Object.fromEntries(WEEKDAYS.map((d) => [d, dayHoursSchema])),
      },
      bookingDepositCents: { bsonType: 'int', minimum: 0 },
      offPeakSurchargeCents: { bsonType: 'int', minimum: 0 },
      offPeakHours: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['start', 'end'],
          properties: { start: { bsonType: 'string' }, end: { bsonType: 'string' } },
        },
      },
      cancellationNoticeHours: { bsonType: 'int', minimum: 0 },
      rescheduleLockoutHours: { bsonType: 'int', minimum: 0 },
      lateArrival: {
        bsonType: 'object',
        required: ['graceMinutes', 'feeCents'],
        properties: {
          graceMinutes: { bsonType: 'int', minimum: 0 },
          feeCents: { bsonType: 'int', minimum: 0 },
        },
      },
      loyalty: {
        bsonType: 'object',
        required: ['pointsPerRand', 'redemptionCentsPerPoint', 'minRedemptionPoints', 'maxRedemptionPercent', 'tiers'],
        properties: {
          pointsPerRand: { bsonType: 'int', minimum: 0 },
          redemptionCentsPerPoint: { bsonType: 'int', minimum: 0 },
          minRedemptionPoints: { bsonType: 'int', minimum: 0 },
          maxRedemptionPercent: { bsonType: 'int', minimum: 0, maximum: 100 },
          tiers: {
            bsonType: 'array',
            items: {
              bsonType: 'object',
              required: ['name', 'minLifetimePoints'],
              properties: { name: { bsonType: 'string' }, minLifetimePoints: { bsonType: 'int' } },
            },
          },
        },
      },
      referral: {
        bsonType: 'object',
        required: ['referrerBonusPoints', 'welcomeDiscountPercent'],
        properties: {
          referrerBonusPoints: { bsonType: 'int', minimum: 0 },
          welcomeDiscountPercent: { bsonType: 'int', minimum: 0, maximum: 100 },
        },
      },
      // Admin-editable home page hero background (§4.1 gap-fix — previously hardcoded in
      // HomePage.css). Not in `required` so it stays optional for forward-compat, but
      // DEFAULT_SETTINGS always sets it so a fresh install still has a real hero image.
      heroMedia: {
        bsonType: 'object',
        required: ['url', 'type'],
        properties: {
          url: { bsonType: 'string' },
          type: { enum: ['image', 'video'] },
        },
      },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const settingsIndexes = [];

export function settingsCollection() {
  return getDb().collection(COLLECTION);
}

// Real business identity/contact info; hours and the money/policy numbers below are
// still placeholders an owner must confirm (no admin settings screen exists yet to edit
// these through the UI — see README "Admin settings UI" gap — so for now that means
// editing this file, or PATCH /api/settings directly, and updating the already-seeded
// live document to match). Everything here is configuration, never hardcoded into
// booking logic (§2).
export const DEFAULT_SETTINGS = {
  _id: SETTINGS_DOC_ID,
  businessName: 'NailsByMandisa',
  contact: {
    address: '882 Almondrock, Strubensvalley, Roodepoort, 1734',
    phone: '+27766878843',
    whatsapp: '+27766878843',
    email: 'nailsbymandisa@gmail.com',
  },
  socialLinks: { instagram: '', facebook: '', tiktok: '' },
  hours: Object.fromEntries(
    WEEKDAYS.map((d) => [d, d === 'sun' ? { closed: true, open: null, close: null } : { closed: false, open: '09:00', close: '17:00' }])
  ),
  bookingDepositCents: 15000, // PLACEHOLDER — R150
  offPeakSurchargeCents: 5000, // PLACEHOLDER — R50
  offPeakHours: [{ start: '17:00', end: '20:00' }],
  // PLACEHOLDER — cancellation policy is explicitly "to be updated" per the owner; 24h
  // notice is a provisional number so booking/reschedule logic has something to enforce
  // in the meantime, not a confirmed business decision. Revisit before launch.
  cancellationNoticeHours: 24,
  rescheduleLockoutHours: 12,
  lateArrival: { graceMinutes: 15, feeCents: 5000 },
  // PLACEHOLDER loyalty policy — reference values from §4.5: 1 point per R1 spent,
  // 100 points = R10 (10c/point), 100-point minimum redemption, capped at 50% of a
  // booking's deposit. Tiers are by lifetime points earned (never spent down).
  loyalty: {
    pointsPerRand: 1,
    redemptionCentsPerPoint: 10,
    minRedemptionPoints: 100,
    maxRedemptionPercent: 50,
    tiers: [
      { name: 'Bronze', minLifetimePoints: 0 },
      { name: 'Silver', minLifetimePoints: 500 },
      { name: 'Gold', minLifetimePoints: 1500 },
      { name: 'Platinum', minLifetimePoints: 5000 },
    ],
  },
  referral: {
    referrerBonusPoints: 200, // PLACEHOLDER
    welcomeDiscountPercent: 10, // PLACEHOLDER — friend's first-booking discount
  },
  // Real photo (not a placeholder) — see README "Home page hero" for where it came from.
  // Admin-editable at /admin/homepage.
  heroMedia: {
    url: 'https://res.cloudinary.com/akrzser7/image/upload/f_auto,q_auto,c_fill,g_auto,w_1920,h_1200/v1789408147/nailsbymandisa/gallery/ldge1cwpb9zji2j0tvlm.jpg',
    type: 'image',
  },
  updatedAt: new Date(),
};

export async function getSettings() {
  const existing = await settingsCollection().findOne({ _id: SETTINGS_DOC_ID });
  if (existing) return existing;
  await settingsCollection().insertOne(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}
