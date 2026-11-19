## 9X — E-mails réels (Resend), confirmation d'inscription et rappel d'essai

**Fournisseur** : nouveau `MAIL_PROVIDER=resend` (API HTTPS, port 443) en plus de `console` et `smtp`. Choisi parce que Render gratuit bloque les ports SMTP 25/465/587 et que Brevo n'envoyait pas le code de vérification. La clé `RESEND_API_KEY` ne se saisit que dans les variables d'environnement de Render, jamais dans le code ni dans Git. Aucune dépendance ajoutée (appel `fetch`, délai maximal 15 s, la clé n'apparaît dans aucun message d'erreur).

**Correctif de fond** : avant, l'e-mail de confirmation était envoyé *dans* la transaction d'inscription ; un fournisseur en panne faisait échouer l'inscription entière. Désormais l'inscription est validée d'abord, l'e-mail part ensuite ; en cas d'échec l'erreur est journalisée et l'utilisateur peut demander un renvoi.

**Renvoi du lien** : `POST /auth/resend-verification` (connecté, 3 par heure et par utilisateur, anciens liens invalidés, réponse `alreadyVerified` si déjà confirmé). Bouton « Renvoyer l'e-mail » dans le bandeau du tableau de bord.

**Rappel de fin d'essai** : le code existait déjà (`trial-reminders.js`, jour 12 par défaut, une seule fois par essai, contrôle toutes les heures). Limite connue : sur Render gratuit l'API s'endort après ~15 min sans visite ; le contrôle ne tourne que lorsqu'elle est réveillée. Solution : un ping régulier (UptimeRobot ou cron-job.org, toutes les 10 min) sur `/api/v1/health`.

**Variables Render** : `MAIL_PROVIDER=resend`, `RESEND_API_KEY=<clé>`, `MAIL_FROM="MHFac <no-reply@mh-digital-solution.com>"` (domaine vérifié chez Resend). Optionnel : `TRIAL_DAYS`, `TRIAL_REMINDER_DAY`.

Tests : `tests/mail_provider.test.js` (4). Total : 249.
