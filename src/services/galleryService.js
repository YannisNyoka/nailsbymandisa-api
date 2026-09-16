import { ObjectId } from 'mongodb';
import { galleryCollection } from '../models/gallery.js';
import { notFound } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { paginate } from '../utils/pagination.js';

export async function listPublished() {
  const items = await (await galleryCollection().find({ isPublished: true })).toArray();
  return sortByCreatedAtDesc(items);
}

// Admin list (§7.3 — paginated, unlike the public listPublished() above, which a single
// salon's curated gallery is realistically never large enough to need infinite-scroll
// treatment for).
export async function listAll({ page = 1, pageSize = 20 } = {}) {
  const items = await (await galleryCollection().find({})).toArray();
  const sorted = sortByCreatedAtDesc(items);
  const { items: pageItems, total } = paginate(sorted, { page, pageSize });
  return { gallery: pageItems, total, page, pageSize };
}

export async function createItem({ mediaUrl, mediaType, caption, createdBy }) {
  const now = new Date();
  const doc = {
    mediaUrl,
    mediaType,
    caption: caption ?? null,
    isPublished: true,
    likedByUserIds: [],
    createdBy: new ObjectId(createdBy),
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await galleryCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

export async function updateItem(id, data) {
  const result = await galleryCollection().updateOne({ _id: new ObjectId(id) }, { $set: { ...data, updatedAt: new Date() } });
  if (result.matchedCount === 0) throw notFound('Gallery item');
  return galleryCollection().findOne({ _id: new ObjectId(id) });
}

export async function deleteItem(id) {
  const result = await galleryCollection().deleteOne({ _id: new ObjectId(id) });
  if (result.deletedCount === 0) throw notFound('Gallery item');
}

// Toggling a like isn't a balance/limit invariant like loyalty points or a discount's
// usage cap — a rare double-toggle under concurrency just means one extra flip, not a
// correctness bug — so this reads-then-writes rather than needing the atomic
// findOneAndUpdate guard pattern used elsewhere in this codebase.
export async function toggleLike(id, userId) {
  const item = await galleryCollection().findOne({ _id: new ObjectId(id) });
  if (!item) throw notFound('Gallery item');
  const uid = new ObjectId(userId);
  const alreadyLiked = item.likedByUserIds.some((u) => String(u) === String(uid));
  await galleryCollection().updateOne(
    { _id: item._id },
    alreadyLiked ? { $pull: { likedByUserIds: uid } } : { $addToSet: { likedByUserIds: uid } }
  );
  return { liked: !alreadyLiked };
}
