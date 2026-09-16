import { ObjectId } from 'mongodb';
import { availabilityCollection } from '../models/availability.js';
import { badRequest, notFound } from '../utils/AppError.js';

function toObjectIdOrNull(id) {
  return id ? new ObjectId(id) : null;
}

// Pure calendar-date arithmetic on YYYY-MM-DD strings via Date.UTC, never relying on the
// server process's local timezone (§6.5) — a "day" here always means the calendar day,
// not a moment 24h later in whatever TZ the process happens to run under.
function enumerateDates(dateFrom, dateTo) {
  const [fy, fm, fd] = dateFrom.split('-').map(Number);
  const [ty, tm, td] = dateTo.split('-').map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  if (end < start) throw badRequest('dateTo must not be before dateFrom.');

  const dates = [];
  for (let t = start; t <= end; t += 86_400_000) {
    const d = new Date(t);
    dates.push(
      `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    );
  }
  return dates;
}

export async function listAvailability({ employeeId, dateFrom, dateTo }) {
  const filter = {};
  if (employeeId) filter.employeeId = new ObjectId(employeeId);
  if (dateFrom && dateTo) filter.date = { $gte: dateFrom, $lte: dateTo };
  const cursor = await availabilityCollection().find(filter);
  return cursor.toArray();
}

export async function createBlock({ employeeId, date, startTime, endTime, reason, createdBy }) {
  if (startTime >= endTime) throw badRequest('startTime must be before endTime.');
  const doc = {
    employeeId: toObjectIdOrNull(employeeId),
    date,
    startTime,
    endTime,
    reason: reason ?? null,
    createdBy: new ObjectId(createdBy),
    createdAt: new Date(),
  };
  const { insertedId } = await availabilityCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

// Bulk-block a date + time range in one write (§4.3) — a single insertMany rather than
// an await-per-day loop (§6.3).
export async function createBulkBlock({ employeeId, dateFrom, dateTo, startTime, endTime, reason, createdBy }) {
  if (startTime >= endTime) throw badRequest('startTime must be before endTime.');
  const dates = enumerateDates(dateFrom, dateTo);
  const now = new Date();
  const docs = dates.map((date) => ({
    employeeId: toObjectIdOrNull(employeeId),
    date,
    startTime,
    endTime,
    reason: reason ?? null,
    createdBy: new ObjectId(createdBy),
    createdAt: now,
  }));
  await availabilityCollection().insertMany(docs);
  return docs;
}

export async function deleteBlock(id) {
  const result = await availabilityCollection().deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 0) throw notFound('Availability block');
}
