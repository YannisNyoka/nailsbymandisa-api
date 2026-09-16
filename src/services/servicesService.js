import { ObjectId } from 'mongodb';
import { servicesCollection } from '../models/services.js';
import { notFound } from '../utils/AppError.js';

export async function listServices({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { isActive: true };
  const cursor = await servicesCollection().find(filter);
  return cursor.toArray();
}

export async function getService(id) {
  const service = await servicesCollection().findOne({ _id: new ObjectId(id) });
  if (!service) throw notFound('Service');
  return service;
}

export async function createService(data) {
  const now = new Date();
  const { insertedId } = await servicesCollection().insertOne({
    ...data,
    isActive: data.isActive ?? true,
    createdAt: now,
    updatedAt: now,
  });
  return getService(insertedId);
}

export async function updateService(id, data) {
  await getService(id); // 404s if missing
  await servicesCollection().updateOne(
    { _id: new ObjectId(id) },
    { $set: { ...data, updatedAt: new Date() } }
  );
  return getService(id);
}

export async function deleteService(id) {
  await getService(id);
  await servicesCollection().updateOne({ _id: new ObjectId(id) }, { $set: { isActive: false, updatedAt: new Date() } });
}
