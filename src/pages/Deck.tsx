import { useState, useEffect, type CSSProperties } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import type { DeckBlock, DeckContent, FloorplanRoom } from '../lib/deckTypes'
import { DECK_CONTACT, DECK_LOGO, DECK_PHOTO } from '../lib/deckTypes'

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
function Img({ src, alt, className, style }: { src?: string; alt?: string; className?: string; style?: CSSProperties }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return <div className={className} style={{ ...style, background: 'linear-gradient(135deg,#d9cfbe,#b7ab95)' }} />
  }
  return <img src={src} alt={alt ?? ''} loading="lazy" onError={() => setFailed(true)} className={className} style={style} />
}

// ── Block-Renderer ──────────────────────────────────────────────────────────────
function CoverBlock(b: Extract<DeckBlock, { type: 'cover' }>) {
  return (
    <section>
      <Img src={b.image} className="w-full h-[62vh] object-cover" />
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

function UnitBlock(b: Extract<DeckBlock, { type: 'unit' }>) {
  return (
    <section className="px-5 md:px-20 py-16 grid grid-cols-1 md:grid-cols-2 gap-10 items-center" style={{ background: CREAM }}>
      <Img src={b.image} className="w-full h-[420px] object-cover rounded-xl" />
      <div>
        <Kicker>{b.kicker}</Kicker>
        <h2 className="font-heading font-bold text-6xl md:text-7xl mt-2" style={{ color: INK }}>{b.number}</h2>
        {b.nickname && <p className="font-heading italic text-xl md:text-2xl mt-1" style={{ color: GOLD }}>{b.nickname}</p>}
        {b.specs && (
          <div className="mt-5 space-y-1 text-[15px] text-gray-700">
            {b.specs.map((s, i) => <p key={i} className={i === 0 ? 'font-semibold text-gray-900' : ''}>{s}</p>)}
          </div>
        )}
        {b.priceLines && b.priceLines.length > 0 ? (
          <div className="mt-6 rounded-xl px-5 py-4 space-y-1.5" style={{ background: DARK }}>
            {b.priceLines.map((l, i) => (
              <div key={i} className={`flex items-baseline justify-between gap-4 ${l.strong ? 'pt-1.5 mt-1.5 border-t border-white/15' : ''}`}>
                <span className={`${l.strong ? 'text-white font-semibold' : 'text-gray-400'} text-[13px]`}>{l.label}</span>
                <span className={`font-heading ${l.strong ? 'text-white text-2xl font-bold' : 'text-gray-200 text-base'} whitespace-nowrap`} style={l.strong ? undefined : { color: '#e5e0d5' }}>{l.value}</span>
              </div>
            ))}
          </div>
        ) : (b.priceMain || b.priceSub) && (
          <div className="mt-6 rounded-xl px-5 py-4" style={{ background: DARK }}>
            {b.priceSub && <p className="text-[11px] font-semibold uppercase tracking-[0.15em]" style={{ color: GOLD }}>{b.priceSub.split('·')[0]}</p>}
            <p className="font-heading font-bold text-white text-4xl mt-1">{b.priceMain}</p>
            {b.priceSub && b.priceSub.includes('·') && <p className="text-xs text-gray-400 mt-1">{b.priceSub.split('·').slice(1).join('·').trim()}</p>}
          </div>
        )}
        {b.note && <p className="mt-4 text-[13px] leading-relaxed text-gray-600" dangerouslySetInnerHTML={{ __html: b.note }} />}
      </div>
    </section>
  )
}

function FactsBlock(b: Extract<DeckBlock, { type: 'facts' }>) {
  const items = b.items ?? []
  const mid = Math.ceil(items.length / 2)
  const cols = [items.slice(0, mid), items.slice(mid)]
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent />
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
      {((b.mapLat != null && b.mapLng != null) || b.mapQuery || b.mapEmbed) ? (() => {
      // INTERAKTIVE Karte (Deck-Standard): scroll-/zoombares keyless Google-Embed
      // (output=embed, kein API-Key). mapEmbed (z.B. Routen-/Richtungs-Karte) hat
      // Vorrang; sonst exakte Koordinaten; sonst Such-Query aus Projektname+Ort.
      const hasCoords = b.mapLat != null && b.mapLng != null
      const q = hasCoords ? `${b.mapLat},${b.mapLng}` : encodeURIComponent(b.mapQuery ?? '')
      const z = hasCoords ? 15 : 14
      const src = b.mapEmbed ?? `https://maps.google.com/maps?q=${q}&z=${z}&output=embed`
      const openHref = b.mapUrl || `https://www.google.com/maps?q=${q}`
      return (
        <div className="mt-8">
          <div className="relative w-full overflow-hidden rounded-xl border border-gray-200" style={{ aspectRatio: '16 / 9' }}>
            <iframe
              title={b.mapLabel ? `Standort ${b.mapLabel}` : 'Standort'}
              src={src}
              className="absolute inset-0 h-full w-full"
              style={{ border: 0 }}
              loading="lazy"
              referrerPolicy="no-referrer-when-downgrade"
              allowFullScreen
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            {b.mapLabel && <span className="text-sm font-semibold px-3 py-1 rounded-full text-white" style={{ background: '#ff795d' }}>📍 {b.mapLabel}</span>}
            <a href={openHref} target="_blank" rel="noopener noreferrer" className="text-xs font-medium px-3 py-1.5 rounded-full text-white shadow ml-auto" style={{ background: 'rgba(27,27,34,0.88)' }}>🗺 In Google Maps öffnen →</a>
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
              <span className="absolute bottom-3 right-3 text-xs font-medium px-3 py-1.5 rounded-full text-white shadow" style={{ background: 'rgba(27,27,34,0.88)' }}>🗺 In Google Maps öffnen →</span>
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
      <div className="px-5 md:px-20 py-12 grid grid-cols-1 md:grid-cols-2 gap-10" style={{ background: DARK }}>
        {b.text && <p className="text-[15px] leading-relaxed text-gray-300">{b.text}</p>}
        {b.quote && <p className="font-heading italic text-lg border-l-2 pl-5" style={{ color: GOLD, borderColor: GOLD }}>{b.quote}</p>}
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
  const CORAL = '#ff795d'
  const inner = rooms.filter(r => r.kind !== 'terrace')
  const minX = Math.min(...inner.map(r => r.x)), minY = Math.min(...inner.map(r => r.y))
  const maxX = Math.max(...inner.map(r => r.x + r.w)), maxY = Math.max(...inner.map(r => r.y + r.h))
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 md:p-6">
      <svg viewBox="0 0 600 600" className="w-full h-auto" role="img" aria-label="Grundriss-Modell">
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
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent /><Kicker>{b.kicker}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 mb-8 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      {/* rooms = schematischer Einzelwohnungs-Grundriss (sauberes Modell, statt z.B. eines
          ganzen Lageplans). Sonst: Grundriss-Bild VOLLBREIT, object-contain = nicht verzerrt. */}
      {b.rooms && b.rooms.length
        ? <FloorplanSchematic rooms={b.rooms} note={b.planNote} />
        : <Img src={b.image} className="w-full h-auto max-h-[660px] object-contain bg-white rounded-xl border border-gray-200 p-3 md:p-5" />}
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
          <div className="flex items-center justify-between text-sm text-gray-600"><span>Nettopreis</span><span className="font-semibold text-gray-900">{b.priceSummary.net}</span></div>
          <div className="flex items-center justify-between text-sm text-gray-600 mt-1.5"><span>zzgl. MwSt. ({b.priceSummary.vatRate ?? '19 %'})</span><span className="font-semibold text-gray-900">{b.priceSummary.vat}</span></div>
          <div className="flex items-center justify-between mt-2.5 pt-2.5 border-t border-gray-200"><span className="font-heading font-bold" style={{ color: INK }}>Bruttopreis gesamt</span><span className="font-heading font-bold text-2xl" style={{ color: INK }}>{b.priceSummary.gross}</span></div>
        </div>
      )}
      {b.note && <div className="mt-6 rounded-xl px-5 py-3 text-[12px] text-gray-700 border-l-2" style={{ background: '#fff', borderColor: GOLD }} dangerouslySetInnerHTML={{ __html: b.note }} />}
    </section>
  )
}

function CtaBlock(b: Extract<DeckBlock, { type: 'cta' }>) {
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
      {/* Kontakt + Foto */}
      <div className="mt-12 grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-6 items-center rounded-2xl px-6 py-6" style={{ background: 'rgba(194,161,94,0.1)' }}>
        <img src={DECK_PHOTO} alt={DECK_CONTACT.name} className="h-28 w-28 md:h-32 md:w-32 object-cover rounded-2xl shadow-lg shrink-0" onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        <div>
          <p className="font-heading font-bold text-white text-2xl">{DECK_CONTACT.name}</p>
          <p className="text-[11px] font-semibold uppercase tracking-[0.15em] mt-0.5" style={{ color: GOLD }}>{DECK_CONTACT.company}</p>
          <p className="text-sm text-gray-300 mt-2">{DECK_CONTACT.phone} · {DECK_CONTACT.email}</p>
          <p className="text-xs text-gray-400">{DECK_CONTACT.web} · {DECK_CONTACT.address}</p>
        </div>
      </div>

      {/* Folge mir — offensiv */}
      <div className="mt-8">
        <p className="font-heading font-bold text-white text-2xl md:text-3xl">Folge mir — ich nehme dich mit nach Zypern.</p>
        <p className="text-sm text-gray-400 mt-1">Projekte, Baufortschritt, Markt-Insights — schau rein und folge:</p>
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
  const CORAL = '#ff795d'
  const from  = b.fromLabel ?? 'Royal Horizon'
  const to    = b.toLabel ?? 'Paphos-Marina'
  const dist  = b.distance ?? '~5 km'
  const drive = b.drive ?? 'direkt um die Ecke'
  const pct   = b.valuePct ?? '+30%'
  const fromSub = b.fromSub                              // Ort des Objekts (z.B. „Tala", „Chlorakas") — projektabhängig
  const toSub   = b.toSub ?? 'Potima Bay · Kissonerga'  // Marina-Standort (überall gleich)
  return (
    <section className="px-5 md:px-20 py-16" style={{ background: CREAM }}>
      <Accent />
      <Kicker>{b.kicker ?? 'Lage · Neue Paphos-Marina'}</Kicker>
      {b.headline && <h2 className="font-heading font-bold text-4xl md:text-5xl mt-3 mb-8 leading-tight" style={{ color: INK }}>{b.headline}</h2>}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-8 items-center">
        {/* Schematische Karte: Haus → Route + Entfernung → Marina */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
            <svg viewBox="0 0 560 240" className="w-full h-auto" role="img" aria-label={`Weg von ${from} zur ${to}`}>
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
            <div className="mt-1 text-white font-semibold uppercase tracking-[0.16em] text-sm">Wertsteigerung</div>
          </div>
          {b.valueText && <p className="mt-4 text-[15px] leading-relaxed text-gray-700">{b.valueText}</p>}
        </div>
      </div>
      {b.note && <p className="mt-6 text-xs text-gray-400">{b.note}</p>}
    </section>
  )
}

function Block({ block }: { block: DeckBlock }) {
  switch (block.type) {
    case 'marina':    return <MarinaBlock {...block} />
    case 'cover':     return <CoverBlock {...block} />
    case 'letter':    return <LetterBlock {...block} />
    case 'unit':      return <UnitBlock {...block} />
    case 'facts':     return <FactsBlock {...block} />
    case 'columns':   return <ColumnsBlock {...block} />
    case 'feature':   return <FeatureBlock {...block} />
    case 'gallery':   return <GalleryBlock {...block} />
    case 'benefits':  return <BenefitsBlock {...block} />
    case 'inventory': return <InventoryBlock {...block} />
    case 'floorplan': return <FloorplanBlock {...block} />
    case 'payment':   return <PaymentBlock {...block} />
    case 'cta':       return <CtaBlock {...block} />
    default:          return null
  }
}

export default function Deck() {
  const { token } = useParams<{ token: string }>()
  const [content, setContent] = useState<DeckContent | null>(null)
  const [loading, setLoading] = useState(true)
  const [err,     setErr]     = useState(false)

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
  useEffect(() => {
    if (!token) return
    void supabase.functions.invoke('track-engagement', { body: { type: 'deck_view', token } }).catch(() => { /* egal */ })
  }, [token])

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
        <p className="font-heading text-2xl">Dieses Deck ist nicht verfügbar.</p>
        <p className="text-sm text-gray-500 mt-2">Bitte den Link prüfen oder Happy Property kontaktieren.</p>
      </div>
    )
  }

  return (
    <div className="font-body" style={{ background: CREAM, color: INK }}>
      {content.blocks.map((b, i) => (
        <div key={i} className="relative">
          <Block block={b} />
          {/* Logo-Wasserzeichen auf jeder Seite — Diebstahlschutz */}
          <img src={DECK_LOGO} alt="" aria-hidden="true"
            className="absolute top-3 right-3 md:top-4 md:right-6 h-7 md:h-9 w-auto rounded-md opacity-80 pointer-events-none select-none ring-1 ring-white/10"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        </div>
      ))}
      <div className="text-center text-[11px] text-gray-400 py-6" style={{ background: CREAM }}>
        © Happy Property · Persönlich erstellt · Preise vorbehaltlich Final-Plans · Bilder zu Marketingzwecken
      </div>
    </div>
  )
}
