import { ObjectId } from 'mongodb';
import { clientGalleryCollection, CLIENT_GALLERY_STATUS } from '../models/clientGallery.js';
import { badRequest, forbidden, notFound } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { paginate } from '../utils/pagination.js';

export async function listApproved() {
  const items = await (await clientGalleryCollection().find({ status: CLIENT_GALLERY_STATUS.APPROVED })).toArray();
  return sortByCreatedAtDesc(items);
}

// Admin moderation queue (§7.3 — paginated; this can genuinely grow large over time as
// customers submit photos).
export async function listByStatus(status, { page = 1, pageSize = 20 } = {}) {
  const items = await (await clientGalleryCollection().find(status ? { status } : {})).toArray();
  const sorted = sortByCreatedAtDesc(items);
  const { items: pageItems, total } = paginate(sorted, { page, pageSize });
  return { submissions: pageItems, total, page, pageSize };
}

export async function submit({ userId, imageUrl, caption }) {
  const now = new Date();
  const doc = {
    submittedByUserId: new ObjectId(userId),
    imageUrl,
    caption: caption ?? null,
    status: CLIENT_GALLERY_STATUS.PENDING,
    likedByUserIds: [],
    moderatedBy: null,
    moderatedAt: null,
    createdAt: now,
  };
  const { insertedId } = await clientGalleryCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

export async function moderate({ id, status, moderatorId }) {
  if (![CLIENT_GALLERY_STATUS.APPROVED, CLIENT_GALLERY_STATUS.REJECTED].includes(status)) {
    throw badRequest('status must be approved or rejected.');
  }
  const result = await clientGalleryCollection().updateOne(
    { _id: new ObjectId(id) },
    { $set: { status, moderatedBy: new ObjectId(moderatorId), moderatedAt: new Date() } }
  );
  if (result.matchedCount === 0) throw notFound('Submission');
  return clientGalleryCollection().findOne({ _id: new ObjectId(id) });
}

export async function deleteSubmission(id, actor) {
  const item = await clientGalleryCollection().findOne({ _id: new ObjectId(id) });
  if (!item) throw notFound('Submission');
  const isOwner = String(item.submittedByUserId) === String(actor._id);
  if (actor.role !== 'admin' && !isOwner) throw forbidden('You do not have access to this submission.');
  await clientGalleryCollection().deleteOne({ _id: item._id });
}

// See galleryService.toggleLike — same reasoning: not a balance invariant, a
// read-then-write is fine for a like toggle.
export async function toggleLike(id, userId) {
  const item = await clientGalleryCollection().findOne({ _id: new ObjectId(id) });
  if (!item) throw notFound('Submission');
  if (item.status !== CLIENT_GALLERY_STATUS.APPROVED) throw badRequest('Only approved submissions can be liked.');
  const uid = new ObjectId(userId);
  const alreadyLiked = item.likedByUserIds.some((u) => String(u) === String(uid));
  await clientGalleryCollection().updateOne(
    { _id: item._id },
    alreadyLiked ? { $pull: { likedByUserIds: uid } } : { $addToSet: { likedByUserIds: uid } }
  );
  return { liked: !alreadyLiked };
}
