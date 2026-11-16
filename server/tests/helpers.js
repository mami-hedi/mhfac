import { createApp } from '../src/app.js';
import { pool } from '../src/config/db.js';
import { sentMails } from '../src/core/mailer.js';

export { sentMails };
export const PASSWORD = 'Zebre-Violet-2026';
export const uniqueEmail = (p = 'user') => `${p}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@test.mhfac`;

export async function startApp() {
  const server = createApp().listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const close = async () => { server.close(); await pool.end(); };

  async function call(method, path, { token, body, cookie, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie: `mhfac_rt=${cookie}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith('mhfac_rt=')) ?? null;
    return {
      status: res.status,
      body: text && !(res.headers.get('content-type') ?? '').includes('text/csv') ? JSON.parse(text) : null,
      setCookie,
      cookie: setCookie ? setCookie.split(';')[0].slice('mhfac_rt='.length) : null,
      raw: text,
    };
  }
  return { call, close, base };
}

export async function registerCompany(call, name = 'Société Test') {
  const email = uniqueEmail('owner');
  const r = await call('POST', '/auth/register-company', { body: { companyName: `${name} ${email}`, fullName: 'Propriétaire Test', email, password: PASSWORD } });
  if (r.status !== 201) throw new Error(`register failed: ${r.raw}`);
  await pool.query('UPDATE users SET email_verified_at = UTC_TIMESTAMP() WHERE public_id = ?', [r.body.data.user.id]); // les tests simulent le clic sur le lien de confirmation
  return { email, token: r.body.data.accessToken, cookie: r.cookie, companyId: r.body.data.company.id, userId: r.body.data.user.id };
}

export const lastTokenFor = (email, param) => {
  const mail = [...sentMails].reverse().find((m) => m.to === email);
  return mail?.text.match(new RegExp(`${param}=([A-Za-z0-9_-]+)`))?.[1];
};

// Invite + accepte : renvoie la session du nouveau membre.
export async function addMember(call, owner, roleCode) {
  const email = uniqueEmail(roleCode);
  const inv = await call('POST', '/users/invitations', { token: owner.token, body: { email, roleCode } });
  if (inv.status !== 201) throw new Error(`invite failed: ${inv.raw}`);
  const acc = await call('POST', '/auth/accept-invitation', { body: { token: lastTokenFor(email, 'token'), fullName: `Membre ${roleCode}`, password: PASSWORD } });
  if (acc.status !== 201) throw new Error(`accept failed: ${acc.raw}`);
  return { email, token: acc.body.data.accessToken, cookie: acc.cookie, userId: acc.body.data.user.id };
}
