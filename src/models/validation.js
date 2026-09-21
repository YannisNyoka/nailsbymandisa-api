import { getDb } from '../config/db.js';
import { logger } from '../config/logger.js';
import { COLLECTION as USERS, usersJsonSchema, usersIndexes } from './users.js';
import { COLLECTION as REFRESH_TOKENS, refreshTokensJsonSchema, refreshTokensIndexes } from './refreshTokens.js';
import {
  COLLECTION as PASSWORD_RESET_TOKENS,
  passwordResetTokensJsonSchema,
  passwordResetTokensIndexes,
} from './passwordResetTokens.js';
import { COLLECTION as SETTINGS, settingsJsonSchema, settingsIndexes } from './settings.js';
import { COLLECTION as SERVICES, servicesJsonSchema, servicesIndexes } from './services.js';
import { COLLECTION as EMPLOYEES, employeesJsonSchema, employeesIndexes } from './employees.js';
import { COLLECTION as AVAILABILITY, availabilityJsonSchema, availabilityIndexes } from './availability.js';
import { COLLECTION as APPOINTMENTS, appointmentsJsonSchema, appointmentsIndexes } from './appointments.js';
import { COLLECTION as PAYMENTS, paymentsJsonSchema, paymentsIndexes } from './payments.js';
import {
  COLLECTION as CLIENT_NOTIFICATIONS,
  clientNotificationsJsonSchema,
  clientNotificationsIndexes,
} from './clientNotifications.js';
import { COLLECTION as ACTIVITY_LOG, activityLogJsonSchema, activityLogIndexes } from './activityLog.js';
import { COLLECTION as DISCOUNT_CODES, discountCodesJsonSchema, discountCodesIndexes } from './discountCodes.js';
import {
  COLLECTION as LOYALTY_ACCOUNTS,
  loyaltyAccountsJsonSchema,
  loyaltyAccountsIndexes,
} from './loyaltyAccounts.js';
import {
  COLLECTION as LOYALTY_TRANSACTIONS,
  loyaltyTransactionsJsonSchema,
  loyaltyTransactionsIndexes,
} from './loyaltyTransactions.js';
import { COLLECTION as REFERRALS, referralsJsonSchema, referralsIndexes } from './referrals.js';
import { COLLECTION as GIFT_CARDS, giftCardsJsonSchema, giftCardsIndexes } from './giftCards.js';
import { COLLECTION as GALLERY, galleryJsonSchema, galleryIndexes } from './gallery.js';
import {
  COLLECTION as CLIENT_GALLERY,
  clientGalleryJsonSchema,
  clientGalleryIndexes,
} from './clientGallery.js';
import { COLLECTION as ENQUIRIES, enquiriesJsonSchema, enquiriesIndexes } from './enquiries.js';

// Applies MongoDB JSON Schema validators and indexes for every collection at boot —
// §3 requires this on every collection touched by money or slot availability, and we
// apply it uniformly rather than only where someone remembered to. Filled in as each
// collection is designed (Build Order §9).

async function ensureCollection(db, name, validator, indexes) {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name, { validator, validationLevel: 'strict' });
  } else {
    await db.command({ collMod: name, validator, validationLevel: 'strict' });
  }
  if (indexes?.length) {
    await syncIndexes(db.collection(name), indexes);
  }
  logger.debug({ collection: name }, 'Schema validation + indexes applied');
}

// createIndexes() throws IndexOptionsConflict if a same-named index already exists with
// a different definition — e.g. a partialFilterExpression that's changed since the index
// was first created (as appointments.js's uniq_active_slot did, to stop pending_payment
// appointments from holding a slot). Drop any same-named index whose live definition no
// longer matches before recreating it, so an index definition can evolve across deploys
// without a manual one-off migration run against the production database.
async function syncIndexes(collection, desiredIndexes) {
  const existingIndexes = await collection.indexes();
  for (const desired of desiredIndexes) {
    const existing = existingIndexes.find((idx) => idx.name === desired.name);
    if (existing && !indexDefinitionMatches(existing, desired)) {
      // eslint-disable-next-line no-await-in-loop -- boot-time migration, not a hot path
      await collection.dropIndex(desired.name);
    }
  }
  await collection.createIndexes(desiredIndexes);
}

function indexDefinitionMatches(existing, desired) {
  return (
    JSON.stringify(existing.key) === JSON.stringify(desired.key) &&
    JSON.stringify(existing.partialFilterExpression ?? null) === JSON.stringify(desired.partialFilterExpression ?? null) &&
    Boolean(existing.unique) === Boolean(desired.unique)
  );
}

export async function applySchemaValidation() {
  const db = getDb();
  await ensureCollection(db, USERS, usersJsonSchema, usersIndexes);
  await ensureCollection(db, REFRESH_TOKENS, refreshTokensJsonSchema, refreshTokensIndexes);
  await ensureCollection(db, PASSWORD_RESET_TOKENS, passwordResetTokensJsonSchema, passwordResetTokensIndexes);
  await ensureCollection(db, SETTINGS, settingsJsonSchema, settingsIndexes);
  await ensureCollection(db, SERVICES, servicesJsonSchema, servicesIndexes);
  await ensureCollection(db, EMPLOYEES, employeesJsonSchema, employeesIndexes);
  await ensureCollection(db, AVAILABILITY, availabilityJsonSchema, availabilityIndexes);
  await ensureCollection(db, APPOINTMENTS, appointmentsJsonSchema, appointmentsIndexes);
  await ensureCollection(db, PAYMENTS, paymentsJsonSchema, paymentsIndexes);
  await ensureCollection(db, CLIENT_NOTIFICATIONS, clientNotificationsJsonSchema, clientNotificationsIndexes);
  await ensureCollection(db, ACTIVITY_LOG, activityLogJsonSchema, activityLogIndexes);
  await ensureCollection(db, DISCOUNT_CODES, discountCodesJsonSchema, discountCodesIndexes);
  await ensureCollection(db, LOYALTY_ACCOUNTS, loyaltyAccountsJsonSchema, loyaltyAccountsIndexes);
  await ensureCollection(db, LOYALTY_TRANSACTIONS, loyaltyTransactionsJsonSchema, loyaltyTransactionsIndexes);
  await ensureCollection(db, REFERRALS, referralsJsonSchema, referralsIndexes);
  await ensureCollection(db, GIFT_CARDS, giftCardsJsonSchema, giftCardsIndexes);
  await ensureCollection(db, GALLERY, galleryJsonSchema, galleryIndexes);
  await ensureCollection(db, CLIENT_GALLERY, clientGalleryJsonSchema, clientGalleryIndexes);
  await ensureCollection(db, ENQUIRIES, enquiriesJsonSchema, enquiriesIndexes);
}
