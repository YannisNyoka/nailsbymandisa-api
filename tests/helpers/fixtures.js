import { servicesCollection } from '../../src/models/services.js';
import { employeesCollection } from '../../src/models/employees.js';
import { WEEKDAYS } from '../../src/models/employees.js';

// A date safely in the future (a week out) regardless of when the test suite runs,
// formatted as the plain YYYY-MM-DD string the app stores — avoids any dependency on
// "today" being a specific weekday.
export function futureDateString(daysAhead = 7) {
  const d = new Date(Date.now() + daysAhead * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export async function createTestService(overrides = {}) {
  const now = new Date();
  const doc = {
    name: 'Gel manicure',
    description: null,
    category: 'gel',
    durationMinutes: 60,
    priceCents: 35000,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const { insertedId } = await servicesCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

// Working hours span every day of the week so tests don't have to know which weekday
// `futureDateString()` lands on.
export async function createTestEmployee(overrides = {}) {
  const now = new Date();
  const workingHours = Object.fromEntries(WEEKDAYS.map((d) => [d, [{ start: '06:00', end: '22:00' }]]));
  const doc = {
    name: 'Naledi',
    bio: null,
    photoUrl: null,
    workingHours,
    serviceIds: null,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const { insertedId } = await employeesCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}
