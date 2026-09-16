import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import * as adminUsersService from '../../src/services/adminUsersService.js';
import { usersCollection } from '../../src/models/users.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('adminUsersService.inviteAdminUser', () => {
  it('creates a brand-new admin account for an unregistered email', async () => {
    const adminUser = await adminUsersService.inviteAdminUser({
      email: 'new-admin@example.com',
      firstName: 'New',
      lastName: 'Admin',
      permissions: [PERMISSIONS.MANAGE_SERVICES],
    });
    expect(adminUser.role).toBe(ROLES.ADMIN);
    expect(adminUser.permissions).toEqual([PERMISSIONS.MANAGE_SERVICES]);
    expect(adminUser.passwordHash).toBeUndefined();

    const stored = await usersCollection().findOne({ email: 'new-admin@example.com' });
    expect(stored.passwordHash).toEqual(expect.any(String));
    // The placeholder hash must not be usable — it's a random token nobody was given.
    expect(stored.passwordHash).not.toBe('');
  });

  it('rejects creating a new account with no name given', async () => {
    await expect(
      adminUsersService.inviteAdminUser({ email: 'noname@example.com', permissions: [] })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('promotes an existing customer in place instead of erroring on the duplicate email', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const existing = await usersCollection().findOne({ _id: userId });

    const adminUser = await adminUsersService.inviteAdminUser({
      email: existing.email,
      permissions: [PERMISSIONS.MANAGE_GALLERY],
    });
    expect(adminUser.role).toBe(ROLES.ADMIN);
    expect(adminUser.permissions).toEqual([PERMISSIONS.MANAGE_GALLERY]);
    expect(String(adminUser._id)).toBe(String(userId));
    // Promoting in place must not touch their existing password.
    const stored = await usersCollection().findOne({ _id: userId });
    expect(stored.passwordHash).toBe(existing.passwordHash);
  });

  it('rejects inviting someone who is already an admin', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    const existing = await usersCollection().findOne({ _id: userId });
    await expect(
      adminUsersService.inviteAdminUser({ email: existing.email, permissions: [] })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an unknown permission string', async () => {
    await expect(
      adminUsersService.inviteAdminUser({
        email: 'bad-perm@example.com',
        firstName: 'A',
        lastName: 'B',
        permissions: ['not_a_real_permission'],
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('adminUsersService.updateAdminPermissions', () => {
  it("updates another admin's permissions", async () => {
    const { userId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    const { userId: actingAdminId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });

    const updated = await adminUsersService.updateAdminPermissions({
      id: String(userId),
      permissions: [PERMISSIONS.MANAGE_PAYMENTS],
      requestingUserId: actingAdminId,
    });
    expect(updated.permissions).toEqual([PERMISSIONS.MANAGE_PAYMENTS]);
  });

  it('refuses to let an admin edit their own permissions', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    await expect(
      adminUsersService.updateAdminPermissions({
        id: String(userId),
        permissions: [PERMISSIONS.MANAGE_PAYMENTS],
        requestingUserId: userId,
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('404s for a target that is not an admin', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { userId: actingAdminId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    await expect(
      adminUsersService.updateAdminPermissions({
        id: String(userId),
        permissions: [],
        requestingUserId: actingAdminId,
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('adminUsersService.revokeAdminAccess', () => {
  it('demotes an admin back to a plain customer with no permissions', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_SERVICES] });
    const { userId: actingAdminId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });

    const revoked = await adminUsersService.revokeAdminAccess({ id: String(userId), requestingUserId: actingAdminId });
    expect(revoked.role).toBe(ROLES.CUSTOMER);
    expect(revoked.permissions).toEqual([]);
  });

  it('refuses to let an admin revoke their own access', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    await expect(
      adminUsersService.revokeAdminAccess({ id: String(userId), requestingUserId: userId })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('adminUsersService.listAdminUsers', () => {
  it('only lists admins, paginated', async () => {
    await createUserAndToken({ role: ROLES.CUSTOMER });
    await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });

    const { adminUsers, total } = await adminUsersService.listAdminUsers({ page: 1, pageSize: 20 });
    expect(total).toBe(2);
    expect(adminUsers).toHaveLength(2);
    expect(adminUsers.every((u) => u.role === ROLES.ADMIN)).toBe(true);
  });
});
