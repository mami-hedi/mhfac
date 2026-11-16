import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '../contexts/AuthContext.jsx';
import { api, errorMessage } from '../services/api.js';
import { Alert, Badge, Button, Card, Input, PageHeader, Select } from '../components/ui/index.jsx';
import BillingSettings from '../features/sales/BillingSettings.jsx';
import { passwordRules, PASSWORD_HINT } from './auth/parts.jsx';
import { ROLE_LABELS, cn } from '../utils/format.js';

const companySchema = z.object({
  name: z.string().trim().min(2, "Nom de l'entreprise requis").max(190),
  legalName: z.string().trim().max(190).optional(),
  taxId: z.string().trim().max(50).optional(),
});

function CompanyTab() {
  const { company, can, reload } = useAuth();
  const editable = can('settings.write');
  const [notice, setNotice] = useState({ tone: 'success', text: '' });
  const { register, handleSubmit, formState: { errors, isSubmitting, isDirty }, reset } = useForm({
    resolver: zodResolver(companySchema),
    defaultValues: { name: company.name, legalName: company.legalName ?? '', taxId: company.taxId ?? '' },
  });
  const onSubmit = async (v) => {
    setNotice({ tone: 'success', text: '' });
    try {
      await api.patch('/companies/current', { name: v.name, legalName: v.legalName || null, taxId: v.taxId || null });
      await reload();
      reset(v);
      setNotice({ tone: 'success', text: 'Informations enregistrées.' });
    } catch (e) { setNotice({ tone: 'error', text: errorMessage(e) }); }
  };
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="mb-4 font-semibold text-slate-900">Informations de l'entreprise</h2>
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4 sm:grid-cols-2" noValidate>
          <div className="sm:col-span-2"><Alert tone={notice.tone}>{notice.text}</Alert></div>
          <Input label="Nom commercial" disabled={!editable} error={errors.name?.message} {...register('name')} />
          <Input label="Raison sociale" disabled={!editable} error={errors.legalName?.message} {...register('legalName')} />
          <Input label="Matricule fiscal" disabled={!editable} error={errors.taxId?.message} {...register('taxId')} />
          <Input label="Langue" value="Français" disabled readOnly hint="L'application et les documents sont en français." />
          <Input label="Devise principale" value={company.currency} disabled readOnly hint="Le dinar tunisien est la devise principale." />
          <Input label="Fuseau horaire" value={company.timezone} disabled readOnly />
          {editable && <div className="sm:col-span-2"><Button type="submit" loading={isSubmitting} disabled={!isDirty}>Enregistrer</Button></div>}
        </form>
      </Card>
      {can('settings.read') && <BillingSettings />}
    </div>
  );
}

const pwdSchema = z.object({ currentPassword: z.string().min(1, 'Mot de passe actuel requis'), newPassword: passwordRules, confirm: z.string() })
  .refine((v) => v.newPassword === v.confirm, { path: ['confirm'], message: 'Les mots de passe ne correspondent pas' });

function AccountTab() {
  const { user, company, role, logout } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm({ resolver: zodResolver(pwdSchema) });
  const onSubmit = async ({ currentPassword, newPassword }) => {
    setError('');
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      await logout(); // le serveur a revoque toutes les sessions
      navigate('/login', { replace: true, state: { notice: 'Mot de passe modifié. Reconnectez-vous.' } });
    } catch (e) { setError(errorMessage(e)); }
  };
  return (
    <div className="space-y-4">
      <Card className="p-5">
        <h2 className="mb-3 font-semibold text-slate-900">Mon profil</h2>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-slate-500">Nom</dt><dd className="font-medium">{user.fullName}</dd></div>
          <div><dt className="text-slate-500">E-mail</dt><dd className="font-medium">{user.email} {user.emailVerified ? <Badge tone="green">Vérifié</Badge> : <Badge tone="orange">Non vérifié</Badge>}</dd></div>
          <div><dt className="text-slate-500">Entreprise</dt><dd className="font-medium">{company.name}</dd></div>
          <div><dt className="text-slate-500">Rôle</dt><dd className="font-medium">{ROLE_LABELS[role]}</dd></div>
        </dl>
      </Card>
      <Card className="p-5">
        <h2 className="mb-1 font-semibold text-slate-900">Changer de mot de passe</h2>
        <p className="mb-4 text-sm text-slate-500">Vous serez déconnecté de tous vos appareils.</p>
        <form onSubmit={handleSubmit(onSubmit)} className="max-w-sm space-y-4" noValidate>
          <Alert tone="error">{error}</Alert>
          <Input label="Mot de passe actuel" type="password" autoComplete="current-password" error={errors.currentPassword?.message} {...register('currentPassword')} />
          <Input label="Nouveau mot de passe" type="password" autoComplete="new-password" hint={PASSWORD_HINT} error={errors.newPassword?.message} {...register('newPassword')} />
          <Input label="Confirmer" type="password" autoComplete="new-password" error={errors.confirm?.message} {...register('confirm')} />
          <Button type="submit" loading={isSubmitting}>Modifier le mot de passe</Button>
        </form>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [...(can('settings.read') ? [{ key: 'company', label: 'Entreprise' }] : []), { key: 'account', label: 'Mon compte' }];
  const active = tabs.find((t) => t.key === params.get('tab'))?.key ?? tabs[0].key;
  return (
    <>
      <PageHeader title="Paramètres" />
      <div className="mb-5 flex gap-1 border-b border-slate-200" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={active === t.key} onClick={() => setParams({ tab: t.key })}
            className={cn('-mb-px border-b-2 px-4 py-2 text-sm font-medium', active === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}>{t.label}</button>
        ))}
      </div>
      {active === 'company' ? <CompanyTab /> : <AccountTab />}
    </>
  );
}
