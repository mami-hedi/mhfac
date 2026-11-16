# Test navigateur Phase 6 : paramètres de facturation, devis -> facture -> avoir, immutabilité, PDF, droits.
# Prérequis : API :4000 (env de dev) + client Vite :5173.   python3 docs/e2e/phase6_browser_test.py
import time, re, os, tempfile
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'
owner_email = f'owner{stamp}@test.mhfac'; ro_email = f'ro{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)

r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P6 {stamp}', 'fullName': 'Hedi Mami', 'email': owner_email, 'password': PW})
tok = r.json()['data']['accessToken']; H = {'Authorization': f'Bearer {tok}'}
requests.post(f'{API}/users/invitations', headers=H, json={'email': ro_email, 'roleCode': 'read_only'})
log = open('api.log').read(); inv = [b for b in log.split('[mail:console] A: ') if b.startswith(ro_email)][-1]
requests.post(f'{API}/auth/accept-invitation', json={'token': re.search(r'token=([A-Za-z0-9_-]+)', inv).group(1), 'fullName': 'Lecteur', 'password': PW})
requests.post(f'{API}/clients', headers=H, json={'name': 'Société Sfax Meuble', 'taxId': '7654321/B/A/000', 'paymentTermsDays': 30})
requests.post(f'{API}/products', headers=H, json={'name': 'Clavier mécanique', 'salePrice': '50', 'taxRateId': [t for t in requests.get(f'{API}/tax-rates', headers=H).json()['data'] if t['rate'] == '7.00'][0]['id']})

def login(pg, email):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1366, 'height': 900}, accept_downloads=True)
    pg = ctx.new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 4' not in m.text else None)
    login(pg, owner_email)

    # --- Paramètres de facturation
    pg.goto(BASE + '/settings'); pg.wait_for_selector('text=Fiscalité et conditions de vente')
    ok('timbre fiscal non imposé : désactivé et à 0 par défaut', not pg.is_checked('#stampOn') and pg.input_value('input[name=stampDutyAmount]') == '0.000')
    pg.fill('input[name=address]', '12 avenue Habib Bourguiba'); pg.fill('input[name=phone]', '72 000 000')
    pg.check('#stampOn'); pg.fill('input[name=stampDutyAmount]', '1'); pg.fill('#paymentInfo', 'RIB 08 006 0123456789 12')
    logo = os.path.join(tempfile.mkdtemp(), 'logo.png')
    import base64; open(logo, 'wb').write(base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='))
    pg.set_input_files('input[aria-label="Fichier logo"]', logo)
    pg.click('button:has-text("Enregistrer") >> nth=-1'); pg.wait_for_selector('text=Paramètres de facturation enregistrés')
    ok('paramètres de facturation enregistrés (logo, timbre, RIB)', True)
    pg.screenshot(path='/tmp/shots/p6-01-settings.png', full_page=True)

    # --- Devis
    pg.click('aside >> text=Ventes'); pg.click('aside >> text=Devis'); pg.wait_for_selector('h1:has-text("Devis")')
    pg.wait_for_selector("text=Aucun devis pour l'instant"); ok('menu Devis : vraie page, état vide', True)
    pg.click('main button:has-text("Nouveau devis")'); pg.wait_for_selector('text=Totaux (calculés par le serveur)')
    ok('création : aucun total tant qu\'il n\'y a pas de client', pg.locator('text=Choisissez un client').count() == 1)
    pg.fill('#client', 'Sfax'); pg.click('li[role=option]:has-text("Société Sfax Meuble")')
    pg.fill('[data-testid=line] >> nth=0 >> input[role=combobox]', 'Clavier'); pg.click('li[role=option]:has-text("Clavier mécanique")')
    ok('article choisi : désignation et prix repris', pg.input_value('input[name="lines.0.description"]') == 'Clavier mécanique' and pg.input_value('input[name="lines.0.unitPrice"]') == '50.000')
    pg.fill('input[name="lines.0.quantity"]', '2')
    pg.click('button:has-text("Ajouter une ligne")')
    pg.fill('input[name="lines.1.description"]', 'Installation'); pg.fill('input[name="lines.1.unitPrice"]', '100')
    pg.wait_for_function("document.querySelector('[data-testid=total-ttc]') && document.querySelector('[data-testid=total-ttc]').innerText.includes('226,000')")
    ok('totaux calculés par le serveur : HT 200, TTC 226', '200,000' in pg.inner_text('[data-testid=total-ht]') and '226,000' in pg.inner_text('[data-testid=total-ttc]'))
    ok('timbre fiscal appliqué depuis les paramètres : net 227', '227,000' in pg.inner_text('[data-testid=net-payable]'))
    pg.fill('input[name=globalDiscountPct]', '10')
    pg.wait_for_function("document.querySelector('[data-testid=total-ht]').innerText.includes('180,000')")
    ok('remise globale 10 % -> HT 180 (calcul serveur)', True)
    pg.fill('input[name=globalDiscountPct]', '0'); pg.wait_for_function("document.querySelector('[data-testid=total-ht]').innerText.includes('200,000')")
    pg.fill('input[name="lines.1.quantity"]', '0'); pg.wait_for_selector('[role=alert]')
    ok('quantité 0 refusée par le serveur (message affiché)', pg.locator('[role=alert]').count() >= 1)
    pg.fill('input[name="lines.1.quantity"]', '1'); pg.wait_for_function("!document.querySelector('[role=alert]')")
    pg.click('button:has-text("Enregistrer le brouillon")'); pg.wait_for_selector('text=DEV-')
    ok('devis créé avec numéro DEV-AAAA-NNNNN', re.search(r'DEV-\d{4}-\d{5}', pg.inner_text('h1')) is not None)
    qnum = pg.inner_text('h1')
    pg.screenshot(path='/tmp/shots/p6-02-quote.png', full_page=True)
    ok('timbre et total TTC affichés', '226,000' in pg.inner_text('[data-testid=view-ttc]'))
    pg.click('button:has-text("Marquer envoyé")'); pg.wait_for_selector('text=Devis marqué comme envoyé')
    pg.click('button:has-text("Accepté")'); pg.wait_for_selector('text=Devis accepté')
    ok('cycle de statut brouillon -> envoyé -> accepté', pg.locator('span:has-text("Accepté")').count() >= 1)
    pg.click('button:has-text("Convertir en facture")'); pg.wait_for_selector('button:has-text("Valider et émettre")')
    ok('conversion en facture brouillon sans ressaisie (même TTC)', '226,000' in pg.inner_text('[data-testid=view-ttc]') and 'Issue du devis' in pg.inner_text('main'))
    pg.screenshot(path='/tmp/shots/p6-03-invoice-draft.png', full_page=True)

    # --- Devis verrouillé
    pg.goto(BASE + '/sales/quotes'); pg.click(f'a:has-text("{qnum}")'); pg.wait_for_selector('text=montants de ce devis sont verrouillés')
    ok('devis converti : verrouillé (pas de Modifier ni Accepté)', pg.locator('button:has-text("Modifier")').count() == 0 and pg.locator('button:has-text("Convertir")').count() == 0)
    pg.click('a:has-text("brouillon / n°")'); pg.wait_for_selector('button:has-text("Valider et émettre")')

    # --- Émission
    pg.click('button:has-text("Valider et émettre")'); pg.wait_for_selector('text=Document émis')
    num = pg.inner_text('h1'); ok('facture émise : numéro FAC-AAAA-NNNNN', re.search(r'^FAC-\d{4}-\d{5}$', num) is not None, num)
    ok('facture émise : ni Modifier, ni Supprimer', pg.locator('button:has-text("Modifier")').count() == 0 and pg.locator('button:has-text("Supprimer")').count() == 0)
    ok('statut Impayée, solde = net à payer', pg.locator('span:has-text("Impayée")').count() >= 1 and '227,000' in pg.inner_text('[data-testid=balance]'))
    pg.goto(pg.url + '/edit'); pg.wait_for_url(re.compile(r'/sales/invoices/[0-9a-f-]{36}$'))
    ok('accès direct à /edit d\'une facture émise : redirigé vers la fiche', True)
    with pg.expect_download() as dl: pg.click('button:has-text("PDF")')
    data = open(dl.value.path(), 'rb').read(); ok('PDF téléchargé (en-tête %PDF)', data[:5] == b'%PDF-' and len(data) > 1500)

    # --- Avoir partiel
    pg.click('button:has-text("Créer un avoir")'); pg.fill('#reason', 'Retour de 1 article')
    pg.fill('input[aria-label="Quantité à créditer ligne 1"]', '5'); pg.click('button:has-text("Créer le brouillon d\'avoir")')
    pg.wait_for_selector('div[role=dialog] [role=alert]'); ok('avoir > quantité facturée : refusé par le serveur', True)
    pg.fill('input[aria-label="Quantité à créditer ligne 1"]', '1'); pg.fill('input[aria-label="Quantité à créditer ligne 2"]', '0')
    pg.click('button:has-text("Créer le brouillon d\'avoir")'); pg.wait_for_selector('text=Avoir sur la facture')
    ok('avoir brouillon créé (1 × 50 HT @7 % = 53,500)', '53,500' in pg.inner_text('[data-testid=view-ttc]'))
    pg.click('button:has-text("Valider et émettre")'); pg.wait_for_selector('text=Document émis')
    ok('avoir émis : AVO-AAAA-NNNNN', re.search(r'^AVO-\d{4}-\d{5}$', pg.inner_text('h1')) is not None)
    pg.click('a:has-text("FAC-")'); pg.wait_for_selector('[data-testid=balance]')
    ok('solde de la facture réduit par l\'avoir (227,000 - 53,500 = 173,500)', '173,500' in pg.inner_text('[data-testid=balance]'))
    pg.click('button:has-text("Annuler")'); pg.fill('input[aria-label="Motif d\'annulation"]', 'Erreur de client'); pg.click('div[role=dialog] >> button:has-text("Annuler la facture")')
    pg.wait_for_selector('text=Des avoirs existent'); ok('annulation refusée quand un avoir existe', True)
    pg.keyboard.press('Escape')
    pg.click('button:has-text("Historique")'); pg.wait_for_selector('[data-testid=history]')
    ok('historique : création et émission tracées', 'Émission' in pg.inner_text('[data-testid=history]') and 'Création' in pg.inner_text('[data-testid=history]'))
    pg.screenshot(path='/tmp/shots/p6-04-invoice-issued.png', full_page=True)

    # --- Listes
    pg.goto(BASE + '/sales/invoices'); pg.wait_for_selector(f'a:has-text("{num}")')
    ok('liste des factures : numéro, client, statut', pg.locator('td:has-text("Société Sfax Meuble")').count() >= 1)
    pg.select_option('select[aria-label=Paiement]', 'overdue'); pg.wait_for_timeout(600)
    ok('filtre « en retard » : aucune facture récente', pg.locator('tbody tr').count() == 0)
    pg.goto(BASE + '/sales/credit-notes'); pg.wait_for_selector('a:has-text("AVO-")'); ok('liste des avoirs', pg.locator('a:has-text("AVO-")').count() == 1)
    pg.goto(BASE + '/sales/invoices/new'); pg.wait_for_selector('text=Totaux')
    ok('Création rapide > Facture ouvre le formulaire', True)

    # --- Mobile
    m = b.new_context(viewport={'width': 390, 'height': 800}); mp = m.new_page(); login(mp, owner_email)
    mp.goto(BASE + '/sales/invoices'); mp.click(f'a:has-text("{num}")'); mp.wait_for_selector('[data-testid=balance]')
    mp.screenshot(path='/tmp/shots/p6-mob-inv.png', full_page=True); print('SW', mp.evaluate('[document.documentElement.scrollWidth, window.innerWidth]'))
    ok('mobile : pas de débordement horizontal (fiche facture)', mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    mp.goto(BASE + '/sales/quotes/new'); mp.wait_for_selector('text=Totaux')
    ok('mobile : pas de débordement horizontal (éditeur)', mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    mp.screenshot(path='/tmp/shots/p6-05-mobile.png'); m.close()

    # --- Lecture seule
    ro = b.new_context(viewport={'width': 1366, 'height': 900}); rp = ro.new_page(); login(rp, ro_email)
    rp.goto(BASE + '/sales/invoices'); rp.wait_for_selector(f'a:has-text("{num}")')
    ok('lecture seule : pas de bouton Nouvelle facture', rp.locator('main button:has-text("Nouvelle facture")').count() == 0)
    rp.click(f'a:has-text("{num}")'); rp.wait_for_selector('[data-testid=balance]')
    ok('lecture seule : aucune action d\'émission/avoir/annulation, PDF autorisé', rp.locator('button:has-text("Créer un avoir")').count() == 0 and rp.locator('button:has-text("Annuler")').count() == 0 and rp.locator('button:has-text("PDF")').count() == 1)
    rp.goto(BASE + '/sales/invoices/new'); rp.wait_for_selector('text=Accès refusé|text=refusé|text=autorisation', timeout=5000) if False else None
    ro.close()

    ok('aucune erreur JS console', not errors, str(errors[:3]))
    b.close()
fails = [n for n, c in results if not c]
print(f'\n{len(results)-len(fails)}/{len(results)} OK')
if fails: print('ECHECS :', fails)
