import { ObjectId } from 'mongodb';

// Minimal in-memory stand-in for the MongoDB driver, supporting only the operators this
// codebase actually uses (exact-match filters including null/ObjectId equality, $gt/$gte/
// $lt/$lte range queries, $in/$nin, and $set updates). Lets service-layer logic — bcrypt hashing, refresh-token rotation,
// atomic findOneAndUpdate guards — be unit-tested without a real mongod, which is slow
// and unreliable to provision in CI/sandboxes. Not a MongoDB reimplementation: extend the
// operator subset here only when a service genuinely needs a new one.

function isPlainConditionObject(condition) {
  return condition && typeof condition === 'object' && !(condition instanceof ObjectId) && !(condition instanceof Date);
}

function matches(doc, filter) {
  return Object.entries(filter).every(([key, condition]) => {
    const actual = doc[key];
    if (isPlainConditionObject(condition)) {
      return Object.entries(condition).every(([op, value]) => {
        if (op === '$in') return value.some((v) => (v instanceof ObjectId ? String(actual) === String(v) : actual === v));
        if (op === '$nin') return !value.some((v) => (v instanceof ObjectId ? String(actual) === String(v) : actual === v));
        if (actual == null) return false;
        if (op === '$gt') return actual > value;
        if (op === '$gte') return actual >= value;
        if (op === '$lt') return actual < value;
        if (op === '$lte') return actual <= value;
        throw new Error(`fakeDb: unsupported operator ${op}`);
      });
    }
    if (condition instanceof ObjectId || actual instanceof ObjectId) {
      return String(actual) === String(condition);
    }
    return actual === condition;
  });
}

function applyUpdate(doc, update) {
  const next = { ...doc };
  if (update.$set) Object.assign(next, update.$set);
  if (update.$inc) {
    for (const [key, amount] of Object.entries(update.$inc)) {
      next[key] = (next[key] ?? 0) + amount;
    }
  }
  if (update.$push) {
    for (const [key, value] of Object.entries(update.$push)) {
      next[key] = [...(next[key] ?? []), value];
    }
  }
  if (update.$addToSet) {
    for (const [key, value] of Object.entries(update.$addToSet)) {
      const arr = next[key] ?? [];
      const already = arr.some((v) => String(v) === String(value));
      next[key] = already ? arr : [...arr, value];
    }
  }
  if (update.$pull) {
    for (const [key, value] of Object.entries(update.$pull)) {
      next[key] = (next[key] ?? []).filter((v) => String(v) !== String(value));
    }
  }
  return next;
}

class FakeDuplicateKeyError extends Error {
  constructor(indexName) {
    super(`E11000 duplicate key error (fakeDb, index: ${indexName})`);
    this.code = 11000;
    this.name = 'FakeDuplicateKeyError';
  }
}

function makeCollection() {
  let docs = [];
  let uniqueIndexes = [];

  function assertUnique(candidate, excludeId) {
    for (const index of uniqueIndexes) {
      if (index.partialFilterExpression && !matches(candidate, index.partialFilterExpression)) continue;
      const fields = Object.keys(index.key);
      // Sparse (§ real bug this caught twice — referralCode, then yocoCheckoutId): a
      // *sparse* index only has an entry for documents where the field is genuinely
      // present, so a document missing it entirely can never collide with anything.
      // Critically this is about presence, not value — an explicit `null` still counts
      // as present and still collides, matching real MongoDB (and matching the actual
      // production incidents this was written to reproduce).
      if (index.sparse && fields.some((f) => !(f in candidate))) continue;
      const clashes = docs.some((d) => {
        if (excludeId !== undefined && String(d._id) === String(excludeId)) return false;
        if (index.partialFilterExpression && !matches(d, index.partialFilterExpression)) return false;
        if (index.sparse && fields.some((f) => !(f in d))) return false;
        return fields.every((f) => String(d[f]) === String(candidate[f]));
      });
      if (clashes) throw new FakeDuplicateKeyError(index.name);
    }
  }

  return {
    // Mirrors the mongodb driver: registers unique (optionally partial) indexes so
    // insertOne/updateOne can enforce them — this is what lets a test prove the
    // double-booking guarantee is enforced at the "database" level, not just in app code.
    async createIndexes(indexDefs) {
      uniqueIndexes = uniqueIndexes.concat(indexDefs.filter((i) => i.unique));
      return indexDefs.map((i) => i.name);
    },
    async insertOne(doc) {
      const _id = doc._id ?? new ObjectId();
      const stored = { ...doc, _id };
      assertUnique(stored);
      docs.push(stored);
      return { insertedId: _id };
    },
    async insertMany(newDocs) {
      const insertedIds = {};
      newDocs.forEach((doc, i) => {
        const _id = doc._id ?? new ObjectId();
        docs.push({ ...doc, _id });
        insertedIds[i] = _id;
      });
      return { insertedIds, insertedCount: newDocs.length };
    },
    async deleteOne(filter) {
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx === -1) return { deletedCount: 0 };
      docs.splice(idx, 1);
      return { deletedCount: 1 };
    },
    async findOne(filter) {
      return docs.find((d) => matches(d, filter)) ?? null;
    },
    async updateOne(filter, update) {
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx === -1) return { matchedCount: 0, modifiedCount: 0 };
      const next = applyUpdate(docs[idx], update);
      assertUnique(next, docs[idx]._id);
      docs[idx] = next;
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async updateMany(filter, update) {
      let count = 0;
      docs = docs.map((d) => {
        if (matches(d, filter)) {
          count += 1;
          return applyUpdate(d, update);
        }
        return d;
      });
      return { matchedCount: count, modifiedCount: count };
    },
    // Mirrors the mongodb v6 driver default: returns the pre-update document (or null),
    // not a { value } wrapper — matches what authService.js relies on.
    async findOneAndUpdate(filter, update) {
      const idx = docs.findIndex((d) => matches(d, filter));
      if (idx === -1) return null;
      const before = docs[idx];
      const next = applyUpdate(docs[idx], update);
      assertUnique(next, before._id);
      docs[idx] = next;
      return before;
    },
    async deleteMany(filter = {}) {
      const before = docs.length;
      docs = docs.filter((d) => !matches(d, filter));
      return { deletedCount: before - docs.length };
    },
    async find(filter = {}) {
      const results = docs.filter((d) => matches(d, filter));
      return { toArray: async () => results };
    },
    _dump: () => docs,
  };
}

export function createFakeDb() {
  const collections = new Map();
  return {
    collection(name) {
      if (!collections.has(name)) collections.set(name, makeCollection());
      return collections.get(name);
    },
    // Mirrors the real driver's Db#command enough for routes/index.js's /health check
    // (`{ ping: 1 }`) to exercise its real code path in tests instead of always hitting
    // the catch branch.
    async command() {
      return { ok: 1 };
    },
  };
}
