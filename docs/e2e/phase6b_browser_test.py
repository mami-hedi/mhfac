# Test navigateur Phase 6 (complément) : commandes, bons de livraison, acompte/solde, factures récurrentes, e-mail, modèles PDF.
# Prérequis : API :4000 (env de dev) + client Vite :5173, lancer depuis la racine :  python3 docs/e2e/phase6b_browser_test.py
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

r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P6b {stamp}', 'fullName': 'Hedi Mami', 'email': owner_email, 'password': PW})
H = {'Authorization': f"Bearer {r.json()['data']['accessToken']}"}
requests.post(f'{API}/users/invitations', headers=H, json={'email': ro_email, 'roleCode': 'read_only'})
log = open('api.log').read(); inv = [b for b in log.split('[mail:console] A: ') if b.startswith(ro_email)][-1]
requests.post(f'{API}/auth/accept-invitation', json={'token': re.search(r'token=([A-Za-z0-9_-]+)', inv).group(1), 'fullName': 'Lecteur', 'password': PW})
client = requests.post(f'{API}/clients', headers=H, json={'name': 'Société Sfax Meuble', 'email': 'achats@sfax-meuble.test', 'address': '5 rue de la République, Sfax', 'paymentTermsDays': 30}).json()['data']
tax19 = [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '19.00'][0]
requests.patch(f'{API}/companies/current/settings', headers=H, json={'identity': {'email': 'contact@mhdigital.test'}})

def login(pg, email):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')

def new_order(pg, qty='10', price='100'):
    pg.goto(BASE + '/sales/orders/new'); pg.wait_for_selector('text=Totaux (calculés par le serveur)')
    pg.fill('#client', 'Sfax'); pg.click('li[role=option]:has-text("Société Sfax Meuble")')
    pg.fill('input[name="lines.0.description"]', 'Licence logiciel'); pg.fill('input[name="lines.0.quantity"]', qty); pg.fill('input[name="lines.0.unitPrice"]', price)
    pg.wait_for_function("document.querySelector('[data-testid=total-ttc]') && document.querySelector('[data-testid=total-ttc]').innerText.includes('1 190,000')")
    pg.click('main button:has-text("Enregistrer")'); pg.wait_for_selector('text=Confirmer la commande')

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1366, 'height': 900}, accept_downloads=True)
    pg = ctx.new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 4' not in m.text else None)
    login(pg, owner_email)

    # --- Modèle PDF et langue
    pg.goto(BASE + '/settings'); pg.wait_for_selector('text=Modèle de PDF')
    pg.select_option('select[name=template]', 'modern'); pg.select_option('select[name=pdfLanguage]', 'ar')
    pg.click('button:has-text("Enregistrer") >> nth=-1'); pg.wait_for_selector('text=Paramètres de facturation enregistrés')
    pg.reload(); pg.wait_for_selector('text=Modèle de PDF')
    ok('modèle PDF et langue enregistrés', pg.input_value('select[name=template]') == 'modern' and pg.input_value('select[name=pdfLanguage]') == 'ar')
    pg.select_option('select[name=template]', 'classic'); pg.select_option('select[name=pdfLanguage]', 'fr')
    pg.click('button:has-text("Enregistrer") >> nth=-1'); pg.wait_for_selector('text=Paramètres de facturation enregistrés')

    # --- Menu : pages réelles
    pg.goto(BASE + '/'); pg.click('aside >> text=Ventes')
    for label, title in [('Commandes client', 'Commandes client'), ('Bons de livraison', 'Bons de livraison'), ('Factures récurrentes', 'Factures récurrentes')]:
        pg.click(f'aside >> text={label}'); pg.wait_for_selector(f'h1:has-text("{title}")')
    ok('menu : commandes, bons de livraison, factures récurrentes sont de vraies pages', pg.locator('text=en cours de développement').count() == 0)

    # --- Commande -> livraison partielle -> facture du bon
    new_order(pg)
    ok('commande créée en brouillon avec numéro CMD-', re.search(r'CMD-\d{4}-\d{5}', pg.inner_text('h1')) is not None, pg.inner_text('h1'))
    pg.click('button:has-text("Confirmer la commande")'); pg.wait_for_selector('text=Commande confirmée')
    ok('commande confirmée : non livrée, non facturée', 'Non livrée' in pg.inner_text('[data-testid=order-progress]') and 'Non facturée' in pg.inner_text('[data-testid=order-progress]'))
    pg.screenshot(path='/tmp/shots/p6b-01-order.png', full_page=True)
    order_url = pg.url
    pg.click('button:has-text("Créer un bon de livraison")'); pg.wait_for_selector('text=Bon de livraison —')
    pg.fill('input[aria-label="Quantité à livrer ligne 1"]', '15'); pg.click('button:has-text("Créer le bon (brouillon)")')
    pg.wait_for_selector('text=supérieure au reste à livrer')
    ok('livraison au-dessus du reste refusée (message serveur)', True)
    pg.fill('input[aria-label="Quantité à livrer ligne 1"]', '4'); pg.click('button:has-text("Créer le bon (brouillon)")')
    pg.wait_for_selector('h1:has-text("Bon de livraison (brouillon)")')
    pg.click('button:has-text("Valider")'); pg.wait_for_selector('text=Bon validé')
    ok('bon validé : numéro BL-', re.search(r'BL-\d{4}-\d{5}', pg.inner_text('h1')) is not None, pg.inner_text('h1'))
    pg.screenshot(path='/tmp/shots/p6b-02-bl.png', full_page=True)
    with pg.expect_download() as dl: pg.click('button:has-text("PDF")')
    path = dl.value.path(); ok('PDF du bon de livraison téléchargé', open(path, 'rb').read(4) == b'%PDF')
    pg.click('button:has-text("Facturer ces quantités")'); pg.wait_for_selector('h1:has-text("(brouillon)")')
    ok('facture du bon : 4 x 100 = 476 TTC, liée à la commande', '476,000' in pg.inner_text('[data-testid=view-ttc]') and 'Commande' in pg.inner_text('main'))
    pg.goto(order_url); pg.wait_for_selector('[data-testid=order-progress]')
    ok('commande : livrée partiellement, facturée partiellement', 'Livrée partiellement' in pg.inner_text('[data-testid=order-progress]') and 'Facturée partiellement' in pg.inner_text('[data-testid=order-progress]'))
    ok('commande : bon et facture listés', pg.locator('[data-testid=order-bls] li').count() == 1 and pg.locator('[data-testid=order-invoices] li').count() == 1)
    ok('facturation complète masquée une fois facturée par livraison', pg.locator('button:has-text("Facture d\'acompte")').count() == 0)

    # --- E-mail de la commande
    pg.click('button:has-text("Envoyer")'); pg.wait_for_selector('text=par e-mail')
    ok('e-mail : destinataire prérempli depuis la fiche client', pg.input_value('#mail-to') == 'achats@sfax-meuble.test')
    pg.click('div[role=dialog] button:has-text("Envoyer"), .fixed button:has-text("Envoyer") >> nth=-1'); pg.wait_for_selector('text=E-mail envoyé')
    ok('e-mail de la commande envoyé', True)
    with pg.expect_download() as dl: pg.click('button:has-text("PDF عربي")')
    ok('PDF arabe de la commande téléchargé', open(dl.value.path(), 'rb').read(4) == b'%PDF')

    # --- Acompte puis solde
    new_order(pg); pg.click('button:has-text("Confirmer la commande")'); pg.wait_for_selector('text=Commande confirmée'); order2 = pg.url
    pg.click('button:has-text("Facture d\'acompte")'); pg.wait_for_selector('text=Pourcentage de la commande')
    pg.fill('#dep-pct', '30'); pg.click('button:has-text("Créer l\'acompte")'); pg.wait_for_selector('text=sera déduite de la facture de solde')
    ok('acompte 30 % : 357 TTC', '357,000' in pg.inner_text('[data-testid=view-ttc]'), pg.inner_text('[data-testid=view-ttc]'))
    pg.click('button:has-text("Valider et émettre")'); pg.wait_for_selector('text=Document émis')
    pg.goto(order2); pg.wait_for_selector('button:has-text("Créer la facture de solde")')
    ok('commande : acompte facturé', 'Acompte facturé' in pg.inner_text('[data-testid=order-progress]'))
    pg.click('button:has-text("Créer la facture de solde")'); pg.wait_for_selector('text=sont déduits du net à payer')
    ok('solde : TTC 1 190, acompte déduit, net 833', '1 190,000' in pg.inner_text('[data-testid=view-ttc]') and pg.locator('text=Acompte FAC-').count() >= 1 and '833,000' in pg.inner_text('[data-testid=doc-totals]'))
    pg.screenshot(path='/tmp/shots/p6b-03-final.png', full_page=True)
    pg.click('button:has-text("Valider et émettre")'); pg.wait_for_selector('text=Document émis')
    ok('solde émis : solde restant 833', '833,000' in pg.inner_text('[data-testid=balance]'))

    # --- Factures récurrentes
    pg.goto(BASE + '/sales/recurring'); pg.wait_for_selector('text=Aucune facture récurrente')
    pg.click('main button:has-text("Nouvelle série") >> nth=0'); pg.wait_for_selector('text=Nouvelle facture récurrente')
    pg.fill('#rec-client', 'Sfax'); pg.click('li[role=option]:has-text("Société Sfax Meuble")')
    pg.fill('#rec-name', 'Maintenance mensuelle')
    import datetime
    start = (datetime.date.today().replace(day=1) - datetime.timedelta(days=40)).replace(day=5).isoformat()
    pg.fill('#rec-start', start)
    pg.fill('input[aria-label="Désignation ligne 1"]', 'Maintenance'); pg.fill('input[aria-label="Prix unitaire ligne 1"]', '200')
    pg.click('button:has-text("Créer la série")'); pg.wait_for_selector('text=enregistrée')
    ok('série créée : active, 0 facture', pg.locator('td:has-text("Maintenance mensuelle")').count() == 1 and 'Active' in pg.inner_text('tbody'))
    pg.click('button:has-text("Générer les échéances dues")'); pg.wait_for_selector('text=brouillon(s) de facture généré(s)')
    ok('échéances dues générées en brouillons', True, pg.inner_text('[role=alert], .rounded-md >> nth=0')[:60] if False else '')
    pg.click('button:has-text("Maintenance mensuelle")'); pg.wait_for_selector('[data-testid=rec-runs]')
    n = pg.locator('[data-testid=rec-runs] li').count(); ok('historique des générations : brouillons à relire', n >= 1 and 'à relire et émettre' in pg.inner_text('[data-testid=rec-runs]'), str(n))
    pg.click('button:has-text("Générer les échéances dues")'); pg.wait_for_selector('text=Aucune échéance due')
    ok('relance : idempotente (aucun doublon)', pg.locator('[data-testid=rec-runs] li').count() == n)
    pg.screenshot(path='/tmp/shots/p6b-04-recurring.png', full_page=True)
    pg.click('[data-testid=rec-runs] a >> nth=0'); pg.wait_for_selector('text=Générée par la facture récurrente')
    ok('facture générée : brouillon relié à la série', 'brouillon' in pg.inner_text('h1').lower() and '238,000' in pg.inner_text('[data-testid=view-ttc]'))
    pg.goto(BASE + '/sales/recurring'); pg.wait_for_selector('td:has-text("Maintenance mensuelle")')
    pg.click('button[aria-label="Mettre en pause Maintenance mensuelle"]'); pg.wait_for_selector('text=Série mise en pause')
    ok('série en pause', 'En pause' in pg.inner_text('tbody'))

    # --- Mobile
    pg.set_viewport_size({'width': 390, 'height': 800}); pg.goto(order2); pg.wait_for_selector('[data-testid=order-progress]')
    ok('mobile : pas de défilement horizontal de la page (commande)', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    pg.goto(BASE + '/sales/recurring'); pg.wait_for_selector('td:has-text("Maintenance mensuelle")')
    ok('mobile : pas de défilement horizontal de la page (récurrentes)', pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    pg.set_viewport_size({'width': 1366, 'height': 900})

    # --- Droits : lecteur seul
    ctx2 = b.new_context(viewport={'width': 1366, 'height': 900}); pg2 = ctx2.new_page(); login(pg2, ro_email)
    pg2.goto(BASE + '/sales/orders'); pg2.wait_for_selector('h1:has-text("Commandes client")')
    ok('lecteur : voit les commandes sans bouton de création', pg2.locator('main button:has-text("Nouvelle commande")').count() == 0)
    pg2.goto(BASE + '/sales/orders/new'); pg2.wait_for_timeout(800)
    ok('lecteur : création de commande refusée par la garde de route', pg2.locator('text=Totaux (calculés par le serveur)').count() == 0)
    pg2.goto(BASE + '/sales/recurring'); pg2.wait_for_selector('h1:has-text("Factures récurrentes")')
    ok('lecteur : séries visibles sans actions', pg2.locator('main button:has-text("Nouvelle série")').count() == 0)

    ok('aucune erreur console / page', not errors, str(errors[:3]))
    b.close()

fails = [n for n, c in results if not c]
print(f'\n{len(results) - len(fails)}/{len(results)} OK'); raise SystemExit(1 if fails else 0)
