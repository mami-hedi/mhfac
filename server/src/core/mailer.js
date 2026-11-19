import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transport;
export const sentMails = []; // utilise par les tests (provider console)

// Provider "console" : affiche le message (dev/test). Provider "smtp" : envoi reel.
export async function sendMail({ to, subject, text, attachments, replyTo }) {
  if (env.MAIL_PROVIDER === 'resend') return sendViaResend({ to, subject, text, attachments, replyTo });
  if (env.MAIL_PROVIDER === 'smtp') {
    transport ??= nodemailer.createTransport({
      host: env.SMTP_HOST, port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465, // 465 = TLS direct ; 587 / 2525 = STARTTLS (négocié automatiquement)
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, // échec rapide plutôt qu'une requête qui reste bloquée
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    });
    await transport.sendMail({ from: env.MAIL_FROM, to, subject, text, attachments, replyTo });
    return;
  }
  sentMails.push({ to, subject, text, replyTo, attachments: (attachments ?? []).map((a) => ({ filename: a.filename, size: a.content?.length ?? 0 })) });
  if (env.NODE_ENV !== 'test') console.log(`[mail:console] A: ${to} | ${subject}\n${text}${attachments?.length ? `\n[pièces jointes : ${attachments.map((a) => a.filename).join(', ')}]` : ''}`);
}

// Provider "resend" : API HTTPS (port 443) -> fonctionne sur Render gratuit, qui bloque les ports SMTP 25/465/587. La clé API reste côté serveur (variable d'environnement).
async function sendViaResend({ to, subject, text, attachments, replyTo }) {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY manquante');
  const recipients = (Array.isArray(to) ? to : String(to).split(',')).map((t) => t.trim()).filter(Boolean);
  const payload = {
    from: env.MAIL_FROM, to: recipients, subject, text,
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(attachments?.length ? { attachments: attachments.map((a) => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}),
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000), // échec rapide plutôt qu'une requête bloquée
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend a refusé l'envoi (HTTP ${res.status}) ${detail.slice(0, 200)}`); // la clé n'apparaît jamais dans le message
  }
}

export const clientUrl = (path) => `${env.clientOrigins[0]}${path}`;
