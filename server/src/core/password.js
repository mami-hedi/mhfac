import bcrypt from 'bcrypt';
import { z } from 'zod';
import { env } from '../config/env.js';

// Politique : 10 caracteres minimum, au moins une lettre et un chiffre, jamais un mot de passe courant.
// Maximum 72 OCTETS : bcrypt ignore silencieusement tout ce qui dépasse (un mot de passe plus long serait tronqué sans que personne le sache).
const COMMON = new Set(['password1', 'password12', 'password123', 'password1234', 'motdepasse1', 'motdepasse12', 'motdepasse123', 'motdepasse1234',
  '1234567890', '12345678910', '123456789a', 'azerty1234', 'azerty12345', 'azertyuiop1', 'qwerty1234', 'qwerty12345', 'qwertyuiop1', 'abcdefgh12',
  'abcd123456', 'admin12345', 'administrateur1', 'welcome123', 'bonjour123', 'tunisie123', 'tunisia123', 'tunis12345', 'iloveyou123', 'letmein1234',
  'mhfac12345', 'mhfac123456', 'azerty123456', 'motdepasse2026', 'password2026', 'azerty2026', 'tunisie2026']);
export const passwordSchema = z
  .string()
  .min(10, 'Minimum 10 caractères')
  .max(128)
  .regex(/[A-Za-z]/, 'Au moins une lettre')
  .regex(/\d/, 'Au moins un chiffre')
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 72, 'Mot de passe trop long (72 octets maximum)')
  .refine((v) => !COMMON.has(v.toLowerCase()) && !/^(.)\1+$/.test(v), 'Mot de passe trop courant : choisissez-en un moins prévisible');

export const hashPassword = (plain) => bcrypt.hash(plain, env.BCRYPT_ROUNDS);
export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

// Hash factice : on compare quand meme pour un e-mail inconnu (meme duree de reponse).
export const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 4);
