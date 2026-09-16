import { getDb } from '../config/db.js';

export const COLLECTION = 'gallery';

// Admin-curated public gallery (§4.10). Items reference already-hosted media by URL —
// this build doesn't include file-upload storage (S3/Cloudinary etc.), which needs its
// own infrastructure credentials beyond this app's scope. An admin pastes a URL to
// media they've already uploaded elsewhere, same as the placeholder-imagery convention
// used throughout (§2).
export const galleryJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['mediaUrl', 'mediaType', 'caption', 'isPublished', 'likedByUserIds', 'createdBy', 'createdAt', 'updatedAt'],
    properties: {
      mediaUrl: { bsonType: 'string' },
      mediaType: { enum: ['image', 'video'] },
      caption: { bsonType: ['string', 'null'] },
      isPublished: { bsonType: 'bool' },
      likedByUserIds: { bsonType: 'array', items: { bsonType: 'objectId' } },
      createdBy: { bsonType: 'objectId' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const galleryIndexes = [{ key: { isPublished: 1, createdAt: -1 }, name: 'idx_published_created' }];

export function galleryCollection() {
  return getDb().collection(COLLECTION);
}
