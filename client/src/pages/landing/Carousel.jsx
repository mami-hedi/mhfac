import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';

// Carrousel accessible : flèches, pastilles, balayage tactile, clavier (← →), défilement automatique
// mis en pause au survol / focus / bouton pause, et désactivé si l'utilisateur préfère réduire les animations.
export default function Carousel({ slides, label = 'Aperçu de l\'application', interval = 5000 }) {
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const touchX = useRef(null);
  const n = slides.length;
  const go = useCallback((k) => setI(((k % n) + n) % n), [n]);
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const auto = !paused && !hover && !reduce;

  useEffect(() => {
    if (!auto) return undefined;
    const id = setInterval(() => setI((k) => (k + 1) % n), interval);
    return () => clearInterval(id);
  }, [auto, n, interval]);

  const onKey = (e) => { if (e.key === 'ArrowLeft') go(i - 1); if (e.key === 'ArrowRight') go(i + 1); };
  const onTouchEnd = (e) => {
    if (touchX.current == null) return;
    const dx = e.changedTouches[0].clientX - touchX.current; touchX.current = null;
    if (Math.abs(dx) > 40) go(dx < 0 ? i + 1 : i - 1);
  };

  return (
    <div role="region" aria-roledescription="carrousel" aria-label={label} tabIndex={0} onKeyDown={onKey}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onFocus={() => setHover(true)} onBlur={() => setHover(false)}
      className="mx-auto max-w-5xl outline-none focus-visible:ring-2 focus-visible:ring-lp-primary">
      <div className="relative overflow-hidden rounded-2xl border border-lp-border bg-lp-card shadow-lp-float"
        onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }} onTouchEnd={onTouchEnd}>
        <div className="flex transition-transform duration-500 ease-out motion-reduce:transition-none" style={{ transform: `translateX(-${i * 100}%)` }}>
          {slides.map((s, k) => (
            <figure key={s.src} className="m-0 w-full shrink-0" role="group" aria-roledescription="diapositive" aria-label={`${k + 1} sur ${n}`} aria-hidden={k !== i}>
              <img src={s.src} alt={s.alt} width="1600" height="1000" loading={k === 0 ? 'eager' : 'lazy'} decoding="async" className="block w-full" draggable="false" />
              <figcaption className="border-t border-lp-border bg-lp-card px-5 py-4">
                <p className="font-bold text-lp-fg">{s.title}</p>
                <p className="mt-1 text-sm text-lp-muted-fg">{s.text}</p>
              </figcaption>
            </figure>
          ))}
        </div>
        <button type="button" onClick={() => go(i - 1)} aria-label="Image précédente"
          className="absolute left-3 top-[40%] grid size-10 -translate-y-1/2 place-items-center rounded-full bg-lp-ink/70 text-white backdrop-blur hover:bg-lp-ink"><ChevronLeft className="size-5" /></button>
        <button type="button" onClick={() => go(i + 1)} aria-label="Image suivante"
          className="absolute right-3 top-[40%] grid size-10 -translate-y-1/2 place-items-center rounded-full bg-lp-ink/70 text-white backdrop-blur hover:bg-lp-ink"><ChevronRight className="size-5" /></button>
      </div>
      <div className="mt-4 flex items-center justify-center gap-3">
        <button type="button" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Reprendre le défilement' : 'Mettre en pause le défilement'}
          className="grid size-8 place-items-center rounded-full border border-lp-border text-lp-muted-fg hover:text-lp-primary">{paused ? <Play className="size-4" /> : <Pause className="size-4" />}</button>
        <div className="flex gap-2" role="tablist" aria-label="Choisir une image">
          {slides.map((s, k) => (
            <button key={s.src} type="button" role="tab" aria-selected={k === i} aria-label={`Image ${k + 1} : ${s.title}`} onClick={() => go(k)}
              className={`h-2.5 rounded-full transition-all ${k === i ? 'w-8 bg-lp-primary' : 'w-2.5 bg-lp-border hover:bg-lp-muted-fg'}`} />
          ))}
        </div>
      </div>
    </div>
  );
}
