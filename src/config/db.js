import { MongoClient } from 'mongodb';
import { env, isTest } from './env.js';
import { logger } from './logger.js';

let client;
let db;

// Test-only escape hatch: lets unit tests inject an in-memory fake db (see
// tests/helpers/fakeDb.js) instead of requiring a real MongoDB instance. Never callable
// outside NODE_ENV=test, so it can't accidentally swap the connection in dev/production.
export function setTestDb(fakeDb) {
  if (!isTest) throw new Error('setTestDb() is only available when NODE_ENV=test');
  db = fakeDb;
}

export async function connectDb() {
  if (db) return db;
  client = new MongoClient(env.MONGO_URI);
  await client.connect();
  db = client.db(env.MONGO_DB_NAME);
  logger.info({ dbName: env.MONGO_DB_NAME }, 'Connected to MongoDB');
  return db;
}

export function getDb() {
  if (!db) {
    throw new Error('Database not connected — call connectDb() before getDb()');
  }
  return db;
}

// The raw MongoClient, for the rare operation that needs a real transaction (a session
// is started from the client, not the Db) — see bookingService.js's reschedule overlap
// guard. Everything else should keep using getDb()/the *Collection() helpers.
export function getClient() {
  if (!client) {
    throw new Error('Database not connected — call connectDb() before getClient()');
  }
  return client;
}

export async function closeDb() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}
