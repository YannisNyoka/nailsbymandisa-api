import { ObjectId } from 'mongodb';
import { employeesCollection, emptyWorkingHours } from '../models/employees.js';
import { notFound } from '../utils/AppError.js';

export async function listEmployees({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { isActive: true };
  const cursor = await employeesCollection().find(filter);
  return cursor.toArray();
}

function toObjectIdArrayOrNull(ids) {
  if (!ids) return null;
  return ids.map((id) => new ObjectId(id));
}

export async function getEmployee(id) {
  const employee = await employeesCollection().findOne({ _id: new ObjectId(id) });
  if (!employee) throw notFound('Staff member');
  return employee;
}

export async function createEmployee(data) {
  const now = new Date();
  const { insertedId } = await employeesCollection().insertOne({
    name: data.name,
    bio: data.bio ?? null,
    photoUrl: data.photoUrl ?? null,
    workingHours: data.workingHours ?? emptyWorkingHours(),
    serviceIds: toObjectIdArrayOrNull(data.serviceIds),
    isActive: data.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  });
  return getEmployee(insertedId);
}

export async function updateEmployee(id, data) {
  await getEmployee(id);
  const update = { ...data, updatedAt: new Date() };
  if ('serviceIds' in data) update.serviceIds = toObjectIdArrayOrNull(data.serviceIds);
  await employeesCollection().updateOne({ _id: new ObjectId(id) }, { $set: update });
  return getEmployee(id);
}

export async function deleteEmployee(id) {
  await getEmployee(id);
  await employeesCollection().updateOne({ _id: new ObjectId(id) }, { $set: { isActive: false, updatedAt: new Date() } });
}

// Which staff members can perform a given service — powers "any available" selection
// in the booking wizard. null/absent serviceIds means "can perform everything".
export async function listEmployeesForService(serviceId) {
  const all = await listEmployees();
  return all.filter((e) => !e.serviceIds || e.serviceIds.some((s) => String(s) === String(serviceId)));
}
