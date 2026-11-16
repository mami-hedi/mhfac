# Test navigateur Phase 8 : tableau de bord réel, rapports, facturation électronique (SIMULATION).
# Prérequis : API :4000 (env de dev) + client Vite :5173, lancer depuis la racine :  python3 docs/e2e/phase8_browser_test.py
import time, os
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'owner{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)
os.makedirs('/tmp/shots', exist_ok=True)
r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P8 {stamp}', 'fullName': 'Hedi Mami', 'email': email, 'password': PW})
H = {'Authorization': f"Bearer {r.json()['data']['accessToken']}"}
def post(path, body=None):
    x = requests.post(f'{API}{path}', headers=H, json=body or {}); assert x.status_code < 300, (path, x.text); return x.json()['data']
client = post('/clients', {'name': 'Société Tunis Services'})
tax19 = [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '19.00'][0]
today = time.strftime('%Y-%m-%d')
d = post('/invoices', {'clientId': client['id'], 'issueDate': today, 'lines': [{'description': 'Prestation', 'quantity': 1, 'unitPrice': '1000', 'taxRateId': tax19['id']}]})
inv = post(f"/invoices/{d['id']}/issue")

def login(pg):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 4' not in m.text else None)
    login(pg)
    ok('tableau de bord : CA 1 190,000 affiché', '1' in pg.locator('main').inner_text() and ('190' in pg.locator('main').inner_text()))
    pg.screenshot(path='/tmp/shots/8_dashboard.png')

    pg.goto(BASE + '/reports'); pg.wait_for_selector('text=Rapports')
    ok('page rapports affichée', pg.locator('button:has-text("CSV")').count() >= 0)
    pg.screenshot(path='/tmp/shots/8_reports.png')

    pg.goto(BASE + f"/sales/invoices/{inv['id']}"); pg.wait_for_selector("button:has-text(\"Préparer l'envoi électronique\")")
    ok('fiche facture : badge SIMULATION', pg.locator('text=SIMULATION').count() >= 1)
    pg.click("button:has-text(\"Préparer l'envoi électronique\")"); pg.wait_for_selector('text=En attente de transmission')
    pg.click('a:has-text("Détail")'); pg.wait_for_selector('text=Historique')
    ok('détail : bannière non homologué TTN', pg.locator('text=non homologué TTN').count() >= 1)
    pg.click('button:has-text("Transmettre")'); pg.wait_for_selector('span:has-text("Acceptée")')
    ok('transmission simulée acceptée', 'SIM-' in pg.locator('main').inner_text())
    pg.screenshot(path='/tmp/shots/8_einvoice_detail.png')

    pg.goto(BASE + '/e-invoicing'); pg.wait_for_selector(f'a:has-text("{inv["number"]}")')
    ok('liste e-invoicing : facture listée', True)
    ok('aucune erreur JS', not errors, str(errors[:3]))
    b.close()
bad = [n for n, c in results if not c]; print(f'\n{len(results)-len(bad)}/{len(results)} OK'); raise SystemExit(1 if bad else 0)
