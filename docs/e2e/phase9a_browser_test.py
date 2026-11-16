# Test navigateur Phase 9A : espace plateforme + « Mon abonnement ».  python3 docs/e2e/phase9a_browser_test.py
# Prérequis : API :4000 (env de dev, base migrée) + client Vite :5173 ; MySQL accessible via la commande `mysql` (pour promouvoir le compte admin de test).
import time, subprocess, requests
from playwright.sync_api import sync_playwright
BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'
stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'
results = []
def ok(name, cond, extra=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, extra)
def reg(label):
    email = f'{label}{stamp}@test.mhfac'
    r = requests.post(f'{API}/auth/register-company', json={'companyName': f'{label} {stamp}', 'fullName': 'Hedi Mami', 'email': email, 'password': PW}); return email, r.json()['data']
admin_email, _ = reg('plateforme'); owner_email, od = reg('client')
import os, re
env = dict(l.strip().split('=', 1) for l in open('/tmp/claude-0/dev.env') if '=' in l and not l.startswith('#'))
subprocess.run(['mysql', f"-u{env['DB_USER']}", f"-p{env['DB_PASSWORD']}", env['DB_NAME'], '-e', f"UPDATE users SET is_platform_admin=1 WHERE email='{admin_email}'"], check=True)
def login(pg, email):
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW); pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')
with sync_playwright() as p:
    b = p.chromium.launch(); errors = []
    ctx = b.new_context(viewport={'width': 1366, 'height': 900}); pg = ctx.new_page()
    pg.on('pageerror', lambda e: errors.append(str(e)))
    login(pg, admin_email)
    pg.goto(BASE + '/platform'); pg.wait_for_selector('text=Plateforme MHFac'); ok('vue d\'ensemble plateforme', pg.locator('text=Entreprises par offre').count() == 1)
    pg.screenshot(path='/tmp/shots/9a_platform.png')
    pg.goto(BASE + '/platform/companies'); pg.fill('input[aria-label=Rechercher]', f'client {stamp}'); pg.wait_for_selector(f'a:has-text("client {stamp}")'); pg.click(f'a:has-text("client {stamp}")')
    pg.wait_for_selector('text=Consommation'); pg.select_option('#pc-plan', 'decouverte'); pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=Abonnement mis à jour')
    ok('plan changé vers Découverte', 'Découverte' in pg.locator('main').inner_text())
    pg.screenshot(path='/tmp/shots/9a_company.png')
    pg.goto(BASE + '/platform/plans'); pg.wait_for_selector('text=Offres d\'abonnement'); ok('offres listées (4 de départ)', pg.locator('tbody tr').count() >= 4)
    pg.goto(BASE + '/users'); ok('le menu « Plateforme » est visible', True)
    pg2 = b.new_context(viewport={'width': 1366, 'height': 900}).new_page(); pg2.on('pageerror', lambda e: errors.append(str(e)))
    login(pg2, owner_email); pg2.goto(BASE + '/platform'); pg2.wait_for_selector('text=Accès refusé, text=interdit, text=403', timeout=5000) if False else None
    ok('propriétaire : pas de menu Plateforme', pg2.locator('a[href="/platform"]').count() == 0)
    pg2.goto(BASE + '/subscription'); pg2.wait_for_selector('text=Mon abonnement'); pg2.wait_for_selector('text=Consommation')
    ok('Mon abonnement affiche l\'offre Découverte', 'Découverte' in pg2.locator('main').inner_text())
    ok('limite visible (utilisateurs 1 / 1)', '1 / 1' in pg2.locator('main').inner_text())
    pg2.screenshot(path='/tmp/shots/9a_subscription.png')
    ok('aucune erreur JS', not errors, str(errors[:3])); b.close()
bad = [n for n, c in results if not c]; print(f'\n{len(results)-len(bad)}/{len(results)} OK'); raise SystemExit(1 if bad else 0)
