# Test navigateur Phase 8C : scan d'une facture fournisseur -> relecture -> brouillon.
# Prérequis : API (env de dev) sur :4000 + client Vite :5173. Lecture RÉELLE (Tesseract) d'une facture de test.  python3 docs/e2e/phase8c_browser_test.py
import time, os, struct, zlib
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'owner{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)
os.makedirs('/tmp/shots', exist_ok=True)
FACTURE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures', 'facture_test.png')
r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P8C {stamp}', 'fullName': 'Hedi Mami', 'email': email, 'password': PW})
H = {'Authorization': f"Bearer {r.json()['data']['accessToken']}"}
requests.post(f'{API}/suppliers', headers=H, json={'name': 'Importex Tunis', 'taxId': '1234567/A'})

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 4' not in m.text else None)
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW); pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')
    pg.goto(BASE + '/purchases/scan'); pg.wait_for_selector('text=Téléverser un document')
    pg.set_input_files('[data-testid=scan-file]', FACTURE); pg.wait_for_selector('text=Lecture automatique NON vérifiée', timeout=60000)
    ok('fournisseur reconnu par matricule fiscal', pg.locator('text=reconnu (matricule fiscal)').count() == 1)
    ok('champs pré-remplis (n° facture, ligne)', pg.input_value('#sc-ref') == 'F-2026-0042' and pg.input_value('[aria-label="Description ligne 1"]') == 'Câble réseau Cat6')
    pg.screenshot(path='/tmp/shots/8c_review.png')
    pg.click('button:has-text("Créer le brouillon")')
    pg.wait_for_url('**/purchases/invoices/*/edit', timeout=30000)  # aucun écart de total -> ouverture directe du brouillon
    ok('totaux lus = totaux recalculés : brouillon ouvert directement', True)
    pg.screenshot(path='/tmp/shots/8c_done.png')
    ok('brouillon ouvert pour correction', '/edit' in pg.url)
    sc = requests.get(f'{API}/purchase-scans', headers=H).json()['data']
    ok('scan converti et lié à la facture', len(sc) == 1 and sc[0]['status'] == 'converted' and sc[0]['invoiceId'])
    pg.goto(BASE + '/purchases/scan'); pg.wait_for_selector('text=Téléverser un document'); pg.set_input_files('[data-testid=scan-file]', FACTURE); pg.wait_for_selector('text=déjà été scanné')
    ok('doublon refusé', True)
    ok('aucune erreur JS', not errors, str(errors[:3]))
    b.close()
bad = [n for n, c in results if not c]; print(f'\n{len(results)-len(bad)}/{len(results)} OK'); raise SystemExit(1 if bad else 0)
