import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).default(4000),
  CLIENT_URL: z.string().default('http://localhost:5173'),
  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.string().min(1),
  DB_SSL: z.enum(['true', 'false']).default('false'),   // true pour une base managée (Aiven…) : connexion chiffrée
  DB_SSL_CA: z.string().optional(),                      // certificat CA (texte PEM) fourni par l'hébergeur ; sans lui, la chaîne de confiance système est utilisée
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(1), // nombre de proxys devant l'API (1 = Nginx/Caddy ; 2 = Vercel + Render)
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET: 32 caracteres minimum'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET: 32 caracteres minimum'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  MAIL_PROVIDER: z.enum(['console', 'smtp', 'resend']).default('console'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  RESEND_API_KEY: z.string().optional(), // clé API Resend (provider 'resend') : à saisir uniquement dans les variables d'environnement de Render
  MAIL_FROM: z.string().default('MHFac <no-reply@localhost>'),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  LOGIN_MAX_FAILURES: z.coerce.number().int().positive().default(5),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),
  REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).default(10),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  EINVOICE_PROVIDER: z.enum(['simulation']).default('simulation'),
  // Module de facturation électronique : DÉSACTIVÉ (« bientôt disponible »). `on` uniquement pour les tests ou un futur déploiement.
  EINVOICE_MODULE: z.enum(['on', 'off']).default('off'),
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(300),
  DEFAULT_PLAN_CODE: z.string().default('pro'),
  TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(14), // essai gratuit offert à chaque nouvelle entreprise (0 = pas d'essai)
  TRIAL_REMINDER_DAY: z.coerce.number().int().min(1).max(89).default(12), // jour de l'essai (depuis l'inscription) où l'e-mail de rappel est envoyé
  PLATFORM_ALERT_EMAIL: z.preprocess((v) => (v === '' ? undefined : v), z.string().email().optional()), // e-mail du propriétaire de la plateforme : alerte à chaque déclaration de virement (sinon : e-mail de contact des coordonnées bancaires)
  RECURRING_SCHEDULER: z.enum(['on', 'off']).default('on'),
  SCAN_MAX_MB: z.coerce.number().positive().max(15).default(8),
  SCAN_HOURLY_LIMIT: z.coerce.number().int().positive().default(30),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  console.error(`Configuration invalide (voir .env.example) :\n${lines.join('\n')}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProd: parsed.data.NODE_ENV === 'production',
  dbSsl: parsed.data.DB_SSL === 'true' ? (parsed.data.DB_SSL_CA ? { ca: parsed.data.DB_SSL_CA.replace(/\\n/g, '\n'), rejectUnauthorized: true } : { rejectUnauthorized: true }) : undefined,
  clientOrigins: parsed.data.CLIENT_URL.split(',').map((s) => s.trim()),
};
