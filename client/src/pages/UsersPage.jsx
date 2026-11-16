import { useCallback, useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Mail, UserPlus, X } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { api, errorMessage } from '../services/api.js';
import { Alert, Badge, Button, Card, EmptyState, Input, Modal, PageHeader, Select, Spinner } from '../components/ui/index.jsx';
import { ROLE_LABELS, formatDate } from '../utils/format.js';

const inviteSchema = z.object({
  email: z.string().trim().min(1, 'E-mail requis').email('E-mail invalide'),
  roleCode: z.string().min(1),
});

function InviteModal({ roles, onClose, onDone }) {
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(inviteSchema), defaultValues: { roleCode: roles[roles.length - 1] } });
  const submit = async (values) => {
    setError('');
    try { await api.post('/users/invitations', values); onDone(values.email); } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <Modal title="Inviter un collaborateur" onClose={onClose}>
      <form onSubmit={handleSubmit(submit)} className="space-y-4" noValidate>
        <Alert tone="error">{error}</Alert>
        <Input label="Adresse e-mail" type="email" error={errors.email?.message} {...register('email')} />
        <Select label="Rôle" {...register('roleCode')}>{roles.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</Select>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" onClick={onClose}>Annuler</Button>
          <Button type="submit" loading={isSubmitting}>Envoyer l'invitation</Button>
        </div>
      </form>
    </Modal>
  );
}

const ACT = { read: 'L', write: 'É', validate: 'V', delete: 'S' };
function RightsMatrix() {
  const [m, setM] = useState(null); const [open, setOpen] = useState(false);
  useEffect(() => { if (open && !m) api.get('/users/permissions-matrix').then((r) => setM(r.data.data)).catch(() => setM({ roles: [], modules: [] })); }, [open, m]);
  return (
    <Card className="mt-4 p-5">
      <button type="button" className="text-sm font-semibold" aria-expanded={open} onClick={() => setOpen(!open)}>Droits par rôle {open ? '▾' : '▸'}</button>
      {open && (!m ? <Spinner /> : (
        <div className="mt-3 overflow-x-auto"><p className="mb-2 text-xs text-slate-500">L = lire, É = écrire, V = valider/émettre, S = supprimer. Ces droits sont appliqués par le serveur à chaque requête.</p>
          <table className="w-full min-w-[640px] text-left text-xs"><thead className="bg-slate-50 text-slate-500"><tr><th className="px-2 py-1">Module</th>{m.roles.map((r) => <th key={r.code} className="px-2 py-1">{ROLE_LABELS[r.code] ?? r.name}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-100">{m.modules.map((x) => <tr key={x.module}><td className="px-2 py-1 font-mono">{x.module}</td>{m.roles.map((r) => <td key={r.code} className="px-2 py-1 tracking-widest">{x.rights[r.code].map((a) => ACT[a]).join('') || '—'}</td>)}</tr>)}</tbody></table></div>))}
    </Card>
  );
}

export default function UsersPage() {
  const { can, role: myRole, user: me } = useAuth();
  const [data, setData] = useState({ loading: true });
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const [invite, setInvite] = useState(false);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([api.get('/users'), api.get('/users/invitations')]);
      setData({ members: m.data.data, invitations: i.data.data });
    } catch (e) { setData({ error: errorMessage(e) }); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Reflet de l'interface : le serveur applique les memes regles et reste l'autorite.
  const canManage = (m) => can('user.write') && m.id !== me.id && m.role !== 'owner' && !(m.role === 'admin' && myRole !== 'owner');
  const assignable = Object.keys(ROLE_LABELS).filter((r) => r !== 'owner' && (r !== 'admin' || myRole === 'owner'));

  const act = async (key, fn, okText) => {
    setBusy(key); setNotice({ tone: 'success', text: '' });
    try { await fn(); setNotice({ tone: 'success', text: okText }); await load(); } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); } finally { setBusy(''); }
  };

  if (data.loading) return <Spinner />;
  if (data.error) return <Alert tone="error">{data.error}</Alert>;

  return (
    <>
      <PageHeader title="Utilisateurs et rôles" subtitle="Gérez l'accès de votre équipe à l'entreprise."
        actions={can('user.write') && <Button onClick={() => setInvite(true)}><UserPlus size={16} aria-hidden /> Inviter</Button>} />
      <div className="mb-4"><Alert tone={notice.tone}>{notice.text}</Alert></div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase text-slate-500">
            <tr><th className="px-4 py-3">Utilisateur</th><th className="px-4 py-3">Rôle</th><th className="px-4 py-3">Statut</th><th className="px-4 py-3">Dernière connexion</th><th className="px-4 py-3 text-right">Actions</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.members.map((m) => (
              <tr key={m.id}>
                <td className="px-4 py-3"><div className="font-medium text-slate-900">{m.fullName}{m.id === me.id && <span className="ml-2 text-xs text-slate-400">(vous)</span>}</div><div className="text-slate-500">{m.email}</div></td>
                <td className="px-4 py-3">
                  {canManage(m) ? (
                    <Select aria-label={`Rôle de ${m.fullName}`} value={m.role} disabled={busy === `role-${m.id}`}
                      onChange={(e) => act(`role-${m.id}`, () => api.patch(`/users/${m.id}/role`, { roleCode: e.target.value }), 'Rôle mis à jour.')}>
                      {assignable.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      {!assignable.includes(m.role) && <option value={m.role}>{ROLE_LABELS[m.role]}</option>}
                    </Select>
                  ) : <Badge tone={m.role === 'owner' ? 'blue' : 'neutral'}>{ROLE_LABELS[m.role]}</Badge>}
                </td>
                <td className="px-4 py-3"><Badge tone={m.status === 'active' ? 'green' : 'red'}>{m.status === 'active' ? 'Actif' : 'Désactivé'}</Badge></td>
                <td className="px-4 py-3 text-slate-600">{formatDate(m.lastLoginAt)}</td>
                <td className="px-4 py-3 text-right">
                  {canManage(m) && (
                    <Button variant={m.status === 'active' ? 'secondary' : 'primary'} loading={busy === `st-${m.id}`}
                      onClick={() => act(`st-${m.id}`, () => api.patch(`/users/${m.id}/status`, { status: m.status === 'active' ? 'disabled' : 'active' }), m.status === 'active' ? 'Accès désactivé.' : 'Accès réactivé.')}>
                      {m.status === 'active' ? 'Désactiver' : 'Réactiver'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <h2 className="mb-3 mt-8 font-semibold text-slate-900">Invitations en attente</h2>
      <Card>
        {data.invitations.length === 0 ? <EmptyState icon={Mail} title="Aucune invitation en attente" /> : (
          <ul className="divide-y divide-slate-100">
            {data.invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div><span className="font-medium text-slate-900">{i.email}</span> <Badge>{ROLE_LABELS[i.role]}</Badge><div className="text-xs text-slate-500">Expire le {formatDate(i.expiresAt)}</div></div>
                {can('user.write') && <Button variant="ghost" loading={busy === `inv-${i.id}`} onClick={() => act(`inv-${i.id}`, () => api.delete(`/users/invitations/${i.id}`), 'Invitation révoquée.')}><X size={14} aria-hidden /> Révoquer</Button>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <RightsMatrix />

      {invite && <InviteModal roles={assignable} onClose={() => setInvite(false)} onDone={(email) => { setInvite(false); setNotice({ tone: 'success', text: `Invitation envoyée à ${email}. (En développement, le lien s'affiche dans la console du serveur.)` }); load(); }} />}
    </>
  );
}
