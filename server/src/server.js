import { createApp } from './app.js';
import { env } from './config/env.js';
import { pool } from './config/db.js';
import { startRecurringScheduler } from './modules/sales/recurring.service.js';
import { startTrialReminderScheduler } from './modules/subscription/trial-reminders.js';
import { startNotificationScheduler } from './modules/notifications/notifications.service.js';

const log = (level, msg, extra = {}) => (level === 'error' ? console.error : console.log)(JSON.stringify({ level, msg, ...extra }));

const server = createApp().listen(env.PORT, () => {
  console.log(`MHFac API : http://localhost:${server.address().port}/api/v1 (${env.NODE_ENV})`);
});
// Délais explicites (clients lents / connexions bloquées) : une requête légitime (PDF, export, lecture de scan) tient largement en 2 minutes.
server.requestTimeout = 120_000; server.headersTimeout = 30_000; server.keepAliveTimeout = 65_000;

const schedulersOn = env.NODE_ENV !== 'test' && env.RECURRING_SCHEDULER === 'on';
const stopRecurring = schedulersOn ? startRecurringScheduler() : null;
const stopReminders = schedulersOn ? startTrialReminderScheduler() : null;
const stopNotifs = schedulersOn ? startNotificationScheduler() : null;
const stopScheduler = () => { stopRecurring?.(); stopReminders?.(); stopNotifs?.(); };

// Arrêt propre : on cesse d'accepter des requêtes, on laisse finir celles en cours (10 s max), puis on ferme la base.
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return; stopping = true;
  log('info', 'arrêt en cours');
  setTimeout(() => { log('error', 'arrêt forcé après 10 s'); process.exit(code || 1); }, 10_000).unref();
  stopScheduler();
  server.close(async () => { try { await pool.end(); } finally { process.exit(code); } });
  server.closeIdleConnections?.();
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(0));

// Une promesse rejetée hors d'une route ne doit pas tuer le serveur pour tout le monde : on journalise et on continue.
process.on('unhandledRejection', (reason) => log('error', 'unhandledRejection', { error: String(reason?.stack ?? reason) }));
// Une exception non rattrapée laisse le processus dans un état inconnu : on journalise puis on s'arrête proprement (PM2 / systemd relance).
process.on('uncaughtException', (err) => { log('error', 'uncaughtException', { error: String(err?.stack ?? err) }); shutdown(1); });
