import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import * as galleryService from '../../src/services/galleryService.js';

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('galleryService', () => {
  it('only lists published items publicly', async () => {
    const adminId = new ObjectId();
    const published = await galleryService.createItem({ mediaUrl: 'https://example.com/a.jpg', mediaType: 'image', createdBy: adminId });
    const unpublished = await galleryService.updateItem(
      (await galleryService.createItem({ mediaUrl: 'https://example.com/b.jpg', mediaType: 'image', createdBy: adminId }))._id,
      { isPublished: false }
    );

    const publicList = await galleryService.listPublished();
    expect(publicList.map((i) => i._id.toString())).toEqual([published._id.toString()]);

    const adminList = await galleryService.listAll();
    expect(adminList.gallery).toHaveLength(2);
    expect(adminList.total).toBe(2);
    expect(unpublished.isPublished).toBe(false);
  });

  it('toggles a like on and off', async () => {
    const adminId = new ObjectId();
    const userId = new ObjectId();
    const item = await galleryService.createItem({ mediaUrl: 'https://example.com/a.jpg', mediaType: 'image', createdBy: adminId });

    const first = await galleryService.toggleLike(item._id, userId);
    expect(first.liked).toBe(true);
    const second = await galleryService.toggleLike(item._id, userId);
    expect(second.liked).toBe(false);
  });
});
