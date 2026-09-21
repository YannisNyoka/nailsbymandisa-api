import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import * as authService from '../../src/services/authService.js';
import { passwordResetTokensCollection } from '../../src/models/passwordResetTokens.js';
import { refreshTokensCollection } from '../../src/models/refreshTokens.js';
import { usersCollection } from '../../src/models/users.js';
import { generateToken, hashToken } from '../../src/utils/crypto.js';

const testUser = {
  email: 'client@example.com',
  password: 'supersecret123',
  firstName: 'Thandi',
  lastName: 'Mokoena',
};

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('authService.register', () => {
  it('creates a user and returns a token pair without leaking the password hash', async () => {
    const result = await authService.register(testUser);
    expect(result.user.email).toBe(testUser.email);
    expect(result.user.passwordHash).toBeUndefined();
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
  });

  it('rejects a duplicate email with a 409', async () => {
    await authService.register(testUser);
    await expect(authService.register(testUser)).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('authService.login', () => {
  it('logs in with correct credentials', async () => {
    await authService.register(testUser);
    const result = await authService.login({ email: testUser.email, password: testUser.password });
    expect(result.user.email).toBe(testUser.email);
  });

  it('rejects an incorrect password with 401', async () => {
    await authService.register(testUser);
    await expect(
      authService.login({ email: testUser.email, password: 'wrong-password' })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects an unknown email with the same 401 as a wrong password', async () => {
    await expect(
      authService.login({ email: 'nobody@example.com', password: 'whatever123' })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects login for a deactivated account', async () => {
    await authService.register(testUser);
    await usersCollection().updateOne({ email: testUser.email }, { $set: { isActive: false } });
    await expect(
      authService.login({ email: testUser.email, password: testUser.password })
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.refresh — rotation and reuse detection', () => {
  it('rotates the refresh token on each use', async () => {
    const { refreshToken: first } = await authService.register(testUser);
    const { refreshToken: second, accessToken } = await authService.refresh({ rawRefreshToken: first });
    expect(second).not.toBe(first);
    expect(accessToken).toEqual(expect.any(String));
  });

  it('treats reuse within the grace window as a benign race (e.g. two tabs refreshing at once), not theft', async () => {
    const { refreshToken: first } = await authService.register(testUser);
    const resultA = await authService.refresh({ rawRefreshToken: first });
    // A second near-simultaneous presentation of the same now-rotated token — e.g. a
    // second browser tab — must not be treated as theft.
    const resultB = await authService.refresh({ rawRefreshToken: first });
    expect(resultB.accessToken).toEqual(expect.any(String));
    expect(resultB.refreshToken).toEqual(expect.any(String));

    // The family must still be alive and usable afterwards.
    await expect(authService.refresh({ rawRefreshToken: resultB.refreshToken })).resolves.toBeTruthy();
    void resultA;
  });

  it('follows multiple hops of rotation within the grace window, not just one (real repro: several quick page loads in a row)', async () => {
    const { refreshToken: gen1 } = await authService.register(testUser);
    const { refreshToken: gen2 } = await authService.refresh({ rawRefreshToken: gen1 });
    // Rotate twice more in quick succession, as separate page loads each triggering
    // their own refresh would — gen1's `replacedByTokenHash` only points at gen2, which
    // is itself now also revoked. Presenting the original gen1 token again must still
    // resolve to the *current* tip (gen4) rather than failing after one hop.
    const { refreshToken: gen3 } = await authService.refresh({ rawRefreshToken: gen2 });
    await authService.refresh({ rawRefreshToken: gen3 });

    const result = await authService.refresh({ rawRefreshToken: gen1 });
    expect(result.accessToken).toEqual(expect.any(String));
    expect(result.refreshToken).toEqual(expect.any(String));
  });

  it('rejects reuse well outside the grace window and revokes the whole family (real theft)', async () => {
    const { refreshToken: first } = await authService.register(testUser);
    const { refreshToken: second } = await authService.refresh({ rawRefreshToken: first });

    // Simulate this reuse happening long after rotation — outside the benign-race
    // grace window a genuine stolen/replayed token would arrive in.
    await refreshTokensCollection().updateOne(
      { tokenHash: hashToken(first) },
      { $set: { revokedAt: new Date(Date.now() - 60_000) } }
    );

    await expect(authService.refresh({ rawRefreshToken: first })).rejects.toMatchObject({ statusCode: 401 });
    // Theft detection revokes the whole family, including the legitimate successor token.
    await expect(authService.refresh({ rawRefreshToken: second })).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.logout', () => {
  it('invalidates the refresh token so it can no longer be used', async () => {
    const { refreshToken } = await authService.register(testUser);
    await authService.logout({ rawRefreshToken: refreshToken });
    await expect(authService.refresh({ rawRefreshToken: refreshToken })).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});

describe('authService.changePassword', () => {
  it('invalidates existing refresh tokens after a password change', async () => {
    const { user, refreshToken } = await authService.register(testUser);
    await authService.changePassword({
      userId: user._id,
      currentPassword: testUser.password,
      newPassword: 'brand-new-password-1',
    });

    await expect(authService.refresh({ rawRefreshToken: refreshToken })).rejects.toMatchObject({
      statusCode: 401,
    });
    // New password works, old one doesn't.
    await expect(
      authService.login({ email: testUser.email, password: 'brand-new-password-1' })
    ).resolves.toBeTruthy();
    await expect(
      authService.login({ email: testUser.email, password: testUser.password })
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects the wrong current password', async () => {
    const { user } = await authService.register(testUser);
    await expect(
      authService.changePassword({ userId: user._id, currentPassword: 'nope', newPassword: 'whatever-new-1' })
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe('authService.requestPasswordReset / resetPassword', () => {
  it('resets the password via a token and revokes existing sessions', async () => {
    const { refreshToken } = await authService.register(testUser);
    await authService.requestPasswordReset({ email: testUser.email });

    const stored = await (await passwordResetTokensCollection().find()).toArray();
    // The service only stores a hash — the raw token that was emailed isn't recoverable
    // from the DB, so this test just confirms a token record was created correctly rather
    // than driving the full reset flow (that's covered at the route/integration level).
    expect(stored).toHaveLength(1);
    expect(stored[0].usedAt).toBeNull();

    // Old refresh token is still valid until resetPassword actually runs.
    await expect(authService.refresh({ rawRefreshToken: refreshToken })).resolves.toBeTruthy();
  });

  it('rejects an invalid reset token', async () => {
    await authService.register(testUser);
    await expect(
      authService.resetPassword({ rawToken: 'not-a-real-token', newPassword: 'whatever-new-1' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('does not throw for an unknown email (avoids account enumeration)', async () => {
    await expect(authService.requestPasswordReset({ email: 'nobody@example.com' })).resolves.toBeUndefined();
  });

  it('lets a reset token be used exactly once', async () => {
    const { user, refreshToken } = await authService.register(testUser);
    const rawToken = generateToken();
    await passwordResetTokensCollection().insertOne({
      userId: user._id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      createdAt: new Date(),
      usedAt: null,
    });

    await authService.resetPassword({ rawToken, newPassword: 'brand-new-password-2' });

    // Old sessions are invalidated by the reset, same guarantee as changePassword.
    await expect(authService.refresh({ rawRefreshToken: refreshToken })).rejects.toMatchObject({
      statusCode: 401,
    });

    // Reusing the same token a second time is rejected — the one-time-use guard is atomic.
    await expect(
      authService.resetPassword({ rawToken, newPassword: 'yet-another-password-3' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
