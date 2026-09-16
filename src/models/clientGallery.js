import { getDb } from '../config/db.js';

export const COLLECTION = 'clientGallery';

export const CLIENT_GALLERY_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

// Customer-submitted before/after photos with a moderation queue (§4.10) — same
// URL-reference approach as gallery.js, no file-upload storage built.
export const clientGalleryJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'submittedByUserId',
      'imageUrl',
      'caption',
      'status',
      'likedByUserIds',
      'moderatedBy',
      'moderatedAt',
      'createdAt',
    ],
    properties: {
      submittedByUserId: { bsonType: 'objectId' },
      imageUrl: { bsonType: 'string' },
      caption: { bsonType: ['string', 'null'] },
      status: { enum: Object.values(CLIENT_GALLERY_STATUS) },
      likedByUserIds: { bsonType: 'array', items: { bsonType: 'objectId' } },
      moderatedBy: { bsonType: ['objectId', 'null'] },
      moderatedAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' },
    },
  },
};

export const clientGalleryIndexes = [
  { key: { status: 1, createdAt: -1 }, name: 'idx_status_created' },
  { key: { submittedByUserId: 1 }, name: 'idx_submitter' },
];

export function clientGalleryCollection() {
  return getDb().collection(COLLECTION);
}
