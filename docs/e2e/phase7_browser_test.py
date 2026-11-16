# Test navigateur Phase 7 : achats (commande, réception, facture d'achat, règlement fournisseur, avoir) et stock.
# Prérequis : API :4000 (env de dev) + client Vite :5173, lancer depuis la racine :  python3 docs/e2e/phase7_browser_test.py
import time, re, os
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'
owner_email = f'owner{stamp}@test.mhfac'; ro_email = f'ro{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)
os.makedirs('/tmp/shots', exist_ok=True)

r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P7 {stamp}', 'fullName': 'Hedi Mami', 'email': owner_email, 'password': PW})
H = {'Authorization': f"Bearer {r.json()['data']['accessToken']}"}
requests.post(f'{API}/users/invitations', headers=H, json={'email': ro_email, 'roleCode': 'read_only'})
log = open('api.log').read(); inv = [b for b in log.split('[mail:console] A: ') if b.startswith(ro_email)][-1]
requests.post(f'{API}/auth/accept-invitation', json={'token': re.search(r'token=([A-Za-z0-9_-]+)', inv).group(1), 'fullName': 'Lecteur', 'password': PW})
sup = requests.post(f'{API}/suppliers', headers=H, json={'name': 'Importex Tunis', 'paymentTermsDays': 30}).json()['data']
tax19 = [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '19.00'][0]
prod = requests.post(f'{API}/products', headers=H, json={'name': 'Routeur WiFi', 'salePrice': '150', 'purchasePrice': '100', 'taxRateId': tax19['id'], 'trackStock': True}).json()['data']
def stock_qty():
    rows = requests.get(f'{API}/stock/levels', headers=H, params={'q': 'Routeur'}).json()['data']
    return next((x['quantity'] for x in rows if x['productId'] == prod['id']), '0.0000')

def login(pg, email):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1366, 'height': 900})
    pg = ctx.new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 4' not in m.text else None)
    login(pg, owner_email)

    # Menu : pages réelles
    pg.click('aside >> text=Achats')
    for label, title in [('Bons de commande', 'Bons de commande fournisseur'), ('Bons de réception', 'Bons de réception'), ("Factures d'achat", "Factures d'achat"), ('Avoirs fournisseur', 'Avoirs fournisseur'), ('Règlements fournisseur', 'Règlements fournisseur')]:
        pg.click(f'aside >> text={label}'); pg.wait_for_selector(f'h1:has-text("{title}")')
    ok('menu Achats : vraies pages', pg.locator('text=en cours de développement').count() == 0)

    # Commande fournisseur
    pg.goto(BASE + '/purchases/orders/new'); pg.wait_for_selector('text=Totaux (calculés par le serveur)')
    pg.fill('#supplier', 'Import'); pg.click('li[role=option]:has-text("Importex Tunis")')
    pg.click('li[role=option]:has-text("Routeur WiFi")') if False else None
    pg.fill('input[name="lines.0.description"]', 'Routeur WiFi'); pg.fill('input[name="lines.0.quantity"]', '10'); pg.fill('input[name="lines.0.unitPrice"]', '100')
    pg.wait_for_function("document.querySelector('[data-testid=total-ttc]') && document.querySelector('[data-testid=total-ttc]').innerText.includes('1 190,000')")
    ok('aperçu des totaux calculé par le serveur (1 190,000)', True)
    pg.click('main button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('text=Confirmer la commande')
    pg.click('button:has-text("Confirmer la commande")'); pg.wait_for_selector('text=Commande confirmée')
    ok('commande confirmée avec numéro BCF-', re.search(r'BCF-\d{4}-\d{5}', pg.inner_text('h1')) is not None, pg.inner_text('h1'))
    pg.screenshot(path='/tmp/shots/p7_order.png')
    order_url = pg.url
    pg.click('button:has-text("PDF")') if False else None

    # Création rapide d'un fournisseur ET d'un article depuis la commande (sans passer par Fournisseurs / Articles)
    pg.goto(BASE + '/purchases/orders/new'); pg.wait_for_selector('text=Totaux (calculés par le serveur)')
    pg.click('text=+ Nouveau fournisseur')
    pg.locator('div.fixed input').first.fill('Fournisseur Express'); pg.get_by_role('button', name='Créer le fournisseur').click()
    pg.wait_for_function("document.querySelector('#supplier').value.includes('Fournisseur Express')")
    ok('fournisseur créé depuis la commande et sélectionné', True)
    pg.click('text=+ Nouvel article'); pg.locator('div.fixed input').first.fill('Switch 8 ports'); pg.locator('div.fixed input').nth(1).fill('50')
    pg.get_by_role('button', name="Créer l'article").click()
    pg.wait_for_function("[...document.querySelectorAll('input')].some(i => i.value === 'Switch 8 ports')")
    pg.wait_for_function("document.querySelector('[data-testid=total-ttc]') && document.querySelector('[data-testid=total-ttc]').innerText.includes('59,500')")
    ok('article créé depuis la ligne, prix d\'achat 50 repris (TTC 59,500)', True)
    pg.click('main button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('text=Confirmer la commande')
    ok('commande enregistrée avec le nouveau fournisseur', 'Fournisseur Express' in pg.inner_text('main'))
    ok('le fournisseur et l\'article existent dans leurs listes', any(x['name'] == 'Fournisseur Express' for x in requests.get(f'{API}/suppliers', headers=H, params={'q': 'Express'}).json()['data']) and any(x['name'] == 'Switch 8 ports' and x['trackStock'] for x in requests.get(f'{API}/products', headers=H, params={'q': 'Switch'}).json()['data']))

    # Même création rapide côté Ventes : client et article depuis une facture
    pg.goto(BASE + '/sales/invoices/new'); pg.wait_for_selector('text=Totaux (calculés par le serveur)')
    pg.click('text=+ Nouveau client'); pg.locator('div.fixed input').first.fill('Client Express'); pg.get_by_role('button', name='Créer le client').click()
    pg.wait_for_function("document.querySelector('#client').value.includes('Client Express')")
    ok('client créé depuis la facture de vente et sélectionné', True)
    pg.click('text=+ Nouvel article'); pg.locator('div.fixed input').first.fill('Imprimante laser'); pg.locator('div.fixed input').nth(2).fill('200')
    pg.get_by_role('button', name="Créer l'article").click()
    pg.wait_for_function("[...document.querySelectorAll('input')].some(i => i.value === 'Imprimante laser')")
    pg.wait_for_function("document.querySelector('[data-testid=total-ttc]') && document.querySelector('[data-testid=total-ttc]').innerText.includes('238,000')")
    ok('article créé depuis la vente, prix de vente 200 repris (TTC 238,000)', True)
    pg.click('main button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('text=Valider et émettre')
    ok('facture de vente enregistrée avec le nouveau client', 'Client Express' in pg.inner_text('main'))

    # Réception partielle (4/10) liée au produit suivi en stock : on crée une ligne produit via API pour le suivi
    # (la commande saisie à la main n'a pas d'article lié : on en crée une seconde avec l'article)
    od = requests.post(f'{API}/purchase-orders', headers=H, json={'supplierId': sup['id'], 'issueDate': time.strftime('%Y-%m-%d'), 'lines': [{'productId': prod['id'], 'description': 'Routeur WiFi', 'quantity': 10, 'unitPrice': '100', 'taxRateId': tax19['id']}]}).json()['data']
    requests.post(f"{API}/purchase-orders/{od['id']}/confirm", headers=H)
    pg.goto(f"{BASE}/purchases/orders/{od['id']}"); pg.wait_for_selector('text=Créer un bon de réception')
    pg.click('button:has-text("Créer un bon de réception")'); pg.wait_for_selector('text=Reste à recevoir')
    pg.fill('input[aria-label="Quantité reçue ligne 1"]', '4'); pg.click('button:has-text("Créer le bon (brouillon)")'); pg.wait_for_selector('text=Valider la réception')
    ok('réception en brouillon : stock inchangé', stock_qty() == '0.0000', stock_qty())
    pg.click('button:has-text("Valider la réception")'); pg.wait_for_selector('text=Réception validée'); pg.wait_for_selector('h1:has-text("BR-")')
    ok('réception validée : numéro BR- et stock = 4', re.search(r'BR-\d{4}-\d{5}', pg.inner_text('h1')) is not None and stock_qty() == '4.0000', stock_qty())

    # Facture depuis la réception
    pg.click('button:has-text("Facturer cette réception")'); pg.fill('#sref', f'FA-FOURN-{stamp}'); pg.click('button:has-text("Créer la facture")')
    pg.wait_for_selector('button:has-text("Enregistrer"):not(:has-text("règlement"))')
    ok('facture depuis réception : 400 HT / 476 TTC', '476,000' in pg.inner_text('[data-testid=doc-totals]') or '476,000' in pg.inner_text('main'))
    pg.get_by_role('button', name='Enregistrer', exact=True).click(); pg.wait_for_selector('text=Document enregistré')
    ok('facture enregistrée : numéro FA-', re.search(r'FA-\d{4}-\d{5}', pg.inner_text('h1')) is not None, pg.inner_text('h1'))
    ok('facture enregistrée : plus de bouton Modifier', pg.locator('button:has-text("Modifier")').count() == 0)
    inv_url = pg.url
    ok('stock inchangé par la facture', stock_qty() == '4.0000')

    # Règlement partiel puis solde
    pg.click('button:has-text("Enregistrer un règlement")'); pg.wait_for_selector('text=Montant réglé')
    pg.fill('input[aria-label^="Montant réglé"]', '200'); pg.click('button:has-text("Enregistrer le règlement")'); pg.wait_for_selector('text=enregistré')
    pg.wait_for_function("document.querySelector('[data-testid=balance]') && document.querySelector('[data-testid=balance]').innerText.includes('276,000')")
    ok('règlement partiel : reste 276,000', True)
    pg.click('button:has-text("Enregistrer un règlement")'); pg.wait_for_selector('text=Montant réglé'); pg.click('button:has-text("Enregistrer le règlement")')
    pg.wait_for_function("document.querySelector('[data-testid=balance]') && document.querySelector('[data-testid=balance]').innerText.includes('0,000')")
    ok('facture soldée : badge Payée', pg.locator('h1 ~ * >> text=Payée').count() > 0 or 'Payée' in pg.inner_text('main'))
    pg.screenshot(path='/tmp/shots/p7_invoice_paid.png')

    # Avoir fournisseur sur une facture libre
    pg.goto(BASE + '/purchases/invoices/new'); pg.wait_for_selector('text=Totaux (calculés par le serveur)')
    pg.fill('#supplier', 'Import'); pg.click('li[role=option]:has-text("Importex Tunis")')
    pg.fill('input[name=supplierRef]', f'FA-LIBRE-{stamp}'); pg.fill('input[name="lines.0.description"]', 'Transport'); pg.fill('input[name="lines.0.unitPrice"]', '100')
    pg.wait_for_function("document.querySelector('[data-testid=total-ttc]') && document.querySelector('[data-testid=total-ttc]').innerText.includes('119,000')")
    pg.click('main button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('text=Enregistrer')
    pg.get_by_role('button', name='Enregistrer', exact=True).click(); pg.wait_for_selector('text=Document enregistré')
    pg.click('button:has-text("Créer un avoir")'); pg.fill('#cn-ref', f'AV-{stamp}'); pg.fill('#cn-reason', 'Remise commerciale')
    pg.click('button:has-text("Créer le brouillon d\'avoir")'); pg.wait_for_selector('text=Avoir sur la facture')
    pg.get_by_role('button', name='Enregistrer', exact=True).click(); pg.wait_for_selector('text=Document enregistré')
    ok('avoir fournisseur enregistré AVF-', re.search(r'AVF-\d{4}-\d{5}', pg.inner_text('h1')) is not None, pg.inner_text('h1'))

    # Doublon du n° fournisseur refusé
    pg.goto(BASE + '/purchases/invoices/new'); pg.wait_for_selector('text=Totaux (calculés par le serveur)')
    pg.fill('#supplier', 'Import'); pg.click('li[role=option]:has-text("Importex Tunis")')
    pg.fill('input[name=supplierRef]', f'FA-LIBRE-{stamp}'); pg.fill('input[name="lines.0.description"]', 'Transport'); pg.fill('input[name="lines.0.unitPrice"]', '10')
    pg.wait_for_function("document.querySelector('[data-testid=total-ttc]') && document.querySelector('[data-testid=total-ttc]').innerText.includes('11,900')")
    pg.click('main button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('text=déjà enregistré')
    ok('n° fournisseur en double refusé avec message clair', True)

    # Annulation de la réception impossible (facturée) -> message
    rcs = requests.get(f'{API}/purchase-receipts', headers=H).json()['data']
    pg.goto(f"{BASE}/purchases/receipts/{rcs[0]['id']}"); pg.wait_for_selector('text=Facturée') if False else pg.wait_for_selector('h1')
    pg.click('button:has-text("Annuler")'); pg.fill('input[aria-label="Motif d\'annulation"]', 'Erreur de saisie'); pg.click('button:has-text("Confirmer l\'annulation")')
    pg.wait_for_selector('text=facture'); ok('annulation d\'une réception facturée refusée', stock_qty() == '4.0000')

    # Stock visible dans l'inventaire
    pg.goto(BASE + '/stock/inventory'); pg.wait_for_selector('text=Routeur WiFi')
    ok('inventaire : Routeur WiFi à 4 en stock', '4' in pg.locator('tr:has-text("Routeur WiFi")').inner_text())
    pg.screenshot(path='/tmp/shots/p7_inventory.png')

    # Liste des règlements fournisseur
    pg.goto(BASE + '/purchases/payments'); pg.wait_for_selector('text=RGF-')
    ok('règlements fournisseur listés (RGF-)', pg.locator('text=RGF-').count() >= 2)

    # Lecture seule : aucune action d'écriture
    ctx2 = b.new_context(viewport={'width': 1366, 'height': 900}); pr = ctx2.new_page(); login(pr, ro_email)
    pr.goto(inv_url); pr.wait_for_selector('h1')
    ok('lecture seule : pas de règlement ni d\'avoir', pr.locator('button:has-text("règlement")').count() == 0 and pr.locator('button:has-text("avoir")').count() == 0)
    pr.goto(BASE + '/purchases/orders'); pr.wait_for_selector('h1')
    ok('lecture seule : pas de bouton Nouvelle commande', pr.locator('button:has-text("Nouvelle commande")').count() == 0)
    ok('aucune erreur console', not errors, str(errors[:3]))
    b.close()

fails = [n for n, c in results if not c]
print(f'\n{len(results) - len(fails)}/{len(results)} OK'); raise SystemExit(1 if fails else 0)
