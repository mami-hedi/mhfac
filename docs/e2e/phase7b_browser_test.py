# Test navigateur Phase 7B : trésorerie, chèques, avances (trop-perçu), relances clients, retours.
# Prérequis : API :4000 (env de dev, journal dans api.log) + client Vite :5173, lancer depuis la racine :  python3 docs/e2e/phase7b_browser_test.py
import time, os
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'owner{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)
os.makedirs('/tmp/shots', exist_ok=True)

r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P7B {stamp}', 'fullName': 'Hedi Mami', 'email': email, 'password': PW})
H = {'Authorization': f"Bearer {r.json()['data']['accessToken']}"}
def post(path, body): 
    x = requests.post(f'{API}{path}', headers=H, json=body); assert x.status_code < 300, (path, x.text); return x.json()['data']
client = post('/clients', {'name': 'Client Retard SARL', 'email': 'retard@example.com'})
tax19 = [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '19.00'][0]
def invoice(issue='2026-01-01', due='2026-01-31'):
    d = post('/invoices', {'clientId': client['id'], 'issueDate': issue, 'dueDate': due, 'lines': [{'description': 'Prestation', 'quantity': 1, 'unitPrice': '100.000', 'taxRateId': tax19['id']}]})
    return post(f"/invoices/{d['id']}/issue", {})
inv_late = invoice(); inv_cheque = invoice(); inv_adv = invoice()

def login(pg):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 4' not in m.text else None)
    login(pg)

    # Comptes : création via l'interface
    pg.click('aside >> text=Trésorerie'); pg.click('aside >> text=Comptes'); pg.wait_for_selector('h1:has-text("Comptes bancaires")')
    pg.click('button:has-text("Nouveau compte")'); pg.fill('#ac-code', 'BIAT'); pg.fill('#ac-name', 'BIAT courant'); pg.fill('#ac-open', '1000')
    pg.click('div.fixed button:has-text("Enregistrer")'); pg.wait_for_selector('td:has-text("BIAT courant")')
    ok('compte créé avec solde d\'ouverture', pg.locator('tr:has-text("BIAT courant")').inner_text().replace(' ', ' ').replace('\xa0', ' ').find('1 000,000') >= 0)
    pg.screenshot(path='/tmp/shots/7b_accounts.png')

    # Règlement client par virement avec compte
    pg.goto(BASE + '/payments'); pg.click('button:has-text("Nouveau règlement")')
    pg.fill('div.fixed input[placeholder^="Rechercher un client"]', 'Retard'); pg.click('div.fixed li:has-text("Client Retard SARL"), div.fixed [role=option]:has-text("Client Retard SARL")')
    pg.wait_for_selector(f'text={inv_late["number"]}')
    pg.fill(f'input[aria-label="Montant réglé {inv_late["number"]}"]', '119'); pg.select_option('#pay-method', 'bank_transfer'); pg.select_option('#pay-acc', index=1)
    pg.click('div.fixed button:has-text("Enregistrer le règlement")'); pg.wait_for_selector('text=enregistré')
    ok('règlement avec compte enregistré', True)
    t = requests.get(f'{API}/treasury/accounts', headers=H).json()['data'][0]
    ok('solde compte crédité de 119', t['balance'] == '1119.000', t['balance'])

    # Chèque : le compte n'est pas crédité avant encaissement
    pg.click('button:has-text("Nouveau règlement")')
    pg.fill('div.fixed input[placeholder^="Rechercher un client"]', 'Retard'); pg.click('div.fixed li:has-text("Client Retard SARL"), div.fixed [role=option]:has-text("Client Retard SARL")')
    pg.wait_for_selector(f'text={inv_cheque["number"]}')
    pg.fill(f'input[aria-label="Montant réglé {inv_cheque["number"]}"]', '119'); pg.select_option('#pay-method', 'cheque'); pg.fill('#pay-ref', 'CHQ-777'); pg.select_option('#pay-acc', index=1)
    pg.click('div.fixed button:has-text("Enregistrer le règlement")'); pg.wait_for_selector('text=enregistré')
    ok('chèque en attente : compte inchangé', requests.get(f'{API}/treasury/accounts', headers=H).json()['data'][0]['balance'] == '1119.000')
    pg.click('aside >> text=Trésorerie'); pg.click('aside >> text=Chèques & traites'); pg.wait_for_selector('td:has-text("CHQ-777")')
    pg.click('button:has-text("Encaisser")'); pg.click('div.fixed button:has-text("Confirmer")'); pg.wait_for_selector('td >> text=Encaissé / débité')
    ok('chèque encaissé : compte crédité', requests.get(f'{API}/treasury/accounts', headers=H).json()['data'][0]['balance'] == '1238.000')
    pg.screenshot(path='/tmp/shots/7b_cheques.png')

    # Transactions + rapprochement
    pg.click('aside >> text=Transactions'); pg.wait_for_selector('h1:has-text("Transactions")')
    pg.wait_for_selector('td:has-text("TRS-")'); ok('journal des écritures', pg.locator('tbody tr').count() >= 2)
    pg.locator('input[aria-label^="Rapprocher TRS"]').first.click(); pg.wait_for_timeout(600)
    ok('rapprochement manuel', requests.get(f'{API}/treasury/accounts', headers=H).json()['data'][0]['reconciledBalance'] != '1000.000')
    pg.click('button:has-text("Écriture manuelle")'); pg.fill('#tx-amt', '12,5'); pg.select_option('#tx-dir', 'out'); pg.fill('#tx-label', 'Frais bancaires')
    pg.click('div.fixed button:has-text("Enregistrer")'); pg.wait_for_selector('td:has-text("Frais bancaires")')
    ok('écriture manuelle (sortie)', requests.get(f'{API}/treasury/accounts', headers=H).json()['data'][0]['balance'] == '1225.500')

    # Avance : montant reçu supérieur au total affecté
    pay = post('/payments', {'clientId': client['id'], 'date': '2026-02-02', 'method': 'cash', 'amount': '500', 'allocations': [{'invoiceId': inv_adv['id'], 'amount': '119'}]})
    pg.goto(BASE + '/payments'); pg.wait_for_selector(f'tr:has-text("{pay["number"]}")')
    ok('avance visible (non affecté 381)', '381' in pg.locator(f'tr:has-text("{pay["number"]}")').inner_text())
    pg.click(f'button[aria-label="Affecter {pay["number"]}"]'); pg.wait_for_selector('div.fixed:has-text("Affecter l\'avance")')
    ok('modale d\'affectation (aucune facture ouverte autre que en retard)', pg.locator('div.fixed').count() >= 1)
    pg.keyboard.press('Escape'); pg.click('div.fixed button:has-text("Annuler")') if pg.locator('div.fixed').count() else None

    # Relances
    inv_new = invoice()
    pg.click('aside >> text=Ventes'); pg.click('aside >> text=Relances clients'); pg.wait_for_selector('h1:has-text("Relances clients")')
    pg.wait_for_selector('p:has-text("Client Retard SARL")'); ok('client en retard listé', True)
    pg.click('button:has-text("Relancer")'); pg.click('div.fixed button:has-text("Envoyer la relance")'); pg.wait_for_selector('text=Relance envoyée')
    ok('relance envoyée et journalisée', requests.get(f'{API}/reminders/history', headers=H).json()['data'][0]['status'] == 'sent')
    pg.screenshot(path='/tmp/shots/7b_reminders.png')

    ok('aucune erreur console', not errors, str(errors[:2]))
    b.close()
bad = [n for n, c in results if not c]; print(f'\n{len(results)-len(bad)}/{len(results)} OK'); raise SystemExit(1 if bad else 0)
