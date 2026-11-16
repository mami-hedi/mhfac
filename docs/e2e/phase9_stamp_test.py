# Test navigateur : le timbre fiscal est FACULTATIF (ventes et achats).  python3 docs/e2e/phase9_stamp_test.py   (API :4000 + Vite :5173)
import time, requests
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'; stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'tim{stamp}@test.mhfac'
res = []
def ok(n, c, extra=''): res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n, extra)
r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Timbre {stamp}', 'fullName': 'Hedi', 'email': email, 'password': PW}).json()['data']; H = {'authorization': 'Bearer ' + r['accessToken']}
requests.post(f'{API}/clients', headers=H, json={'name': 'Client Timbre'}); requests.post(f'{API}/suppliers', headers=H, json={'name': 'Fourn Timbre'})
requests.patch(f'{API}/companies/current/settings', headers=H, json={'sales': {'stampDutyEnabled': True, 'stampDutyAmount': '1.000'}})
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1366, 'height': 1100}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW); pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')
    # ---- VENTE : pré-cochée mais décochable, jamais imposée
    pg.goto(BASE + '/sales/invoices/new'); pg.wait_for_selector('text=Totaux'); time.sleep(1)
    ok('vente : case pré-cochée (réglage par défaut) et libellé « facultatif » + montant', pg.is_checked('#stamp') and 'facultatif' in pg.inner_text('main') and '1,000' in pg.inner_text('main').replace('\xa0', ' '))
    pg.fill('#client', 'Timbre'); pg.click('li[role=option]:has-text("Client Timbre")'); pg.fill('input[name="lines.0.description"]', 'Prestation'); pg.fill('input[name="lines.0.unitPrice"]', '100'); time.sleep(1.5)
    ok('vente : aperçu avec timbre', 'Timbre fiscal' in pg.inner_text('main'))
    pg.uncheck('#stamp'); time.sleep(1.5); ok('vente : décochée -> plus de timbre dans l\'aperçu', 'Timbre fiscal' not in pg.inner_text('main'))
    pg.click('button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('text=Brouillon'); time.sleep(0.8); ok('vente : fiche enregistrée sans timbre', 'Timbre fiscal' not in pg.inner_text('main'))
    # ---- ACHAT
    pg.goto(BASE + '/purchases/invoices/new'); pg.wait_for_selector('text=Totaux'); time.sleep(1)
    ok('achat : case présente, décochée par défaut, pas de champ montant', pg.locator('#pi-stamp').count() == 1 and not pg.is_checked('#pi-stamp') and pg.locator('input[name=stampDutyAmount]').count() == 0)
    pg.fill('#supplier', 'Timbre'); pg.click('li[role=option]:has-text("Fourn Timbre")'); pg.fill('input[name=supplierRef]', f'F-{stamp}')
    pg.fill('input[name="lines.0.description"]', 'Achat'); pg.fill('input[name="lines.0.unitPrice"]', '100'); time.sleep(1.5)
    ok('achat : aucun timbre dans l\'aperçu', 'Timbre fiscal' not in pg.inner_text('main'))
    pg.check('#pi-stamp'); pg.wait_for_selector('input[name=stampDutyAmount]'); pg.fill('input[name=stampDutyAmount]', '1,5'); time.sleep(1.5)
    t = pg.inner_text('main').replace('\xa0', ' '); ok('achat : aperçu avec timbre 1,500 et net à payer 120,500', 'Timbre fiscal' in t and '1,500' in t and '120,500' in t)
    pg.screenshot(path='/tmp/claude-0/logo/achat_timbre.png', full_page=True)
    pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=Brouillon'); time.sleep(0.8)
    ok('achat : fiche enregistrée avec timbre 1,500', 'Timbre fiscal' in pg.inner_text('main') and '1,500' in pg.inner_text('main').replace('\xa0', ' '))
    pg.click('a:has-text("Modifier"), button:has-text("Modifier")'); pg.wait_for_selector('#pi-stamp'); time.sleep(1)
    ok('achat : à la réouverture la case est cochée avec le bon montant', pg.is_checked('#pi-stamp') and pg.input_value('input[name=stampDutyAmount]').startswith('1.5'))
    pg.uncheck('#pi-stamp'); pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=Brouillon'); time.sleep(0.8)
    ok('achat : timbre retiré après modification', 'Timbre fiscal' not in pg.inner_text('main'))
    ok('aucune erreur JS', not errs, errs); b.close()
print(f'{sum(res)}/{len(res)} OK')
