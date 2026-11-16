# Test navigateur : inscription -> essai gratuit de 14 jours + tarifs 56 / 560 TND dans « Mon abonnement ».
# python3 docs/e2e/phase9_pricing_trial_test.py   (API :4000 + client Vite :5173, base migrée jusqu'à 016)
import time
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:5173'; stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'
res = []
def ok(n, c, extra=''): res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n, extra)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1280, 'height': 900}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(BASE + '/register')
    ok("page d'inscription annonce l'essai gratuit", 'Essai gratuit' in pg.inner_text('body'))
    pg.fill('input[name=companyName]', f'Essai {stamp}'); pg.fill('input[name=fullName]', 'Hedi Mami')
    pg.fill('input[name=email]', f'essai{stamp}@test.mhfac'); pg.fill('input[name=password]', PW); pg.fill('input[name=confirm]', PW)
    pg.click('button[type=submit]'); pg.wait_for_selector('text=Tableau de bord', timeout=15000)
    pg.goto(BASE + '/subscription'); pg.wait_for_selector('text=Mon abonnement'); pg.wait_for_selector('text=Offres disponibles')
    t = pg.inner_text('body')
    ok('bannière essai : 14 jours restants', 'Essai gratuit : il vous reste' in t and '14 jours' in t)
    ok('badge Période d\'essai', "Période d'essai" in t)
    ok('prix mensuel 56 TND', '56 TND / mois' in t.replace(' ', ' ').replace('\xa0', ' '))
    ok('prix annuel 560 TND et 2 mois offerts', '560 TND / an' in t.replace(' ', ' ').replace('\xa0', ' ') and '2 mois offerts' in t)
    ok('autres offres « Sur demande »', 'Sur demande' in t)
    pg.screenshot(path='/tmp/claude-0/pricing.png', full_page=True)
    ok('aucune erreur JS', not errs, errs); b.close()
print(f'{sum(res)}/{len(res)} OK')
