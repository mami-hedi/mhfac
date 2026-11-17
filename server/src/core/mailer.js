import nodemailer from 'nodemailer';
import { env } from '../config/env.js';

let transport;
export const sentMails = []; // utilise par les tests (provider console)

// Provider "console" : affiche le message (dev/test). Provider "smtp" : envoi reel.
export async function sendMail({ to, subject, text, attachments, replyTo }) {
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

export const clientUrl = (path) => `${env.clientOrigins[0]}${path}`;
