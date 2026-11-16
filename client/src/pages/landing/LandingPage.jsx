// Page d'accueil publique de MHFac (visiteurs non connectés). Mêmes sections et même charte que la maquette initiale :
// mêmes sections et même charte, mais les offres et les prix viennent de l'API (GET /api/v1/public/plans) pour rester identiques
// à ce que l'administrateur configure ; le contenu statique ci-dessous n'est qu'un repli si l'API ne répond pas.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText, Receipt, ShoppingCart, Boxes, Wallet, Landmark, ShieldCheck,
  Users, BarChart3, ScanLine, Percent, Monitor, Smartphone, Tablet, Check, X, ArrowRight, Sparkles, MessageCircle, Plus, Menu,
} from 'lucide-react';
import { usePublicPlans } from './plans.js';
import Carousel from './Carousel.jsx';

const SLIDES = [
  { src: "/landing/app-tableau-de-bord.jpg", title: "Tableau de bord", text: "Chiffre d'affaires, encaissements, impayés et alertes de stock, calculés côté serveur.", alt: "Tableau de bord MHFac : chiffre d'affaires, encaissements, factures impayées et soldes (données de démonstration)" },
  { src: "/landing/app-facture-detail.jpg", title: "Facture détaillée", text: "TVA, timbre fiscal, règlement, retenue à la source et avoir depuis la même fiche.", alt: "Fiche d'une facture de vente dans MHFac avec totaux, règlement et avoir (données de démonstration)" },
  { src: "/landing/app-paiements.jpg", title: "Paiements clients", text: "Espèces, virements, chèques et traites rattachés aux factures, annulables avec traçabilité.", alt: "Liste des règlements clients dans MHFac (données de démonstration)" },
  { src: "/landing/app-achats.jpg", title: "Factures d'achat", text: "Suivez ce que vous devez à vos fournisseurs et les échéances en retard.", alt: "Liste des factures d'achat fournisseurs dans MHFac (données de démonstration)" },
];

const wa = (msg) => "https://wa.me/21658146177?text=" + encodeURIComponent(msg);
const CONTACT = wa("Bonjour, je souhaite en savoir plus sur MHFac");
const DEMO = wa("Bonjour, je souhaite obtenir une démonstration gratuite de MHFac");

const compare = [
  ["Devis convertis en factures en un clic", "Ressaisie manuelle", "Automatique"],
  ["TVA et retenue à la source tunisiennes", "Formules à maintenir", "Intégrées"],
  ["Stock mis à jour à chaque vente ou achat", "Mise à jour à la main", "En temps réel"],
  ["Suivi des paiements, chèques et traites", "Fichiers dispersés", "Centralisé"],
  ["Accès multi-utilisateurs avec rôles", "Fichier partagé sans contrôle", "Rôles et permissions"],
  ["Accès depuis mobile et tablette", "Limité", "100% web"],
  ["Rapports et exports PDF, Excel, CSV", "À construire soi-même", "Prêts à l'emploi"],
];

const faq = [
  { g: "Sécurité et protection des données", q: [
    ["Mes données professionnelles sont-elles sécurisées ?", "Oui. MHFac met en œuvre des mesures de sécurité pour protéger vos informations professionnelles. Chaque entreprise dispose d'un espace de données isolé afin de garantir la confidentialité de ses informations."],
    ["Qui peut accéder aux données de mon entreprise ?", "Seuls les utilisateurs autorisés peuvent accéder aux informations de votre entreprise. MHFac propose une gestion des rôles et des permissions permettant de contrôler les accès selon les responsabilités de chaque utilisateur."],
    ["Mes données sont-elles chiffrées ?", "Les échanges entre votre navigateur et la plateforme sont chiffrés (HTTPS) et les mots de passe sont stockés sous forme hachée, jamais en clair."],
    ["L'accès à mon compte est-il sécurisé ?", "Oui. L'accès est protégé par identifiant et mot de passe, avec verrouillage temporaire après des tentatives répétées et sessions sécurisées. Chaque action sensible est journalisée."],
  ]},
  { g: "Sauvegardes et récupération des données", q: [
    ["Mes données sont-elles sauvegardées automatiquement ?", "MHFac fournit des outils de sauvegarde et de restauration de la base de données, utilisés par MH Digital Solution pour l'exploitation de la plateforme. Contactez-nous pour connaître les modalités applicables à votre offre."],
    ["Que se passe-t-il si je perds mes données ou si un incident survient ?", "MHFac dispose de mécanismes de restauration permettant de récupérer les données à partir des sauvegardes disponibles, selon la nature de l'incident."],
    ["Puis-je récupérer mes données après une suppression accidentelle ?", "Contactez notre équipe d'assistance dès que possible. Nous étudierons les possibilités de récupération en fonction de la situation et des sauvegardes disponibles."],
  ]},
  { g: "Hébergement et disponibilité", q: [
    ["Où sont hébergées mes données ?", "MHFac repose sur une infrastructure d'hébergement destinée à assurer le fonctionnement et la protection de la plateforme ainsi que de vos données professionnelles."],
    ["MHFac est-il accessible à tout moment ?", "MHFac est conçu pour offrir une disponibilité continue. La plateforme dépend néanmoins de la maintenance technique et des éventuels incidents affectant l'infrastructure ou les connexions Internet."],
    ["Que faire si je rencontre un problème de connexion ?", "Vérifiez votre connexion Internet et réessayez. Si le problème persiste, contactez notre équipe d'assistance afin d'obtenir de l'aide."],
  ]},
  { g: "Assistance et accompagnement", q: [
    ["Comment contacter l'assistance MHFac ?", "Notre équipe est disponible pour vous accompagner dans l'utilisation de MHFac, répondre à vos questions et vous aider en cas de difficulté technique."],
    ["Proposez-vous une assistance en cas de problème technique ?", "Oui. Notre équipe peut vous accompagner dans l'identification et la résolution des problèmes techniques liés à l'utilisation de la plateforme."],
    ["Est-il possible de bénéficier d'une formation ?", "Oui. Un accompagnement à la prise en main de MHFac peut vous aider à maîtriser les différentes fonctionnalités : ventes, achats, facturation, trésorerie, gestion des clients, fournisseurs et stocks."],
    ["Puis-je utiliser MHFac sur plusieurs appareils ?", "MHFac est accessible depuis un navigateur Internet. Vous pouvez ainsi consulter votre espace professionnel depuis les appareils compatibles disposant d'une connexion Internet."],
  ]},
  { g: "Abonnement et utilisation", q: [
    ["Mes données sont-elles conservées si mon abonnement expire ?", "À la fin de l'essai ou de la période payée, l'application passe en lecture seule : vos données restent consultables et exportables, et tout est réactivé dès la confirmation de votre paiement."],
    ["MHFac convient-il aux petites et moyennes entreprises ?", "Oui. MHFac est conçu pour accompagner les commerçants, entrepreneurs et PME dans la gestion quotidienne de leur activité, en centralisant leurs opérations commerciales et administratives au sein d'une seule plateforme."],
    ["Comment payer mon abonnement ?", "Par virement bancaire : après l'essai gratuit de 14 jours, vous voyez nos coordonnées bancaires et le montant dans l'application, effectuez le virement puis le déclarez. L'abonnement est activé après vérification de la réception du virement. Aucun paiement en ligne n'est demandé."],
    ["La facturation électronique est-elle disponible ?", "Pas encore : ce module sera disponible bientôt. En attendant, MHFac émet des factures numérotées et figées, imprimables en PDF, que vous pouvez utiliser dans votre procédure habituelle."],
    ["Puis-je obtenir une démonstration avant de m'abonner ?", "Vous pouvez créer votre entreprise et essayer MHFac gratuitement pendant 14 jours, ou contacter notre équipe sur WhatsApp pour une démonstration en direct."],
  ]},
];

const features = [
  { icon: FileText, t: "Devis", d: "Créez, envoyez et suivez l'acceptation, puis convertissez en facture en un clic." },
  { icon: Receipt, t: "Factures & avoirs", d: "Numérotation automatique, TVA tunisienne, timbre fiscal et avoirs liés à la facture d'origine." },
  { icon: ShoppingCart, t: "Achats & fournisseurs", d: "Commandes, factures fournisseurs et scan automatique des documents." },
  { icon: Boxes, t: "Stock multi-entrepôts", d: "Inventaire, bons d'entrée, de prélèvement et de transfert, fiches d'inventaire." },
  { icon: Wallet, t: "Paiements & trésorerie", d: "Comptes, transactions, chèques et traites suivis en temps réel." },
  { icon: Percent, t: "Retenue à la source", d: "RS ventes et achats gérées nativement, y compris la retenue enregistrée après émission." },
  { icon: Landmark, t: "Facturation électronique", d: "Module en préparation, bientôt disponible." },
  { icon: BarChart3, t: "Rapports & exports", d: "Tableau de bord, statistiques et exports CSV, Excel, PDF." },
];

const FALLBACK_PLANS = [
  { n: "Découverte", priced: false, cur: "TND", s: "Pour essayer MHFac", p: "Sur demande", y: null, f: [["1 utilisateur", 1], ["10 factures / mois", 1], ["1 entrepôt", 1], ["5 scans de factures / mois", 1], ["Scan de factures fournisseur", 1], ["Facturation électronique (bientôt)", 0], ["Export des rapports", 0]] },
  { n: "Auto-entrepreneur", priced: true, cur: "TND", s: "Pour une activité individuelle", p: "31", y: "310 TND / an (2 mois offerts)", f: [["1 utilisateur", 1], ["50 factures / mois", 1], ["1 entrepôt", 1], ["30 scans de factures / mois", 1], ["Scan de factures fournisseur", 1], ["Export des rapports (CSV, Excel, PDF)", 1], ["Facturation électronique (bientôt)", 0]] },
  { n: "Pro", priced: true, cur: "TND", s: "L'offre standard MHFac", p: "56", y: "560 TND / an (2 mois offerts)", hot: true, f: [["5 utilisateurs", 1], ["300 factures / mois", 1], ["3 entrepôts", 1], ["150 scans de factures / mois", 1], ["Facturation électronique (bientôt)", 0], ["Scan de factures fournisseur", 1], ["Export des rapports (CSV, Excel, PDF)", 1]] },
  { n: "Business", priced: true, cur: "TND", s: "Pour une entreprise multi-utilisateurs", p: "129", y: "1 290 TND / an (2 mois offerts)", f: [["25 utilisateurs", 1], ["Factures illimitées", 1], ["10 entrepôts", 1], ["1 000 scans de factures / mois", 1], ["Exports illimités", 1], ["Facturation électronique (bientôt)", 0], ["Scan de factures fournisseur", 1]] },
];

function Logo({ light }) {
  return (
    <a href="#" className="flex items-center gap-2.5">
      <span className="grid size-9 place-items-center rounded-xl bg-lp-brand text-white shadow-lp-glow"><FileText className="size-5" /></span>
      <span className="leading-none">
        <span className={`block text-lg font-extrabold ${light ? "text-lp-ink-fg" : "text-lp-fg"}`}>MH<span className="font-medium text-lp-primary">Fac</span></span>
        <span className={`block whitespace-nowrap text-[9px] font-semibold tracking-[0.12em] sm:text-[10px] sm:tracking-[0.2em] ${light ? "text-lp-ink-muted" : "text-lp-muted-fg"}`}>MH DIGITAL SOLUTION</span>
      </span>
    </a>
  );
}

function Cta({ children, href = "#offres", ghost }) {
  return ghost ? (
    <a href={href} className="inline-flex items-center gap-2 rounded-full border border-lp-ink-fg/20 px-6 py-3.5 font-semibold text-lp-ink-fg transition hover:bg-lp-ink-fg/10">{children}</a>
  ) : (
    <a href={href} className="inline-flex items-center gap-2 rounded-full bg-lp-brand px-6 py-3.5 font-bold text-white shadow-lp-glow transition hover:-translate-y-0.5">{children}</a>
  );
}

export default function LandingPage() {
  const [menu, setMenu] = useState(false);
  const apiPlans = usePublicPlans();
  const plans = apiPlans ?? FALLBACK_PLANS;
  useEffect(() => { if (!menu) return undefined; const k = (e) => { if (e.key === 'Escape') setMenu(false); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [menu]);
  useEffect(() => {
    const el = document.createElement('script'); el.type = 'application/ld+json'; el.id = 'ld-faq';
    el.text = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.flatMap((g) => g.q.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } }))) });
    document.head.appendChild(el); return () => el.remove();
  }, []);
  useEffect(() => { const t = document.title; document.title = "MHFac — Logiciel de facturation et gestion commerciale pour la Tunisie"; return () => { document.title = t; }; }, []);
  return (
    <div className="min-h-screen bg-lp-bg">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-lp-ink-fg/10 bg-lp-ink/85 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <Logo light />
          <nav className="hidden gap-8 text-sm font-semibold text-lp-ink-muted md:flex">
            <a href="#fonctionnalites" className="hover:text-lp-primary">Fonctionnalités</a>
            <a href="#apercu" className="hover:text-lp-primary">Aperçu</a>
            <a href="#securite" className="hover:text-lp-primary">Sécurité</a>
            <a href="#comparatif" className="hover:text-lp-primary">Comparatif</a>
            <a href="#offres" className="hover:text-lp-primary">Offres</a>
            <a href="#faq" className="hover:text-lp-primary">FAQ</a>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <Link to="/login" className="hidden text-sm font-semibold text-lp-ink-muted hover:text-lp-primary sm:inline">Se connecter</Link>
            <Link to="/register" className="whitespace-nowrap rounded-full bg-lp-brand px-4 py-2 text-sm font-bold text-white sm:px-5 sm:py-2.5">Essai gratuit</Link>
            <button type="button" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-controls="menu-mobile" aria-label={menu ? 'Fermer le menu' : 'Ouvrir le menu'}
              className="grid size-10 place-items-center rounded-lg border border-lp-ink-fg/15 text-lp-ink-fg md:hidden">{menu ? <X className="size-5" /> : <Menu className="size-5" />}</button>
          </div>
        </div>
        {menu && (
          <nav id="menu-mobile" aria-label="Menu principal" className="border-t border-lp-ink-fg/10 bg-lp-ink px-4 pb-5 pt-3 md:hidden">
            <ul className="flex flex-col text-base font-semibold text-lp-ink-fg">
              {[["#fonctionnalites", "Fonctionnalités"], ["#apercu", "Aperçu"], ["#securite", "Sécurité"], ["#comparatif", "Comparatif"], ["#offres", "Offres"], ["#faq", "FAQ"]].map(([h, l]) => (
                <li key={h}><a href={h} onClick={() => setMenu(false)} className="block rounded-lg px-3 py-3 hover:bg-lp-ink-fg/5 hover:text-lp-primary">{l}</a></li>
              ))}
              <li className="mt-2 border-t border-lp-ink-fg/10 pt-3"><Link to="/login" className="block rounded-lg px-3 py-3 text-lp-ink-muted hover:text-lp-primary">Se connecter</Link></li>
            </ul>
          </nav>
        )}
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden bg-lp-hero text-lp-ink-fg">
        <div className="lp-grid-lines absolute inset-0" />
        <div className="relative mx-auto max-w-7xl px-6 pb-24 pt-20 lg:pt-28">
          <div className="mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-lp-ink-fg/15 bg-lp-ink-fg/5 px-4 py-1.5 text-sm font-semibold">
              <Sparkles className="size-4 text-lp-primary" /> 100% web · Ordinateur, mobile et tablette
            </span>
            <h1 className="mt-7 font-lp-display text-5xl leading-[1.05] md:text-7xl">
              La facturation et la gestion commerciale, <em className="text-lp-primary">pensées pour la Tunisie.</em>
            </h1>
            <p className="mx-auto mt-6 max-w-2xl text-lg text-lp-ink-muted">
              Devis, factures, avoirs, achats, stock, paiements et trésorerie réunis dans un seul outil simple, sécurisé et adapté à la fiscalité tunisienne (TVA, timbre fiscal, retenue à la source).
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-4">
              <Link to="/register" className="inline-flex items-center gap-2 rounded-full bg-lp-brand px-6 py-3.5 font-bold text-white shadow-lp-glow transition hover:-translate-y-0.5">Essayer gratuitement 14 jours <ArrowRight className="size-4" /></Link>
              <Cta href={DEMO} ghost><MessageCircle className="size-4" /> Demander une démo</Cta>
            </div>
            <p className="mt-4 text-sm text-lp-ink-muted">Sans carte bancaire · Paiement par virement après l'essai</p>
          </div>

          <div className="relative mx-auto mt-16 max-w-5xl">
            <div className="overflow-hidden rounded-2xl border border-lp-ink-fg/15 bg-lp-card shadow-lp-float">
              <div className="flex gap-1.5 border-b border-lp-border bg-lp-muted px-4 py-3">
                <span className="size-3 rounded-full bg-lp-destructive/70" /><span className="size-3 rounded-full bg-lp-primary/70" /><span className="size-3 rounded-full bg-lp-green/70" />
              </div>
              <img src={"/landing/app-factures.jpg"} alt="Liste des factures dans MHFac (données de démonstration)" width="1600" height="1000" fetchpriority="high" className="w-full" />
            </div>
            <div className="animate-lp-floaty absolute -left-6 top-1/3 hidden rounded-2xl bg-lp-card p-4 text-lp-fg shadow-lp-float md:block">
              <p className="text-xs font-semibold text-lp-muted-fg">Devis → facture</p>
              <p className="mt-1 text-lg font-extrabold">en un clic <span className="text-sm text-lp-primary">TVA et timbre inclus</span></p>
            </div>
            <div className="animate-lp-floaty absolute -right-6 bottom-12 hidden rounded-2xl bg-lp-card p-4 text-lp-fg shadow-lp-float [animation-delay:1.5s] md:block">
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-xl bg-lp-accent text-lp-accent-fg"><ShieldCheck className="size-5" /></span>
                <div><p className="text-sm font-bold">Données isolées</p><p className="text-xs text-lp-muted-fg">par entreprise</p></div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Pillars */}
      <section className="mx-auto max-w-7xl px-6 py-24">
        <div className="grid gap-6 md:grid-cols-3">
          {[
            { i: Receipt, t: "Devis, factures et avoirs", d: "Pour les entreprises tunisiennes : TVA, timbre fiscal, retenue à la source et numérotation automatique." },
            { i: Wallet, t: "Achats, stock, paiements et trésorerie", d: "Toute votre activité commerciale au même endroit, sans tableurs ni ressaisie." },
            { i: ShieldCheck, t: "Rôles et permissions", d: "Données isolées par entreprise, accès contrôlés pour chaque collaborateur." },
          ].map(({ i: I, t, d }) => (
            <div key={t} className="rounded-3xl border border-lp-border bg-lp-card p-8 transition hover:-translate-y-1 hover:shadow-lp-glow">
              <span className="grid size-12 place-items-center rounded-2xl bg-lp-brand text-white"><I className="size-6" /></span>
              <h3 className="mt-6 font-lp-display text-2xl">{t}</h3>
              <p className="mt-3 text-lp-muted-fg">{d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="fonctionnalites" className="bg-lp-muted py-24">
        <div className="mx-auto max-w-7xl px-6">
          <div className="max-w-2xl">
            <p className="text-sm font-bold uppercase tracking-widest text-lp-primary">Fonctionnalités</p>
            <h2 className="mt-3 font-lp-display text-4xl md:text-5xl">Tout ce qu'il faut pour piloter votre commerce.</h2>
          </div>
          <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {features.map(({ icon: I, t, d }) => (
              <div key={t} className="rounded-2xl bg-lp-card p-6">
                <I className="size-6 text-lp-primary" />
                <h3 className="mt-4 font-bold">{t}</h3>
                <p className="mt-2 text-sm text-lp-muted-fg">{d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Aperçu : carrousel */}
      <section id="apercu" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24">
        <div className="mx-auto mb-10 max-w-2xl text-center">
          <p className="text-sm font-bold uppercase tracking-widest text-lp-primary">Aperçu</p>
          <h2 className="mt-3 font-lp-display text-3xl sm:text-4xl">L'application en images.</h2>
          <p className="mt-3 text-lp-muted-fg">Captures réalisées avec des données de démonstration fictives.</p>
        </div>
        <Carousel slides={SLIDES} />
      </section>

      {/* Stock showcase */}
      <section className="mx-auto grid max-w-7xl items-center gap-14 px-6 py-24 lg:grid-cols-2">
        <div>
          <p className="text-sm font-bold uppercase tracking-widest text-lp-primary">Stock & données</p>
          <h2 className="mt-3 font-lp-display text-4xl md:text-5xl">Clients, articles et entrepôts toujours à jour.</h2>
          <ul className="mt-8 space-y-4">
            {["Mouvements de stock tracés automatiquement", "Bons d'entrée, de prélèvement et de transfert", "Fiches d'inventaire et gestion multi-entrepôts", "Suivi par projet et fiches clients / fournisseurs"].map((x) => (
              <li key={x} className="flex gap-3"><span className="grid size-6 shrink-0 place-items-center rounded-full bg-lp-accent text-lp-accent-fg"><Check className="size-4" /></span>{x}</li>
            ))}
          </ul>
        </div>
        <div className="overflow-hidden rounded-2xl border border-lp-border shadow-lp-float">
          <img src={"/landing/app-articles.jpg"} alt="Articles, clients, fournisseurs et stock dans MHFac (données de démonstration)" className="w-full" loading="lazy" />
        </div>
      </section>

      {/* Devices + security */}
      <section id="securite" className="relative overflow-hidden bg-lp-hero py-24 text-lp-ink-fg">
        <div className="lp-grid-lines absolute inset-0" />
        <div className="relative mx-auto grid max-w-7xl gap-6 px-6 md:grid-cols-2">
          <div className="rounded-3xl border border-lp-ink-fg/10 bg-lp-ink-fg/5 p-10">
            <div className="flex gap-4 text-lp-primary"><Monitor className="size-8" /><Tablet className="size-8" /><Smartphone className="size-8" /></div>
            <h3 className="mt-6 font-lp-display text-3xl">100% web, partout.</h3>
            <p className="mt-3 text-lp-ink-muted">Aucune installation. Facturez depuis votre bureau, en déplacement ou chez le client, sur ordinateur, tablette ou mobile.</p>
          </div>
          <div className="rounded-3xl border border-lp-ink-fg/10 bg-lp-ink-fg/5 p-10">
            <div className="flex gap-4 text-lp-primary"><ShieldCheck className="size-8" /><Users className="size-8" /><ScanLine className="size-8" /></div>
            <h3 className="mt-6 font-lp-display text-3xl">Sécurisé par conception.</h3>
            <p className="mt-3 text-lp-ink-muted">Chaque entreprise dispose de données isolées. Définissez des rôles et permissions précis pour chaque utilisateur.</p>
          </div>
        </div>
      </section>

      {/* Comparison */}
      <section id="comparatif" className="mx-auto max-w-5xl px-6 py-24">
        <div className="text-center">
          <p className="text-sm font-bold uppercase tracking-widest text-lp-primary">Comparatif</p>
          <h2 className="mt-3 font-lp-display text-4xl md:text-5xl">Fini Excel et les carnets de factures.</h2>
        </div>
        <div className="mt-12 overflow-x-auto rounded-3xl border border-lp-border bg-lp-card">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead><tr className="border-b border-lp-border">
              <th className="p-5 font-semibold text-lp-muted-fg"></th>
              <th className="p-5 font-semibold text-lp-muted-fg">Excel / méthodes manuelles</th>
              <th className="bg-lp-ink p-5 font-bold text-lp-ink-fg">MHFac</th>
            </tr></thead>
            <tbody>{compare.map(([f, a, b]) => (
              <tr key={f} className="border-b border-lp-border last:border-0">
                <td className="p-5 font-semibold">{f}</td>
                <td className="p-5 text-lp-muted-fg"><span className="inline-flex items-center gap-2"><X className="size-4 text-lp-destructive" />{a}</span></td>
                <td className="bg-lp-accent/40 p-5 font-semibold"><span className="inline-flex items-center gap-2"><Check className="size-4 text-lp-primary" />{b}</span></td>
              </tr>))}
            </tbody>
          </table>
        </div>
        <div className="mt-10 flex justify-center"><a href={DEMO} className="inline-flex items-center gap-2 rounded-full bg-lp-brand px-6 py-3.5 font-bold text-white shadow-lp-glow transition hover:-translate-y-0.5"><MessageCircle className="size-4" /> Voir la différence en démo</a></div>
      </section>

      {/* Pricing */}
      <section id="offres" className="mx-auto max-w-7xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <p className="text-sm font-bold uppercase tracking-widest text-lp-primary">Offres</p>
          <h2 className="mt-3 font-lp-display text-4xl md:text-5xl">Un tarif adapté à chaque étape.</h2>
          <p className="mt-4 text-lp-muted-fg">Essai gratuit de 14 jours, sans carte bancaire. Paiement par virement bancaire ; votre abonnement est activé après vérification du virement. Paiement annuel : mois offerts selon l'offre.</p>
        </div>
        <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {plans.map((pl) => {
            const hot = !!pl.hot;
            return (
              <div key={pl.code ?? pl.n} className={`relative flex flex-col rounded-3xl p-7 ${hot ? "bg-lp-ink text-lp-ink-fg shadow-lp-glow" : "border border-lp-border bg-lp-card"}`}>
                {hot && <span className="absolute -top-3 left-7 rounded-full bg-lp-brand px-3 py-1 text-xs font-bold text-white">Le plus choisi</span>}
                <h3 className="font-lp-display text-2xl">{pl.n}</h3>
                <p className={`text-sm ${hot ? "text-lp-ink-muted" : "text-lp-muted-fg"}`}>{pl.s}</p>
                <div className="mt-6">
                  {pl.priced ? <p><span className="text-4xl font-extrabold">{pl.p}</span> <span className="font-semibold">{pl.cur} / mois</span></p> : <p className="text-3xl font-extrabold">{pl.p}</p>}
                  <p className={`mt-1 h-5 text-xs ${hot ? "text-lp-ink-muted" : "text-lp-muted-fg"}`}>{pl.y}</p>
                </div>
                <ul className="mt-6 flex-1 space-y-3 text-sm">
                  {pl.f.map(([x, ok]) => (
                    <li key={x} className={`flex gap-2 ${ok ? "" : "line-through opacity-50"}`}>
                      {ok ? <Check className="size-4 shrink-0 text-lp-primary" /> : <X className="size-4 shrink-0" />}{x}
                    </li>
                  ))}
                </ul>
                {pl.priced ? (
                  <Link to="/register" className={`mt-8 rounded-full py-3 text-center font-bold transition ${hot ? "bg-lp-brand text-white" : "border border-lp-border hover:border-lp-primary hover:text-lp-primary"}`}>Essayer 14 jours</Link>
                ) : (
                  <a href={wa(`Bonjour, je suis intéressé(e) par le pack ${pl.n} de MHFac`)} className="mt-8 rounded-full border border-lp-border py-3 text-center font-bold transition hover:border-lp-primary hover:text-lp-primary">Nous contacter</a>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="bg-lp-muted py-24">
        <div className="mx-auto max-w-4xl px-6">
          <div className="text-center">
            <p className="text-sm font-bold uppercase tracking-widest text-lp-primary">FAQ</p>
            <h2 className="mt-3 font-lp-display text-4xl md:text-5xl">Vos questions, nos réponses.</h2>
          </div>
          <div className="mt-12 space-y-10">
            {faq.map((g) => (
              <div key={g.g}>
                <h3 className="font-lp-display text-2xl">{g.g}</h3>
                <div className="mt-4 space-y-3">
                  {g.q.map(([q, a]) => (
                    <details key={q} className="group rounded-2xl bg-lp-card p-5 open:shadow-lp-glow">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-semibold">
                        {q}<Plus className="size-5 shrink-0 text-lp-primary transition group-open:rotate-45" />
                      </summary>
                      <p className="mt-3 text-lp-muted-fg">{a}</p>
                    </details>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="h-24" />
      {/* Final CTA */}
      <section className="px-6 pb-24">
        <div className="relative mx-auto max-w-6xl overflow-hidden rounded-[2rem] bg-lp-hero px-8 py-16 text-center text-lp-ink-fg">
          <div className="lp-grid-lines absolute inset-0" />
          <div className="relative">
            <h2 className="font-lp-display text-4xl md:text-5xl">Voyez MHFac en action, avec vos propres cas.</h2>
            <p className="mx-auto mt-4 max-w-xl text-lp-ink-muted">Un conseiller vous présente MHFac en direct et vous aide à choisir la formule adaptée. Rejoignez les entreprises tunisiennes qui gèrent leur activité avec MHFac.</p>
            <div className="mt-8 flex flex-wrap justify-center gap-4"><Link to="/register" className="inline-flex items-center gap-2 rounded-full bg-lp-brand px-6 py-3.5 font-bold text-white shadow-lp-glow transition hover:-translate-y-0.5">Essayer gratuitement 14 jours</Link><Cta href={DEMO} ghost><MessageCircle className="size-4" /> Réserver ma démo sur WhatsApp</Cta></div>
            <p className="mt-5 text-sm text-lp-ink-muted">Démo gratuite et sans engagement · +216 58 146 177</p>
          </div>
        </div>
      </section>

      <footer className="border-t border-lp-border py-10">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-6 md:flex-row">
          <Logo />
          <div className="flex flex-wrap items-center gap-5 text-sm text-lp-muted-fg"><Link className="hover:text-lp-primary" to="/login">Se connecter</Link><Link className="hover:text-lp-primary" to="/register">Créer mon entreprise</Link><span>© 2026 MH Digital Solution · Tunisie</span></div>
        </div>
      </footer>
      <a href={DEMO} aria-label="Demander une démo sur WhatsApp" className="fixed bottom-5 right-5 z-50 inline-flex items-center gap-2 rounded-full bg-lp-brand px-5 py-3.5 font-bold text-white shadow-lp-glow transition hover:-translate-y-0.5">
        <MessageCircle className="size-5" /><span className="hidden sm:inline">Démo gratuite</span>
      </a>
    </div>
  );
}
