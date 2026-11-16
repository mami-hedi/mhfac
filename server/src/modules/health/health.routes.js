import { Router } from 'express';
import { pingDb } from '../../config/db.js';

const router = Router();

router.get('/', async (_req, res) => {
  let db = 'up';
  try {
    await pingDb();
  } catch {
    db = 'down';
  }
  res.status(db === 'up' ? 200 : 503).json({
    data: { status: db === 'up' ? 'ok' : 'degraded', db, service: 'mhfac-api', time: new Date().toISOString() },
  });
});

export default router;
