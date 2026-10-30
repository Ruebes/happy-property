import { useState, useEffect, useLayoutEffect, useRef, createContext, useContext, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { supabase } from '../lib/supabase'
import type { DeckBlock, DeckContent, FloorplanRoom } from '../lib/deckTypes'
import { DECK_CONTACT, DECK_LOGO, DECK_PHOTO } from '../lib/deckTypes'
import { normalizeMonthPlan, monthPlanCounts } from '../lib/rechner'
import { VideoAutoCtx, InBookCtx, webBlocks, WebBlockView, WebStyle, isWebBlock, type AnyBlock, type ProjectPage } from './deckWeb'
import { DeckBook, TopViewToggle } from './deckBook'

// ── Sales-Deck Render-Seite (öffentlich, per Token) ─────────────────────────────
// Personalisierte Verkaufs-Microsite in Happy-Property-Optik. Datengetrieben aus
// der Block-Liste (content.blocks). Reihenfolge & Auswahl der Blöcke kommen aus
// der KI-Generierung; hier wird nur gezeichnet.

const CREAM = '#FAF6EC'
const DARK  = '#1b1b22'
const GOLD  = '#C2A15E'
const INK   = '#1a1a1a'

// ── kleine Bausteine ────────────────────────────────────────────────────────────
function Accent() { return <div className="w-10 h-[3px] mb-4 rounded-full" style={{ background: GOLD }} /> }
function Kicker({ children, light }: { children?: string; light?: boolean }) {
  if (!children) return null
  return <p className="text-[11px] font-semibold uppercase tracking-[0.2em]" style={{ color: light ? GOLD : GOLD }}>{children}</p>
}
// Bilder aus dem eigenen Storage verkleinert ueber die Supabase-Bildtransformation
// ausliefern (WebP, feste Breite). Die Bautraeger-Renderings liegen als 4K-PNG mit
// ~10 MB im Storage; das Mamba-Deck lud so ~140 MB Bilder und Safari wurde nach
// wenigen Sekunden weiss (Sven 12.10.26). SVG/GIF und fremde URLs bleiben wie sie sind.
const STORAGE_OBJ = '/storage/v1/object/public/'
function sizedImg(url: string | undefined, width = 1600): string | undefined {
  if (!url) return url
  const i = url.indexOf(STORAGE_OBJ)
  if (i < 0 || url.includes('?') || !/\.(jpe?g|png|webp)$/i.test(url)) return url
  // width allein schneidet zu (resize=cover behaelt die Originalhoehe) - contain in ein
  // Quadrat erhaelt das Seitenverhaeltnis fuer Quer- und Hochformat.
  return `${url.slice(0, i)}/storage/v1/render/image/public/${url.slice(i + STORAGE_OBJ.length)}?width=${width}&height=${width}&resize=contain&quality=75`
}
function Img({ src, alt, className, style, w = 1600 }: { src?: string; alt?: string; className?: string; style?: CSSProperties; w?: number }) {
  // 0 = verkleinert, 1 = Original (Transformation fehlgeschlagen), 2 = Platzhalter
  const [stage, setStage] = useState(0)
  const sized = sizedImg(src, w)
  if (!src || stage === 2) {
    return <div className={className} style={{ ...style, background: 'linear-gradient(135deg,#d9cfbe,#b7ab95)' }} />
  }
  return <img src={stage === 0 ? sized : src} alt={alt ?? ''} loading="lazy"
    onError={() => setStage(st => (st === 0 && sized !== src ? 1 : 2))} className={className} style={style} />
}

// ── Block-Renderer ──────────────────────────────────────────────────────────────
// Cover: animierte Kamerafahrt (Higgsfield, EIN Video je Projekt) statt Standbild,
// wenn vorhanden. Stumm, Loop, autoplay, poster = Originalbild; bei Ladefehler
// fällt es still aufs Bild zurück (VideoCover-State).
function CoverMedia({ image, video }: { image?: string; video?: string }) {
  const [videoFailed, setVideoFailed] = useState(false)
  if (video && !videoFailed) {
    return (
      <video
        src={video}
        poster={sizedImg(image, 1920)}
        autoPlay muted loop playsInline
        preload="metadata"
        onError={() => setVideoFailed(true)}
        className="w-full h-[62vh] object-cover"
      />
    )
  }
  return <Img src={image} w={1920} className="w-full h-[62vh] object-cover" />
}
function CoverBlock(b: Extract<DeckBlock, { type: 'cover' }>) {
  return (
    <section>
      <CoverMedia image={b.image} video={b.video} />
      <div className="px-5 md:px-20 py-16" style={{ background: DARK }}>
        <img src={DECK_LOGO} alt="Happy Property" className="h-16 w-auto mb-6" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        <Accent />
        <Kicker>{b.kicker}</Kicker>
        <h1 className="font-heading font-bold text-white text-5xl md:text-7xl mt-3 leading-none">{b.title}</h1>
        {b.tagline && <p className="font-heading italic text-gray-300 text-lg md:text-2xl mt-4">{b.tagline}</p>}
        {b.forLine && <p className="font-heading italic text-base md:text-lg mt-5" style={{ color: GOLD }}>{b.forLine}</p>}
      </div>
    </section>
  )
}

function LetterBlock(b: Extract<DeckBlock, { type: 'letter' }>) {
  return (
    <section className="px-5 md:px-20 py-20 grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-16">
      <div>
        <Accent />
        <Kicker>{b.kicker}</Kicker>
        {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-4 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      </div>
      <div className="space-y-4 text-[15px] leading-relaxed text-gray-700">
        {b.paragraphs.map((p, i) => <p key={i} dangerouslySetInnerHTML={{ __html: p }} />)}
        {b.signoff && <p className="font-heading italic text-lg pt-2" style={{ color: INK }}>{b.signoff}</p>}
        {b.signName && <p className="text-xs text-gray-400">{b.signName}</p>}
      </div>
    </section>
  )
}

// ── MwSt.-Erstattung bei Kurzzeitvermietung ─────────────────────────────────────
// Steht in der Rendite-Berechnung des Kunden bei einer Wohnung „Kurzzeit", sagt das
// Deck dazu, dass die MwSt. erstattet wird (Sven 12.10.26). Quelle: get_deck_let_types
// (jüngste Berechnung des Leads je Wohnung). Nur Text, keine eigene Rechnung: der
// erstattete Anteil folgt rechner.ts, (12 - Monate Selbstnutzung) / 12.
type VatRefund = { letMonths: number }
// Decks mit mehreren Wohnungen: jede Wohnung hat einen eigenen „Mehr Infos“-Knopf,
// der das Formular mit genau dieser Wohnung öffnet (Sven 24.10.26, vorher bekam jede
// Anfrage die erste Wohnung des Decks). null = Deck mit nur einer Wohnung.
const InfoOpenCtx = createContext<((nr: string) => void) | null>(null)
// Terminlink (persönlich oder allgemein) für die Termin-Knöpfe in Wohnung und Abschluss.
// Auswertung Flora 28.10.26: 70 Besuche, 2 Termin-Klicks, weil der Knopf fast nur oben stand.
const TerminCtx = createContext<string | null>(null)

// „Passt nicht ganz?" (Sven 30.10.26): derselbe Buchungslink, aber erst der Fragebogen
// passt-nicht (Nutzung, Eigenkapital, Immobilie in DE, Wohnung/Haus). Der Kontakt ist
// über den Token bekannt, danach geht es ohne Kontaktformular zur Terminwahl.
function altUrl(termin: string): string {
  return `${termin}${termin.includes('?') ? '&' : '?'}f=passt-nicht`
}
const VatRefundCtx = createContext<{ byUnit: Record<string, VatRefund>; units: string[] }>({ byUnit: {}, units: [] })
const unitNorm = (s?: string) => (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
function vatRefundMap(rows: unknown): Record<string, VatRefund> {
  const out: Record<string, VatRefund> = {}
  if (!Array.isArray(rows)) return out
  for (const r of rows as Array<{ unit?: string; letType?: string; selfUseMonths?: unknown; monthPlan?: string[] | null }>) {
    if (r?.letType !== 'short' || !r.unit) continue
    // Selbstnutzung wie rechner.ts: ein Kalender mit Aussage geht vor der reinen Monatszahl (0-11).
    const plan = normalizeMonthPlan(r.monthPlan)
    const c = monthPlanCounts(plan)
    const self = plan && (c.self > 0 || c.empty > 0) ? c.self : Math.max(0, Math.min(11, Math.round(Number(r.selfUseMonths) || 0)))
    if (self >= 12) continue
    out[unitNorm(r.unit)] = { letMonths: 12 - self }
  }
  return out
}
function VatRefundRow({ unit }: { unit?: string }) {
  const { t } = useTranslation()
  const r = useContext(VatRefundCtx).byUnit[unitNorm(unit)]
  if (!r) return null
  return (
    <div className="flex items-baseline justify-between gap-4 pt-1.5 mt-1.5 border-t border-white/15">
      <span className="text-gray-400 text-[13px]">{t('deck.vatRefundLabel', 'Bei Kurzzeitvermietung')}</span>
      <span className="font-heading text-base text-right" style={{ color: GOLD }}>
        {r.letMonths >= 12
          ? t('deck.vatRefundFull', 'MwSt. wird erstattet')
          : t('deck.vatRefundPartial', 'MwSt. anteilig erstattet ({{n}} von 12 Monaten vermietet)', { n: r.letMonths })}
      </span>
    </div>
  )
}

function UnitInfoButton({ nr }: { nr?: string }) {
  const { t } = useTranslation()
  const open = useContext(InfoOpenCtx)
  const termin = useContext(TerminCtx)
  const n = nr?.trim()
  if (!open || !n) return null
  return (
    <div className="mt-5 flex flex-wrap gap-2.5 print:hidden">
      {termin && (
        <a href={termin} className="px-5 py-2.5 rounded-full font-semibold text-sm shadow transition hover:brightness-105" style={{ background: GOLD, color: DARK }}>
          📅 {t('deck.unitTermin', 'Termin zu {{nr}} buchen', { nr: n })}
        </a>
      )}
      <button onClick={() => open(n)} className="px-5 py-2.5 rounded-full font-semibold text-sm border transition hover:bg-black/5" style={{ borderColor: GOLD, color: INK }}>
        {t('deck.unitInfo', 'Mehr Infos zu {{nr}} anfordern', { nr: n })} <span aria-hidden>→</span>
      </button>
    </div>
  )
}

function UnitBlock(b: Extract<DeckBlock, { type: 'unit' }>) {
  return (
    <section className={`px-5 md:px-20 grid grid-cols-1 md:grid-cols-2 items-center ${b.compact ? 'py-10 gap-6 md:gap-10' : 'py-16 gap-10'}`} style={{ background: CREAM }}>
      <Img src={b.image} className={`w-full object-cover rounded-xl ${b.compact ? 'h-[200px] md:h-[360px]' : 'h-[420px]'}`} />
      <div>
        <Kicker>{b.kicker}</Kicker>
        <h2 className={`font-heading font-bold mt-2 ${b.compact ? 'text-5xl md:text-6xl' : 'text-6xl md:text-7xl'}`} style={{ color: INK }}>{b.number}</h2>
        {b.nickname && <p className="font-heading italic text-xl md:text-2xl mt-1" style={{ color: GOLD }}>{b.nickname}</p>}
        {b.specs && b.compact ? (
          <p className="mt-4 text-[14px] leading-relaxed text-gray-700">
            <strong className="text-gray-900">{b.specs[0]}</strong>{b.specs.length > 1 && ` · ${b.specs.slice(1).join(' · ')}`}
          </p>
        ) : b.specs && (
          <div className="mt-5 space-y-1 text-[15px] text-gray-700">
            {b.specs.map((s, i) => <p key={i} className={i === 0 ? 'font-semibold text-gray-900' : ''}>{s}</p>)}
          </div>
        )}
        {b.priceLines && b.priceLines.length > 0 ? (
          <div className="mt-6 rounded-xl px-5 py-4 space-y-1.5" style={{ background: DARK }}>
            {b.priceLines.map((l, i) => (
              <div key={i} className={`flex items-baseline justify-between gap-4 ${l.strong ? 'pt-1.5 mt-1.5 border-t border-white/15' : ''}`}>
                <span className={`${l.strong ? 'text-white font-semibold' : 'text-gray-400'} text-[13px]`}>{l.label}</span>
                <span className={`font-heading ${l.strong ? 'text-white text-2xl font-bold' : 'text-gray-200 text-base'} whitespace-nowrap${l.strike ? ' line-through' : ''}`} style={l.strong ? undefined : { color: l.strike ? '#9aa2ad' : '#e5e0d5' }}>{l.value}</span>
              </div>
            ))}
            <VatRefundRow unit={b.number} />
          </div>
        ) : (b.priceMain || b.priceSub) && (
          <div className="mt-6 rounded-xl px-5 py-4" style={{ background: DARK }}>
            {b.priceSub && <p className="text-[11px] font-semibold uppercase tracking-[0.15em]" style={{ color: GOLD }}>{b.priceSub.split('·')[0]}</p>}
            <p className="font-heading font-bold text-white text-4xl mt-1">{b.priceMain}</p>
            {b.priceSub && b.priceSub.includes('·') && <p className="text-xs text-gray-400 mt-1">{b.priceSub.split('·').slice(1).join('·').trim()}</p>}
            <VatRefundRow unit={b.number} />
          </div>
        )}
        {b.note && <p className="mt-4 text-[13px] leading-relaxed text-gray-600" dangerouslySetInnerHTML={{ __html: b.note }} />}
        <UnitInfoButton nr={b.number} />
      </div>
    </section>
  )
}

// ── Standort-Karte ohne Google-Embed ─────────────────────────────────────────
// Der keyless Google-Embed (maps.google.com/maps?…&output=embed) antwortet mit
// einem Redirect samt X-Frame-Options - je nach Browser blieb das iframe leer
// (Sven 19.9.26: "Karte fehlt"). Jetzt: OpenStreetMap-Kacheln als Bildraster,
// Pin exakt auf den Koordinaten, kein iframe, kein Schluessel, kein Redirect.
// Laden die Kacheln nicht, faellt die Karte auf das statische Bild oder den
// Link zurueck - nie auf eine leere Flaeche.
// Zoomen (Sven 22.10.26): +/- Knöpfe (Zoom 10 bis 18), Maus/Stift ziehen zum
// Verschieben, Doppelklick zoomt hinein. Touch bleibt unberührt (ein Finger
// scrollt immer die Seite), kein Mausrad (würde das Seiten-Scrollen kapern).
// Startansicht und Kachelsatz bei Zoom 15 sind exakt wie vorher (5x3 um den Pin).
// Satellit (Sven 22.10.26, wie früher bei Google): Umschalter "Karte | Satellit",
// Satellitenbild = Esri World Imagery, ohne Schlüssel. Gleiches Web-Mercator-Raster,
// also gleicher Pin und gleiches Zoomen/Verschieben. Startansicht bleibt die Karte.
const OSM_ZOOM = 15
const OSM_MIN_ZOOM = 10
const OSM_MAX_ZOOM = 18
const TILE = 256
type OsmLayer = 'map' | 'sat'
// Ansicht: Ebene + Zoom + Versatz der Kartenmitte zum Pin in Bildschirmpixeln (0/0 = Pin mittig)
type OsmView = { l: OsmLayer; z: number; px: number; py: number }
// Kachel-URL je Ebene. Achtung: Esri erwartet z/y/x, OSM z/x/y.
function osmTileSrc(l: OsmLayer, z: number, x: number, y: number) {
  return l === 'sat'
    ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
    : `https://tile.openstreetmap.org/${z}/${x}/${y}.png`
}
// Web-Mercator: Weltpixel eines Punkts bei Zoom z (gleiche Formel wie bisher, nur in Pixeln)
function osmWorld(lat: number, lng: number, z: number) {
  const n = 2 ** z * TILE
  const latRad = lat * Math.PI / 180
  return { x: (lng + 180) / 360 * n, y: (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n }
}
// Kachelsatz einer Ansicht: deckt mindestens das bisherige 5x3-Raster (1024x512 um
// die Kartenmitte) ab, bei größeren Containern die gemessene Fläche, gedeckelt auf
// 11x7 Kacheln. Kachel-x läuft modulo 2^z um, Kachel-y außerhalb der Welt entfällt.
// Schlüssel enthalten die Ebene, damit Fehler, geladene Kacheln und Hintergrund
// von Karte und Satellit nie vermischt werden.
function osmTiles(lat: number, lng: number, v: OsmView, w: number, h: number) {
  const n = 2 ** v.z
  const p = osmWorld(lat, lng, v.z)
  const mx = p.x + v.px, my = p.y + v.py
  const W = Math.min(Math.max(w, 4 * TILE), 10 * TILE), H = Math.min(Math.max(h, 2 * TILE), 6 * TILE)
  const x0 = Math.floor((mx - W / 2) / TILE), x1 = Math.floor((mx + W / 2) / TILE)
  const y0 = Math.floor((my - H / 2) / TILE), y1 = Math.floor((my + H / 2) / TILE)
  const list: { key: string; rk: string; src: string; left: number; top: number }[] = []
  for (let ty = Math.max(0, y0); ty <= Math.min(n - 1, y1); ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const x = ((tx % n) + n) % n
      list.push({ key: `${v.l}/${v.z}/${x}/${ty}`, rk: `${v.l}:${v.z}:${tx}:${ty}`, src: osmTileSrc(v.l, v.z, x, ty), left: (tx - x0) * TILE, top: (ty - y0) * TILE })
    }
  }
  // ox/oy: Lage der linken oberen Kachel relativ zur Kartenmitte
  return { list, ox: x0 * TILE - mx, oy: y0 * TILE - my }
}
function OsmMap({ lat, lng, label, fallbackImage, openHref }: { lat: number; lng: number; label?: string; fallbackImage?: string; openHref: string }) {
  const { t } = useTranslation()
  const box = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<OsmView>({ l: 'map', z: OSM_ZOOM, px: 0, py: 0 })
  // Vorige Zoomstufe als unscharfer Hintergrund, bis die neuen Kacheln da sind
  const [prev, setPrev] = useState<OsmView | null>(null)
  // Fehler je Kachel (z/x/y), gezählt wird nur im aktuell sichtbaren Kachelsatz.
  // Zoomen/Verschieben löst den Fallback also nicht durch alte Fehler aus.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set())
  const loaded = useRef(new Set<string>())
  // Seit dem letzten Wechsel auf Satellit schon eine Satellitenkachel geladen?
  const satSeen = useRef(false)
  const drag = useRef<{ id: number; x: number; y: number; px: number; py: number; moved: boolean } | null>(null)
  const lastPointer = useRef('')

  // Containergröße messen, damit die Kacheln jede Breite abdecken
  useEffect(() => {
    const el = box.current
    if (!el) return
    const measure = () => setSize(s => (s.w === el.clientWidth && s.h === el.clientHeight) ? s : { w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const cur = osmTiles(lat, lng, view, size.w, size.h)
  const bad = cur.list.filter(tl => failed.has(tl.key)).length
  const tilesDown = cur.list.length === 0 || bad >= cur.list.length / 2
  // Satellit fällt aus: zurück auf die Karte, nie auf Bild/Link. Erst wenn auch die
  // Karte bricht, greift der bisherige Fallback (statisches Bild, dann Link).
  const satDown = view.l === 'sat' && tilesDown
  const broken = view.l === 'map' && tilesDown
  const atHome = view.z === OSM_ZOOM && view.px === 0 && view.py === 0
  const back = prev && prev.l === view.l && prev.z !== view.z ? { v: prev, ...osmTiles(lat, lng, prev, size.w, size.h) } : null
  const backTiles = back ? back.list.filter(tl => loaded.current.has(tl.key)) : []

  // Vor dem Zeichnen umschalten, damit nie kurz das Fallback-Bild aufblitzt
  useLayoutEffect(() => {
    if (!satDown) return
    setPrev(null)
    setFailed(new Set())
    setView(v => ({ ...v, l: 'map' }))
  }, [satDown])
  // Satellit hängt (Esri antwortet nicht, kein Fehler kommt): lädt binnen 8 s keine
  // einzige Satellitenkachel, ebenfalls zurück auf die Karte statt beiger Fläche
  useEffect(() => {
    if (view.l !== 'sat') return
    const id = setTimeout(() => {
      if (satSeen.current) return
      setPrev(null)
      setFailed(new Set())
      setView(v => v.l === 'sat' ? { ...v, l: 'map' } : v)
    }, 8000)
    return () => clearTimeout(id)
  }, [view.l])

  const go = (z: number, px: number, py: number, l: OsmLayer = view.l) => {
    // Neue Zoomstufe oder Ebene wird frisch geladen: alte Fehler (kurzer Netzaussetzer)
    // sperren sie nicht. Beim Ebenenwechsel kein Hintergrund der anderen Ebene.
    if (l !== view.l) { setPrev(null); setFailed(new Set()); satSeen.current = false }
    else if (z !== view.z) { setPrev(view); setFailed(new Set()) }
    setView({ l, z, px, py })
  }
  const zoomBy = (d: 1 | -1) => {
    const z = Math.min(OSM_MAX_ZOOM, Math.max(OSM_MIN_ZOOM, view.z + d))
    if (z === view.z) return
    // Pin im Bild: Pin bleibt Bezugspunkt und steht still. Pin außerhalb: um die
    // Kartenmitte zoomen, damit er beim Herauszoomen wieder ins Bild kommt.
    const el = box.current
    const pinVisible = Math.abs(view.px) <= (el?.clientWidth ?? 0) / 2 && Math.abs(view.py) <= (el?.clientHeight ?? 0) / 2
    const f = pinVisible ? 1 : 2 ** (z - view.z)
    go(z, view.px * f, view.py * f)
  }
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    lastPointer.current = e.pointerType
    // Nur Maus/Stift ziehen die Karte, Touch scrollt weiter die Seite
    if (broken || (e.pointerType !== 'mouse' && e.pointerType !== 'pen') || e.button !== 0) return
    if ((e.target as HTMLElement).closest('a,button')) return
    e.preventDefault()
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* egal */ }
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, px: view.px, py: view.py, moved: false }
    e.currentTarget.style.cursor = 'grabbing'
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || e.pointerId !== d.id) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    // Kleines Zittern beim Klicken ist kein Verschieben
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return
    d.moved = true
    setView(v => ({ ...v, px: d.px - dx, py: d.py - dy }))
  }
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    e.currentTarget.style.cursor = ''
  }
  const onDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (broken || view.z >= OSM_MAX_ZOOM || (lastPointer.current !== 'mouse' && lastPointer.current !== 'pen')) return
    if ((e.target as HTMLElement).closest('a,button')) return
    // Um die Klickstelle zoomen: der Punkt unter dem Mauszeiger bleibt stehen
    const r = e.currentTarget.getBoundingClientRect()
    const qx = e.clientX - (r.left + r.width / 2), qy = e.clientY - (r.top + r.height / 2)
    go(view.z + 1, 2 * view.px + qx, 2 * view.py + qy)
  }
  const btn = 'flex h-9 w-9 items-center justify-center rounded-lg bg-white/95 text-gray-800 shadow-md ring-1 ring-black/10 hover:bg-white disabled:opacity-40 disabled:cursor-default touch-manipulation'

  return (
    <div className="mt-8">
      <div ref={box} className={`relative w-full overflow-clip rounded-xl border border-gray-200 bg-[#e8e4dc] select-none${broken ? '' : ' cursor-grab'}`} style={{ aspectRatio: '16 / 9' }}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd} onDoubleClick={onDoubleClick}>
        {broken && fallbackImage ? (
          <Img src={fallbackImage} className="absolute inset-0 h-full w-full object-cover" />
        ) : broken ? (
          <a href={openHref} target="_blank" rel="noopener noreferrer" className="absolute inset-0 flex items-center justify-center text-sm text-gray-600 underline">
            {t('deck.openInGoogleMaps', 'In Google Maps öffnen')}
          </a>
        ) : (
          <>
            {back && backTiles.length > 0 && (
              <div className="absolute pointer-events-none" style={{ left: `calc(50% - ${view.px}px)`, top: `calc(50% - ${view.py}px)`, transform: `scale(${2 ** (view.z - back.v.z)})`, transformOrigin: '0 0' }}>
                <div className="absolute left-0 top-0" style={{ transform: `translate(${back.ox + back.v.px}px, ${back.oy + back.v.py}px)` }}>
                  {backTiles.map(tl => (
                    <img key={tl.rk} alt="" src={tl.src} className="absolute select-none pointer-events-none"
                      style={{ width: TILE, height: TILE, left: tl.left, top: tl.top, maxWidth: 'none' }} />
                  ))}
                </div>
              </div>
            )}
            <div className="absolute left-1/2 top-1/2" style={{ transform: `translate(${cur.ox}px, ${cur.oy}px)` }}>
              {cur.list.map(tl => (
                <img key={tl.rk} alt="" loading="eager" decoding="async"
                  src={tl.src}
                  onLoad={() => {
                    loaded.current.add(tl.key)
                    if (tl.key.startsWith('sat/')) satSeen.current = true
                    if (failed.has(tl.key)) setFailed(s => { const c = new Set(s); c.delete(tl.key); return c })
                  }}
                  onError={() => setFailed(s => s.has(tl.key) ? s : new Set(s).add(tl.key))}
                  className="absolute select-none pointer-events-none"
                  style={{ width: TILE, height: TILE, left: tl.left, top: tl.top, maxWidth: 'none' }} />
              ))}
            </div>
          </>
        )}
        {!broken && (
          <div className="absolute -translate-x-1/2 -translate-y-full pointer-events-none flex flex-col items-center"
            style={{ left: `calc(50% - ${view.px}px)`, top: `calc(50% - ${view.py}px)` }}>
            <span className="text-sm font-semibold px-3 py-1 rounded-full text-white shadow-lg whitespace-nowrap mb-1" style={{ background: '#ff795d' }}>📍 {label || t('deck.mapIframeTitle', 'Standort')}</span>
            <svg width="22" height="30" viewBox="0 0 22 30" aria-hidden="true"><path d="M11 0C4.9 0 0 4.9 0 11c0 8 11 19 11 19s11-11 11-19C22 4.9 17.1 0 11 0z" fill="#ff795d"/><circle cx="11" cy="11" r="4.5" fill="#fff"/></svg>
          </div>
        )}
        {!broken && (
          <div className="absolute left-2 top-2 z-10 flex flex-col gap-1.5 print:hidden">
            <button type="button" className={btn} onClick={() => zoomBy(1)} disabled={view.z >= OSM_MAX_ZOOM}
              aria-label={t('deck.mapZoomIn', 'Hineinzoomen')} title={t('deck.mapZoomIn', 'Hineinzoomen')}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
            <button type="button" className={btn} onClick={() => zoomBy(-1)} disabled={view.z <= OSM_MIN_ZOOM}
              aria-label={t('deck.mapZoomOut', 'Herauszoomen')} title={t('deck.mapZoomOut', 'Herauszoomen')}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 7h12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </div>
        )}
        {/* Unterkante: links "Zurück zum Standort", rechts der Umschalter Karte/Satellit
            über der Quellenangabe. Oben ist kein Platz: links +/-, in der Mitte die
            Pin-Beschriftung, rechts im Website-Deck das Logo-Wasserzeichen. Reicht die
            Breite nicht (schmales Handy), rutscht die rechte Spalte eine Zeile über den
            Knopf (wrap-reverse: erste Zeile unten, daher items-start = unten bündig).
            So überdeckt sich nichts, der Knopf bleibt wo er war. Die Spalte hat eine
            feste Breite (passt für die längste Esri-Zeile, längere wird mit … gekürzt),
            damit der Umschalter beim Wechsel Karte/Satellit nicht springt.
            z-10: liegt im Blättermodus über den unsichtbaren Blätter-Knöpfen. */}
        <div className="absolute inset-x-2 bottom-1 z-10 flex flex-wrap-reverse items-start gap-x-2 gap-y-1 pointer-events-none">
          {!atHome && (
            <button type="button" onClick={() => go(OSM_ZOOM, 0, 0)}
              className="mb-1 shrink-0 pointer-events-auto text-xs font-medium px-3 py-1.5 rounded-full text-white shadow touch-manipulation print:hidden" style={{ background: 'rgba(27,27,34,0.88)' }}>
              ↺ {t('deck.mapReset', 'Zurück zum Standort')}
            </button>
          )}
          {!broken && (
            <div className="ml-auto flex w-[min(21rem,100%)] flex-col items-end gap-1.5">
              <div role="group" aria-label={t('deck.mapLayer', 'Kartenansicht')}
                className="pointer-events-auto flex h-9 rounded-full bg-white/95 shadow-md ring-1 ring-black/10 print:hidden">
                {(['map', 'sat'] as const).map(l => (
                  <button key={l} type="button" aria-pressed={view.l === l}
                    onClick={() => { if (l !== view.l) go(view.z, view.px, view.py, l) }}
                    className={`h-full rounded-full px-3 text-xs font-semibold whitespace-nowrap touch-manipulation ${view.l === l ? 'text-white' : 'text-gray-700 hover:bg-black/5'}`}
                    style={view.l === l ? { background: 'rgba(27,27,34,0.88)' } : undefined}>
                    {l === 'sat' ? t('deck.mapLayerSatellite', 'Satellit') : t('deck.mapLayerMap', 'Karte')}
                  </button>
                ))}
              </div>
              <span className="pointer-events-auto max-w-full truncate text-right text-[10px] text-gray-600 bg-white/70 px-1 rounded">
                {view.l === 'sat'
                  ? <>Powered by <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a> · {t('deck.mapImagery', 'Bilder')} © <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a>, Vantor, Earthstar Geographics</>
                  : <>© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a></>}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <a href={openHref} target="_blank" rel="noopener noreferrer" className="text-xs font-medium px-3 py-1.5 rounded-full text-white shadow" style={{ background: 'rgba(27,27,34,0.88)' }}>🗺 {t('deck.openInGoogleMaps', 'In Google Maps öffnen')} →</a>
      </div>
    </div>
  )
}

function FactsBlock(b: Extract<DeckBlock, { type: 'facts' }>) {
  const { t } = useTranslation()
  const items = b.items ?? []
  const mid = Math.ceil(items.length / 2)
  const cols = [items.slice(0, mid), items.slice(mid)]
  // Nur Karte (Website-Stil, deckWeb.tsx): Text und Entfernungen stehen im Abschnitt davor.
  const mapOnly = !b.kicker && !b.headline && items.length === 0
  return (
    <section className={mapOnly ? 'px-5 md:px-20 pb-16' : 'px-5 md:px-20 py-16'} style={{ background: mapOnly ? '#fff' : CREAM }}>
      {!mapOnly && <Accent />}
      <Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 mb-8 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-16">
        {cols.map((col, ci) => (
          <div key={ci}>
            {col.map((it, i) => {
              // min ist oft eine kurze Zahl ("5 min", "300 m"), kann aber auch ein
              // langes Wort sein ("Fußläufig", "Infrastruktur"). Feste Breite + text-2xl
              // ließ lange Werte über das Label laufen ("mehrfach drübergeschrieben").
              // Fix: flexible Mindestbreite (kein Überlauf) + Schriftgröße nach Länge.
              const ml = (it.min ?? '').length
              const sz = ml <= 6 ? 'text-2xl' : ml <= 9 ? 'text-lg' : 'text-base'
              return (
              <div key={i} className="flex items-baseline gap-4 py-3 border-b border-gray-200">
                <span className={`font-heading font-bold shrink-0 whitespace-nowrap min-w-[3.5rem] leading-tight ${sz}`} style={{ color: GOLD }}>{it.min}</span>
                <span className="text-[15px] text-gray-700">{it.label}</span>
              </div>
              )
            })}
          </div>
        ))}
      </div>
      {(b.mapLat != null && b.mapLng != null) ? (
        <OsmMap lat={b.mapLat} lng={b.mapLng} label={b.mapLabel} fallbackImage={b.image}
          openHref={b.mapUrl || `https://www.google.com/maps?q=${b.mapLat},${b.mapLng}`} />
      ) : (b.mapQuery || b.mapEmbed) ? (() => {
      // Ohne Koordinaten: Such-Query als Google-Embed (Ausnahme, Projekte ohne
      // Geocoding). Mit Koordinaten zeichnet OsmMap die Karte selbst.
      const q = encodeURIComponent(b.mapQuery ?? '')
      const src = b.mapEmbed ?? `https://www.google.com/maps/embed?origin=mfe&pb=!1m2!2m1!1s${q}`
      const openHref = b.mapUrl || `https://www.google.com/maps/search/?api=1&query=${q}`
      return (
        <div className="mt-8">
          <div className="relative w-full overflow-hidden rounded-xl border border-gray-200" style={{ aspectRatio: '16 / 9' }}>
            <iframe
              title={b.mapLabel ? t('deck.mapIframeTitleWithLabel', 'Standort {{label}}', { label: b.mapLabel }) : t('deck.mapIframeTitle', 'Standort')}
              src={src}
              className="absolute inset-0 h-full w-full"
              style={{ border: 0 }}
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {b.mapLabel && <span className="text-sm font-semibold px-3 py-1 rounded-full text-white" style={{ background: '#ff795d' }}>📍 {b.mapLabel}</span>}
            <a href={openHref} target="_blank" rel="noopener noreferrer" className="text-xs font-medium px-3 py-1.5 rounded-full text-white shadow ml-auto" style={{ background: 'rgba(27,27,34,0.88)' }}>🗺 {t('deck.openInGoogleMaps', 'In Google Maps öffnen')} →</a>
          </div>
        </div>
      )
      })() : b.image && (() => {
      // Mit Marker: Karte als VOLLBILD (natürliches Seitenverhältnis) — sonst würde
      // object-cover das Bild beschneiden und die %-Marker-Position verrutschen.
      // Ohne Marker: bisheriger 320px-Band-Look (zentrierter Ring egal beim Crop).
      const imgCls = b.mapMarker ? 'w-full h-auto rounded-xl' : 'w-full h-80 object-cover rounded-xl'
      return (
        <div className="relative mt-8">
          {b.mapUrl ? (
            <a href={b.mapUrl} target="_blank" rel="noopener noreferrer" className="block group">
              <Img src={b.image} className={imgCls} />
              <span className="absolute bottom-3 right-3 text-xs font-medium px-3 py-1.5 rounded-full text-white shadow" style={{ background: 'rgba(27,27,34,0.88)' }}>🗺 {t('deck.openInGoogleMaps', 'In Google Maps öffnen')} →</span>
            </a>
          ) : (
            <Img src={b.image} className={imgCls} />
          )}
          {/* Deck-Standard: oranger Kreis um die Lage + Objektname. Position aus
              mapMarker (vom Vision-Detektor erkannt, %-Koordinaten); ohne Marker
              mittig als Fallback. */}
          {b.mapLabel && (
            b.mapMarker ? (
              <div
                className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2"
                style={{ left: `${b.mapMarker.x}%`, top: `${b.mapMarker.y}%` }}
              >
                {/* Ring exakt auf dem Pin-Punkt; Label hängt direkt darunter */}
                <span className="block" style={{ width: 48, height: 48, borderRadius: '9999px', border: '4px solid #ff795d', boxShadow: '0 0 0 5px rgba(255,121,93,0.22)' }} />
                <span className="absolute left-1/2 top-full -translate-x-1/2 mt-2 text-sm font-semibold px-3 py-1 rounded-full text-white shadow-lg whitespace-nowrap" style={{ background: '#ff795d' }}>{b.mapLabel}</span>
              </div>
            ) : (
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <span style={{ width: 56, height: 56, borderRadius: '9999px', border: '4px solid #ff795d', boxShadow: '0 0 0 5px rgba(255,121,93,0.22)' }} />
                <span className="mt-2 text-sm font-semibold px-3 py-1 rounded-full text-white shadow-lg" style={{ background: '#ff795d' }}>{b.mapLabel}</span>
              </div>
            )
          )}
        </div>
      )
      })()}
    </section>
  )
}

function ColumnsBlock(b: Extract<DeckBlock, { type: 'columns' }>) {
  const cols = b.cols ?? []
  return (
    <section>
      {b.image && (
        <div className="relative">
          <Img src={b.image} className="w-full h-[46vh] object-cover" />
          <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,rgba(0,0,0,0.15),rgba(27,27,34,0.85))' }} />
          <div className="absolute bottom-8 left-5 right-5 md:left-20 md:right-8">
            <Accent />
            <Kicker>{b.kicker}</Kicker>
            {b.headline && <h2 className="font-heading font-bold text-white text-3xl md:text-5xl mt-2 leading-tight">{b.headline}</h2>}
          </div>
        </div>
      )}
      <div className="px-5 md:px-20 py-14 grid grid-cols-1 md:grid-cols-3 gap-10" style={{ background: DARK }}>
        {!b.image && (
          <div className="md:col-span-3">
            <Accent /><Kicker>{b.kicker}</Kicker>
            {b.headline && <h2 className="font-heading font-bold text-white text-3xl md:text-4xl mt-2">{b.headline}</h2>}
          </div>
        )}
        {cols.map((c, i) => (
          <div key={i}>
            <h3 className="font-heading font-bold text-2xl" style={{ color: GOLD }}>{c.title}</h3>
            {c.sub && <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-gray-400 mt-1">{c.sub}</p>}
            <p className="text-[14px] leading-relaxed text-gray-300 mt-2">{c.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function FeatureBlock(b: Extract<DeckBlock, { type: 'feature' }>) {
  const { t } = useTranslation()
  return (
    <section>
      <div className="relative">
        <Img src={b.image} className="w-full h-[52vh] object-cover" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg,rgba(0,0,0,0.1),rgba(0,0,0,0.45))' }} />
        <div className="absolute top-8 left-5 right-5 md:left-20 md:right-8">
          <Accent /><Kicker>{b.kicker}</Kicker>
          {b.headline && <h2 className="font-heading font-bold text-white text-4xl md:text-6xl mt-2 leading-tight drop-shadow">{b.headline}</h2>}
        </div>
      </div>
      <div className="px-5 md:px-20 py-12" style={{ background: DARK }}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
          {b.text && <p className="text-[15px] leading-relaxed text-gray-300">{b.text}</p>}
          {b.quote && <p className="font-heading italic text-lg border-l-2 pl-5" style={{ color: GOLD, borderColor: GOLD }}>{b.quote}</p>}
        </div>
        {b.link && (
          <a href={b.link} target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-2 mt-9 px-7 py-3.5 rounded-full font-heading font-semibold text-[15px] shadow-lg transition-transform hover:scale-[1.03]"
             style={{ background: GOLD, color: DARK }}>
            {b.linkLabel ?? t('deck.viewOnline', 'Online ansehen')} <span aria-hidden>→</span>
          </a>
        )}
      </div>
    </section>
  )
}

function GalleryBlock(b: Extract<DeckBlock, { type: 'gallery' }>) {
  const items = b.items ?? []
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 mb-8 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {items.map((it, i) => (
          <div key={i} className="relative rounded-xl overflow-hidden">
            <Img src={it.image} className="w-full h-72 object-cover" />
            {(it.title || it.caption) && (
              <div className="absolute bottom-0 inset-x-0 p-4" style={{ background: 'linear-gradient(transparent,rgba(0,0,0,0.7))' }}>
                {it.title && <p className="font-heading font-bold text-white text-lg">{it.title}</p>}
                {it.caption && <p className="text-xs text-gray-200">{it.caption}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
      {b.note && <div className="mt-6 rounded-xl px-5 py-3 text-[13px] text-gray-700 border-l-2" style={{ background: '#fff', borderColor: GOLD }} dangerouslySetInnerHTML={{ __html: b.note }} />}
    </section>
  )
}

// Lageplan der Gesamtanlage: Bauträgerplan gross, darunter die Legende (Club House,
// Park, Gebäude) und die Merkmale der Anlage. Ersetzt das bisherige Loch zwischen
// „Standort" und „Wohnung" — der Kunde sieht, wo im Areal er landet.
function MasterplanBlock(b: Extract<DeckBlock, { type: 'masterplan' }>) {
  const legend = b.legend ?? []
  const features = b.features ?? []
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      {b.intro && <p className="text-[15px] leading-relaxed text-gray-700 mt-4 max-w-3xl">{b.intro}</p>}
      <Img src={b.image} w={2400} className="w-full h-auto max-h-[720px] object-contain bg-white rounded-xl border border-gray-200 p-2 md:p-4 mt-8" />
      {b.caption && <p className="text-[12px] text-gray-500 mt-3 max-w-3xl">{b.caption}</p>}
      {legend.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5 mt-8">
          {legend.map((l, i) => (
            <div key={i} className="bg-white rounded-xl p-5 border-t-2" style={{ borderColor: GOLD }}>
              <div className="flex items-center gap-3">
                {l.n && <span className="w-8 h-8 rounded-md flex items-center justify-center text-[13px] font-bold shrink-0" style={{ background: '#f3ead7', color: GOLD }}>{l.n}</span>}
                <h3 className="font-heading font-bold text-lg" style={{ color: INK }}>{l.title}</h3>
              </div>
              {(l.items ?? []).length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {(l.items ?? []).map((it, j) => (
                    <li key={j} className="flex gap-2.5 text-[13.5px] leading-snug text-gray-700">
                      <span className="shrink-0" style={{ color: GOLD }}>·</span><span>{it}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
      {features.length > 0 && (
        <div className="flex flex-wrap gap-2.5 mt-8">
          {features.map((f, i) => (
            <span key={i} className="rounded-full bg-white px-4 py-2 text-[13px] text-gray-700 border" style={{ borderColor: '#e6ddc9' }}>{f}</span>
          ))}
        </div>
      )}
      {b.note && <div className="mt-6 rounded-xl px-5 py-3 text-[13px] text-gray-700 border-l-2 bg-white" style={{ borderColor: GOLD }} dangerouslySetInnerHTML={{ __html: b.note }} />}
    </section>
  )
}

// Gemeinschaftsanlagen: je Anlage ein Render UND — wo vorhanden — der echte
// Grundriss des Bauträgers mit Flächen. Genau das, was die Bauträger-Broschüre
// zeigt und was im Deck bisher fehlte.
function AmenityBlock(b: Extract<DeckBlock, { type: 'amenity' }>) {
  const items = b.items ?? []
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      {b.intro && <p className="text-[15px] leading-relaxed text-gray-700 mt-4 max-w-3xl">{b.intro}</p>}
      <div className="space-y-12 mt-10">
        {items.map((it, i) => (
          <div key={i}>
            <Img src={it.image} className="w-full h-[38vh] md:h-[52vh] object-cover rounded-xl" />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mt-6">
              <div>
                <h3 className="font-heading font-bold text-2xl md:text-3xl" style={{ color: INK }}>{it.title}</h3>
                {it.text && <p className="text-[15px] leading-relaxed text-gray-700 mt-3">{it.text}</p>}
                {(it.stats ?? []).length > 0 && (
                  <div className="grid grid-cols-2 gap-3 mt-5">
                    {(it.stats ?? []).map((s, j) => (
                      <div key={j} className="rounded-xl p-4 border-t-2 bg-white" style={{ borderColor: GOLD }}>
                        <p className="font-heading font-bold text-2xl break-words" style={{ color: INK }}>{s.value}<span className="text-sm text-gray-400 ml-1">{s.unit}</span></p>
                        <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-1">{s.label}</p>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {it.plan && (
                <div>
                  <Img src={it.plan} w={2400} className="w-full h-auto max-h-[420px] object-contain bg-white rounded-xl border border-gray-200 p-3" />
                  {it.planLabel && <p className="text-[12px] text-gray-500 mt-2">{it.planLabel}</p>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {b.note && <div className="mt-8 rounded-xl px-5 py-3 text-[13px] text-gray-700 border-l-2 bg-white" style={{ borderColor: GOLD }} dangerouslySetInnerHTML={{ __html: b.note }} />}
    </section>
  )
}

function BenefitsBlock(b: Extract<DeckBlock, { type: 'benefits' }>) {
  const cards = b.cards ?? []
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 mb-8 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {cards.map((c, i) => (
          <div key={i} className="bg-white rounded-xl p-5 border-t-2" style={{ borderColor: GOLD }}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm mb-3" style={{ background: '#f3ead7', color: GOLD }}>{c.icon ?? '★'}</div>
            <h3 className="font-heading font-bold text-lg" style={{ color: INK }}>{c.title}</h3>
            <p className="text-[13px] leading-relaxed text-gray-600 mt-1.5">{c.text}</p>
          </div>
        ))}
      </div>
    </section>
  )
}

function InventoryBlock(b: Extract<DeckBlock, { type: 'inventory' }>) {
  const groups = b.groups ?? []
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      {b.intro && <p className="text-[15px] leading-relaxed text-gray-700 mt-4 max-w-3xl">{b.intro}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-8">
        {groups.map((g, i) => (
          <div key={i} className="bg-white rounded-xl p-6 border-t-2" style={{ borderColor: GOLD }}>
            <div className="flex items-center gap-3 mb-4">
              <span className="w-9 h-9 rounded-full flex items-center justify-center text-sm shrink-0" style={{ background: '#f3ead7', color: GOLD }}>{g.icon ?? '✦'}</span>
              <h3 className="font-heading font-bold text-xl" style={{ color: INK }}>{g.title}</h3>
            </div>
            <ul className="space-y-2">
              {(g.items ?? []).map((it, j) => (
                <li key={j} className="flex gap-2.5 text-[14px] leading-snug text-gray-700">
                  <span className="shrink-0 mt-0.5" style={{ color: GOLD }}>✓</span>
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      {b.note && <div className="mt-6 rounded-xl px-5 py-4 text-[14px] font-medium text-gray-800 border-l-2" style={{ background: '#fff', borderColor: GOLD }} dangerouslySetInnerHTML={{ __html: b.note }} />}
    </section>
  )
}

// Sauberes Grundriss-Modell aus Raum-Rechtecken (SVG-Raum 0..600 × 0..600).
// Innenräume: helle Füllung + dunkle Wände; Terrasse: coral, gestrichelt, außenliegend;
// Küche: Gold-Akzent. Labels = Raumname + Fläche. Ersetzt unübersichtliche Plan-Bilder.
function FloorplanSchematic({ rooms, note }: { rooms: FloorplanRoom[]; note?: string }) {
  const { t } = useTranslation()
  const CORAL = '#ff795d'
  const inner = rooms.filter(r => r.kind !== 'terrace')
  const minX = Math.min(...inner.map(r => r.x)), minY = Math.min(...inner.map(r => r.y))
  const maxX = Math.max(...inner.map(r => r.x + r.w)), maxY = Math.max(...inner.map(r => r.y + r.h))
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 md:p-6">
      <svg viewBox="0 0 600 600" className="w-full h-auto" role="img" aria-label={t('deck.floorplanModelAriaLabel', 'Grundriss-Modell')}>
        {/* Außenwand um die Innenräume */}
        <rect x={minX} y={minY} width={maxX - minX} height={maxY - minY} fill="none" stroke={DARK} strokeWidth="6" rx="3" />
        {rooms.map((r, i) => {
          const terrace = r.kind === 'terrace'
          const kitchen = r.kind === 'kitchen'
          const fill = terrace ? 'rgba(255,121,93,0.10)' : kitchen ? 'rgba(194,161,94,0.16)' : '#faf6ec'
          const stroke = terrace ? CORAL : DARK
          const cx = r.x + r.w / 2
          return (
            <g key={i}>
              <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={fill} stroke={stroke}
                strokeWidth={terrace ? 2.5 : 3} strokeDasharray={terrace ? '7 6' : undefined} rx="2" />
              <text x={cx} y={r.y + r.h / 2 - (r.area ? 8 : 0)} textAnchor="middle" dominantBaseline="middle"
                fontSize="18" fontWeight="700" fill={INK} fontFamily="Montserrat, sans-serif">{r.name}</text>
              {r.area && <text x={cx} y={r.y + r.h / 2 + 15} textAnchor="middle" dominantBaseline="middle"
                fontSize="14" fontWeight="600" fill={terrace ? CORAL : GOLD} fontFamily="Montserrat, sans-serif">{r.area}</text>}
            </g>
          )
        })}
      </svg>
      {note && <p className="mt-3 text-xs text-gray-500">{note}</p>}
    </div>
  )
}

function FloorplanBlock(b: Extract<DeckBlock, { type: 'floorplan' }>) {
  const { t } = useTranslation()
  // Eingeklappt unter der eigenen Wohnung (Sammel-Decks, siehe webBlocks).
  if (b.collapsed) {
    const { collapsed: _c, ...open } = b
    return (
      <details className="px-5 md:px-20 pb-8 -mt-4 group" style={{ background: CREAM }}>
        <summary className="cursor-pointer list-none inline-flex items-center gap-2 text-sm font-semibold py-2" style={{ color: INK }}>
          <span className="transition-transform group-open:rotate-90" style={{ color: GOLD }}>▸</span>
          {t('deck.floorplanToggle', 'Grundriss und Flächen ansehen')}
        </summary>
        <div className="-mx-5 md:-mx-20"><FloorplanBlock {...open} /></div>
      </details>
    )
  }
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 mb-8 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      {/* rooms = schematischer Einzelwohnungs-Grundriss (sauberes Modell, statt z.B. eines
          ganzen Lageplans). Sonst: Grundriss-Bild VOLLBREIT, object-contain = nicht verzerrt. */}
      {b.rooms && b.rooms.length
        ? <FloorplanSchematic rooms={b.rooms} note={b.planNote} />
        : (
          <>
            <Img src={b.image} w={2400} className="w-full h-auto max-h-[660px] object-contain bg-white rounded-xl border border-gray-200 p-3 md:p-5" />
            {/* Flächen-/Maß-Note (hp-floorplan): echte m² als Text statt KI-gemalter
                Maßketten — der image-Zweig ließ planNote bisher stumm unter den Tisch fallen. */}
            {b.planNote && <p className="text-[12px] text-gray-500 mt-3 max-w-3xl">{b.planNote}</p>}
          </>
        )}
      {b.stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-8">
          {b.stats.map((s, i) => (
            <div key={i} className="rounded-xl p-4 border-t-2 bg-white" style={{ borderColor: GOLD }}>
              <p className="font-heading font-bold text-2xl md:text-3xl break-words" style={{ color: INK }}>{s.value}<span className="text-sm text-gray-400 ml-1">{s.unit}</span></p>
              <p className="text-[11px] uppercase tracking-wide text-gray-500 mt-1">{s.label}</p>
            </div>
          ))}
        </div>
      )}
      {b.bullets && (
        <div className="space-y-2.5 mt-6 max-w-3xl">
          {b.bullets.map((bl, i) => (
            <div key={i} className="flex gap-3 text-[14px] text-gray-700">
              <span style={{ color: GOLD }}>—</span>
              <span>{bl.strong && <strong className="text-gray-900">{bl.strong} </strong>}{bl.text}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function PaymentPhaseCard({ phase, dark }: { phase?: import('../lib/deckTypes').DeckPaymentPhase; dark?: boolean }) {
  if (!phase) return null
  return (
    <div className="rounded-xl p-5 border-t-2" style={{ borderColor: GOLD, background: dark ? DARK : '#fff' }}>
      {phase.label && <p className="text-[11px] font-semibold uppercase tracking-[0.15em]" style={{ color: GOLD }}>{phase.label}</p>}
      {phase.title && <p className="font-heading font-bold text-xl mt-1" style={{ color: dark ? '#fff' : INK }}>{phase.title}</p>}
      <div className="mt-4 space-y-3">
        {(phase.rows ?? []).map((r, i) => (
          <div key={i} className="flex items-start justify-between gap-4 border-b border-gray-200/40 pb-2">
            <div>
              <p className={`text-sm font-medium ${dark ? 'text-gray-100' : 'text-gray-800'}`}>{r.label}</p>
              {r.sub && <p className="text-[11px] text-gray-400">{r.sub}</p>}
            </div>
            <p className={`text-sm font-semibold whitespace-nowrap ${dark ? 'text-white' : 'text-gray-900'}`}>{r.value}</p>
          </div>
        ))}
      </div>
      {(phase.sumLabel || phase.sumValue) && (
        <div className="flex items-center justify-between mt-3 rounded-lg px-3 py-2" style={{ background: dark ? 'rgba(255,255,255,0.08)' : '#f3ead7' }}>
          <span className={`text-xs font-semibold uppercase tracking-wide ${dark ? 'text-gray-200' : 'text-gray-600'}`}>{phase.sumLabel}</span>
          <span className={`font-heading font-bold ${dark ? 'text-white' : 'text-gray-900'}`}>{phase.sumValue}</span>
        </div>
      )}
      {phase.advantage && (
        <div className="mt-3 rounded-lg px-3 py-2 text-[12px]" style={{ background: 'rgba(194,161,94,0.15)', color: dark ? '#e8dcc2' : '#7a6534' }} dangerouslySetInnerHTML={{ __html: phase.advantage }} />
      )}
    </div>
  )
}

function PaymentBlock(b: Extract<DeckBlock, { type: 'payment' }>) {
  const { t } = useTranslation()
  // Kurzzeit-Wohnungen dieses Decks laut Berechnung (siehe VatRefundCtx)
  const { byUnit, units } = useContext(VatRefundCtx)
  const kurz = units.filter(u => byUnit[unitNorm(u)])
  const anteilig = kurz.some(u => byUnit[unitNorm(u)].letMonths < 12)
  const refundNote = !kurz.length ? null
    : anteilig ? t('deck.vatRefundNotePartial', 'Bei Kurzzeitvermietung wird die MwSt. anteilig erstattet ({{units}}).', { units: kurz.join(', ') })
    : kurz.length === units.length ? t('deck.vatRefundNote', 'Bei Kurzzeitvermietung wird die MwSt. erstattet.')
    : t('deck.vatRefundNoteUnits', 'Bei Kurzzeitvermietung wird die MwSt. erstattet ({{units}}).', { units: kurz.join(', ') })
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      {b.intro && <p className="text-[15px] leading-relaxed text-gray-700 mt-4 max-w-3xl">{b.intro}</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-8">
        <PaymentPhaseCard phase={b.phase1} />
        <PaymentPhaseCard phase={b.phase2} dark />
      </div>
      {/* MwSt.-Berechnung als fester Bestandteil (Standard): Netto → MwSt → Brutto.
          Zyperns Bauträger weisen netto aus; der Brutto-Gesamtpreis muss klar erkennbar sein. */}
      {b.priceSummary && (
        <div className="mt-6 sm:max-w-md sm:ml-auto rounded-xl border-2 bg-white px-5 py-4" style={{ borderColor: GOLD }}>
          <div className="flex items-center justify-between text-sm text-gray-600"><span>{t('deck.netPrice', 'Nettopreis')}</span><span className="font-semibold text-gray-900">{b.priceSummary.net}</span></div>
          <div className="flex items-center justify-between text-sm text-gray-600 mt-1.5"><span>{t('deck.plusVat', 'zzgl. MwSt. ({{rate}})', { rate: b.priceSummary.vatRate ?? '19 %' })}</span><span className="font-semibold text-gray-900">{b.priceSummary.vat}</span></div>
          <div className="flex items-center justify-between mt-2.5 pt-2.5 border-t border-gray-200"><span className="font-heading font-bold" style={{ color: INK }}>{t('deck.grossPriceTotal', 'Bruttopreis gesamt')}</span><span className="font-heading font-bold text-2xl" style={{ color: INK }}>{b.priceSummary.gross}</span></div>
          {refundNote && <p className="text-[13px] font-semibold mt-2.5 pt-2.5 border-t border-gray-200" style={{ color: GOLD }}>{refundNote}</p>}
        </div>
      )}
      {!b.priceSummary && refundNote && <p className="mt-6 text-[13px] font-semibold" style={{ color: GOLD }}>{refundNote}</p>}
      {b.note && <div className="mt-6 rounded-xl px-5 py-3 text-[12px] text-gray-700 border-l-2" style={{ background: '#fff', borderColor: GOLD }} dangerouslySetInnerHTML={{ __html: b.note }} />}
    </section>
  )
}

function CtaBlock(b: Extract<DeckBlock, { type: 'cta' }>) {
  const { t } = useTranslation()
  const termin = useContext(TerminCtx)
  return (
    <section className="px-5 md:px-20 py-20" style={{ background: DARK }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-white text-5xl md:text-7xl mt-2 leading-none">{b.headline}</h2>}
      {b.text && <p className="text-[15px] leading-relaxed text-gray-300 mt-5 max-w-3xl">{b.text}</p>}
      {b.steps && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-10">
          {b.steps.map((s, i) => (
            <div key={i} className="rounded-xl p-5 border" style={{ borderColor: 'rgba(194,161,94,0.4)' }}>
              <p className="font-heading font-bold text-2xl" style={{ color: GOLD }}>{s.n}</p>
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-white mt-2">{s.title}</p>
              <p className="text-[13px] text-gray-400 mt-1.5">{s.text}</p>
            </div>
          ))}
        </div>
      )}
      {termin && (
        <a href={termin} className="inline-block mt-10 px-7 py-3.5 rounded-full font-semibold text-[15px] shadow-lg transition-transform hover:scale-[1.03] print:hidden" style={{ background: GOLD, color: DARK }}>
          📅 {t('deck.ctaTermin', 'Strategiegespräch mit Sven buchen')} <span aria-hidden>→</span>
        </a>
      )}
      {termin && (
        <div className="mt-8 rounded-2xl px-6 py-5 border max-w-3xl print:hidden" style={{ borderColor: 'rgba(194,161,94,0.4)' }}>
          <p className="font-heading font-bold text-white text-xl">{t('deck.altTitle', 'Passt das Projekt nicht ganz?')}</p>
          <p className="text-[14px] text-gray-300 mt-1.5">{t('deck.altText', 'Beantworte vier kurze Fragen. Dann zeigt dir Sven Alternativen, die zu dir passen.')}</p>
          <a href={altUrl(termin)} className="inline-block mt-4 px-6 py-2.5 rounded-full font-semibold text-[14px] text-white border hover:bg-white/10 transition" style={{ borderColor: 'rgba(194,161,94,0.6)' }}>
            {t('deck.altButton', 'Passende Alternativen finden')} <span aria-hidden>→</span>
          </a>
        </div>
      )}
      {/* Kontakt + Foto */}
      <div className="mt-12 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-6 items-center rounded-2xl px-6 py-6" style={{ background: 'rgba(194,161,94,0.1)' }}>
        <img src={sizedImg(DECK_PHOTO, 400)} alt={DECK_CONTACT.name} className="h-28 w-28 md:h-32 md:w-32 object-cover rounded-2xl shadow-lg shrink-0" onError={e => { const el = e.currentTarget as HTMLImageElement; if (el.src !== DECK_PHOTO) el.src = DECK_PHOTO; else el.style.display = 'none' }} />
        <div>
          <p className="font-heading font-bold text-white text-2xl">{DECK_CONTACT.name}</p>
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] mt-0.5" style={{ color: GOLD }}>{DECK_CONTACT.company}</p>
          <p className="text-sm text-gray-300 mt-2">{DECK_CONTACT.phone} · {DECK_CONTACT.email}</p>
          <p className="text-xs text-gray-400">{DECK_CONTACT.web} · {DECK_CONTACT.address}</p>
        </div>
      </div>

      {/* Folge mir — offensiv */}
      <div className="mt-8">
        <p className="font-heading font-bold text-white text-2xl md:text-3xl">{t('deck.followMeHeadline', 'Folge mir — ich nehme dich mit nach Zypern.')}</p>
        <p className="text-sm text-gray-400 mt-1">{t('deck.followMeSubline', 'Projekte, Baufortschritt, Markt-Insights — schau rein und folge:')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
          {DECK_CONTACT.socials.map((s, i) => {
            const inner = (
              <div className="flex items-center gap-3 rounded-xl px-4 py-3 transition-colors" style={{ background: 'rgba(255,255,255,0.06)' }}>
                <span className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0" style={{ background: GOLD, color: DARK }}>{s.icon}</span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: GOLD }}>{s.platform}</p>
                  <p className="text-sm text-white truncate">{s.handle}</p>
                </div>
              </div>
            )
            return s.url
              ? <a key={i} href={s.url} target="_blank" rel="noopener noreferrer" className="hover:opacity-80 transition-opacity">{inner}</a>
              : <div key={i}>{inner}</div>
          })}
        </div>
      </div>
    </section>
  )
}

function MarinaBlock(b: Extract<DeckBlock, { type: 'marina' }>) {
  const { t } = useTranslation()
  const CORAL = '#ff795d'
  const from  = b.fromLabel ?? 'Royal Horizon'
  const to    = b.toLabel ?? t('deck.marinaDefaultTo', 'Paphos-Marina')
  const dist  = b.distance ?? '~5 km'
  const drive = b.drive ?? t('deck.marinaDefaultDrive', 'direkt um die Ecke')
  const pct   = b.valuePct ?? '+30%'
  const fromSub = b.fromSub                              // Ort des Objekts (z.B. „Tala", „Chlorakas") — projektabhängig
  const toSub   = b.toSub ?? t('deck.marinaDefaultToSub', 'Potima Bay · Kissonerga')  // Marina-Standort (überall gleich)
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent />
      <Kicker>{b.kicker ?? t('deck.marinaDefaultKicker', 'Lage · Neue Paphos-Marina')}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 mb-8 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 items-center">
        {/* Schematische Karte: Haus → Route + Entfernung → Marina */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <svg viewBox="0 0 560 240" className="w-full h-auto" role="img" aria-label={t('deck.marinaRouteAriaLabel', 'Weg von {{from}} zur {{to}}', { from, to })}>
              {/* Route (gestrichelt) */}
              <path d="M72 168 C 190 96, 360 222, 484 150" fill="none" stroke={GOLD} strokeWidth="5" strokeDasharray="2 13" strokeLinecap="round" />
              {/* Haus links */}
              <g>
                <rect x="42" y="122" width="68" height="56" rx="3" fill={DARK} />
                <path d="M34 122 L76 86 L118 122 Z" fill={CORAL} />
                <rect x="60" y="148" width="18" height="30" rx="1.5" fill={CREAM} />
                <rect x="86" y="134" width="16" height="16" rx="1.5" fill={GOLD} />
              </g>
              <text x="76" y="200" textAnchor="middle" fontSize="14" fontWeight="700" fill={INK} fontFamily="Montserrat, sans-serif">{from}</text>
              {fromSub && <text x="76" y="219" textAnchor="middle" fontSize="11" fill="#8a8a8a" fontFamily="Montserrat, sans-serif">{fromSub}</text>}
              {/* Marina rechts: Wasser + Segelboote */}
              <g>
                <ellipse cx="482" cy="172" rx="70" ry="20" fill="#bfe0ea" />
                <path d="M420 172 q 12 -7 24 0 t 24 0 t 24 0 t 24 0 t 24 0" fill="none" stroke="#7fb6c8" strokeWidth="2.5" />
                <g transform="translate(452,116)"><path d="M14 0 L14 42 L0 42 Z" fill="#ffffff" stroke={GOLD} strokeWidth="1.5" /><path d="M16 8 L31 42 L16 42 Z" fill={CORAL} /><rect x="-3" y="42" width="38" height="7" rx="3.5" fill={DARK} /></g>
                <g transform="translate(496,132)"><path d="M11 0 L11 30 L0 30 Z" fill={CORAL} /><rect x="-2" y="30" width="28" height="6" rx="3" fill={DARK} /></g>
              </g>
              <text x="482" y="206" textAnchor="middle" fontSize="14" fontWeight="700" fill={INK} fontFamily="Montserrat, sans-serif">{to}</text>
              <text x="482" y="225" textAnchor="middle" fontSize="11" fill="#8a8a8a" fontFamily="Montserrat, sans-serif">{toSub}</text>
              {/* Entfernungs-Pille auf der Route */}
              <g transform="translate(286,74)">
                <path d="M0 22 L0 64" stroke={GOLD} strokeWidth="2" strokeDasharray="2 4" />
                <rect x="-70" y="-22" width="140" height="44" rx="22" fill={DARK} />
                <text x="0" y="-2" textAnchor="middle" fontSize="17" fontWeight="800" fill="#ffffff" fontFamily="Montserrat, sans-serif">{dist}</text>
                <text x="0" y="14" textAnchor="middle" fontSize="10" fill={GOLD} fontFamily="Montserrat, sans-serif">{drive}</text>
              </g>
            </svg>
          </div>
        </div>
        {/* +30 % Wertsteigerung */}
        <div className="lg:col-span-2">
          <div className="rounded-2xl p-7 text-center shadow-md" style={{ background: CORAL }}>
            <div className="font-heading font-extrabold leading-none text-white" style={{ fontSize: 'clamp(52px, 9vw, 88px)' }}>{pct}</div>
            <div className="mt-1 text-white font-semibold uppercase tracking-[0.16em] text-sm">{t('deck.valueIncrease', 'Wertsteigerung')}</div>
          </div>
          {b.valueText && <p className="mt-4 text-[15px] leading-relaxed text-gray-700">{b.valueText}</p>}
        </div>
      </div>
      {b.note && <p className="mt-6 text-xs text-gray-400">{b.note}</p>}
    </section>
  )
}

// Normalisiert eine beliebige Video-URL in eine iframe-Embed-Quelle. Deckt YouTube
// (watch/youtu.be/embed), Vimeo und Google-Drive-Datei-Links ab. null = kein Embed
// bekannt → dann wird (falls es eine direkte Mediendatei ist) nativ abgespielt.
function toEmbedSrc(url: string): string | null {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/)
  // enablejsapi: damit der Autostart (VideoBlock) den Player per postMessage steuern kann
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt[1]}?rel=0&modestbranding=1&enablejsapi=1&playsinline=1`
  const vimeo = url.match(/vimeo\.com\/(?:video\/)?(\d+)/)
  if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`
  const drive = url.match(/drive\.google\.com\/file\/d\/([\w-]+)/)
  if (drive) return `https://drive.google.com/file/d/${drive[1]}/preview`
  return null
}
const isDirectVideo = (url: string) => /\.(mp4|webm|ogg|mov|m4v)(\?|#|$)/i.test(url)

// VideoAutoCtx (aus deckWeb): false = Videos dieser Ansicht nicht von selbst starten
// (Scroll-Seite hinter dem Buchmodus, Druckansicht). Im Buchmodus gilt true nur für die aufgeschlagene Seite.

// ── Video-Sektion (Drohnen-/Meerblick-Video o.Ä.) ────────────────────────────
// Nimmt embedUrl (iframe) ODER videoUrl (direktes MP4) an und normalisiert selbst,
// damit auch eine YouTube-URL im videoUrl-Feld korrekt eingebettet wird.
// Autostart (Sven 19.10.26): Ein Video startet, sobald es zur Hälfte im Bild ist
// oder man mit der Maus darüber fährt, und hält an, wenn man weiterscrollt. Wer
// selbst auf Pause drückt, bekommt keinen Neustart aufgezwungen; ein zu Ende
// gelaufener Film startet nicht neu. Der Autostart läuft stumm (Browser erlauben
// Ton ohne Klick nicht, und Ton aus dem Nichts stört), den Ton schaltet man über
// das Lautsprecher-Symbol ein. YouTube und Vimeo werden per postMessage gesteuert,
// Google-Drive-Vorschauen bleiben Klick.
function VideoBlock(b: Extract<DeckBlock, { type: 'video' }>) {
  const { t } = useTranslation()
  const raw = (b.embedUrl || b.videoUrl || '').trim()
  const embedSrc = b.embedUrl ? (toEmbedSrc(b.embedUrl) ?? (isDirectVideo(b.embedUrl) ? null : b.embedUrl)) : toEmbedSrc(raw)
  const nativeSrc = embedSrc ? null : (b.videoUrl && isDirectVideo(b.videoUrl) ? b.videoUrl : (isDirectVideo(raw) ? raw : null))
  const autoAktiv = useContext(VideoAutoCtx)
  const imBuch = useContext(InBookCtx)
  const boxRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const sichtbar = useRef(false)
  const nutzerPause = useRef(false)   // Nutzer hat selbst pausiert
  const wirPausieren = useRef(false)  // die nächste pause-Meldung kommt vom Autostart
  const schonGestartet = useRef(false) // stumm nur beim ersten Autostart, danach bleibt der Ton, wie der Nutzer ihn gestellt hat
  const anFrame = (msg: object) => frameRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*')
  const istYt = !!embedSrc && embedSrc.includes('youtube')
  const istVimeo = !!embedSrc && embedSrc.includes('vimeo')
  const starten = () => {
    if (!autoAktiv) return
    const ersterStart = !schonGestartet.current
    const v = videoRef.current
    if (v) {
      if (nutzerPause.current || !v.paused || v.ended) return
      if (ersterStart) v.muted = true
      schonGestartet.current = true
      v.play().catch(() => {})
    } else if (istYt) {
      schonGestartet.current = true
      if (ersterStart) anFrame({ event: 'command', func: 'mute', args: '' })
      anFrame({ event: 'command', func: 'playVideo', args: '' })
    } else if (istVimeo) {
      schonGestartet.current = true
      if (ersterStart) anFrame({ method: 'setVolume', value: 0 })
      anFrame({ method: 'play' })
    }
  }
  const anhalten = () => {
    const v = videoRef.current
    if (v) {
      if (!v.paused) { wirPausieren.current = true; v.pause() }
    } else if (istYt) anFrame({ event: 'command', func: 'pauseVideo', args: '' })
    else if (istVimeo) anFrame({ method: 'pause' })
  }
  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([e]) => {
      sichtbar.current = e.isIntersecting && e.intersectionRatio >= 0.5
      if (sichtbar.current) starten(); else anhalten()
    }, { threshold: [0, 0.5] })
    io.observe(box)
    return () => io.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedSrc, nativeSrc, autoAktiv])
  useEffect(() => { if (!autoAktiv) anhalten() }, [autoAktiv]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!embedSrc && !nativeSrc) return null
  // Das Seitenverhaeltnis aus den Projektdaten ist nur die erste Schaetzung: Google
  // Drive meldet fuer manche Dateien falsche Masse (Show-House-Clip: 816x960 laut
  // Drive, tatsaechlich 1280x720). Sobald der Player die echten Masse kennt, gilt
  // er — sonst laeuft ein Querformat-Video in einem Hochformat-Rahmen.
  const [echtAspekt, setEchtAspekt] = useState<number | null>(null)
  const geschaetzt = (b.aspect ?? '16/9')
  const [gw, gh] = geschaetzt.split('/').map(Number)
  const verhaeltnis = echtAspekt ?? (gh ? gw / gh : 16 / 9)
  const hoch = verhaeltnis < 0.95
  const seiten = `${verhaeltnis}`
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: DARK }}>
      <Accent /><Kicker light>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-white text-4xl md:text-6xl mt-2 leading-tight">{b.headline}</h2>}
      {b.text && <p className="text-[15px] leading-relaxed text-gray-300 mt-4 max-w-2xl">{b.text}</p>}
      {/* Bautraeger liefern auch Hochformat (Reels vom Musterhaus, Sauna-Clip). In
          einem 16:9-Rahmen liefe das mit schwarzen Balken links und rechts, deshalb
          bekommt jedes Format seinen eigenen Rahmen: hoch = schmal und zentriert. */}
      {/* Im Buchmodus haben alle Videos denselben Rahmen (halbe Seitenhöhe, volle
          Breite), das Video steht darin ganz, dahinter das Standbild unscharf. */}
      <div ref={boxRef} onMouseEnter={starten}
           className={`mt-8 relative overflow-hidden rounded-xl border ${hoch && !imBuch ? 'w-full max-w-sm mx-auto' : 'w-full'}`}
           style={imBuch
             ? { height: 'calc(var(--hp-book-h, 600px) * 0.5)', borderColor: 'rgba(194,161,94,0.3)', background: '#0e0e13' }
             : { aspectRatio: seiten, borderColor: 'rgba(194,161,94,0.3)' }}>
        {imBuch && !embedSrc && b.poster && (
          <img src={sizedImg(b.poster, 640)} alt="" aria-hidden
            className="absolute inset-0 h-full w-full object-cover scale-110 blur-xl opacity-50 pointer-events-none" />
        )}
        {embedSrc ? (
          <iframe
            ref={frameRef}
            onLoad={() => { if (sichtbar.current) starten() }}
            title={b.headline || t('deck.videoIframeTitle', 'Video')}
            src={embedSrc}
            className="absolute inset-0 h-full w-full"
            style={{ border: 0 }}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
            allowFullScreen
          />
        ) : (
          <video
            ref={videoRef}
            className={`absolute inset-0 h-full w-full ${hoch || imBuch ? 'object-contain' : 'object-cover'}`}
            src={nativeSrc ?? undefined}
            aria-label={b.headline || undefined}
            onLoadedMetadata={e => {
              const v = e.currentTarget
              if (v.videoWidth && v.videoHeight) setEchtAspekt(v.videoWidth / v.videoHeight)
            }}
            onPlay={() => { nutzerPause.current = false }}
            onPause={e => {
              if (wirPausieren.current) wirPausieren.current = false
              else if (!e.currentTarget.ended) nutzerPause.current = true
            }}
            poster={sizedImg(b.poster)}
            controls
            playsInline
            preload="metadata"
          />
        )}
      </div>
      {b.caption && <p className="mt-3 text-sm italic text-gray-400">{b.caption}</p>}
    </section>
  )
}

function Block({ block }: { block: AnyBlock }) {
  if (isWebBlock(block)) return <WebBlockView block={block} />
  switch (block.type) {
    case 'marina':    return <MarinaBlock {...block} />
    case 'video':     return <VideoBlock {...block} />
    case 'cover':     return <CoverBlock {...block} />
    case 'letter':    return <LetterBlock {...block} />
    case 'unit':      return <UnitBlock {...block} />
    case 'facts':     return <FactsBlock {...block} />
    case 'columns':   return <ColumnsBlock {...block} />
    case 'feature':   return <FeatureBlock {...block} />
    case 'gallery':   return <GalleryBlock {...block} />
    case 'masterplan':return <MasterplanBlock {...block} />
    case 'amenity':   return <AmenityBlock {...block} />
    case 'benefits':  return <BenefitsBlock {...block} />
    case 'inventory': return <InventoryBlock {...block} />
    case 'floorplan': return <FloorplanBlock {...block} />
    case 'payment':   return <PaymentBlock {...block} />
    case 'cta':       return <CtaBlock {...block} />
    default:          return null
  }
}

// ── Kontakt-Leiste + „Mehr Infos" (Sven 11.10.26) ──────────────────────────
// Auswertung Newsletter 10.10.: drei Viertel der Besucher kamen nie bis zum
// Abschluss-Block am Seitenende, einen Kontakt-Knopf gab es sonst nirgends.
// Jetzt: feste Leiste unten (WhatsApp, Termin, Mehr Infos) und ein
// kurzer Zwischen-Aufruf nach dem Grundriss. „Mehr Infos" ist die kleinere Hürde
// als ein Termin: Unterlagen anfordern, Sven bekommt eine Aufgabe und antwortet
// persönlich. Automatisch geht an den Kunden nichts raus.
const REF_RE = /^[ls]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const WA_NUMBER = DECK_CONTACT.phone.replace(/\D/g, '')
const PRIVACY_URL = 'https://steuervorteil-zypern-immobilien.com/datenschutz/'
const INFO_WANTS = ['grundriss', 'zahlungsplan', 'rechnung', 'ablauf'] as const

// Newsletter-Klicks kommen mit Empfänger-Kennung (hpr) und Kampagne (hpc), siehe
// track-engagement nl_click. Damit weiß das CRM, wer die Wohnung ansieht.
function readRef(): { ref: string | null; campaign: string | null } {
  try {
    const p = new URLSearchParams(window.location.search)
    const ref = p.get('hpr') ?? '', campaign = p.get('hpc') ?? ''
    return { ref: REF_RE.test(ref) ? ref.toLowerCase() : null, campaign: UUID_RE.test(campaign) ? campaign : null }
  } catch { return { ref: null, campaign: null } }
}

interface DeckPerson { known: boolean; first_name: string | null; booking_url: string }

function ActionBar({ onInfo, terminUrl, waUrl }: { onInfo: () => void; terminUrl: string; waUrl: string }) {
  const { t } = useTranslation()
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 sm:bottom-5 sm:flex sm:justify-center pointer-events-none print:hidden">
      <div className="pointer-events-auto flex items-center gap-2 px-3 pt-2.5 sm:px-2.5 sm:rounded-full shadow-2xl"
        style={{ background: 'rgba(27,27,34,0.97)', paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>
        <a href={waUrl} target="_blank" rel="noopener noreferrer" aria-label={t('deck.waLabel', 'WhatsApp an Sven')} title={t('deck.waLabel', 'WhatsApp an Sven')}
          className="w-11 h-11 shrink-0 rounded-full flex items-center justify-center text-lg bg-white/10 hover:bg-white/20 transition">💬</a>
        <a href={terminUrl}
          className="h-11 px-4 shrink-0 rounded-full flex items-center gap-1.5 text-sm font-semibold text-white border hover:bg-white/10 transition"
          style={{ borderColor: 'rgba(194,161,94,0.6)' }}>
          📅 <span>{t('deck.barTermin', 'Termin')}</span>
        </a>
        <button onClick={onInfo}
          className="h-11 px-5 flex-1 sm:flex-none rounded-full text-sm font-semibold shadow transition hover:brightness-105 whitespace-nowrap"
          style={{ background: GOLD, color: DARK }}>
          <span className="sm:hidden">{t('deck.barInfoShort', 'Mehr Infos')}</span>
          <span className="hidden sm:inline">{t('deck.barInfo', 'Mehr Infos zur Wohnung')}</span>
        </button>
      </div>
    </div>
  )
}

// Zwischen-Aufruf direkt nach dem Grundriss: wer bis hier scrollt, ist interessiert.
function InlineCta({ onInfo, terminUrl }: { onInfo: () => void; terminUrl: string }) {
  const { t } = useTranslation()
  return (
    <section className="px-5 md:px-20 py-12 print:hidden" style={{ background: DARK }}>
      <div className="max-w-3xl">
        <Accent /><Kicker>{t('deck.inlineKicker', 'Nächster Schritt')}</Kicker>
        <h2 className="font-heading font-bold text-white text-3xl md:text-4xl mt-2 leading-tight">{t('deck.inlineHeadline', 'Gefällt dir die Wohnung?')}</h2>
        <p className="text-[15px] leading-relaxed text-gray-300 mt-3">
          {t('deck.inlineText', 'Hol dir die Unterlagen: deine persönliche Kosten- und Mietrechnung, die Wohnung als PDF und unseren Immobilienguide. Kostenlos und unverbindlich per E-Mail.')}
        </p>
        <div className="flex flex-wrap gap-3 mt-6">
          <button onClick={onInfo} className="px-6 py-3 rounded-full font-semibold text-[15px] shadow-lg transition-transform hover:scale-[1.03]" style={{ background: GOLD, color: DARK }}>
            {t('deck.inlineInfo', 'Mehr Infos anfordern')} <span aria-hidden>→</span>
          </button>
          <a href={terminUrl} className="px-6 py-3 rounded-full font-semibold text-[15px] text-white border hover:bg-white/10 transition" style={{ borderColor: 'rgba(194,161,94,0.6)' }}>
            {t('deck.inlineTermin', 'Lieber gleich Termin mit Sven')}
          </a>
        </div>
        <a href={altUrl(terminUrl)} className="inline-block mt-4 text-[14px] text-gray-300 underline underline-offset-4 hover:text-white">
          {t('deck.altLink', 'Passt nicht ganz? Vier Fragen, dann zeigt dir Sven Alternativen')} →
        </a>
      </div>
    </section>
  )
}

function InfoModal({ token, refId, campaign, person, unitNr, units, internal, terminUrl, onClose }: {
  token: string; refId: string | null; campaign: string | null; person: DeckPerson | null
  unitNr: string | null; units: string[]; internal: boolean; terminUrl: string; onClose: () => void
}) {
  const { t } = useTranslation()
  // Bei mehreren Wohnungen wählt der Kunde (vorbelegt, wenn er den Knopf an einer Wohnung genommen hat).
  const [wohnung, setWohnung] = useState<string>(unitNr ?? (units.length === 1 ? units[0] : ''))
  const mehrere = units.length > 1
  const [wants, setWants] = useState<string[]>([])
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [question, setQuestion] = useState('')
  const [website, setWebsite] = useState('')   // Honigtopf, für Menschen unsichtbar
  const [state, setState] = useState<'form' | 'sending' | 'done'>('form')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')
  const known = !!person?.known
  const first = person?.first_name ?? ''

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const toggle = (k: string) => setWants(w => w.includes(k) ? w.filter(x => x !== k) : [...w, k])
  const wantLabel = (k: string) => k === 'grundriss' ? t('deck.wantFloorplan', 'Grundriss und Ausstattungsliste')
    : k === 'zahlungsplan' ? t('deck.wantPayment', 'Zahlungsplan und Kaufnebenkosten')
    : k === 'rechnung' ? t('deck.wantCalc', 'Persönliche Kosten- und Mietrechnung')
    : t('deck.wantProcess', 'Ablauf beim Kauf aus Deutschland')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (mehrere && !wohnung) { setError(t('deck.infoErrUnit', 'Bitte wähle die Wohnung aus, zu der du Infos möchtest.')); return }
    if (!known) {
      if (!name.trim()) { setError(t('deck.infoErrName', 'Bitte gib deinen Namen an.')); return }
      if (!email.trim() && !phone.trim()) { setError(t('deck.infoErrContact', 'Bitte gib eine E-Mail-Adresse oder Telefonnummer an.')); return }
    }
    setState('sending')
    const { data: res, error: fnErr } = await supabase.functions.invoke('track-engagement', { body: {
      type: 'info_request', token, ref: refId, campaign, wants, question, website, internal, unit: wohnung || null,
      ...(known ? {} : { name, email, phone }),
    } })
    if (fnErr) {
      let msg = ''
      try { msg = ((await (fnErr as { context?: Response }).context?.json()) as { error?: string } | undefined)?.error ?? '' } catch { /* egal */ }
      setError(msg || t('deck.infoErrSend', 'Das hat leider nicht geklappt. Schreib Sven gern direkt per WhatsApp.'))
      setState('form')
      return
    }
    setSent(!!(res as { sent?: boolean } | null)?.sent)
    setState('done')
  }

  const title = wohnung ? t('deck.infoTitleUnit', 'Mehr Infos zu Wohnung {{nr}}', { nr: wohnung })
    : mehrere ? t('deck.infoTitleMulti', 'Mehr Infos anfordern') : t('deck.infoTitle', 'Mehr Infos zu dieser Wohnung')
  const field = 'w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-[15px] focus:outline-none focus:ring-2'
  return (
    <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/60 print:hidden" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={e => e.stopPropagation()}
        className="w-full sm:max-w-lg max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl p-6 shadow-2xl font-body" style={{ background: CREAM, color: INK }}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <Accent />
            <h2 className="font-heading font-bold text-2xl leading-tight">{title}</h2>
          </div>
          <button onClick={onClose} aria-label={t('deck.exitBook', 'Schließen')} className="text-2xl leading-none text-gray-400 hover:text-gray-700">×</button>
        </div>

        {state === 'done' ? (
          <div className="mt-4">
            <p className="text-[15px] leading-relaxed text-gray-700">
              {sent
                ? t('deck.infoDoneSent', 'Danke{{name}}! Deine Unterlagen sind unterwegs. Schau in dein Postfach, notfalls auch in den Spam-Ordner.', { name: first ? `, ${first}` : '' })
                : first ? t('deck.infoDoneName', 'Danke, {{name}}! Sven meldet sich persönlich bei dir, in der Regel innerhalb von 24 Stunden.', { name: first })
                : t('deck.infoDone', 'Danke! Sven meldet sich persönlich bei dir, in der Regel innerhalb von 24 Stunden.')}
            </p>
            <div className="flex flex-wrap gap-3 mt-6">
              <button onClick={onClose} className="px-5 py-2.5 rounded-full font-semibold text-sm text-white" style={{ background: DARK }}>{t('deck.infoBack', 'Zurück zur Wohnung')}</button>
              <a href={terminUrl} className="px-5 py-2.5 rounded-full font-semibold text-sm border" style={{ borderColor: GOLD, color: INK }}>{t('deck.infoTermin', 'Oder gleich Termin aussuchen')} →</a>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="mt-3 space-y-4">
            <p className="text-[15px] leading-relaxed text-gray-700">
              {first ? t('deck.infoIntroName', 'Hallo {{name}}, du bekommst per E-Mail: deine persönliche Kosten- und Mietrechnung, die Wohnung als PDF und unseren Immobilienguide. Kostenlos und unverbindlich.', { name: first })
                : t('deck.infoIntro', 'Du bekommst per E-Mail: deine persönliche Kosten- und Mietrechnung, die Wohnung als PDF und unseren Immobilienguide. Kostenlos und unverbindlich.')}
            </p>
            {mehrere && (
              <label className="block">
                <span className="block text-[11px] font-semibold uppercase tracking-[0.15em] mb-2" style={{ color: GOLD }}>{t('deck.infoUnit', 'Welche Wohnung?')}</span>
                <select className={field} value={wohnung} onChange={e => setWohnung(e.target.value)} required>
                  <option value="">{t('deck.infoUnitPick', 'Bitte wählen')}</option>
                  {units.map(n => <option key={n} value={n}>{t('deck.infoUnitOption', 'Wohnung {{nr}}', { nr: n })}</option>)}
                </select>
              </label>
            )}
            <fieldset>
              <legend className="text-[11px] font-semibold uppercase tracking-[0.15em] mb-2" style={{ color: GOLD }}>{t('deck.infoWhat', 'Was interessiert dich besonders? (optional)')}</legend>
              <div className="space-y-2">
                {INFO_WANTS.map(k => (
                  <label key={k} className="flex items-center gap-3 rounded-lg bg-white border border-gray-200 px-3 py-2.5 cursor-pointer text-[14px]">
                    <input type="checkbox" checked={wants.includes(k)} onChange={() => toggle(k)} className="h-4 w-4 shrink-0" style={{ accentColor: GOLD }} />
                    <span>{wantLabel(k)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {!known && (
              <div className="space-y-2.5">
                <input className={field} placeholder={t('deck.infoName', 'Dein Name')} value={name} onChange={e => setName(e.target.value)} autoComplete="name" />
                <input className={field} type="email" placeholder={t('deck.infoEmail', 'E-Mail-Adresse')} value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" />
                <input className={field} type="tel" placeholder={t('deck.infoPhone', 'Telefon oder WhatsApp (optional)')} value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" />
              </div>
            )}
            <textarea className={field} rows={3} placeholder={t('deck.infoQuestion', 'Deine Frage an Sven (optional)')} value={question} onChange={e => setQuestion(e.target.value)} />
            <input type="text" tabIndex={-1} autoComplete="off" aria-hidden="true" value={website} onChange={e => setWebsite(e.target.value)}
              className="absolute -left-[9999px] h-0 w-0 opacity-0" />
            {error && <p className="text-sm text-red-700">{error}</p>}
            <button type="submit" disabled={state === 'sending'}
              className="w-full py-3 rounded-full font-semibold text-[15px] shadow disabled:opacity-60" style={{ background: GOLD, color: DARK }}>
              {state === 'sending' ? t('deck.infoSending', 'Wird gesendet …') : t('deck.infoSubmit', 'Infos anfordern')}
            </button>
            <p className="text-[11px] leading-relaxed text-gray-500">
              {t('deck.infoPrivacy', 'Unverbindlich. Wir nutzen deine Angaben nur, um dir die Unterlagen zu schicken.')}{' '}
              <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" className="underline">{t('deck.infoPrivacyLink', 'Datenschutz')}</a>
            </p>
          </form>
        )}
      </div>
    </div>
  )
}

export default function Deck() {
  const { t, i18n } = useTranslation()
  const { token } = useParams<{ token: string }>()
  // Buchmodus (deckBook.tsx), ?buch=1 öffnet das Deck direkt als Buch
  const [book, setBook] = useState(() => typeof window !== 'undefined' && !window.location.pathname.endsWith('/print')
    && new URLSearchParams(window.location.search).get('buch') === '1')
  const [content, setContent] = useState<DeckContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(false)
  const [info, setInfo] = useState(false)
  const [infoUnit, setInfoUnit] = useState<string | null>(null)
  const [internal, setInternal] = useState(false)
  const [person, setPerson] = useState<DeckPerson | null>(null)
  const [vatRefund, setVatRefund] = useState<Record<string, VatRefund>>({})
  const [page, setPage] = useState<ProjectPage | null>(null)
  const [deckLang, setDeckLang] = useState<string>('de')
  const [{ ref, campaign }] = useState(readRef)
  const isPrint = typeof window !== 'undefined' && window.location.pathname.endsWith('/print')

  // Druckansicht (/deck/<token>/print, verlinkt aus dem Infopaket „Als PDF
  // speichern"): alle Bilder sofort laden, dann den Druckdialog öffnen. Bilder
  // stehen auf loading="lazy" und fehlten sonst im PDF.
  const printPage = async () => {
    const imgs = [...document.querySelectorAll('img')] as HTMLImageElement[]
    imgs.forEach(img => { img.loading = 'eager' })
    await Promise.race([
      Promise.all(imgs.map(img => img.complete ? Promise.resolve() : new Promise<void>(r => { img.onload = () => r(); img.onerror = () => r() }))),
      new Promise<void>(r => setTimeout(r, 8000)),
    ])
    window.print()
  }
  useEffect(() => {
    if (!isPrint || !content) return
    const tm = setTimeout(() => { void printPage() }, 800)
    return () => clearTimeout(tm)
  }, [isPrint, content])

  // Wer schaut? Nur Vorname + passender Terminlink (persönlich, sonst allgemein).
  useEffect(() => {
    if (!token) return
    supabase.functions.invoke('track-engagement', { body: { type: 'deck_person', token, ref } })
      .then(({ data }) => { if (data && typeof (data as DeckPerson).booking_url === 'string') setPerson(data as DeckPerson) })
      .catch(() => { /* ohne Person geht alles weiter */ })
  }, [token, ref])

  // Empfängersprache: Das Deck liegt hinter einem Token, es gibt keinen Login -
  // die Sprache kommt serverseitig aus dem Lead. Ohne das blieben alle festen
  // Bausteine (Folge-mir-Block, Beschriftungen, Kontaktkarte) deutsch, obwohl der
  // Deck-Text englisch war (Sven 27.8.).
  useEffect(() => { void (async () => {
    if (!token) return
    try {
      const { data } = await supabase.rpc('get_deck_lang', { p_token: token })
      const lang = typeof data === 'string' ? data : 'de'
      setDeckLang(lang)
      if (lang === 'en' && i18n.language !== 'en') await i18n.changeLanguage('en')
    } catch { /* im Zweifel in der eingestellten Sprache anzeigen */ }
  })() }, [token, i18n])

  // Vermietungsart je Wohnung aus der Berechnung des Kunden (MwSt.-Erstattung bei Kurzzeit).
  useEffect(() => {
    if (!token) return
    supabase.rpc('get_deck_let_types', { p_token: token })
      .then(({ data }) => setVatRefund(vatRefundMap(data)), () => { /* ohne Hinweis geht alles weiter */ })
  }, [token])

  // Projektseite der Website als Deck-Grundlage (deckWeb.tsx). Fehlt sie oder die
  // Funktion, bleibt das Deck in der bisherigen Darstellung.
  useEffect(() => {
    if (!token) return
    supabase.rpc('get_deck_page', { p_token: token })
      .then(({ data }) => { const p = data as ProjectPage | null; if (p && p.hero?.img && p.h1) setPage(p) }, () => { /* bisherige Darstellung */ })
  }, [token])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { data, error } = await supabase.rpc('get_deck_by_token', { p_token: token })
      if (cancelled) return
      const row = data as { content?: DeckContent } | null
      if (error || !row?.content?.blocks) { setErr(true); setLoading(false); return }
      setContent(row.content)
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [token])

  // Engagement-Tracking (fire-and-forget, blockiert das Rendern nicht): loggt den
  // Deck-Aufruf → erscheint im CRM-Dashboard („X hat sich Deck Y angesehen").
  // NUR echte Kundenbesuche zählen: interne Kontroll-Aufrufe werden übersprungen —
  // (a) wenn jemand im CRM eingeloggt ist (Kunden sind das nie), oder
  // (b) wenn der Link als Vorschau markiert ist (?preview=1, so öffnet der Admin es).
  useEffect(() => {
    if (!token) return
    // Ein Browser, in dem je eine CRM-Session lief oder der ein Vorschau-Link war,
    // gilt DAUERHAFT als intern. Ohne diese Markierung zählte ein aus dem Postausgang
    // kopierter Link im selben Browser (ausgeloggt / anderer Tab) als Kundenbesuch.
    const INTERNAL = 'hp_internal_viewer'
    const markInternal = () => { setInternal(true); try { localStorage.setItem(INTERNAL, '1') } catch { /* Storage gesperrt */ } }
    if (new URLSearchParams(window.location.search).get('preview') === '1') { markInternal(); return }
    try { if (localStorage.getItem(INTERNAL) === '1') { setInternal(true); return } } catch { /* egal */ }
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession()
      if (session) { markInternal(); return }
      supabase.functions.invoke('track-engagement', { body: { type: 'deck_view', token, ref, campaign } }).catch(() => { /* egal */ })
    })()
  }, [token, ref, campaign])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: CREAM }}>
        <div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
      </div>
    )
  }
  if (err || !content) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center font-body" style={{ background: CREAM, color: INK }}>
        <p className="font-heading text-2xl">{t('deck.notAvailable', 'Dieses Deck ist nicht verfügbar.')}</p>
        <p className="text-sm text-gray-500 mt-2">{t('deck.notAvailableHint', 'Bitte den Link prüfen oder Happy Property kontaktieren.')}</p>
      </div>
    )
  }

  // Website-Stil nur für deutsche Decks (die Seiteninhalte gibt es nur deutsch; maßgeblich ist
  // die Sprache des Leads, nicht die des Browsers) und nicht mit ?klassisch=1.
  const klassisch = new URLSearchParams(window.location.search).get('klassisch') === '1'
  const web = !!page && !klassisch && deckLang !== 'en'
  const view: AnyBlock[] = web && page ? webBlocks(content.blocks, page) : content.blocks
  const unitNr = (content.blocks.find(b => b.type === 'unit') as Extract<DeckBlock, { type: 'unit' }> | undefined)?.number?.trim() || null
  const deckUnits = content.blocks.flatMap(b => b.type === 'unit' && b.number?.trim() ? [b.number.trim()] : [])
  const openInfo = (nr: string | null) => { setInfoUnit(nr); setInfo(true) }
  const terminUrl = person?.booking_url ?? '/termin?src=deck'
  const waUrl = `https://wa.me/${WA_NUMBER}?text=${encodeURIComponent(unitNr
    ? t('deck.waTextUnit', 'Hallo Sven, ich habe mir die Wohnung {{nr}} angesehen und hätte eine Frage.', { nr: unitNr })
    : t('deck.waText', 'Hallo Sven, ich habe mir die Wohnung angesehen und hätte eine Frage.'))}`
  // Zwischen-Aufruf nach dem Grundriss (sonst nach dem Wohnungs-Block), nicht
  // direkt vor dem Abschluss-Block, sonst stünde dasselbe zweimal untereinander.
  // Sammel-Decks: erst nach der letzten Wohnung, nicht schon nach der ersten.
  const fpIdx = view.findIndex(b => b.type === 'floorplan')
  const lastUnitIdx = view.reduce((m, b, i) => (b.type === 'unit' || b.type === 'floorplan') ? i : m, -1)
  const ctaAfter = deckUnits.length > 3 ? lastUnitIdx : fpIdx >= 0 ? fpIdx : view.findIndex(b => b.type === 'unit')
  const showInline = ctaAfter >= 0 && view[ctaAfter + 1]?.type !== 'cta'
  // Buchseiten: ein Abschnitt je Seite, das schmale Kennzahlen-Band steht mit auf der Titelseite.
  const bookPages: number[][] = []
  view.forEach((b, i) => { if (b.type === 'w_facts' && bookPages.length) bookPages[bookPages.length - 1].push(i); else bookPages.push([i]) })
  const coverBlock = content.blocks.find(b => b.type === 'cover') as Extract<DeckBlock, { type: 'cover' }> | undefined
  const bookCover = {
    image: sizedImg(web && page ? page.hero.img : coverBlock?.image, 1200),
    forLine: coverBlock?.forLine?.replace(/\s+[-–—]\s+|\s*[–—]\s*/g, ', '),
    logo: DECK_LOGO,
  }
  const closeBook = (p: number) => {
    setBook(false)
    // Zurück auf der Scroll-Seite an der Stelle, die im Buch offen war
    const at = p >= 0 ? bookPages[p]?.[0] ?? 0 : 0
    requestAnimationFrame(() => {
      const el = document.querySelectorAll('[data-deck-block]')[at]
      if (at > 0 && el) el.scrollIntoView({ block: 'start' }); else window.scrollTo({ top: 0 })
    })
  }
  // Logo steht im Buch im Seitenkopf (deckBook.tsx), nicht mehr je Abschnitt.
  const renderBookPage = (p: number) => (
    <div className={web ? 'hpweb-deck' : undefined}>
      {(bookPages[p] ?? []).map(i => <div key={i} className="relative"><Block block={view[i]} /></div>)}
    </div>
  )
  // Seitenkopf im Buch: kurze, genaue Überschrift je Seite (Leser-Feedback 22.10.)
  const bookTitle = (b: AnyBlock): string => {
    const k = 'kicker' in b && typeof b.kicker === 'string' ? b.kicker.trim() : ''
    switch (b.type) {
      case 'w_hero':    return t('deck.bookCh.overview', 'Überblick')
      case 'letter':    return t('deck.bookCh.letter', 'Persönliches Anschreiben')
      case 'unit':      return b.number?.trim() ? t('deck.bookCh.unitNr', 'Wohnung {{nr}}', { nr: b.number.trim() }) : t('deck.bookCh.unit', 'Die Wohnung')
      case 'floorplan': return k || t('deck.bookCh.floorplan', 'Grundriss')
      case 'masterplan':return t('deck.bookCh.masterplan', 'Lageplan der Anlage')
      case 'video':     return k ? `${t('deck.bookCh.video', 'Video')} · ${k}` : t('deck.bookCh.video', 'Video')
      case 'w_day':     return t('deck.bookCh.day', 'Ein Tag hier')
      case 'w_home':    return b.page.home?.kicker || t('deck.bookCh.home', 'Dein Zuhause')
      case 'w_amen':    return b.page.amen?.kicker || t('deck.bookCh.amen', 'Die Anlage')
      case 'w_more':    return b.page.more?.[b.i]?.kicker || t('deck.bookCh.amen', 'Die Anlage')
      case 'w_options': return b.page.options?.kicker || t('deck.bookCh.options', 'Optionen')
      case 'w_reasons': return t('deck.bookCh.reasons', 'Für Anleger')
      case 'w_loc':     return t('deck.bookCh.loc', 'Lage')
      case 'facts':     return web ? t('deck.bookCh.map', 'Lage auf der Karte') : (k || t('deck.bookCh.loc', 'Lage'))
      case 'marina':    return t('deck.bookCh.marina', 'Marina')
      case 'payment':   return k || t('deck.bookCh.payment', 'Zahlungsplan')
      case 'w_gallery': return t('deck.bookCh.gallery', 'Bilder')
      case 'w_spec':    return t('deck.bookCh.spec', 'Ausstattung')
      case 'inventory': return t('deck.bookCh.inventory', 'Inventar')
      case 'w_why':     return t('deck.bookCh.why', 'Warum Happy Property')
      case 'cta':       return t('deck.bookCh.cta', 'Nächster Schritt')
      case 'cover':     return t('deck.bookCh.overview', 'Überblick')
      default:          return k || ('headline' in b && typeof b.headline === 'string' ? b.headline : '')
    }
  }
  const bookTitles = bookPages.map(g => bookTitle(view[g[0]]))

  return (
    <VatRefundCtx.Provider value={{ byUnit: vatRefund, units: deckUnits }}>
    <InfoOpenCtx.Provider value={!isPrint && deckUnits.length > 1 ? openInfo : null}>
    <TerminCtx.Provider value={isPrint ? null : terminUrl}>
    <div className={web ? 'font-body hpweb-deck' : 'font-body'} style={{ background: CREAM, color: INK }}>
      {isPrint && (
        <div className="print:hidden sticky top-0 z-50 flex justify-center p-3" style={{ background: DARK }}>
          <button onClick={() => { void printPage() }} className="px-5 py-2.5 rounded-full text-sm font-semibold shadow" style={{ background: GOLD, color: DARK }}>
            📄 {t('deck.printSave', 'Als PDF speichern oder drucken')}
          </button>
        </div>
      )}
      {web && <WebStyle />}
      {/* Oben umschalten: Seite (scrollen) oder Buch */}
      {!isPrint && !book && <TopViewToggle onBook={() => setBook(true)} />}
      <VideoAutoCtx.Provider value={!book && !isPrint}>
      {view.map((b, i) => (
        <div key={i} className="relative" data-deck-block>
          <Block block={b} />
          {/* Logo-Wasserzeichen auf jeder Seite — Diebstahlschutz (nicht auf dem schmalen Kennzahlen-Band
              und nicht auf der eingeklappten Grundriss-Zeile, dort läge es über dem Text) */}
          {b.type !== 'w_facts' && !(b.type === 'floorplan' && b.collapsed) && <img src={DECK_LOGO} alt="" aria-hidden="true"
            className="absolute top-3 right-3 md:top-4 md:right-6 h-7 md:h-9 w-auto rounded-md opacity-80 pointer-events-none select-none ring-1 ring-white/10"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
          {!isPrint && showInline && i === ctaAfter && <InlineCta onInfo={() => openInfo(null)} terminUrl={terminUrl} />}
        </div>
      ))}
      </VideoAutoCtx.Provider>
      <div className={`text-center text-[11px] text-gray-400 pt-6 ${isPrint ? 'pb-6' : 'pb-28 sm:pb-24'}`} style={{ background: CREAM }}>
        © Happy Property · {t('deck.footerNote', 'Persönlich erstellt · Preise vorbehaltlich Final-Plans · Bilder zu Marketingzwecken')}
      </div>

      {/* Feste Leiste unten: WhatsApp, Termin, Mehr Infos (auch über dem Buch) */}
      {!isPrint && <ActionBar onInfo={() => openInfo(null)} terminUrl={terminUrl} waUrl={waUrl} />}
      {info && token && (
        <InfoModal token={token} refId={ref} campaign={campaign} person={person} unitNr={deckUnits.length > 1 ? infoUnit : unitNr} units={deckUnits}
          internal={internal} terminUrl={terminUrl} onClose={() => setInfo(false)} />
      )}
      {book && !isPrint && <DeckBook count={bookPages.length} renderPage={renderBookPage} titles={bookTitles} cover={bookCover} onClose={closeBook} />}
    </div>
    </TerminCtx.Provider>
    </InfoOpenCtx.Provider>
    </VatRefundCtx.Provider>
  )
}
