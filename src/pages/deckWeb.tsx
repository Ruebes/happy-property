import { useState, useEffect, useRef, useContext, createContext, type CSSProperties, type ReactNode } from 'react'
import type { DeckBlock } from '../lib/deckTypes'
import { WEB_CSS } from './deckWebCss'

// ── Sales Deck im Stil der Projektseite (Sven 20.10.26) ─────────────────────────
// "Ab sofort alle Sales Decks in diesem Stil", "mehr wie die Webseite": Hat ein
// Projekt eine Projektseite auf der Website, liegt deren Inhalt strukturiert in
// crm_projects.deck_assets.page (erzeugt von ~/Claude/website-projekte/seite.py).
// Das Deck zeigt dann Hero, Kennzahlen, den Tagesablauf mit Clips, Anlage, Galerie
// und Ausstattung genau wie die Website und behält seine eigenen Teile je Wohnung:
// Anschreiben, Wohnung, Grundriss, Lage-Karte, Marina, Zahlungsplan, Abschluss.
// Gilt sofort auch für alle schon verschickten Decks des Projekts, weil nur die
// Darstellung wechselt (Blöcke in sales_decks bleiben unverändert).

export type PageMedia = { img?: string; alt?: string; clip?: string; poster?: string; cap?: string } | null
type Photo = { url: string; label: string }
export type ProjectPage = {
  v: number
  url?: string
  stand?: string
  hero: { img: string; alt?: string }
  kicker: string
  h1: string
  usp_v?: string | null
  usp_k?: string | null
  lead?: string | null
  facts?: [string, string][]
  day?: {
    title: string; intro?: string | null; film_note?: string | null
    cards: { time: string; title: string; text: string; clip: string; poster: string }[]
    film?: { src: string; poster?: string; cap?: string }
  }
  home?: { kicker: string; title: string; paras: string[]; media?: PageMedia; photos?: Photo[]; note?: string | null }
  amen?: { badge?: string | null; kicker: string; title: string; paras: string[]; stats?: [string, string][] | null; media?: PageMedia; photos?: Photo[]; note?: string | null }
  options?: { kicker: string; title: string; intro?: string; items: [string, string, string][]; note?: string }
  // Weitere Abschnitte im Stil von Anlage/Zuhause (Golfresort: Spa, Villen), in Seitenreihenfolge.
  more?: { tone: 'dark' | 'cream' | 'white'; badge?: string | null; kicker: string; title: string; paras: string[]; stats?: [string, string][] | null; media?: PageMedia; photos?: Photo[]; note?: string | null }[]
  reasons_title?: string
  reasons?: [string, string][]
  gallery?: Photo[]
  spec_title?: string
  spec?: [string, string][]
  loc?: { title: string; paras: string[]; poi?: [string, string][] | null; media?: PageMedia; note?: string | null }
}

export type WebBlock =
  | { type: 'w_hero'; page: ProjectPage; forLine?: string }
  | { type: 'w_facts'; page: ProjectPage }
  | { type: 'w_day'; page: ProjectPage }
  | { type: 'w_home'; page: ProjectPage }
  | { type: 'w_amen'; page: ProjectPage }
  | { type: 'w_options'; page: ProjectPage }
  | { type: 'w_more'; page: ProjectPage; i: number }
  | { type: 'w_reasons'; page: ProjectPage }
  | { type: 'w_loc'; page: ProjectPage }
  | { type: 'w_gallery'; page: ProjectPage }
  | { type: 'w_spec'; page: ProjectPage }
  | { type: 'w_why' }
export type AnyBlock = DeckBlock | WebBlock
export const isWebBlock = (b: AnyBlock): b is WebBlock => b.type.startsWith('w_')

// false = Videos dieser Ansicht nicht von selbst starten (Scroll-Seite hinter dem
// Buchmodus, nicht aufgeschlagene Buchseiten, Druckansicht). Gilt für Deck-Videos und die Clips der Projektseite.
export const VideoAutoCtx = createContext(true)
// true = gerendert als Buchseite (deckBook.tsx): Videos im einheitlichen Rahmen.
export const InBookCtx = createContext(false)

/** Seitenstruktur des Decks im Website-Stil. Reihenfolge wie besprochen: erst das
 *  Gefühl (Hero, Kennzahlen), dann das Persönliche (Anschreiben, Wohnung, Grundriss),
 *  dann der Tag in der Anlage, Lage mit Karte und Marina, Zahlungsplan, Bilder,
 *  Ausstattung, warum mit uns, Abschluss. Deck-Blöcke, die die Seite besser zeigt
 *  (Titel, Lebensfilm, KI-Texte zu Anlage/Gemeinschaft, Galerie), entfallen. */
// Karten-Pin und Marina-Startpunkt trugen den Projektnamen (generate-deck nimmt
// crm_projects.name), im Kundenmaterial verboten.
const HOME_LABEL = 'Dein Zuhause'

export function webBlocks(blocks: DeckBlock[], page: ProjectPage): AnyBlock[] {
  const of = <T extends DeckBlock['type']>(t: T) => blocks.filter(b => b.type === t) as Extract<DeckBlock, { type: T }>[]
  const cover = of('cover')[0]
  // Gedankenstriche aus älteren Decks ("Für Walter – Oktober 2026") nicht übernehmen.
  const forLine = cover?.forLine?.replace(/\s+[-–—]\s+|\s*[–—]\s*/g, ', ')
  const out: AnyBlock[] = [{ type: 'w_hero', page, forLine }]
  if (page.facts?.length) out.push({ type: 'w_facts', page })
  // Ältere Decks nennen in den Wohnungsdaten den Bauträger, im Kundenmaterial verboten.
  const units = of('unit').map(u => ({ ...u, specs: u.specs?.filter(x => !/^\s*Bauträger\b/i.test(x)) }))
  out.push(...of('letter'), ...units, ...of('floorplan'), ...of('masterplan'))
  // Deck-eigene Videos (Baustelle heute) direkt nach dem Grundriss, Projektvideos
  // und Lebensfilm zeigt die Seite selbst.
  out.push(...of('video').filter(v => v.web))
  if (page.day?.cards?.length) out.push({ type: 'w_day', page })
  if (page.home) out.push({ type: 'w_home', page })
  if (page.amen) out.push({ type: 'w_amen', page })
  ;(page.more ?? []).forEach((_, i) => out.push({ type: 'w_more', page, i }))
  if (page.options) out.push({ type: 'w_options', page })
  if (page.reasons?.length) out.push({ type: 'w_reasons', page })
  // Karte nur mit Koordinaten: Such-Links und Such-Karten tragen den Projektnamen
  // ("…/maps/search/?query=Venara Paphos"), der Link wird deshalb aus den Koordinaten gebaut.
  const f0 = of('facts')[0]
  const hasPin = f0?.mapLat != null && f0?.mapLng != null
  const facts = f0 && {
    ...f0, mapLabel: HOME_LABEL, mapQuery: undefined, mapEmbed: undefined,
    mapUrl: hasPin ? `https://www.google.com/maps?q=${f0.mapLat},${f0.mapLng}` : undefined,
    image: hasPin ? f0.image : undefined,
  }
  if (page.loc) {
    out.push({ type: 'w_loc', page })
    // Nur die Karte aus dem Deck-Block, die Entfernungen stehen schon im Lagetext.
    if (facts && hasPin) out.push({ ...facts, kicker: undefined, headline: undefined, items: [] })
  } else if (facts) out.push(facts)
  out.push(...of('marina').map(m => ({ ...m, fromLabel: HOME_LABEL })))
  out.push(...of('payment'))
  if (page.gallery?.length) out.push({ type: 'w_gallery', page })
  if (page.spec?.length) out.push({ type: 'w_spec', page })
  out.push(...of('inventory'))
  out.push({ type: 'w_why' })
  out.push(...of('cta'))
  return out
}

// ── kleine Helfer ───────────────────────────────────────────────────────────────
const OBJ = '/storage/v1/object/public/'
function rimg(url: string | undefined, w: number, h?: number): string | undefined {
  if (!url || !url.includes(OBJ) || url.includes('?') || !/\.(jpe?g|png|webp)$/i.test(url)) return url
  // Ohne Höhe contain in ein Quadrat, sonst schneidet Supabase bei breiten Bildern die Mitte aus.
  return url.replace(OBJ, '/storage/v1/render/image/public/') + `?width=${w}&quality=74` + (h ? `&height=${h}&resize=cover` : `&height=${w}&resize=contain`)
}
function Head({ kicker, title, dark }: { kicker: string; title: string; dark?: boolean }) {
  return dark
    ? <><p className="pj-kicker-gold">{kicker}</p><h2 className="pj-h2w">{title}</h2></>
    : <><p className="pj-kicker">{kicker}</p><div className="pj-rule" /><h2 className="pj-h2">{title}</h2></>
}
const PILL: CSSProperties = { position: 'absolute', background: 'rgba(26,35,50,.72)', color: '#fff', fontSize: 11, letterSpacing: '.06em', padding: '4px 9px', borderRadius: 20, pointerEvents: 'none' }
const BTN: CSSProperties = { position: 'absolute', border: 0, cursor: 'pointer', background: 'rgba(26,35,50,.8)', color: '#fff', fontWeight: 600, borderRadius: 20, lineHeight: 1 }
const inView = (el: Element, min: number) => {
  const r = el.getBoundingClientRect(), h = r.height || 1
  return (Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) / h >= min
}

// Stummer Loop-Clip wie auf der Website: startet, sobald er ins Bild kommt, hält
// außerhalb an, eigener Pause-Knopf. Wer selbst pausiert, bekommt keinen Neustart.
function Clip({ src, poster, cap }: { src: string; poster?: string; cap?: string }) {
  const auto = useContext(VideoAutoCtx)
  const ref = useRef<HTMLVideoElement>(null)
  const user = useRef(false)
  const [playing, setPlaying] = useState(false)
  const play = (v: HTMLVideoElement) => { if (!v.getAttribute('src')) v.src = src; v.play().catch(() => {}) }
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (!auto) { v.pause(); return }
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !user.current) play(v); else if (!v.paused) v.pause()
    }, { threshold: [0, 0.01] })
    io.observe(v)
    // Chrome hält stumme Videos in verdeckten Tabs selbst an: beim Zurückkommen neu starten.
    const vis = () => { if (!document.hidden && !user.current && inView(v, 0.01)) play(v) }
    document.addEventListener('visibilitychange', vis)
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', vis) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, src])
  return (
    <>
      <video ref={ref} muted loop playsInline preload="none" poster={poster}
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }} />
      <span style={{ ...PILL, top: 10, left: 10 }}>Visualisierung</span>
      {cap && <span style={{ position: 'absolute', left: 12, right: 52, bottom: 10, color: '#fff', fontSize: 14, fontWeight: 600, textShadow: '0 1px 6px rgba(0,0,0,.6)' }}>{cap}</span>}
      <button type="button" aria-label={playing ? 'Pause' : 'Abspielen'} style={{ ...BTN, right: 10, bottom: 10, width: 34, height: 34, padding: 0, fontSize: 12 }}
        onClick={e => { e.preventDefault(); const v = ref.current; if (!v) return; if (v.paused) { user.current = false; play(v) } else { user.current = true; v.pause() } }}>
        {playing ? '❚❚' : '▶'}
      </button>
    </>
  )
}

// Lebensfilm: startet stumm, sobald er zur Hälfte sichtbar ist, Ton per Knopf.
function Film({ src, poster }: { src: string; poster?: string }) {
  const auto = useContext(VideoAutoCtx)
  const ref = useRef<HTMLVideoElement>(null)
  const user = useRef(false)
  const ours = useRef(0)
  const [muted, setMuted] = useState(true)
  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (!auto) { v.pause(); return }
    if (typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && e.intersectionRatio >= 0.5) { if (!user.current) v.play().catch(() => {}) }
      else if (!v.paused) { ours.current++; v.pause() }
    }, { threshold: [0, 0.5] })
    io.observe(v)
    return () => io.disconnect()
  }, [auto])
  return (
    <>
      <video ref={ref} src={src} poster={rimg(poster, 1600)} muted controls playsInline preload="none"
        onVolumeChange={e => setMuted(e.currentTarget.muted)}
        onPlay={() => { user.current = false }}
        onPause={e => { if (ours.current > 0) ours.current--; else if (!e.currentTarget.ended && !document.hidden) user.current = true }}
        onEnded={() => { user.current = true }}
        style={{ width: '100%', display: 'block', background: '#1a2332', aspectRatio: '16/9', objectFit: 'contain' }} />
      {muted && (
        <button type="button" style={{ ...BTN, left: 12, top: 12, padding: '10px 16px', fontSize: 14 }}
          onClick={() => { const v = ref.current; if (!v) return; v.muted = false; user.current = false; v.play().catch(() => {}) }}>
          🔈 Ton an
        </button>
      )}
    </>
  )
}

// Vollbild-Ansicht für Fotos (Pfeile, Wischen, Escape).
function useLightbox(items: Photo[]): [(i: number) => void, ReactNode] {
  const [i, setI] = useState<number | null>(null)
  const n = items.length
  const go = (d: number) => setI(c => (c == null ? c : (c + d + n) % n))
  useEffect(() => {
    if (i == null) return
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setI(null); if (e.key === 'ArrowLeft') go(-1); if (e.key === 'ArrowRight') go(1) }
    document.addEventListener('keydown', k)
    return () => document.removeEventListener('keydown', k)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i])
  const sx = useRef(0)
  const box = i == null ? null : (
    <div role="dialog" aria-modal="true" onClick={e => { if (e.target === e.currentTarget) setI(null) }}
      onTouchStart={e => { sx.current = e.touches[0].clientX }}
      onTouchEnd={e => { const d = e.changedTouches[0].clientX - sx.current; if (Math.abs(d) > 40) go(d < 0 ? 1 : -1) }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(10,14,22,.95)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 99999 }}>
      <img src={rimg(items[i].url, 1800)} alt={items[i].label} style={{ maxWidth: '92vw', maxHeight: '82vh', borderRadius: 6 }} />
      <p style={{ position: 'absolute', bottom: 16, left: 0, right: 0, textAlign: 'center', color: '#dcdfe5', fontSize: 14, margin: 0 }}>{items[i].label}  ·  {i + 1} / {n}</p>
      <button type="button" aria-label="Schließen" onClick={() => setI(null)} style={{ position: 'absolute', top: 10, right: 14, background: 'none', border: 0, color: '#fff', fontSize: 36, cursor: 'pointer' }}>×</button>
      {n > 1 && <button type="button" aria-label="Zurück" onClick={() => go(-1)} style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: '#fff', fontSize: 48, cursor: 'pointer' }}>‹</button>}
      {n > 1 && <button type="button" aria-label="Weiter" onClick={() => go(1)} style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 0, color: '#fff', fontSize: 48, cursor: 'pointer' }}>›</button>}
    </div>
  )
  return [setI, box]
}
function Photos({ items, cls = 'pj-gr-ph', bigFirst }: { items: Photo[]; cls?: string; bigFirst?: boolean }) {
  const [open, box] = useLightbox(items)
  return (
    <>
      <div className={cls}>
        {items.map((p, i) => (
          <a key={i} className={`pj-gal-a${bigFirst && i === 0 ? ' pj-gal-big' : ''}`} href={rimg(p.url, 1800)} onClick={e => { e.preventDefault(); open(i) }}>
            <img className="pj-gal-img" src={rimg(p.url, 640, 480)} alt={p.label} loading="lazy" />
          </a>
        ))}
      </div>
      {box}
    </>
  )
}
function Media({ m, big }: { m?: PageMedia; big?: boolean }) {
  if (!m) return null
  if (m.clip) return <div className={big === false ? 'pj-gr-clip' : 'pj-gr-big'}><Clip src={m.clip} poster={m.poster} cap={m.cap} /></div>
  if (m.img) return <img className="pj-split-img" src={rimg(m.img, 1100)} alt={m.alt ?? ''} loading="lazy" />
  return null
}

// ── Abschnitte ──────────────────────────────────────────────────────────────────
function Hero({ page, forLine }: { page: ProjectPage; forLine?: string }) {
  return (
    <section className="pj-hero">
      <img className="pj-hero-img" src={rimg(page.hero.img, 1800)} alt={page.hero.alt ?? ''} />
      <div className="pj-hero-shade" />
      <div className="pj-hero-in">
        <p className="pj-kicker-gold">{page.kicker}</p>
        <h1 className="pj-h1">{page.h1}</h1>
        {page.usp_v && (
          <div className="pj-gr-herousp"><p className="pj-gr-heroust">{page.usp_v}</p>{page.usp_k && <p className="pj-gr-herousk">{page.usp_k}</p>}</div>
        )}
        {page.lead && <p className="pj-lead">{page.lead}</p>}
        {forLine && <p className="font-heading italic text-lg" style={{ color: '#c2a15e', margin: 0 }}>{forLine}</p>}
      </div>
    </section>
  )
}
function Facts({ page }: { page: ProjectPage }) {
  return (
    <section className="pj-facts">
      {(page.facts ?? []).map(([v, k], i) => <div key={i} className="pj-fact"><p className="pj-fact-v">{v}</p><p className="pj-fact-k">{k}</p></div>)}
    </section>
  )
}
function Day({ page }: { page: ProjectPage }) {
  const d = page.day!
  return (
    <section className="pj-sec"><div className="pj-wrap">
      <Head kicker="Stell dir vor" title={d.title} />
      {d.intro && <p className="pj-p pj-text">{d.intro}</p>}
      <div className="pj-gr-day">
        {d.cards.map((c, i) => (
          <article key={i} className="pj-gr-dcard">
            <div className="pj-gr-media"><Clip src={c.clip} poster={c.poster} /></div>
            <div className="pj-gr-dbody"><p className="pj-gr-time">{c.time}</p><h3 className="pj-gr-dt">{c.title}</h3><p className="pj-gr-dp">{c.text}</p></div>
          </article>
        ))}
      </div>
      {d.film && (
        <>
          <div className="pj-gr-film"><Film src={d.film.src} poster={d.film.poster} /></div>
          <p className="pj-note">{d.film_note || 'Ein Tag hier in 30 Sekunden, mit Ton. Szenen mit Personen sind Visualisierungen auf Basis der Renderings des Bauträgers.'}</p>
        </>
      )}
    </div></section>
  )
}
function Home({ page }: { page: ProjectPage }) {
  const h = page.home!
  return (
    <section className="pj-sec"><div className="pj-wrap">
      <div className="pj-gr-split">
        <div><Head kicker={h.kicker} title={h.title} />{h.paras.map((p, i) => <p key={i} className="pj-p">{p}</p>)}</div>
        <Media m={h.media} />
      </div>
      {!!h.photos?.length && <><Photos items={h.photos} /><p className="pj-note">{h.note || 'Visualisierungen des Bauträgers. Tippe auf ein Bild für die Vollansicht.'}</p></>}
    </div></section>
  )
}
function Amen({ page }: { page: ProjectPage }) {
  const m = page.amen!
  return (
    <section className="pj-gr-dark"><div className="pj-wrap">
      <div className="pj-gr-split">
        <div>
          {m.badge && <p className="pj-gr-badge">{m.badge}</p>}
          <Head kicker={m.kicker} title={m.title} dark />
          {m.paras.map((p, i) => <p key={i} className="pj-gr-pw">{p}</p>)}
          {!!m.stats?.length && <div className="pj-gr-stats">{m.stats.map(([v, k], i) => <div key={i} className="pj-gr-stat"><p className="pj-gr-sv">{v}</p><p className="pj-gr-sk">{k}</p></div>)}</div>}
        </div>
        <Media m={m.media} />
      </div>
      {!!m.photos?.length && <><Photos items={m.photos} /><p className="pj-gr-noted">{m.note || 'Visualisierungen des Bauträgers. Szenen mit Personen sind Visualisierungen auf Basis dieser Renderings.'}</p></>}
    </div></section>
  )
}
function More({ page, i }: { page: ProjectPage; i: number }) {
  const m = page.more![i]
  const dark = m.tone === 'dark'
  const body = (
    <div className="pj-wrap">
      <div className="pj-gr-split">
        <div>
          {m.badge && <p className="pj-gr-badge">{m.badge}</p>}
          <Head kicker={m.kicker} title={m.title} dark={dark} />
          {m.paras.map((p, j) => <p key={j} className={dark ? 'pj-gr-pw' : 'pj-p'}>{p}</p>)}
          {!!m.stats?.length && <div className="pj-gr-stats">{m.stats.map(([v, k], j) => <div key={j} className="pj-gr-stat"><p className={dark ? 'pj-gr-sv' : 'pj-gr-svd'}>{v}</p><p className={dark ? 'pj-gr-sk' : 'pj-gr-skd'}>{k}</p></div>)}</div>}
        </div>
        <Media m={m.media} />
      </div>
      {!!m.photos?.length && <><Photos items={m.photos} />{m.note && <p className={dark ? 'pj-gr-noted' : 'pj-note'}>{m.note}</p>}</>}
    </div>
  )
  if (m.tone === 'white') return <section className="pj-sec">{body}</section>
  return <section className={dark ? 'pj-gr-dark' : 'pj-gr-cream'}>{body}</section>
}
function Options({ page }: { page: ProjectPage }) {
  const o = page.options!
  return (
    <section className="pj-gr-cream"><div className="pj-wrap">
      <Head kicker={o.kicker} title={o.title} />
      {o.intro && <p className="pj-p pj-text">{o.intro}</p>}
      <div className="pj-gr-perks">{o.items.map(([v, t, d], i) => <div key={i} className="pj-gr-perk"><p className="pj-gr-pv">{v}</p><p className="pj-card-t">{t}</p><p className="pj-card-p">{d}</p></div>)}</div>
      {o.note && <p className="pj-note">{o.note}</p>}
    </div></section>
  )
}
function Reasons({ page }: { page: ProjectPage }) {
  return (
    <section className="pj-sec"><div className="pj-wrap">
      <Head kicker="Für Kapitalanleger" title={page.reasons_title || 'Warum das Projekt auch für Anleger passt'} />
      <div className="pj-reasons">
        {page.reasons!.map(([t, d], i) => <div key={i} className="pj-card"><p className="pj-card-n">{String(i + 1).padStart(2, '0')}</p><p className="pj-card-t">{t}</p><p className="pj-card-p">{d}</p></div>)}
      </div>
    </div></section>
  )
}
function Loc({ page }: { page: ProjectPage }) {
  const L = page.loc!
  return (
    <section className="pj-sec"><div className="pj-wrap">
      <div className="pj-gr-split">
        <div><Head kicker="Lage" title={L.title} />{L.paras.map((p, i) => <p key={i} className="pj-p">{p}</p>)}</div>
        <Media m={L.media} />
      </div>
      {!!L.poi?.length && <div className="pj-poi">{L.poi.map(([v, k], i) => <div key={i} className="pj-poi-i"><p className="pj-poi-v">{v}</p><p className="pj-poi-k">{k}</p></div>)}</div>}
      <p className="pj-note">{L.note || 'Entfernungen laut Bauträger.'}</p>
    </div></section>
  )
}
function Gallery({ page }: { page: ProjectPage }) {
  const g = page.gallery!
  return (
    <section className="pj-sec"><div className="pj-wrap">
      <Head kicker="Die Anlage in Bildern" title={`${g.length} Ansichten`} />
      <p className="pj-p">Tippe auf ein Bild für die Vollansicht.</p>
      <Photos items={g} cls="pj-gal" bigFirst />
    </div></section>
  )
}
function Spec({ page }: { page: ProjectPage }) {
  return (
    <section className="pj-sec"><div className="pj-wrap">
      <Head kicker="Ausstattung" title={page.spec_title || 'Ausstattung'} />
      <div className="pj-spec">{page.spec!.map(([t, d], i) => <div key={i} className="pj-spec-i"><p className="pj-card-t">{t}</p><p className="pj-card-p">{d}</p></div>)}</div>
    </div></section>
  )
}
const WHY: [string, string][] = [
  ['Gleicher Preis wie beim Bauträger', 'Unsere Vergütung trägt der Bauträger. Du zahlst keinen Cent mehr, als wenn du direkt kaufst.'],
  ['Ein Anwalt auf deiner Seite', 'Sonst musst du mit dem Vertrag des Bauträgers allein klarkommen oder selbst einen Anwalt auf Zypern suchen. Bei uns prüft ihn unser Anwalt.'],
  ['Musterverträge für deutsche Käufer', 'Mit jedem unserer Bauträger ausgehandelt: Garantie, Lieferumfang und Fristen klar geregelt.'],
  ['Standardisierte Spezifikation, nur bei uns', 'Für jedes Projekt haben wir eine eigene, standardisierte Spezifikation erstellt: Bauausführung, Materialien und alles, was geliefert wird, von Möbeln und Geräten bis zu Besteck und Bettwäsche. Sie wird Anhang deines Kaufvertrags. Das gibt es so nur bei Happy Property.'],
  ['Verwaltung, die Bewertungen schützt', 'Das beste Objekt nützt nichts, wenn die Reinigung nicht stimmt. Wir übernehmen Gäste, Reinigung und Instandhaltung.'],
  ['Alles in der Happy Property App', 'Zahlungsplan, Baufortschritt mit Fotos, Belegung, Einnahmen und Dokumente an einem Ort.'],
]
function Why() {
  return (
    <section className="pj-why"><div className="pj-wrap">
      <p className="pj-kicker-gold">Warum mit Happy Property</p>
      <h2 className="pj-h2w">Gleicher Preis. Aber du kaufst nicht allein.</h2>
      <div className="pj-whygrid">
        {WHY.map(([t, d], i) => (
          <div key={i} className="pj-whyi"><p className="pj-whyt">{t}</p><p className="pj-whyp">{d}</p>
            {t.includes('App') && <a className="pj-whylink" href="https://steuervorteil-zypern-immobilien.com/happy-property-app/" target="_blank" rel="noopener noreferrer">Die App ansehen →</a>}
          </div>
        ))}
      </div>
    </div></section>
  )
}

/** Ein Abschnitt der Projektseite. Eigene weiße Fläche wie auf der Website. */
export function WebBlockView({ block }: { block: WebBlock }) {
  let inner: ReactNode = null
  switch (block.type) {
    case 'w_hero':    inner = <Hero page={block.page} forLine={block.forLine} />; break
    case 'w_facts':   inner = <Facts page={block.page} />; break
    case 'w_day':     inner = <Day page={block.page} />; break
    case 'w_home':    inner = <Home page={block.page} />; break
    case 'w_amen':    inner = <Amen page={block.page} />; break
    case 'w_more':    inner = <More page={block.page} i={block.i} />; break
    case 'w_options': inner = <Options page={block.page} />; break
    case 'w_reasons': inner = <Reasons page={block.page} />; break
    case 'w_loc':     inner = <Loc page={block.page} />; break
    case 'w_gallery': inner = <Gallery page={block.page} />; break
    case 'w_spec':    inner = <Spec page={block.page} />; break
    case 'w_why':     inner = <Why />; break
  }
  // Abstand nach unten nur für die hellen Abschnitte, Hero/Kennzahlen/Dunkles schließen bündig an.
  const pad = !['w_hero', 'w_facts', 'w_amen', 'w_why'].includes(block.type) && !(block.type === 'w_more' && block.page.more?.[block.i]?.tone !== 'white')
  return <div className="hpweb" style={pad ? { paddingBottom: 64 } : undefined}>{inner}</div>
}

/** Einmal je Deck: die Klassen der Projektseite. */
export function WebStyle() { return <style>{WEB_CSS}</style> }
