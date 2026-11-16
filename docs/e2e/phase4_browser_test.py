import re, time, json
from playwright.sync_api import sync_playwright, expect

BASE='http://localhost:5173'
stamp=str(int(time.time()))
owner_email=f'owner{stamp}@test.mhfac'
inv_email=f'compta{stamp}@test.mhfac'
PW='Zebre-Violet-2026'
results=[]
def ok(name, cond, extra=''):
    results.append((name, bool(cond)))
    print(('PASS ' if cond else 'FAIL ')+name, extra)

def mail_token(email, kind):
    log=open('api.log').read()
    m=re.findall(r'\[mail:console\] A: '+re.escape(email)+r' \|.*?\\n|\[mail:console\] A: '+re.escape(email), log)
    # lire le texte complet du dernier mail pour cet email
    blocks=log.split('[mail:console] A: ')
    for b in reversed(blocks):
        if b.startswith(email) and kind in b:
            return re.search(r'token=([A-Za-z0-9_-]+)', b).group(1)

with sync_playwright() as p:
    b=p.chromium.launch()
    ctx=b.new_context(viewport={'width':1366,'height':800})
    pg=ctx.new_page()
    errors=[]
    pg.on('pageerror', lambda e: errors.append(str(e)))
    pg.on('console', lambda m: errors.append(m.text) if m.type=='error' and 'status of 401' not in m.text else None)

    # 1. anonyme -> redirige vers login
    pg.goto(BASE+'/users'); pg.wait_for_url('**/login')
    ok('route protegee redirige vers /login', '/login' in pg.url)
    pg.screenshot(path='/tmp/shots/01-login.png')

    # 2. validation client
    pg.click('button[type=submit]')
    ok('validation formulaire login', pg.locator('text=E-mail requis').count()==1)

    # 3. inscription
    pg.click('text=Créer mon entreprise'); pg.wait_for_url('**/register')
    pg.fill('input[name=companyName]','Société Démo SARL'); pg.fill('input[name=taxId]','1234567/A')
    pg.fill('input[name=fullName]','Hedi Mami'); pg.fill('input[name=email]',owner_email)
    pg.fill('input[name=password]','court'); pg.fill('input[name=confirm]','autre')
    pg.click('button[type=submit]')
    ok('validation mot de passe faible', pg.locator('text=Minimum 10 caractères').count()==1)
    pg.fill('input[name=password]',PW); pg.fill('input[name=confirm]',PW)
    pg.click('button[type=submit]')
    pg.wait_for_selector('text=Bonjour Hedi')
    ok('inscription -> tableau de bord', True)
    ok('banniere e-mail non verifie', pg.locator('text=pas encore vérifiée').count()==1)
    ok('KPI sans chiffre invente', pg.locator('text=Disponible en phase').count()>=8)
    ok('equipe reelle = 1 membre', pg.locator('text=membre actif').count()==1)
    pg.screenshot(path='/tmp/shots/02-dashboard.png')

    # 4. verification e-mail via lien
    tok=mail_token(owner_email,'verify-email')
    pg.goto(f'{BASE}/verify-email?token={tok}'); pg.wait_for_selector('text=est confirmée')
    ok('verification e-mail', True)
    pg.goto(BASE+'/'); pg.wait_for_selector('text=Bonjour Hedi')
    ok('session conservee apres rechargement (refresh cookie)', True)
    ok('banniere disparue apres verification', pg.locator('text=pas encore vérifiée').count()==0)

    # 5. navigation menu & module en developpement
    pg.click('aside >> text=Ventes'); pg.click('aside >> text=Factures')
    pg.wait_for_selector('text=Ce module n\'est pas encore disponible')
    ok('module en developpement clairement indique', pg.locator('text=En cours de développement').count()>=1)
    pg.screenshot(path='/tmp/shots/03-coming-soon.png')

    # 6. recherche globale (client) + menu rapide
    pg.goto(BASE+'/')
    pg.wait_for_selector('text=Bonjour Hedi')

    # 7. utilisateurs : inviter
    pg.click('aside >> text=Utilisateurs et rôles'); pg.wait_for_selector('h1:has-text("Utilisateurs et rôles")')
    pg.click('button:has-text("Inviter")')
    pg.fill('input[name=email]', inv_email); pg.select_option('select[name=roleCode]','accountant')
    pg.click('button:has-text("Envoyer l\'invitation")')
    pg.wait_for_selector('text=Invitation envoyée à')
    ok('invitation envoyee', pg.locator(f'li:has-text("{inv_email}")').count()==1)
    pg.screenshot(path='/tmp/shots/04-users.png')

    # 8. parametres entreprise
    pg.click('aside >> text=Paramètres'); pg.wait_for_selector('text=Informations de l\'entreprise')
    pg.fill('input[name=name]','Société Démo SARL (modifiée)')
    pg.click('button:has-text("Enregistrer")'); pg.wait_for_selector('text=Informations enregistrées')
    ok('parametres entreprise enregistres', True)
    pg.wait_for_selector('text=modifiée') ; 
    pg.screenshot(path='/tmp/shots/05-settings.png')

    # 9. mobile
    m=b.new_context(viewport={'width':390,'height':800}, storage_state=ctx.storage_state()).new_page()
    m.goto(BASE+'/'); m.wait_for_selector('text=Bonjour Hedi')
    bb=m.locator('aside').first.bounding_box(); sidebar_hidden = bb is None or bb['x']+bb['width']<=0
    ok('mobile : menu replie par defaut', sidebar_hidden)
    m.click('button[aria-label="Ouvrir le menu"]'); m.wait_for_timeout(500)
    bb=m.locator('aside').first.bounding_box()
    ok('mobile : menu ouvrable', bb and bb['x']>=0)
    m.screenshot(path='/tmp/shots/06-mobile-menu.png')
    scroll_ok = m.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    ok('mobile : pas de defilement horizontal', scroll_ok)

    # 10. deconnexion
    pg.goto(BASE+'/'); pg.wait_for_selector('text=Bonjour Hedi')
    pg.click('button[aria-label="Création rapide"]'); ok('creation rapide : entrees selon permissions', pg.locator('[role=menuitem]:has-text("Facture")').count()==1); pg.keyboard.press('Escape'); pg.click('h1')
    pg.click('button[aria-label="Profil"]'); pg.screenshot(path='/tmp/shots/09-profile-menu.png')
    pg.click('text=Se déconnecter'); pg.wait_for_url('**/login')
    ok('deconnexion', True)
    pg.goto(BASE+'/'); pg.wait_for_url('**/login')
    ok('apres deconnexion, acces refuse', True)

    # 11. acceptation d'invitation (comptable)
    ctx2=b.new_context(viewport={'width':1366,'height':800}); pg2=ctx2.new_page()
    itok=mail_token(inv_email,'accept-invitation')
    pg2.goto(f'{BASE}/accept-invitation?token={itok}')
    pg2.fill('input[name=fullName]','Sami Comptable'); pg2.fill('input[name=password]',PW)
    pg2.click('button[type=submit]'); pg2.wait_for_selector('text=Bonjour Sami')
    ok('invitation acceptee -> connecte', True)
    ok('comptable : pas de menu Utilisateurs', pg2.locator('aside >> text=Utilisateurs et rôles').count()==0)
    ok('comptable : pas de menu Paramètres', pg2.locator('aside >> text=Paramètres').count()==0)
    pg2.goto(BASE+'/users'); pg2.wait_for_selector('text=Accès non autorisé')
    ok('comptable : /users -> acces non autorise', True)
    pg2.goto(BASE+'/settings?tab=account'); pg2.wait_for_selector('text=Changer de mot de passe')
    ok('comptable : Mon compte accessible', True)
    pg2.screenshot(path='/tmp/shots/07-accountant-account.png')
    # changement de mot de passe -> deconnecte
    pg2.fill('input[name=currentPassword]',PW); pg2.fill('input[name=newPassword]','NouveauMdp2027'); pg2.fill('input[name=confirm]','NouveauMdp2027')
    pg2.click('button:has-text("Modifier le mot de passe")'); pg2.wait_for_url('**/login')
    ok('changement de mot de passe -> retour login avec message', pg2.locator('text=Mot de passe modifié').count()==1)
    pg2.fill('input[name=email]',inv_email); pg2.fill('input[name=password]','NouveauMdp2027'); pg2.click('button[type=submit]')
    pg2.wait_for_selector('text=Bonjour Sami'); ok('reconnexion avec le nouveau mot de passe', True)

    # 12. mauvais mot de passe
    ctx3=b.new_context(); pg3=ctx3.new_page(); pg3.goto(BASE+'/login')
    pg3.fill('input[name=email]',owner_email); pg3.fill('input[name=password]','Mauvais12345'); pg3.click('button[type=submit]')
    pg3.wait_for_selector('text=incorrect'); ok('mauvais mot de passe : message clair', True)
    pg3.click('text=Mot de passe oublié'); pg3.fill('input[name=email]',owner_email); pg3.click('button[type=submit]')
    pg3.wait_for_selector('text=un e-mail vient d'); ok('mot de passe oublie : message neutre', True)
    pg3.screenshot(path='/tmp/shots/08-forgot.png')

    ok('aucune erreur JS console', not errors, errors[:3])
    b.close()
fails=[n for n,c in results if not c]
print(f'\n{len(results)-len(fails)}/{len(results)} OK'); print('ECHECS:',fails)
