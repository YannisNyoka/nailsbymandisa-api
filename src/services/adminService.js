import { ObjectId } from 'mongodb';
import { appointmentsCollection } from '../models/appointments.js';
import { paymentsCollection } from '../models/payments.js';
import { loyaltyAccountsCollection } from '../models/loyaltyAccounts.js';
import { servicesCollection } from '../models/services.js';
import { employeesCollection } from '../models/employees.js';
import { usersCollection, toPublicUser } from '../models/users.js';
import { ROLES, APPOINTMENT_STATUS, PAYMENT_STATUS, PAYMENT_PURPOSE, PAGINATION } from '../config/constants.js';
import { todayDateString, dateStringFor, lastNDateStrings, currentWeekDateStrings, currentMonthDateStrings } from '../utils/businessTime.js';
import { badRequest, notFound } from '../utils/AppError.js';
import { listActivity } from './activityLogService.js';

const PAID_STATUSES = [PAYMENT_STATUS.PAID, PAYMENT_STATUS.PARTIALLY_REFUNDED, PAYMENT_STATUS.REFUNDED];
const netCents = (p) => p.amountCents - p.refundedAmountCents;

// Shared by every windowed report below — `range` is either a plain day-count (a rolling
// window of that many days ending today, as this app has always done) or the literal
// 'week'/'month' for calendar-aligned boundaries instead (this Monday through today, or
// the 1st of this calendar month through today) — see routes/admin.js's rangeSchema for
// where that string reaches here from the query param.
function dateStringsForRange(range) {
  if (range === 'week') return currentWeekDateStrings();
  if (range === 'month') return currentMonthDateStrings();
  return lastNDateStrings(range);
}

// §4.12 admin overview. Deliberately computed from full collection scans reduced in
// application code (consistent with every other list/report in this codebase) rather
// than a Mongo aggregation pipeline — fine at this app's scale, and keeps the fake-db
// test double usable for these reads too.
// `employeeId` scopes every figure to one staff member's own bookings/revenue — used for
// the staff-facing overview (§ staff-scoped admin access), which must never show
// salon-wide numbers or other staff/clients' activity to a non-admin.
export async function getOverviewStats({ employeeId } = {}) {
  const today = todayDateString();
  const employeeObjectId = employeeId ? new ObjectId(employeeId) : null;
  const appointmentsFilter = employeeObjectId ? { employeeId: employeeObjectId } : {};

  const [appointments, allPayments, clientCount, recentActivity, loyaltyAccounts] = await Promise.all([
    (await appointmentsCollection().find(appointmentsFilter)).toArray(),
    (await paymentsCollection().find({})).toArray(),
    employeeObjectId ? Promise.resolve(null) : (await usersCollection().find({ role: ROLES.CUSTOMER })).toArray().then((u) => u.length),
    employeeObjectId ? Promise.resolve({ entries: [] }) : listActivity({ page: 1, pageSize: 10 }),
    // Salon-wide membership data, not meaningful scoped to one staff member's own clients.
    employeeObjectId ? Promise.resolve(null) : (await loyaltyAccountsCollection().find({})).toArray(),
  ]);

  // A staff member's revenue only counts payments tied to their own appointments — join
  // in application code rather than a query per payment, same full-scan style as the rest
  // of this file.
  const appointmentIds = new Set(appointments.map((a) => String(a._id)));
  const payments = employeeObjectId
    ? allPayments.filter((p) => p.appointmentId && appointmentIds.has(String(p.appointmentId)))
    : allPayments;

  const appointmentsToday = appointments.filter(
    (a) => a.date === today && [APPOINTMENT_STATUS.PENDING_PAYMENT, APPOINTMENT_STATUS.CONFIRMED].includes(a.status)
  ).length;
  const upcomingConfirmed = appointments.filter(
    (a) => a.date >= today && a.status === APPOINTMENT_STATUS.CONFIRMED
  ).length;
  const pendingPayment = appointments.filter((a) => a.status === APPOINTMENT_STATUS.PENDING_PAYMENT).length;

  const paidPayments = payments.filter((p) => PAID_STATUSES.includes(p.status));
  const netRevenueCents = paidPayments.reduce((sum, p) => sum + netCents(p), 0);

  // "Today" is always a 1-day rolling window (trivially the same as "today" read any
  // other way); "week"/"month" are calendar-aligned (Monday through today, and the 1st
  // of the month through today) rather than a rolling 7/30-day lookback — explicit
  // business decision, matching the same "week"/"month" range values Business Analytics
  // accepts (dateStringsForRange above).
  const todayWindow = new Set(lastNDateStrings(1));
  const weekWindow = new Set(currentWeekDateStrings());
  const monthWindow = new Set(currentMonthDateStrings());
  const revenueInWindow = (window) =>
    paidPayments.filter((p) => window.has(dateStringFor(p.createdAt))).reduce((sum, p) => sum + netCents(p), 0);

  const cancellationsCount = appointments.filter((a) => a.status === APPOINTMENT_STATUS.CANCELLED).length;
  const noShowsCount = appointments.filter((a) => a.status === APPOINTMENT_STATUS.NO_SHOW).length;
  const completedCount = appointments.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED).length;

  // Out of every booking that actually reached a final outcome (completed, cancelled or
  // a no-show) — still-pending/upcoming ones aren't a "miss" yet, so they're excluded
  // rather than silently dragging the rate down while they're still on the calendar.
  const finishedCount = completedCount + cancellationsCount + noShowsCount;
  const completionRate = finishedCount > 0 ? Math.round((completedCount / finishedCount) * 100) : null;

  const avgBookingValueCents = paidPayments.length > 0 ? Math.round(netRevenueCents / paidPayments.length) : 0;

  const revenueBreakdown = {
    bookingDepositCents: paidPayments
      .filter((p) => p.purpose === PAYMENT_PURPOSE.BOOKING_DEPOSIT)
      .reduce((sum, p) => sum + netCents(p), 0),
    giftCardPurchaseCents: paidPayments
      .filter((p) => p.purpose === PAYMENT_PURPOSE.GIFT_CARD_PURCHASE)
      .reduce((sum, p) => sum + netCents(p), 0),
  };

  const loyaltyMemberCount = loyaltyAccounts?.length ?? null;
  const avgLoyaltyPoints = loyaltyAccounts?.length
    ? Math.round(loyaltyAccounts.reduce((sum, a) => sum + a.pointsBalance, 0) / loyaltyAccounts.length)
    : null;

  return {
    appointmentsToday,
    upcomingConfirmed,
    pendingPayment,
    unpaidBookings: pendingPayment,
    clientCount,
    // Revenue is salon financial data, not staff-facing operational info — withheld
    // entirely for a staff-scoped caller (not just narrowed to their own bookings), so
    // it's never in the response at all, not just hidden by the admin UI.
    netRevenueCents: employeeObjectId ? null : netRevenueCents,
    revenueTodayCents: employeeObjectId ? null : revenueInWindow(todayWindow),
    revenueWeekCents: employeeObjectId ? null : revenueInWindow(weekWindow),
    revenueMonthCents: employeeObjectId ? null : revenueInWindow(monthWindow),
    revenueBreakdown: employeeObjectId ? null : revenueBreakdown,
    avgBookingValueCents: employeeObjectId ? null : avgBookingValueCents,
    cancellationsCount,
    noShowsCount,
    completedCount,
    completionRate,
    loyaltyMemberCount,
    avgLoyaltyPoints,
    recentActivity: recentActivity.entries,
  };
}

// Dedicated "Business Analytics" page (a single adjustable date range driving every
// figure at once, matching how the salon owner asked for it) — getOverviewStats above
// stays fixed-window (today/week/month) for the always-visible dashboard glance, this is
// the deliberately re-windowable counterpart everything on that page is built from.
export async function getBusinessSummary({ range = 30, employeeId } = {}) {
  const today = todayDateString();
  const dateStrings = new Set(dateStringsForRange(range));
  const employeeObjectId = employeeId ? new ObjectId(employeeId) : null;
  const appointmentsFilter = employeeObjectId ? { employeeId: employeeObjectId } : {};

  const [appointments, allPayments, customers, loyaltyAccounts] = await Promise.all([
    (await appointmentsCollection().find(appointmentsFilter)).toArray(),
    (await paymentsCollection().find({})).toArray(),
    employeeObjectId ? Promise.resolve(null) : (await usersCollection().find({ role: ROLES.CUSTOMER })).toArray(),
    employeeObjectId ? Promise.resolve(null) : (await loyaltyAccountsCollection().find({})).toArray(),
  ]);

  const appointmentIds = new Set(appointments.map((a) => String(a._id)));
  const payments = employeeObjectId
    ? allPayments.filter((p) => p.appointmentId && appointmentIds.has(String(p.appointmentId)))
    : allPayments;
  const paidPayments = payments.filter((p) => PAID_STATUSES.includes(p.status));
  const paidInWindow = paidPayments.filter((p) => dateStrings.has(dateStringFor(p.createdAt)));
  const combinedRevenueCents = paidInWindow.reduce((sum, p) => sum + netCents(p), 0);

  const inWindow = appointments.filter((a) => dateStrings.has(a.date));
  const bookingsToday = appointments.filter(
    (a) => a.date === today && [APPOINTMENT_STATUS.PENDING_PAYMENT, APPOINTMENT_STATUS.CONFIRMED].includes(a.status)
  ).length;
  const bookingsInWindow = inWindow.filter((a) => a.status !== APPOINTMENT_STATUS.CANCELLED).length;
  const completedCount = inWindow.filter((a) => a.status === APPOINTMENT_STATUS.COMPLETED).length;
  const cancelledCount = inWindow.filter((a) => a.status === APPOINTMENT_STATUS.CANCELLED).length;
  const noShowsCount = inWindow.filter((a) => a.status === APPOINTMENT_STATUS.NO_SHOW).length;
  const upcomingCount = inWindow.filter((a) =>
    [APPOINTMENT_STATUS.PENDING_PAYMENT, APPOINTMENT_STATUS.CONFIRMED].includes(a.status)
  ).length;
  const finishedCount = completedCount + cancelledCount + noShowsCount;
  const completionRate = finishedCount > 0 ? Math.round((completedCount / finishedCount) * 100) : null;

  const revenueBreakdown = {
    bookingDepositCents: paidInWindow
      .filter((p) => p.purpose === PAYMENT_PURPOSE.BOOKING_DEPOSIT)
      .reduce((sum, p) => sum + netCents(p), 0),
    giftCardPurchaseCents: paidInWindow
      .filter((p) => p.purpose === PAYMENT_PURPOSE.GIFT_CARD_PURCHASE)
      .reduce((sum, p) => sum + netCents(p), 0),
  };

  const totalClients = customers?.length ?? null;
  const newClientsInWindow = customers
    ? customers.filter((c) => dateStrings.has(dateStringFor(c.createdAt))).length
    : null;
  const loyaltyMemberCount = loyaltyAccounts?.length ?? null;
  const avgLoyaltyPoints = loyaltyAccounts?.length
    ? Math.round(loyaltyAccounts.reduce((sum, a) => sum + a.pointsBalance, 0) / loyaltyAccounts.length)
    : null;

  return {
    range,
    // Revenue is salon financial data, not staff-facing operational info — withheld
    // entirely for a staff-scoped caller (not just narrowed to their own bookings), so
    // it's never in the response at all, not just hidden by the admin UI.
    combinedRevenueCents: employeeObjectId ? null : combinedRevenueCents,
    revenueBreakdown: employeeObjectId ? null : revenueBreakdown,
    bookingsToday,
    bookingsInWindow,
    completedCount,
    cancelledCount,
    noShowsCount,
    upcomingCount,
    completionRate,
    totalClients,
    newClientsInWindow,
    loyaltyMemberCount,
    avgLoyaltyPoints,
  };
}

// §SEO-analytics-followup — "which services/staff/clients actually drive the business,"
// not just aggregate totals. All three below share the same non-cancelled-bookings
// window as the trend charts (dateStringsForRange), full-scan-then-reduce like everything
// else in this file.
export async function getTopServices({ range = 30, limit = 8, employeeId } = {}) {
  const dateStrings = new Set(dateStringsForRange(range));
  const employeeObjectId = employeeId ? new ObjectId(employeeId) : null;
  const filter = employeeObjectId ? { employeeId: employeeObjectId } : {};

  const [appointments, services] = await Promise.all([
    (await appointmentsCollection().find(filter)).toArray(),
    (await servicesCollection().find({})).toArray(),
  ]);
  const serviceById = new Map(services.map((s) => [String(s._id), s.name]));

  const counts = new Map();
  for (const a of appointments) {
    if (a.status === APPOINTMENT_STATUS.CANCELLED || !dateStrings.has(a.date)) continue;
    for (const serviceId of a.serviceIds) {
      const key = String(serviceId);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }

  const items = [...counts.entries()]
    .map(([serviceId, count]) => ({ serviceId, name: serviceById.get(serviceId) || 'Deleted service', count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);

  return { range, items };
}

// Admin-only (never staff-scoped) — comparing headcount across staff is exactly the
// cross-staff visibility a staff account must never get (§ staff-scoped admin access).
export async function getStaffBookingsBreakdown({ range = 30 } = {}) {
  const dateStrings = new Set(dateStringsForRange(range));
  const [appointments, employees] = await Promise.all([
    (await appointmentsCollection().find({})).toArray(),
    (await employeesCollection().find({})).toArray(),
  ]);
  const employeeById = new Map(employees.map((e) => [String(e._id), e.name]));

  const counts = new Map();
  for (const a of appointments) {
    if (a.status === APPOINTMENT_STATUS.CANCELLED || !dateStrings.has(a.date)) continue;
    const key = String(a.employeeId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const items = [...counts.entries()]
    .map(([employeeId, count]) => ({ employeeId, name: employeeById.get(employeeId) || 'Former staff member', count }))
    .sort((a, b) => b.count - a.count);

  return { range, items };
}

// Admin-only — ranks the whole client base, not one staff member's own clients.
export async function getTopClients({ limit = 5 } = {}) {
  const appointments = await (await appointmentsCollection().find({})).toArray();
  const counts = new Map();
  for (const a of appointments) {
    if (!a.userId) continue;
    const key = String(a.userId);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const topIds = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
  if (topIds.length === 0) return { items: [] };

  const users = await (await usersCollection().find({ _id: { $in: topIds.map((id) => new ObjectId(id)) } })).toArray();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const items = topIds
    .map((id) => {
      const user = userById.get(id);
      if (!user) return null;
      return { userId: id, firstName: user.firstName, lastName: user.lastName, email: user.email, bookingsCount: counts.get(id) };
    })
    .filter(Boolean);

  return { items };
}

const TREND_METRICS = new Set(['revenue', 'bookings']);

// §4.12 admin overview charts. `range` windows the x-axis — either a rolling day-count
// (365 → Year in the UI) or the calendar-aligned 'week'/'month' (→ Week/Month in the
// UI, dateStringsForRange above); bucketing is by the appointment's own `date` for
// bookings, and by payment `createdAt` (business-tz) for revenue — same
// full-scan-then-reduce style as getOverviewStats(), fine at this app's scale.
export async function getTrend({ metric, range = 7, employeeId }) {
  if (!TREND_METRICS.has(metric)) throw badRequest(`Unknown trend metric: ${metric}`);
  const dateStrings = dateStringsForRange(range);
  const employeeObjectId = employeeId ? new ObjectId(employeeId) : null;
  const appointmentsFilter = employeeObjectId ? { employeeId: employeeObjectId } : {};

  if (metric === 'revenue') {
    const scopedAppointmentIds = employeeObjectId
      ? new Set((await (await appointmentsCollection().find(appointmentsFilter)).toArray()).map((a) => String(a._id)))
      : null;
    const payments = (await (await paymentsCollection().find({})).toArray()).filter(
      (p) => PAID_STATUSES.includes(p.status) && (!scopedAppointmentIds || (p.appointmentId && scopedAppointmentIds.has(String(p.appointmentId))))
    );
    const byDate = new Map(dateStrings.map((d) => [d, 0]));
    for (const p of payments) {
      const d = dateStringFor(p.createdAt);
      if (byDate.has(d)) byDate.set(d, byDate.get(d) + netCents(p));
    }
    return { metric, range, points: dateStrings.map((date) => ({ date, revenueCents: byDate.get(date) })) };
  }

  const appointments = await (await appointmentsCollection().find(appointmentsFilter)).toArray();
  const byDate = new Map(dateStrings.map((d) => [d, { booked: 0, cancelled: 0, completed: 0 }]));
  for (const a of appointments) {
    const bucket = byDate.get(a.date);
    if (!bucket) continue;
    if (a.status === APPOINTMENT_STATUS.CANCELLED) bucket.cancelled += 1;
    else if (a.status === APPOINTMENT_STATUS.COMPLETED) bucket.completed += 1;
    else if ([APPOINTMENT_STATUS.PENDING_PAYMENT, APPOINTMENT_STATUS.CONFIRMED].includes(a.status)) bucket.booked += 1;
  }
  return { metric, range, points: dateStrings.map((date) => ({ date, ...byDate.get(date) })) };
}

export async function listClients({ page = 1, pageSize = PAGINATION.DEFAULT_LIMIT, search } = {}) {
  let all = await (await usersCollection().find({ role: ROLES.CUSTOMER })).toArray();
  if (search) {
    const needle = search.trim().toLowerCase();
    all = all.filter((u) => `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(needle));
  }
  // Alphabetical (first name, then last name as a tiebreaker) — this is a directory an
  // admin scans by name to find someone, not an activity feed, so newest-first isn't
  // the right default here.
  const sorted = [...all].sort(
    (a, b) => a.firstName.localeCompare(b.firstName) || a.lastName.localeCompare(b.lastName)
  );
  const start = (page - 1) * pageSize;
  const pageOfClients = sorted.slice(start, start + pageSize);

  // Joined stats only computed for the page actually being shown, not the whole customer
  // base — cheap even at this app's full-scan-then-reduce style since it's bounded by
  // pageSize, unlike the collection-wide scans elsewhere in this file.
  const clientIds = pageOfClients.map((c) => c._id);
  const [allAppointments, allLoyaltyAccounts] = await Promise.all([
    clientIds.length
      ? (await appointmentsCollection().find({ userId: { $in: clientIds } })).toArray()
      : Promise.resolve([]),
    clientIds.length
      ? (await loyaltyAccountsCollection().find({ userId: { $in: clientIds } })).toArray()
      : Promise.resolve([]),
  ]);
  const loyaltyByUser = new Map(allLoyaltyAccounts.map((a) => [String(a.userId), a.pointsBalance]));

  const clients = pageOfClients.map((c) => {
    const theirAppointments = allAppointments.filter((a) => String(a.userId) === String(c._id));
    const lastBookingDate = theirAppointments.reduce((latest, a) => (!latest || a.date > latest ? a.date : latest), null);
    return {
      ...toPublicUser(c),
      bookingsCount: theirAppointments.length,
      lastBookingDate,
      loyaltyPoints: loyaltyByUser.get(String(c._id)) ?? 0,
    };
  });

  return { clients, total: all.length, page, pageSize };
}

export async function getClientDetail(clientId) {
  const client = await usersCollection().findOne({ _id: new ObjectId(clientId), role: ROLES.CUSTOMER });
  if (!client) throw notFound('Client');

  const appointments = await (await appointmentsCollection().find({ userId: client._id })).toArray();
  const sorted = appointments.sort((a, b) => (a.date < b.date ? 1 : -1));

  return { client: toPublicUser(client), appointments: sorted };
}

// Blocking/unblocking reuses the same `isActive` flag login() already enforces — a
// blocked customer simply can't log in, same as any other deactivated account (§4.2),
// rather than a second parallel "banned" concept.
export async function setClientActive(clientId, isActive) {
  const id = new ObjectId(clientId);
  const before = await usersCollection().findOneAndUpdate(
    { _id: id, role: ROLES.CUSTOMER },
    { $set: { isActive, updatedAt: new Date() } }
  );
  if (!before) throw notFound('Client');
  return toPublicUser(await usersCollection().findOne({ _id: id }));
}
