import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import * as clientGalleryService from '../../src/services/clientGalleryService.js';
import { ROLES } from '../../src/config/constants.js';

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('clientGalleryService.submit / moderate', () => {
  it('starts pending and is only publicly visible once approved', async () => {
    const userId = new ObjectId();
    const submission = await clientGalleryService.submit({ userId, imageUrl: 'https://example.com/before-after.jpg' });
    expect(submission.status).toBe('pending');
    expect(await clientGalleryService.listApproved()).toHaveLength(0);

    const adminId = new ObjectId();
    await clientGalleryService.moderate({ id: submission._id, status: 'approved', moderatorId: adminId });
    expect(await clientGalleryService.listApproved()).toHaveLength(1);
  });

  it('rejects an invalid moderation status', async () => {
    const userId = new ObjectId();
    const submission = await clientGalleryService.submit({ userId, imageUrl: 'https://example.com/x.jpg' });
    await expect(
      clientGalleryService.moderate({ id: submission._id, status: 'pending', moderatorId: new ObjectId() })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('clientGalleryService.deleteSubmission', () => {
  it('lets the owner delete their own submission but not a stranger', async () => {
    const owner = { _id: new ObjectId(), role: ROLES.CUSTOMER };
    const stranger = { _id: new ObjectId(), role: ROLES.CUSTOMER };
    const submission = await clientGalleryService.submit({ userId: owner._id, imageUrl: 'https://example.com/x.jpg' });

    await expect(clientGalleryService.deleteSubmission(submission._id, stranger)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(clientGalleryService.deleteSubmission(submission._id, owner)).resolves.toBeUndefined();
  });
});

describe('clientGalleryService.toggleLike', () => {
  it('rejects liking a submission that is not approved', async () => {
    const userId = new ObjectId();
    const submission = await clientGalleryService.submit({ userId, imageUrl: 'https://example.com/x.jpg' });
    await expect(clientGalleryService.toggleLike(submission._id, userId)).rejects.toMatchObject({ statusCode: 400 });
  });
});
