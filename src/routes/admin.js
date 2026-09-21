import { Router } from 'express';
import { z } from 'zod';
import * as adminService from '../services/adminService.js';
import * as adminUsersService from '../services/adminUsersService.js';
import { listActivity, logActivity } from '../services/activityLogService.js';
import * as clientNotificationsService from '../services/clientNotificationsService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requirePermission, requirePermissionOrStaffSelf } from '../middleware/auth.js';
import { messagingLimiter } from '../middleware/rateLimit.js';
import { sendSms } from '../config/smsClient.js';
import { sendMail } from '../config/mailer.js';
import { PERMISSIONS, PAGINATION, ROLES } from '../config/constants.js';
import { badRequest, notFound } from '../utils/AppError.js';
import { usersCollection } from '../models/users.js';
import { ObjectId } from 'mongodb';

export const router = Router();

router.use(authenticate);

router.get('/overview', requirePermissionOrStaffSelf(PERMISSIONS.VIEW_ANALYTICS), async (req, res, next) => {
  try {
    const employeeId = req.user.role === ROLES.STAFF ? req.user.employeeId : undefined;
    res.json(await adminService.getOverviewStats({ employeeId }));
  } catch (err) {
    next(err);
  }
});

const trendQuerySchema = z.object({
  metric: z.enum(['revenue', 'bookings']),
  days: z.coerce.number().int().min(1).max(365).default(7),
});

router.get('/trends', requirePermissionOrStaffSelf(PERMISSIONS.VIEW_ANALYTICS), validate(trendQuerySchema, 'query'), async (req, res, next) => {
  try {
    const employeeId = req.user.role === ROLES.STAFF ? req.user.employeeId : undefined;
    res.json(await adminService.getTrend({ ...req.query, employeeId }));
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

router.get('/activity', requirePermission(PERMISSIONS.VIEW_ANALYTICS), validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await listActivity(req.query));
  } catch (err) {
    next(err);
  }
});

const listClientsQuerySchema = listQuerySchema.extend({ search: z.string().max(200).optional() });

router.get('/clients', requirePermission(PERMISSIONS.MANAGE_CLIENTS), validate(listClientsQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await adminService.listClients(req.query));
  } catch (err) {
    next(err);
  }
});

router.post('/clients/:id/block', requirePermission(PERMISSIONS.MANAGE_CLIENTS), async (req, res, next) => {
  try {
    const client = await adminService.setClientActive(req.params.id, false);
    await logActivity({ type: 'client_blocked', message: `${client.firstName} ${client.lastName} was blocked`, actorUserId: req.user._id });
    res.json({ client });
  } catch (err) {
    next(err);
  }
});

router.post('/clients/:id/unblock', requirePermission(PERMISSIONS.MANAGE_CLIENTS), async (req, res, next) => {
  try {
    const client = await adminService.setClientActive(req.params.id, true);
    await logActivity({ type: 'client_unblocked', message: `${client.firstName} ${client.lastName} was unblocked`, actorUserId: req.user._id });
    res.json({ client });
  } catch (err) {
    next(err);
  }
});

router.get('/clients/:id', requirePermission(PERMISSIONS.MANAGE_CLIENTS), async (req, res, next) => {
  try {
    res.json(await adminService.getClientDetail(req.params.id));
  } catch (err) {
    next(err);
  }
});

const sendNotificationSchema = z
  .object({
    userId: z.string().min(1).optional(),
    broadcast: z.boolean().optional(),
    title: z.string().min(1).max(200),
    body: z.string().min(1).max(2000),
    link: z.string().max(500).nullable().optional(),
    // SMS is only offered for a single targeted send, never a broadcast — blasting SMS
    // to every customer at once is a real cost/abuse risk this form deliberately doesn't
    // expose a one-click path to.
    alsoSms: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.userId) !== Boolean(v.broadcast), {
    message: 'Provide exactly one of userId or broadcast.',
  });

// §4.11 — targeted one-off or broadcast, via a real compose form on the admin side
// (web/src/pages/admin/AdminComposeNotificationPage.jsx), not native prompt() dialogs.
router.post(
  '/notifications/send',
  requirePermission(PERMISSIONS.SEND_NOTIFICATIONS),
  messagingLimiter,
  validate(sendNotificationSchema),
  async (req, res, next) => {
    try {
      const { userId, broadcast, title, body, link, alsoSms } = req.body;
      if (broadcast) {
        const { sentCount } = await clientNotificationsService.broadcastNotification({ title, body, link });
        await logActivity({
          type: 'broadcast_sent',
          message: `Broadcast sent to ${sentCount} clients: "${title}"`,
          actorUserId: req.user._id,
        });
        return res.json({ sentCount });
      }

      const target = await usersCollection().findOne({ _id: new ObjectId(userId) });
      if (!target) throw notFound('Client');
      if (target.role !== 'customer') throw badRequest('Notifications can only be sent to customers.');

      if (alsoSms && target.phone) {
        await sendSms({ to: target.phone, body: `${title}: ${body}` });
      }

      if (target.email) {
        await sendMail({
          to: target.email,
          subject: title,
          html: `<p><strong>${title}</strong></p><p>${body.replace(/\n/g, '<br>')}</p>`,
          text: body,
        });
      }

      await clientNotificationsService.createClientNotification({ userId, type: 'admin_message', title, body, link });
      await logActivity({
        type: 'notification_sent',
        message: `Notification sent to ${target.firstName} ${target.lastName}: "${title}"`,
        actorUserId: req.user._id,
        metadata: { targetUserId: userId },
      });
      res.json({ sentCount: 1 });
    } catch (err) {
      next(err);
    }
  }
);

// §4.12/gap-fix — lets an admin with MANAGE_ADMIN_USERS grant/edit/revoke another
// account's admin access from the dashboard itself, instead of the only path being a
// developer running a one-off database script.
router.get(
  '/users',
  requirePermission(PERMISSIONS.MANAGE_ADMIN_USERS),
  validate(listQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      res.json(await adminUsersService.listAdminUsers(req.query));
    } catch (err) {
      next(err);
    }
  }
);

const inviteAdminUserSchema = z
  .object({
    email: z.string().email(),
    firstName: z.string().min(1).max(80).optional(),
    lastName: z.string().min(1).max(80).optional(),
    permissions: z.array(z.enum(Object.values(PERMISSIONS))).default([]),
    role: z.enum([ROLES.ADMIN, ROLES.STAFF]).default(ROLES.ADMIN),
    employeeId: z.string().optional(),
  })
  .refine((v) => v.role !== ROLES.STAFF || Boolean(v.employeeId), {
    message: 'employeeId is required for a staff account.',
    path: ['employeeId'],
  });

router.post(
  '/users',
  requirePermission(PERMISSIONS.MANAGE_ADMIN_USERS),
  validate(inviteAdminUserSchema),
  async (req, res, next) => {
    try {
      const adminUser = await adminUsersService.inviteAdminUser(req.body);
      const roleLabel = adminUser.role === ROLES.STAFF ? 'staff' : 'admin';
      await logActivity({
        type: 'admin_user_invited',
        message: `${adminUser.firstName} ${adminUser.lastName} (${adminUser.email}) was given ${roleLabel} access`,
        actorUserId: req.user._id,
      });
      res.status(201).json({ adminUser });
    } catch (err) {
      next(err);
    }
  }
);

const updatePermissionsSchema = z.object({
  permissions: z.array(z.enum(Object.values(PERMISSIONS))),
});

router.patch(
  '/users/:id',
  requirePermission(PERMISSIONS.MANAGE_ADMIN_USERS),
  validate(updatePermissionsSchema),
  async (req, res, next) => {
    try {
      const adminUser = await adminUsersService.updateAdminPermissions({
        id: req.params.id,
        permissions: req.body.permissions,
        requestingUserId: req.user._id,
      });
      await logActivity({
        type: 'admin_user_permissions_updated',
        message: `Permissions updated for ${adminUser.firstName} ${adminUser.lastName}`,
        actorUserId: req.user._id,
      });
      res.json({ adminUser });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/users/:id/revoke',
  requirePermission(PERMISSIONS.MANAGE_ADMIN_USERS),
  async (req, res, next) => {
    try {
      const adminUser = await adminUsersService.revokeAdminAccess({
        id: req.params.id,
        requestingUserId: req.user._id,
      });
      await logActivity({
        type: 'admin_user_revoked',
        message: `Admin access revoked for ${adminUser.firstName} ${adminUser.lastName}`,
        actorUserId: req.user._id,
      });
      res.json({ adminUser });
    } catch (err) {
      next(err);
    }
  }
);
