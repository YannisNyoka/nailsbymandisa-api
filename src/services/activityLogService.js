import { ObjectId } from 'mongodb';
import { activityLogCollection } from '../models/activityLog.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';

export async function logActivity({ type, message, actorUserId = null, metadata = null }) {
  await activityLogCollection().insertOne({
    type,
    message,
    actorUserId: actorUserId ? new ObjectId(actorUserId) : null,
    metadata,
    createdAt: new Date(),
  });
}

export async function listActivity({ page = 1, pageSize = 20 } = {}) {
  const all = await (await activityLogCollection().find({})).toArray();
  const sorted = sortByCreatedAtDesc(all);
  const start = (page - 1) * pageSize;
  return { entries: sorted.slice(start, start + pageSize), total: all.length, page, pageSize };
}
