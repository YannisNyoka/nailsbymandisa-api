import { getDb } from '../config/db.js';

export const COLLECTION = 'services';

// PLACEHOLDER category vocabulary — adjust to the salon's real menu structure.
export const SERVICE_CATEGORIES = Object.freeze([
  'manicure',
  'pedicure',
  'gel',
  'acrylic',
  'polygel',
  'nail_art',
  'soak_off',
  'extensions',
]);

export const servicesJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['name', 'category', 'durationMinutes', 'priceCents', 'isActive', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1 },
      description: { bsonType: ['string', 'null'] },
      // Shown on the public services list/card (HomePage.jsx) — a Cloudinary URL from the
      // same /uploads/image endpoint the hero slideshow and gallery use. Not in `required`
      // for forward-compat with services created before this field existed.
      imageUrl: { bsonType: ['string', 'null'] },
      category: { enum: SERVICE_CATEGORIES },
      durationMinutes: { bsonType: 'int', minimum: 5, maximum: 480 },
      priceCents: { bsonType: 'int', minimum: 0 },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const servicesIndexes = [
  { key: { isActive: 1, category: 1 }, name: 'idx_active_category' },
];

export function servicesCollection() {
  return getDb().collection(COLLECTION);
}
