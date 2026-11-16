import { z } from 'zod';
import { passwordSchema } from '../../core/password.js';

const email = z.string().trim().toLowerCase().email().max(190);

export const registerSchema = z.object({
  companyName: z.string().trim().min(2).max(190),
  taxId: z.string().trim().max(50).optional(),
  fullName: z.string().trim().min(2).max(190),
  email,
  password: passwordSchema,
});
export const loginSchema = z.object({ email, password: z.string().min(1).max(128), companyId: z.string().uuid().optional() });
export const emailOnlySchema = z.object({ email });
export const resetSchema = z.object({ token: z.string().min(20).max(200), password: passwordSchema });
export const tokenSchema = z.object({ token: z.string().min(20).max(200) });
export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  fullName: z.string().trim().min(2).max(190).optional(),
  password: z.string().min(1).max(128),
});
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: passwordSchema });
export const switchCompanySchema = z.object({ companyId: z.string().uuid() });
export const profileSchema = z.object({ fullName: z.string().trim().min(2).max(190), locale: z.literal('fr') }).partial().refine((v) => Object.values(v).some((x) => x !== undefined), 'Aucun champ à modifier');
