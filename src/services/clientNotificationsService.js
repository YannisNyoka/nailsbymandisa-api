import { ObjectId } from 'mongodb';
import { clientNotificationsCollection } from '../models/clientNotifications.js';
import { usersCollection } from '../models/users.js';
import { notFound } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { ROLES } from '../config/constants.js';

export async function createClientNotification({ userId, type, title, body, link = null }) {
  const doc = {
    userId: new ObjectId(userId),
    type,
    title,
    body,
    link,
    isRead: false,
    createdAt: new Date(),
  };
  const { insertedId } = await clientNotificationsCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

export async function listForUser(userId, { page = 1, pageSize = 20 } = {}) {
  const uid = new ObjectId(userId);
  const [all, unreadCount] = await Promise.all([
    (await clientNotificationsCollection().find({ userId: uid })).toArray(),
    (await clientNotificationsCollection().find({ userId: uid, isRead: false })).toArray().then((n) => n.length),
  ]);
  const sorted = sortByCreatedAtDesc(all);
  const start = (page - 1) * pageSize;
  return {
    notifications: sorted.slice(start, start + pageSize),
    total: all.length,
    unreadCount,
    page,
    pageSize,
  };
}

// Ownership is enforced here (not just at the route) so this function is safe to call
// from anywhere — a customer can only ever mark/delete their own notifications (§5.3).
export async function markRead(notificationId, userId) {
  const result = await clientNotificationsCollection().updateOne(
    { _id: new ObjectId(notificationId), userId: new ObjectId(userId) },
    { $set: { isRead: true } }
  );
  if (result.matchedCount === 0) throw notFound('Notification');
}

export async function markAllRead(userId) {
  await clientNotificationsCollection().updateMany(
    { userId: new ObjectId(userId), isRead: false },
    { $set: { isRead: true } }
  );
}

export async function deleteNotification(notificationId, userId) {
  const result = await clientNotificationsCollection().deleteOne({
    _id: new ObjectId(notificationId),
    userId: new ObjectId(userId),
  });
  if (result.deletedCount === 0) throw notFound('Notification');
}

// §4.11 — admin broadcast to every client, via the real in-app compose form (routes/admin.js),
// not a chain of prompt() dialogs. One insertMany rather than an await-per-customer loop (§6.3).
export async function broadcastNotification({ title, body, link = null }) {
  const customers = await (await usersCollection().find({ role: ROLES.CUSTOMER, isActive: true })).toArray();
  if (customers.length === 0) return { sentCount: 0 };
  const now = new Date();
  await clientNotificationsCollection().insertMany(
    customers.map((c) => ({ userId: c._id, type: 'broadcast', title, body, link, isRead: false, createdAt: now }))
  );
  return { sentCount: customers.length };
}
