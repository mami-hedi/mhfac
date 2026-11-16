# Test navigateur : coordonnées bancaires (admin) -> déclaration de virement (client) -> confirmation (admin) -> abonnement actif (client).
# python3 docs/e2e/phase9_payment_test.py   (API :4000 + client Vite :5173 ; base migrée jusqu'à 017 ; commande `mysql` disponible)
# La ligne des coordonnées bancaires est remise à son état d'origine à la fin.
import time, subprocess, requests
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'; stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'
res = []
def ok(n, c, extra=''): res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n, extra)
def reg(label):
    email = f'{label}{stamp}@test.mhfac'
    r = requests.post(f'{API}/auth/register-company', json={'companyName': f'{label} {stamp}', 'fullName': 'Hedi Mami', 'email': email, 'password': PW}); return email, r.json()['data']
env = dict(l.strip().split('=', 1) for l in open('/tmp/claude-0/dev.env') if '=' in l and not l.startswith('#'))
def sql(q): return subprocess.run(['mysql', '--default-character-set=utf8mb4', f"-u{env['DB_USER']}", f"-p{env['DB_PASSWORD']}", env['DB_NAME'], '-N', '-e', q], check=True, capture_output=True, text=True).stdout.strip()
admin_email, _ = reg('plateforme'); owner_email, od = reg('client')
sql(f"UPDATE users SET is_platform_admin=1 WHERE email='{admin_email}'")
saved = sql("SELECT CONCAT_WS('|', beneficiary, bank_name, rib, IFNULL(iban,''), IFNULL(bic,''), is_configured) FROM platform_payment_info WHERE id=1").split('|')
# l'offre Pro donne un prix ; l'essai de test est prolongé
tok = requests.post(f'{API}/auth/login', json={'email': admin_email, 'password': PW}).json()['data']['accessToken']
cid = od['company']['id']
requests.put(f'{API}/platform/companies/{cid}/subscription', headers={'authorization': f'Bearer {tok}'}, json={'planCode': 'pro', 'status': 'trial', 'trialEndsAt': time.strftime('%Y-%m-%d', time.gmtime(time.time() + 5 * 86400))})
def login(pg, email):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW); pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')
try:
    with sync_playwright() as p:
        b = p.chromium.launch(); errors = []
        sql("UPDATE platform_payment_info SET is_configured=0, beneficiary='MH DIGITAL SOLUTION (À COMPLÉTER)', bank_name='NOM DE LA BANQUE (À COMPLÉTER)', rib='00 000 0000000000000 00' WHERE id=1")
        # 1) le client n'a pas de coordonnées tant que l'admin n'a rien publié
        cc = b.new_context(viewport={'width': 1366, 'height': 1000}); cl = cc.new_page(); cl.on('pageerror', lambda e: errors.append(str(e))); login(cl, owner_email)
        cl.goto(BASE + '/subscription/pay'); cl.wait_for_selector('text=Payer mon abonnement')
        t = cl.inner_text('main'); ok('avant publication : aucune coordonnée, aucune valeur de remplacement', 'ne sont pas encore communiquées' in t and 'COMPLÉTER' not in t)
        ok('bouton de déclaration désactivé', cl.locator('button:has-text("J\'ai effectué le virement")').is_disabled())
        # 2) l'admin publie ses coordonnées
        ac = b.new_context(viewport={'width': 1366, 'height': 1000}); ad = ac.new_page(); ad.on('pageerror', lambda e: errors.append(str(e))); login(ad, admin_email)
        ad.goto(BASE + '/platform/payments'); ad.wait_for_selector('text=Paiements par virement'); ok('avertissement valeurs de remplacement', 'valeurs de remplacement' in ad.inner_text('main'))
        ad.fill('#bk-ben', 'SARL Exemple Test'); ad.fill('#bk-bank', 'Banque Exemple'); ad.fill('#bk-rib', '08 006 0110123456789 74'); ad.fill('#bk-iban', 'TN98 0800 6011 0123 4567 8974'); ad.fill('#bk-bic', 'BXMPTNTT'); ad.fill('#bk-mail', 'paiement@exemple.test')
        ad.click('button:has-text("Enregistrer et publier")'); ad.wait_for_selector('text=Coordonnées bancaires enregistrées'); ad.wait_for_selector('text=/publiées/i'); ok('coordonnées publiées', 'publiées' in ad.inner_text('main').lower())
        # 3) le client voit RIB, montants et déclare son virement
        cl.reload(); cl.wait_for_selector('text=08 006 0110123456789 74'); t = cl.inner_text('main').replace(' ', ' ').replace('\xa0', ' ')
        ok('le client voit le RIB et la référence MHFAC-', 'MHFAC-' in t and 'SARL Exemple Test' in t)
        ok('montants 56 TND et 560 TND', '56 TND' in t and '560 TND' in t and '2 mois offerts' in t)
        cl.screenshot(path='/tmp/shots/9_pay_client.png', full_page=True)
        cl.fill('#pay-ref', 'VIR-E2E-001'); cl.click('button:has-text("J\'ai effectué le virement")'); cl.wait_for_selector('text=Déclaration envoyée')
        ok('déclaration en attente', 'En attente de vérification' in cl.inner_text('main'))
        cl.goto(BASE + '/subscription'); cl.wait_for_selector('text=Mon abonnement'); ok('toujours en essai (rien activé)', "Période d'essai" in cl.inner_text('main'))
        # 4) l'admin vérifie : mauvais montant refusé, bon montant accepté
        ad.goto(BASE + '/platform/payments'); ad.wait_for_selector(f'tr:has-text("client {stamp}")'); ad.click(f'tr:has-text("client {stamp}") button:has-text("Confirmer")')
        ad.fill('#pay-recv', '500'); ad.click('button:has-text("Confirmer et activer")'); ad.wait_for_selector('text=ne correspond pas'); ok('montant erroné refusé', True)
        ad.fill('#pay-recv', '560'); ad.click('button:has-text("Confirmer et activer")'); ad.wait_for_selector('text=Paiement confirmé')
        ad.screenshot(path='/tmp/shots/9_pay_admin.png', full_page=True)
        # 5) le client est actif, échéance dans un an
        cl.goto(BASE + '/subscription'); cl.wait_for_selector('text=Mon abonnement'); t = cl.inner_text('main')
        ok('abonnement actif, périodicité annuelle', 'Actif' in t and 'Annuelle' in t and 'Essai gratuit' not in t)
        cl.goto(BASE + '/subscription/pay'); cl.wait_for_selector('text=Mes déclarations'); ok('historique : confirmé', 'Confirmé' in cl.inner_text('main'))
        ok('aucune erreur JS', not errors, errors); b.close()
finally:
    sql("UPDATE platform_payment_info SET beneficiary='{0}', bank_name='{1}', rib='{2}', iban=NULLIF('{3}',''), bic=NULLIF('{4}',''), is_configured={5}, contact_email=NULL WHERE id=1".format(*[x.replace("'", "''") for x in saved]))
print(f'{sum(res)}/{len(res)} OK')
