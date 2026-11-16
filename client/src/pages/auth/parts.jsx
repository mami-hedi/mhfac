import { z } from 'zod';

export const passwordRules = z
  .string()
  .min(10, 'Minimum 10 caractères')
  .max(128, 'Maximum 128 caractères')
  .regex(/[A-Za-z]/, 'Au moins une lettre')
  .regex(/\d/, 'Au moins un chiffre');

export const PASSWORD_HINT = '10 caractères minimum, avec au moins une lettre et un chiffre.';

export const Heading = ({ title, children }) => (
  <div className="mb-6">
    <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
    {children && <p className="mt-1 text-sm text-slate-500">{children}</p>}
  </div>
);

export const queryToken = (search) => new URLSearchParams(search).get('token') ?? '';
