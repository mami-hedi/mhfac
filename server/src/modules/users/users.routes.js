import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middlewares/asyncHandler.js';
import { authenticate, requirePermission } from '../../middlewares/auth.js';
import { validate } from '../../middlewares/validate.js';
import { permissionMatrix } from '../../core/permissions.js';
import * as svc from './users.service.js';

const router = Router();
router.use(authenticate);

const roleCode = z.enum(['admin', 'accountant', 'sales', 'stock_manager', 'read_only', 'owner']);
const idParam = z.object({ id: z.string().uuid() });

router.get('/', requirePermission('user.read'), asyncHandler(async (req, res) => res.json({ data: await svc.listMembers(req.auth.companyId) })));
router.get('/permissions-matrix', requirePermission('user.read'), (_req, res) => res.json({ data: permissionMatrix() }));
router.get('/roles', requirePermission('user.read'), asyncHandler(async (_req, res) => res.json({ data: await svc.listRoles() })));

router.get('/invitations', requirePermission('user.read'), asyncHandler(async (req, res) => res.json({ data: await svc.listInvitations(req.auth.companyId) })));
router.post('/invitations', requirePermission('user.write'),
  validate({ body: z.object({ email: z.string().trim().toLowerCase().email().max(190), roleCode }) }),
  asyncHandler(async (req, res) => res.status(201).json({ data: await svc.createInvitation(req.auth, req.body, req.ip) })));
router.delete('/invitations/:id', requirePermission('user.write'), validate({ params: idParam }),
  asyncHandler(async (req, res) => { await svc.revokeInvitation(req.auth, req.params.id, req.ip); res.status(204).end(); }));

router.patch('/:id/role', requirePermission('user.write'), validate({ params: idParam, body: z.object({ roleCode }) }),
  asyncHandler(async (req, res) => { await svc.changeRole(req.auth, req.params.id, req.body.roleCode, req.ip); res.status(204).end(); }));
router.patch('/:id/status', requirePermission('user.write'), validate({ params: idParam, body: z.object({ status: z.enum(['active', 'disabled']) }) }),
  asyncHandler(async (req, res) => { await svc.setStatus(req.auth, req.params.id, req.body.status, req.ip); res.status(204).end(); }));

export default router;
