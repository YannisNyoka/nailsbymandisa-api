import { ObjectId } from 'mongodb';
import { appointmentsCollection } from '../models/appointments.js';
import { usersCollection } from '../models/users.js';
import { servicesCollection } from '../models/services.js';
import { APPOINTMENT_STATUS } from '../config/constants.js';
import { getSettings } from './settingsService.js';
import { sendMail } from '../config/mailer.js';
import { logActivity } from './activityLogService.js';
import { toInstant, hoursBetween } from '../utils/businessTime.js';
import { env } from '../config/env.js';

// Appointment reminder emails, timed close to the appointment (owner-configurable via
// SETTINGS.reminderHoursBefore, default 24h — no admin UI for it yet, same as the other
// policy numbers in this file; PATCH /api/settings directly for now).
//
// Triggered by an external scheduled job (routes/cron.js +
// .github/workflows/reminders.yml), not an in-process timer — Render's free tier spins
// the API down when idle, so a setInterval/node-cron loop inside the process wouldn't
// reliably fire on schedule. An external HTTP call both wakes the dyno and drives the
// timing.
//
// Idempotent via `reminderSentAt`: safe to call as often as the scheduler likes, and
// safe to call late (e.g. after a stretch the dyno was asleep) — anything that's crossed
// the threshold and hasn't been reminded yet goes out exactly once, whenever this next runs.
export async function sendDueReminders() {
  const settings = await getSettings();
  const hoursBefore = settings.reminderHoursBefore ?? 24;
  const now = new Date();

  // Cheap candidate set from Mongo (confirmed, never reminded); the precise "due within
  // hoursBefore, not already past" cut is computed in JS via toInstant/hoursBetween —
  // same full-scan-then-reduce style used throughout this codebase (see adminService.js).
  const candidates = await (
    await appointmentsCollection().find({ status: APPOINTMENT_STATUS.CONFIRMED, reminderSentAt: null })
  ).toArray();

  const due = candidates.filter((a) => {
    const hoursUntil = hoursBetween(now, toInstant(a.date, a.startTime));
    return hoursUntil > 0 && hoursUntil <= hoursBefore;
  });

  if (due.length === 0) return { sent: 0 };

  const userIds = [...new Set(due.filter((a) => a.userId).map((a) => String(a.userId)))];
  const serviceIds = [...new Set(due.flatMap((a) => a.serviceIds.map(String)))];
  const [users, services] = await Promise.all([
    userIds.length
      ? (await usersCollection().find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } })).toArray()
      : Promise.resolve([]),
    serviceIds.length
      ? (await servicesCollection().find({ _id: { $in: serviceIds.map((id) => new ObjectId(id)) } })).toArray()
      : Promise.resolve([]),
  ]);
  const usersById = new Map(users.map((u) => [String(u._id), u]));
  const servicesById = new Map(services.map((s) => [String(s._id), s]));

  let sent = 0;
  for (const appointment of due) {
    // Claim it first (atomic, guarded on reminderSentAt still being null) — if two runs
    // ever overlap, only one wins the claim and only one email goes out.
    // eslint-disable-next-line no-await-in-loop -- bounded by how many appointments are due this run, not a collection-wide scan
    const claimed = await appointmentsCollection().findOneAndUpdate(
      { _id: appointment._id, reminderSentAt: null },
      { $set: { reminderSentAt: now } }
    );
    if (!claimed) continue;

    const isGuest = !appointment.userId;
    const identity = isGuest ? appointment.guestInfo : usersById.get(String(appointment.userId));
    const to = identity?.email;
    if (!to) continue;
    const firstName = isGuest ? identity.name : identity.firstName;
    const serviceNames = appointment.serviceIds.map((id) => servicesById.get(String(id))?.name).filter(Boolean).join(', ');
    const serviceLabel = serviceNames ? ` (${serviceNames})` : '';
    const manageLine = isGuest
      ? `Need to reschedule or cancel? Call or WhatsApp us at ${settings.contact.whatsapp}.`
      : `Need to reschedule or cancel? Manage it from your account: <a href="${env.CLIENT_URL}/account/bookings">${env.CLIENT_URL}/account/bookings</a>`;

    // eslint-disable-next-line no-await-in-loop -- see above
    await sendMail({
      to,
      subject: `Reminder: your NailsByMandisa appointment on ${appointment.date}`,
      html: `<p>Hi ${firstName || 'there'},</p><p>This is a reminder that your appointment${serviceLabel} is coming up on ${appointment.date} at ${appointment.startTime}.</p><p>${manageLine}</p>`,
      text: `Reminder: your appointment${serviceLabel} is on ${appointment.date} at ${appointment.startTime}.`,
    });
    sent += 1;
  }

  if (sent > 0) {
    await logActivity({ type: 'reminders_sent', message: `Sent ${sent} appointment reminder email${sent === 1 ? '' : 's'}.` });
  }

  return { sent };
}
