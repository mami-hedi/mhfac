# Test navigateur : Paramètres > Logo et couleur. Le logo s'enregistre dès qu'il est choisi (sans autre bouton), même gros, et n'est jamais effacé par l'autre formulaire.
# python3 docs/e2e/phase9_logo_test.py   (API :4000 + client Vite :5173 ; fichiers de test générés par le script ci-dessous si absents)
import os, random, time, requests
from playwright.sync_api import sync_playwright
from PIL import Image
D = '/tmp/claude-0/logo'; os.makedirs(D, exist_ok=True)
if not os.path.exists(f'{D}/gros.png'):
    random.seed(7); w, h = 1800, 900
    im = Image.frombytes('RGB', (w, h), bytes(random.getrandbits(8) for _ in range(w * h * 3))); im.save(f'{D}/gros.png'); im.save(f'{D}/gros.jpg', quality=95)
    Image.new('RGBA', (300, 120), (220, 30, 30, 255)).save(f'{D}/rouge.webp'); open(f'{D}/faux.png', 'wb').write(b'<html>pas une image</html>')
BASE = 'http://localhost:5173'; API = 'http://localhost:4000/api/v1'; stamp = str(int(time.time())); PW = 'Zebre-Violet-2026'; email = f'logo{stamp}@test.mhfac'
res = []
def ok(n, c, extra=''): res.append(bool(c)); print(('PASS ' if c else 'FAIL ') + n, extra)
requests.post(f'{API}/auth/register-company', json={'companyName': f'Logo {stamp}', 'fullName': 'Hedi', 'email': email, 'password': PW})
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1366, 'height': 1000}); errs = []; sizes = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('request', lambda r: sizes.append(len(r.post_data or '')) if r.method == 'PATCH' and '/settings' in r.url else None)
    pg.goto(BASE + '/login'); pg.fill('input[name=email]', email); pg.fill('input[name=password]', PW); pg.click('button[type=submit]'); pg.wait_for_selector('text=Bonjour')
    pg.goto(BASE + '/settings'); pg.wait_for_selector('text=Logo et couleur')
    logo = lambda: pg.locator('img[alt=Logo]').count()
    ok('départ : aucun logo', logo() == 0)
    pg.set_input_files('input[aria-label="Fichier logo"]', f'{D}/gros.png'); pg.wait_for_selector('text=Logo enregistré')
    ok('gros PNG (≈ 4,8 Mo) accepté et enregistré sans autre bouton', logo() == 1, f'envoi : {sizes[-1] // 1024} Ko')
    ok('image réduite avant envoi (< 400 Ko)', sizes[-1] < 400_000)
    pg.reload(); pg.wait_for_selector('text=Logo et couleur'); ok('présent après rechargement', logo() == 1)
    # l'autre formulaire ne l'efface pas
    pg.fill('input[type=number] >> nth=0', '25'); pg.click('button:has-text("Enregistrer les paramètres de facturation")'); pg.wait_for_selector('text=Paramètres de facturation enregistrés')
    pg.reload(); pg.wait_for_selector('text=Logo et couleur'); ok('présent après enregistrement du formulaire fiscal', logo() == 1)
    pg.goto(BASE + '/clients'); pg.goto(BASE + '/settings'); pg.wait_for_selector('text=Logo et couleur'); ok('présent après navigation', logo() == 1)
    # couleur + modèle
    pg.locator('select:has(option[value=modern])').select_option('modern'); pg.click('button:has-text("Enregistrer la couleur et le modèle")'); pg.wait_for_selector('text=Couleur, modèle et langue enregistrés')
    pg.reload(); pg.wait_for_selector('text=Logo et couleur'); ok('modèle conservé, logo toujours là', pg.locator('select:has(option[value=modern])').input_value() == 'modern' and logo() == 1)
    # JPEG, WebP, faux fichier
    pg.set_input_files('input[aria-label="Fichier logo"]', f'{D}/gros.jpg'); pg.wait_for_selector('text=Logo enregistré'); ok('gros JPEG accepté', logo() == 1)
    pg.evaluate("document.querySelector('[role=alert]') && 0")
    pg.set_input_files('input[aria-label="Fichier logo"]', f'{D}/rouge.webp'); time.sleep(1.5); ok('WebP converti et accepté', logo() == 1 and pg.locator('img[alt=Logo]').get_attribute('src').startswith('data:image/png'))
    pg.set_input_files('input[aria-label="Fichier logo"]', f'{D}/faux.png'); pg.wait_for_selector('text=/illisible|non pris en charge/')
    ok('faux fichier refusé avec message VISIBLE dans la carte, logo précédent conservé', logo() == 1)
    pg.screenshot(path='/tmp/claude-0/logo/after.png', full_page=True)
    pg.click('button:has-text("Retirer")'); pg.wait_for_selector('text=Logo retiré'); pg.reload(); pg.wait_for_selector('text=Logo et couleur'); ok('retrait persistant', logo() == 0)
    ok('aucune erreur JS', not errs, errs); b.close()
print(f'{sum(res)}/{len(res)} OK')
