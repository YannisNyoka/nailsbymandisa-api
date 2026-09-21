// System-level constants only. Business policy (deposit amounts, cancellation windows,
// loyalty rates, etc.) belongs in the admin-editable SETTINGS document (see models/settings.js)
// so an owner can change it without a code deploy — never hardcode business policy here.

export const BCRYPT_COST_FACTOR = 12;

export const PAGINATION = {
  DEFAULT_LIMIT: 20,
  MAX_LIMIT: 100,
};

export const REFRESH_TOKEN_BYTES = 40;
export const PASSWORD_RESET_TOKEN_BYTES = 32;
export const DISCOUNT_CODE_LENGTH = 8;
export const GIFT_CARD_CODE_LENGTH = 12;
export const REFERRAL_CODE_LENGTH = 8;

export const ROLES = Object.freeze({
  CUSTOMER: 'customer',
  STAFF: 'staff',
  ADMIN: 'admin',
});

// Granular permission flags an admin account can hold — see §4.2: never a single
// global "is admin" boolean gating everything. Checked per-endpoint via requirePermission().
export const PERMISSIONS = Object.freeze({
  MANAGE_APPOINTMENTS: 'manage_appointments',
  MANAGE_STAFF: 'manage_staff',
  MANAGE_SERVICES: 'manage_services',
  MANAGE_AVAILABILITY: 'manage_availability',
  MANAGE_PAYMENTS: 'manage_payments',
  MANAGE_DISCOUNTS: 'manage_discounts',
  MANAGE_GIFT_CARDS: 'manage_gift_cards',
  MANAGE_LOYALTY: 'manage_loyalty',
  MANAGE_GALLERY: 'manage_gallery',
  MANAGE_CLIENTS: 'manage_clients',
  MANAGE_SETTINGS: 'manage_settings',
  SEND_NOTIFICATIONS: 'send_notifications',
  VIEW_ANALYTICS: 'view_analytics',
  // Grants access to the admin-user-management screen itself (invite/promote an admin,
  // edit their permissions, revoke access). Deliberately its own flag rather than folded
  // into MANAGE_SETTINGS — granting someone control over who else has admin access is a
  // meaningfully bigger trust boundary than letting them edit business settings.
  MANAGE_ADMIN_USERS: 'manage_admin_users',
  // Viewing/marking-read the public contact-form inbox (routes/contact.js) — a mutation
  // (marking read), so MANAGE_ to match the rest of this enum, not a bare VIEW_.
  MANAGE_ENQUIRIES: 'manage_enquiries',
});

export const ALL_ADMIN_PERMISSIONS = Object.values(PERMISSIONS);

export const APPOINTMENT_STATUS = Object.freeze({
  PENDING_PAYMENT: 'pending_payment',
  CONFIRMED: 'confirmed',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  NO_SHOW: 'no_show',
});

export const PAYMENT_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  FAILED: 'failed',
  REFUNDED: 'refunded',
  PARTIALLY_REFUNDED: 'partially_refunded',
});

export const ANY_AVAILABLE_EMPLOYEE = 'any';
export const SLOT_GRANULARITY_MINUTES = 30;
// A pending_payment appointment never blocks its slot for anyone else (see
// bookingService.js's evaluateSlot) — this is purely a hygiene deadline: if payment
// still hasn't come in after this many minutes, the abandoned appointment is
// auto-cancelled so it stops cluttering "my bookings"/admin views as if still live.
export const UNPAID_APPOINTMENT_EXPIRY_MINUTES = 15;
// Floor so a stacked discount + points redemption can never reduce a Yoco charge to
// zero/negative — payment gateways require a positive amount.
export const MIN_CHARGE_CENTS = 100;

// PLACEHOLDER gift card purchase bounds — move to SETTINGS if the salon wants these
// admin-configurable.
export const GIFT_CARD_MIN_CENTS = 5000; // R50
export const GIFT_CARD_MAX_CENTS = 500000; // R5000

export const PAYMENT_PURPOSE = Object.freeze({
  BOOKING_DEPOSIT: 'booking_deposit',
  GIFT_CARD_PURCHASE: 'gift_card_purchase',
});
