# Test navigateur Phase 5 : clients, fournisseurs, articles, TVA, import/export, permissions.
# Prerequis : API sur :4000 (env de dev), client Vite sur :5173. Lancer : python3 docs/e2e/phase5_browser_test.py
import time, json, os, tempfile
import requests
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'
owner_email = f'owner{stamp}@test.mhfac'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)

# Preparation par l'API : societe + membre lecture seule (le parcours d'inscription est couvert par la phase 4)
r = requests.post(f'{API}/auth/register-company', json={'companyName': f'Démo P5 {stamp}', 'fullName': 'Hedi Mami', 'email': owner_email, 'password': PW})
tok = r.json()['data']['accessToken']
H = {'Authorization': f'Bearer {tok}'}
ro_email = f'ro{stamp}@test.mhfac'
requests.post(f'{API}/users/invitations', headers=H, json={'email': ro_email, 'roleCode': 'read_only'})
log = open('api.log').read()
inv = [b for b in log.split('[mail:console] A: ') if b.startswith(ro_email)][-1]
import re
inv_token = re.search(r'token=([A-Za-z0-9_-]+)', inv).group(1)
requests.post(f'{API}/auth/accept-invitation', json={'token': inv_token, 'fullName': 'Lecteur', 'password': PW})

def login(pg, email):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1366, 'height': 800}, accept_downloads=True)
    pg = ctx.new_page(); errors = []
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'status of 40' not in m.text else None)
    login(pg, owner_email)

    # --- Clients
    pg.click('aside >> text=Clients'); pg.wait_for_selector('h1:has-text("Clients")')
    ok('menu Clients ouvre une vraie page', pg.locator('text=en cours de développement').count() == 0)
    ok('etat vide clair', pg.locator("text=Aucun client pour l'instant").count() == 1)
    pg.click('main button:has-text("Nouveau")'); pg.fill('input[name=name]', 'A')
    pg.fill('input[name=email]', 'pas-un-mail'); pg.click('button:has-text("Enregistrer")')
    ok('validation client (nom court, e-mail)', pg.locator('text=Nom trop court').count() == 1 and pg.locator('text=E-mail invalide').count() == 1)
    pg.fill('input[name=name]', 'Société Sfax Meuble'); pg.fill('input[name=taxId]', '1234567/A/M/000')
    pg.fill('input[name=email]', 'contact@sfax.tn'); pg.fill('input[name=governorate]', 'Sfax'); pg.fill('input[name=paymentTermsDays]', '30')
    pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=CLI-00001 créé')
    ok('client cree avec code automatique', pg.locator('td:has-text("CLI-00001")').count() == 1)
    pg.click('main button:has-text("Nouveau")'); pg.fill('input[name=name]', 'Doublon'); pg.fill('input[name=taxId]', '1234567/A/M/000')
    pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=déjà utilisé')
    ok('matricule fiscal en double refuse', True)
    pg.click('button:has-text("Annuler")')
    pg.fill('input[aria-label=Rechercher]', 'sfax'); pg.wait_for_timeout(700)
    ok('recherche', pg.locator('tbody tr').count() == 1)
    pg.fill('input[aria-label=Rechercher]', 'zzz'); pg.wait_for_timeout(700)
    ok('recherche sans resultat', pg.locator('text=Aucun résultat').count() == 1)
    pg.fill('input[aria-label=Rechercher]', ''); pg.wait_for_timeout(700)
    pg.click('button[aria-label^="Modifier Société Sfax"]'); pg.fill('input[name=phone]', '+216 74 123 456')
    pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=mis à jour')
    ok('modification', True)
    pg.screenshot(path='/tmp/shots/p5-01-clients.png')

    # --- Import CSV client
    csv = 'Nom;Type;Matricule fiscal;E-mail\nImport Un;entreprise;7654321/B/A/000;un@x.tn\nMauvais;entreprise;;pas-email\n"Import, Deux";particulier;;\n'
    path = os.path.join(tempfile.mkdtemp(), 'clients.csv'); open(path, 'w', encoding='utf-8').write(csv)
    pg.click('button:has-text("Importer")'); pg.set_input_files('input[type=file]', path)
    pg.click('button:has-text("Vérifier")'); pg.wait_for_selector('[data-testid=import-preview]')
    ok('apercu import : 2 valides, 1 erreur ligne 3', 'Ligne 3' in pg.inner_text('[data-testid=import-preview]') and pg.locator('button:has-text("Importer les 2 lignes valides")').count() == 1)
    pg.screenshot(path='/tmp/shots/p5-02-import.png')
    pg.click('button:has-text("Importer les 2 lignes valides")'); pg.wait_for_selector('text=2 clients importé')
    ok('import confirme', pg.locator('tbody tr').count() == 3)

    # --- Export
    with pg.expect_download() as dl: pg.click('button:has-text("Exporter")')
    content = open(dl.value.path(), encoding='utf-8-sig').read()
    ok('export CSV authentifie', 'Société Sfax Meuble' in content and content.startswith('Code;Nom'))

    # --- Archivage / filtre / suppression
    pg.click('button[aria-label^="Archiver Import Un"]'); pg.wait_for_selector('text=Import Un archivé')
    ok('archivage retire de la liste active', pg.locator('td:has-text("Import Un")').count() == 0)
    pg.select_option('select[aria-label=Statut]', 'archived'); pg.wait_for_selector('td:has-text("Import Un")')
    ok('filtre archives', True)
    pg.click('button[aria-label^="Supprimer Import Un"]'); pg.click('div[role=dialog] >> button:has-text("Supprimer")')
    pg.wait_for_selector('text=Import Un supprimé'); ok('suppression apres confirmation', True)

    # --- Fournisseurs
    pg.click('aside >> text=Fournisseurs'); pg.wait_for_selector('h1:has-text("Fournisseurs")')
    pg.click('main button:has-text("Nouveau")'); pg.fill('input[name=name]', 'Fournisseur Tunis'); pg.click('button:has-text("Enregistrer")')
    pg.wait_for_selector('text=FOU-00001 créé'); ok('fournisseur cree (FOU-00001)', True)
    ok('liste fournisseurs distincte des clients', pg.locator('td:has-text("Société Sfax")').count() == 0)

    # --- Taux de TVA
    pg.click('aside >> text=Taux de TVA'); pg.wait_for_selector('h1:has-text("Taux de TVA")')
    ok('4 taux proposes, un par defaut', pg.locator('tbody tr').count() == 4 and pg.locator('text=Par défaut').count() == 1)
    ok('avertissement validation comptable', pg.locator('text=faites-les valider par votre comptable').count() == 1)
    pg.click('main button:has-text("Nouveau taux")'); pg.fill('input[name=name]', 'TVA 12 %'); pg.fill('input[name=rate]', '150'); pg.click('button:has-text("Enregistrer")')
    ok('validation taux > 100', pg.locator('text=Taux entre 0 et 100').count() == 1)
    pg.fill('input[name=rate]', '12'); pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('td:has-text("TVA 12 %")')
    ok('taux personnalise ajoute', True)

    # --- Articles
    pg.click('aside >> text=Articles'); pg.wait_for_selector('h1:has-text("Articles")')
    pg.click('button:has-text("Catégories")'); pg.fill('input[aria-label="Nouvelle catégorie"]', 'Informatique')
    pg.click('div[role=dialog] >> button:has-text("Ajouter")'); pg.wait_for_selector('div[role=dialog] >> text=Informatique'); pg.keyboard.press('Escape')
    pg.click('main button:has-text("Nouvel article")'); pg.fill('input[name=name]', 'Clavier'); pg.fill('input[name=salePrice]', '12,5x')
    pg.click('button:has-text("Enregistrer")'); ok('validation prix invalide', pg.locator('text=Montant positif requis').count() == 1)
    pg.fill('input[name=salePrice]', '12,500'); pg.select_option('select[name=categoryId]', label='Informatique')
    ok('TVA par defaut preselectionnee', 'TVA 19' in pg.locator('select[name=taxRateId] option:checked').inner_text())
    pg.check('input[name=trackStock]'); pg.fill('input[name=stockAlertThreshold]', '5')
    pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=ART-00001 créé')
    ok('article cree, SKU automatique, prix en TND', pg.locator('td:has-text("12,500")').count() >= 1)
    pg.click('main button:has-text("Nouvel article")'); pg.fill('input[name=name]', 'Maintenance'); pg.select_option('select[name=type]', 'service')
    ok('service : suivi de stock masque', pg.locator('input[name=trackStock]').count() == 0)
    pg.fill('input[name=sku]', 'ART-00001'); pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=SKU existe déjà'); ok('SKU en double refuse', True)
    pg.fill('input[name=sku]', 'SRV-1'); pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=SRV-1 créé')
    pg.select_option('select[aria-label="Type"]', 'service'); pg.wait_for_timeout(500)
    ok('filtre par type', pg.locator('tbody tr').count() == 1)
    pg.screenshot(path='/tmp/shots/p5-03-products.png')

    # --- Mobile
    m = b.new_context(viewport={'width': 390, 'height': 800}); mp = m.new_page()
    login(mp, owner_email); mp.goto(BASE + '/clients'); mp.wait_for_selector('h1:has-text("Clients")')
    ok('mobile : pas de debordement horizontal de la page', mp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
    mp.screenshot(path='/tmp/shots/p5-04-mobile.png'); m.close()

    # --- Lecture seule
    ro = b.new_context(viewport={'width': 1366, 'height': 800}); rp = ro.new_page(); login(rp, ro_email)
    rp.goto(BASE + '/clients'); rp.wait_for_selector('h1:has-text("Clients")'); rp.wait_for_selector('tbody tr')
    ok('lecture seule : pas de bouton Nouveau/Importer/Modifier/Supprimer',
       rp.locator('button:has-text("Nouveau")').count() == 0 and rp.locator('button:has-text("Importer")').count() == 0 and rp.locator('button[aria-label^="Modifier"]').count() == 0 and rp.locator('button[aria-label^="Supprimer"]').count() == 0)
    ok('lecture seule : export autorise', rp.locator('button:has-text("Exporter")').count() == 1)
    rp.goto(BASE + '/settings/taxes'); rp.wait_for_selector('h1:has-text("Taux de TVA")')
    ok('lecture seule : taux sans actions', rp.locator('button:has-text("Nouveau taux")').count() == 0)
    ro.close()

    ok('aucune erreur JS console', not errors, str(errors[:3]))
    b.close()

fails = [n for n, c in results if not c]
print(f'\n{len(results)-len(fails)}/{len(results)} OK'); 
if fails: print('ECHECS :', fails)
