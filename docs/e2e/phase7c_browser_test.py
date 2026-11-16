# Test navigateur Phase 7C : retenue à la source, notes de débours, projets.
# Prérequis : API :4000 (env de dev) + client Vite :5173, lancer depuis la racine :  python3 docs/e2e/phase7c_browser_test.py
import time, os
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'owner{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)
os.makedirs('/tmp/shots', exist_ok=True)
r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P7C {stamp}', 'fullName': 'Hedi Mami', 'email': email, 'password': PW})
H = {'Authorization': f"Bearer {r.json()['data']['accessToken']}"}
def post(path, body):
    x = requests.post(f'{API}{path}', headers=H, json=body); assert x.status_code < 300, (path, x.text); return x.json()['data']
client = post('/clients', {'name': 'Société Tunis Services', 'taxId': '1234567/A'})
sup = post('/suppliers', {'name': 'Importex Tunis'})
tax19 = [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '19.00'][0]
today = time.strftime('%Y-%m-%d')
d = post('/invoices', {'clientId': client['id'], 'issueDate': today, 'withholdingPct': '1.5', 'lines': [{'description': 'Prestation', 'quantity': 1, 'unitPrice': '1000', 'taxRateId': tax19['id']}]})
inv = post(f"/invoices/{d['id']}/issue", {})
pi = post('/purchase-invoices', {'supplierId': sup['id'], 'issueDate': today, 'supplierRef': 'F-77', 'withholdingPct': '1.5', 'lines': [{'description': 'Achat', 'quantity': 1, 'unitPrice': '400', 'taxRateId': tax19['id']}]})
post(f"/purchase-invoices/{pi['id']}/record", {})

def login(pg):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 4' not in m.text else None)
    login(pg)

    # RS ventes : attestation reçue
    pg.goto(BASE + '/withholdings/sales'); pg.wait_for_selector(f'td:has-text("{inv["number"]}")')
    ok('RS ventes : facture listée avec retenue 17,850', '17,850' in pg.locator('tbody').inner_text())
    pg.click('button:has-text("Saisir")'); pg.fill('#wc-num', 'ATT-2026-001'); pg.click('div.fixed button:has-text("Enregistrer")'); pg.wait_for_selector('text=Attestation enregistrée')
    ok('attestation reçue enregistrée', requests.get(f'{API}/withholdings/sales?status=done', headers=H).json()['meta']['total'] == 1)
    pg.goto(BASE + '/withholdings/purchases'); pg.wait_for_selector('td:has-text("F-77"), div:has-text("Réf. F-77")')
    ok('RS achats : facture d\'achat listée', pg.locator('tbody tr').count() == 1)
    pg.screenshot(path='/tmp/shots/7c_rs.png')

    # Projet
    pg.goto(BASE + '/projects'); pg.click('button:has-text("Nouveau projet")'); pg.fill('#pj-name', 'Refonte site Tunis Services'); pg.fill('#pj-budget', '2000')
    pg.fill('div.fixed input[placeholder^="Rechercher un client"]', 'Tunis'); pg.click('div.fixed li:has-text("Société Tunis Services"), div.fixed [role=option]:has-text("Société Tunis Services")')
    pg.click('div.fixed button:has-text("Enregistrer")'); pg.wait_for_selector('h1:has-text("PRJ-")')
    ok('projet créé (code automatique)', True)
    # Note de débours (vente) rattachée au projet via l'éditeur
    pg.goto(BASE + '/sales/expense-notes/new'); pg.fill('div.grid input[placeholder^="Rechercher un client"]', 'Tunis'); pg.click('li:has-text("Société Tunis Services"), [role=option]:has-text("Société Tunis Services")')
    pg.select_option('#en-project', index=1); pg.fill('#en-d-0', "Droits d'enregistrement"); pg.fill('#en-p-0', 'Recette des finances'); pg.fill('#en-a-0', '120,500')
    ok('total débours calculé à l\'écran', '120,500' in pg.locator('[data-testid=en-total]').inner_text())
    pg.click('button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('h1:has-text("brouillon")')
    pg.click('button:has-text("Valider")'); pg.wait_for_selector('h1:has-text("DEB-")')
    ok('note de débours validée (DEB-)', True)
    # Rattacher la facture au projet
    proj = requests.get(f'{API}/projects', headers=H).json()['data'][0]
    pg.goto(f"{BASE}/projects/{proj['id']}"); pg.click('button:has-text("Rattacher un document")'); pg.select_option('#lk-type', 'invoice'); pg.wait_for_selector(f'td:has-text("{inv["number"]}")')
    pg.click('div.fixed button:has-text("Rattacher")'); pg.wait_for_selector(f'td:has-text("{inv["number"]}")')
    s = requests.get(f"{API}/projects/{proj['id']}", headers=H).json()['data']['summary']
    ok('synthèse : facturé 1000, débours refacturés 120,5', s['invoiced'] == '1000.000' and s['expenseSales'] == '120.500', str(s['result']))
    pg.screenshot(path='/tmp/shots/7c_project.png')
    # Menu : plus de page « en cours de développement » sur la phase 7
    pg.goto(BASE + '/purchases/expense-notes'); pg.wait_for_selector('h1:has-text("Notes de débours")')
    ok('notes de débours achats : page réelle', pg.locator('text=En cours de développement').count() == 0)
    ok('aucune erreur console', not errors, str(errors[:2]))
    b.close()
bad = [n for n, c in results if not c]; print(f'\n{len(results)-len(bad)}/{len(results)} OK'); raise SystemExit(1 if bad else 0)
