# Test navigateur : case « Entrer en stock » sur une facture d'achat.  python3 docs/e2e/phase8d_stock_entry_test.py
import time, requests
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'owner{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)
r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo stock {stamp}', 'fullName': 'Hedi Mami', 'email': email, 'password': PW})
H = {'Authorization': f"Bearer {r.json()['data']['accessToken']}"}
def post(path, body=None):
    x = requests.post(f'{API}{path}', headers=H, json=body or {}); assert x.status_code < 300, (path, x.text); return x.json()['data']
sup = post('/suppliers', {'name': 'Fournisseur Stock'}); tax19 = [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '19.00'][0]
prod = post('/products', {'name': 'Clavier E2E', 'salePrice': '100', 'taxRateId': tax19['id'], 'trackStock': True})
today = time.strftime('%Y-%m-%d')
d = post('/purchase-invoices', {'supplierId': sup['id'], 'issueDate': today, 'supplierRef': f'E2E-{stamp}', 'stockEntry': True, 'lines': [{'productId': prod['id'], 'description': 'Clavier E2E', 'quantity': 6, 'unitPrice': '40', 'taxRateId': tax19['id']}]})
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW); pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')
    pg.goto(BASE + '/purchases/invoices/new'); pg.wait_for_selector("text=Entrer les articles en stock à l'enregistrement")
    ok('case visible sur une nouvelle facture d\'achat', True)
    pg.goto(BASE + f"/purchases/invoices/{d['id']}/edit"); pg.wait_for_selector("text=Entrer les articles en stock")
    ok('case cochée sur le brouillon', pg.locator('input[type=checkbox]').first.is_checked())
    pg.goto(BASE + f"/purchases/invoices/{d['id']}"); pg.wait_for_selector('text=entreront en stock')
    pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=Articles entrés en stock par cette facture', timeout=15000)
    lv = [x for x in requests.get(f'{API}/stock/levels?q=Clavier', headers=H).json()['data'] if x['productId'] == prod['id']][0]
    ok('stock = 6 après enregistrement', float(lv['quantity']) == 6, str(lv['quantity']))
    pg.screenshot(path='/tmp/shots/8d_view.png')
    ok('aucune erreur JS', not errors, str(errors[:3])); b.close()
bad = [n for n, c in results if not c]; print(f'\n{len(results)-len(bad)}/{len(results)} OK'); raise SystemExit(1 if bad else 0)
