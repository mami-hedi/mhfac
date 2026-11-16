# Test navigateur : cloche de notifications, liste, marquage lu, préférences, rôles.
# python3 docs/e2e/phase9_notifications_test.py   (API :4000 + client Vite :5173)
import time, requests
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'; stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'notif{stamp}@test.mhfac'
res = []
def ok(n, c, extra=''): res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n, extra)
r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Notif {stamp}', 'fullName': 'Hedi', 'email': email, 'password': PW}); tok = r.json()['data']['accessToken']
H = {'Authorization': f'Bearer {tok}'}
cl = requests.post(f'{API}/clients', json={'name': 'Client Retard'}, headers=H).json()['data']
tax = [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '19.00'][0]
for _ in range(2):
    d = requests.post(f'{API}/invoices', json={'clientId': cl['id'], 'issueDate': '2026-01-01', 'dueDate': '2026-01-31', 'lines': [{'description': 'Prestation', 'quantity': 1, 'unitPrice': '100.000', 'taxRateId': tax['id']}]}, headers=H).json()['data']
    requests.post(f"{API}/invoices/{d['id']}/issue", headers=H)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1366, 'height': 900}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW); pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')
    pg.wait_for_selector('[data-testid=notif-count]', timeout=8000)
    ok('pastille rouge avec le nombre de non lues', pg.locator('[data-testid=notif-count]').inner_text().strip() == '1', pg.locator('[data-testid=notif-count]').inner_text())
    pg.click('button[aria-label^="Notifications"]'); pg.wait_for_selector('text=2 factures clients en retard')
    ok('la cloche liste la notification groupée', pg.locator('text=2 factures clients en retard').count() >= 1)
    pg.screenshot(path='/tmp/claude-0/notif_bell.png')
    pg.click('text=2 factures clients en retard'); pg.wait_for_url('**/sales/reminders'); ok('un clic ouvre la page liée (relances)', '/sales/reminders' in pg.url)
    try: pg.wait_for_selector('[data-testid=notif-count]', state='detached', timeout=5000); gone = True
    except Exception: gone = False
    ok('et la marque comme lue (pastille disparue)', gone)
    pg.goto(BASE + '/notifications'); pg.wait_for_selector('text=Mes notifications'); pg.wait_for_selector('text=factures clients en retard')
    ok('page : notification présente', pg.locator('text=2 factures clients en retard').count() == 1)
    pg.click('button[role=tab]:has-text("Non lues")'); pg.wait_for_selector('text=Tout est à jour'); ok('filtre non lues : vide', True)
    pg.click('button[role=tab]:has-text("Préférences")'); pg.wait_for_selector('text=Factures clients en retard de paiement')
    ok('préférences groupées par catégorie', pg.locator('h2:has-text("Ventes")').count() == 1 and pg.locator('h2:has-text("Abonnement")').count() == 1)
    pg.click('#np-invoice_overdue'); pg.wait_for_selector('text=Préférence enregistrée')
    ok('désactivation enregistrée', not pg.locator('#np-invoice_overdue').is_checked())
    pg.reload(); pg.wait_for_selector('text=Factures clients en retard de paiement'); ok('conservée après rechargement', not pg.locator('#np-invoice_overdue').is_checked())
    pg.screenshot(path='/tmp/claude-0/notif_prefs.png', full_page=True)
    pg.set_viewport_size({'width': 390, 'height': 800}); pg.goto(BASE + '/notifications'); pg.wait_for_selector('text=Mes notifications')
    ok('mobile : pas de défilement horizontal', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth'))
    ok('aucune erreur JavaScript', not errs, errs)
    b.close()
print(f'{sum(res)}/{len(res)} OK'); raise SystemExit(0 if all(res) else 1)
