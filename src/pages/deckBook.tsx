import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { VideoAutoCtx, InBookCtx } from './deckWeb'

// ── Buchmodus (Sven 22.10.26) ───────────────────────────────────────────────────
// "Das alles als ein richtiges Buch öffnen, die Seiten sollen sich beim Umblättern
// bewegen, mit Ton, vielleicht als Ringbuch." Ersetzt den alten Blättern-Modus.
// Ein Ringbuch mit goldener Drahtbindung links: erst der geschlossene Umschlag,
// dann eine Seite je Deck-Abschnitt. Die Seite dreht sich in 3D um die Ringe und
// folgt beim Wischen dem Finger. Das Papiergeräusch ist eine echte Aufnahme (Mixkit,
// public/sounds, abwechselnd zwei Blätter, von Conny 26.10. ausgesucht), abgespielt über
// Web Audio, das Aufliegen fällt aufs Ende der Drehung. Lädt sie nicht, wird das Geräusch
// wie bisher im Browser berechnet. Lange Seiten scrollen in sich.
// Umgeschaltet wird oben über "Seite | Buch" (ViewToggle), Escape schließt.
// Nachgebessert nach Leser-Feedback (22.10.): jede Seite hat oben denselben Kopf
// (Kapitelnummer, genaue Überschrift, Logo), Videos stehen im Buch in einem
// einheitlichen Rahmen, und auch auf einem Video lässt sich weiterblättern.

const CREAM = '#FAF6EC'
const DARK = '#1b1b22'
const GOLD = '#C2A15E'
const PAPER_BACK = '#F1EADB'
const BIND = 14            // Bindungsrand innen (px), dort sitzen die Löcher
const HOLE_X = 7
const SHEET_RADIUS = '3px 12px 12px 3px'
const SOUND_KEY = 'hp_deck_book_ton'

// ── Ton ────────────────────────────────────────────────────────────────────────
// Drei Schichten wie beim echten Blatt: Knistern beim Anheben, Rauschen der Luft
// während der Drehung, Klatschen beim Aufliegen. Dazu ein leises Klicken am Draht.
// Leichte Zufallsabweichung je Seite, damit es nicht nach Schleife klingt.
let audioCtx: AudioContext | null = null
let noiseBuf: AudioBuffer | null = null
let crackleBuf: AudioBuffer | null = null

// Echte Aufnahme: zwei einzelne Blätter aus „Single book paging“ (Mixkit, Lizenz in public/sounds).
// land = Sekunde, in der das Blatt aufliegt; darauf wird das Ende der Drehung gelegt.
const PAPER_SAMPLES = [
  { url: '/sounds/papier-blatt-1.m4a', land: 0.42 },
  { url: '/sounds/papier-blatt-2.m4a', land: 0.35 },
]
let paperBufs: (AudioBuffer | null)[] = []
let paperLoading = false
let paperNext = 0

function loadPaper(ctx: AudioContext) {
  if (paperLoading) return
  paperLoading = true
  paperBufs = PAPER_SAMPLES.map(() => null)
  PAPER_SAMPLES.forEach((smp, i) => {
    fetch(smp.url)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then(b => new Promise<AudioBuffer>((res, rej) => ctx.decodeAudioData(b, res, rej)))
      .then(buf => { paperBufs[i] = buf })
      .catch(() => { /* bleibt null, dann klingt der berechnete Ton */ })
  })
}

/** Spielt ein echtes Blatt; false, wenn die Aufnahme (noch) nicht da ist. */
function playPaper(ctx: AudioContext, seconds: number, kind: 'page' | 'cover'): boolean {
  const ready = paperBufs.map((b, i) => (b ? i : -1)).filter(i => i >= 0)
  if (!ready.length) return false
  const i = ready[paperNext++ % ready.length]
  const buf = paperBufs[i]!
  // Umschlag: etwas langsamer abgespielt, klingt schwerer
  const rate = kind === 'cover' ? 0.86 : 0.96 + Math.random() * 0.08
  const land = PAPER_SAMPLES[i].land / rate
  const s = ctx.createBufferSource()
  s.buffer = buf
  s.playbackRate.value = rate
  const g = ctx.createGain()
  g.gain.value = kind === 'cover' ? 0.95 : 0.8
  s.connect(g).connect(ctx.destination)
  s.start(ctx.currentTime + 0.01 + Math.max(0, seconds - land))
  return true
}

function getAudio(): AudioContext | null {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return null
      audioCtx = new AC()
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume().catch(() => {})
    loadPaper(audioCtx)
    if (!noiseBuf || !crackleBuf) {
      const sr = audioCtx.sampleRate, len = Math.floor(sr * 2)
      noiseBuf = audioCtx.createBuffer(1, len, sr)
      const n = noiseBuf.getChannelData(0)
      for (let i = 0; i < len; i++) n[i] = Math.random() * 2 - 1
      // Knistern: einzelne kurze Knackser mit zufälliger Stärke, ca. 260 je Sekunde
      crackleBuf = audioCtx.createBuffer(1, len, sr)
      const c = crackleBuf.getChannelData(0)
      for (let i = 0; i < len - 8; i++) {
        if (Math.random() < 260 / sr) {
          const amp = (0.25 + Math.random() * 0.75) * (Math.random() < 0.5 ? -1 : 1)
          for (let k = 0; k < 8; k++) c[i + k] += amp * Math.exp(-k / 1.6) * (k % 2 ? -0.6 : 1)
        }
      }
    }
    return audioCtx
  } catch { return null }
}
/** Im Klick-Handler aufrufen: Safari erlaubt Ton nur nach einer Berührung. */
export function unlockBookAudio() { getAudio() }

function playTurn(seconds: number, kind: 'page' | 'cover') {
  const ctx = getAudio()
  if (!ctx) return
  try { if (playPaper(ctx, seconds, kind)) return } catch { /* weiter mit dem berechneten Ton */ }
  if (!noiseBuf || !crackleBuf) return
  try {
    const d = Math.max(0.16, seconds)
    const t0 = ctx.currentTime + 0.01
    const tl = t0 + d
    const r = (a: number, b: number) => a + Math.random() * (b - a)
    const out = ctx.createGain()
    out.gain.value = kind === 'cover' ? 0.75 : 0.6
    out.connect(ctx.destination)
    const end = tl + 0.35

    const noise = (buf: AudioBuffer, rate = 1) => {
      const s = ctx.createBufferSource()
      s.buffer = buf
      s.playbackRate.value = rate
      s.loop = true
      s.start(t0, r(0, 0.8))
      s.stop(end)
      return s
    }
    const env = (g: GainNode, pts: [number, number][]) => {
      g.gain.setValueAtTime(0.0001, t0)
      for (const [t, v] of pts) g.gain.exponentialRampToValueAtTime(Math.max(0.0001, v), t)
    }

    // 1) Knistern beim Anheben, nimmt zur Mitte ab
    {
      const s = noise(crackleBuf, r(0.9, 1.1))
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = r(2200, 2800)
      const g = ctx.createGain()
      env(g, [[t0 + 0.04, 0.32], [t0 + d * 0.45, 0.12], [tl, 0.03], [tl + 0.05, 0.0001]])
      s.connect(hp).connect(g).connect(out)
    }
    // 2) Papierrauschen, Bandpass wandert mit der Drehung nach oben und zurück
    {
      const s = noise(noiseBuf, r(0.92, 1.08))
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.85
      const f = r(0.9, 1.1)
      bp.frequency.setValueAtTime(1300 * f, t0)
      bp.frequency.exponentialRampToValueAtTime(3600 * f, t0 + d * 0.55)
      bp.frequency.exponentialRampToValueAtTime(2000 * f, tl)
      const g = ctx.createGain()
      env(g, [[t0 + Math.min(0.07, d * 0.3), 0.16], [t0 + d * 0.5, 0.24], [tl - 0.02, 0.1], [tl + 0.06, 0.0001]])
      s.connect(bp).connect(g).connect(out)
    }
    // 3) Luftzug, tief und weich, am stärksten kurz vor dem Aufliegen
    {
      const s = noise(noiseBuf, r(0.95, 1.05))
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.5
      lp.frequency.setValueAtTime(500, t0)
      lp.frequency.exponentialRampToValueAtTime(1500, t0 + d * 0.7)
      lp.frequency.exponentialRampToValueAtTime(700, tl)
      const g = ctx.createGain()
      env(g, [[t0 + d * 0.3, 0.14], [t0 + d * 0.72, kind === 'cover' ? 0.42 : 0.3], [tl + 0.04, 0.0001]])
      s.connect(lp).connect(g).connect(out)
    }
    // 4) Aufliegen: kurzer breiter Klatsch, beim Umschlag mit dumpfem Pappton
    {
      const s = noise(noiseBuf)
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 0.6
      bp.frequency.value = kind === 'cover' ? 520 : r(800, 1050)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0.0001, t0)
      g.gain.setValueAtTime(0.0001, tl - 0.006)
      g.gain.exponentialRampToValueAtTime(kind === 'cover' ? 0.8 : 0.5, tl + 0.004)
      g.gain.exponentialRampToValueAtTime(0.0001, tl + (kind === 'cover' ? 0.16 : 0.09))
      s.connect(bp).connect(g).connect(out)

      const o = ctx.createOscillator(); o.type = 'sine'
      const f0 = kind === 'cover' ? 95 : 150
      o.frequency.setValueAtTime(f0, tl)
      o.frequency.exponentialRampToValueAtTime(f0 * 0.5, tl + 0.08)
      const og = ctx.createGain()
      og.gain.setValueAtTime(0.0001, t0)
      og.gain.setValueAtTime(0.0001, tl - 0.004)
      og.gain.exponentialRampToValueAtTime(kind === 'cover' ? 0.5 : 0.14, tl + 0.006)
      og.gain.exponentialRampToValueAtTime(0.0001, tl + (kind === 'cover' ? 0.18 : 0.08))
      o.connect(og).connect(out)
      o.start(t0); o.stop(end)
    }
    // 5) Draht: leises metallisches Klicken beim Anheben (Umschlag: kurzes Klirren)
    {
      const ticks = kind === 'cover' ? [0, 0.035, 0.075] : [0]
      for (const dt of ticks) {
        for (const hz of [r(3900, 4300), r(5400, 5900)]) {
          const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz
          const g = ctx.createGain()
          const ts = t0 + 0.012 + dt
          g.gain.setValueAtTime(0.0001, t0)
          g.gain.setValueAtTime(0.0001, ts)
          g.gain.exponentialRampToValueAtTime(kind === 'cover' ? 0.035 : 0.022, ts + 0.002)
          g.gain.exponentialRampToValueAtTime(0.0001, ts + 0.07)
          o.connect(g).connect(out)
          o.start(t0); o.stop(ts + 0.1)
        }
      }
    }
  } catch { /* ohne Ton geht alles weiter */ }
}

function readSound(): boolean {
  try { return localStorage.getItem(SOUND_KEY) !== '0' } catch { return true }
}
function writeSound(on: boolean) {
  try { localStorage.setItem(SOUND_KEY, on ? '1' : '0') } catch { /* Storage gesperrt */ }
}

// ── Umschalter "Seite | Buch" ──────────────────────────────────────────────────
const PageIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
    <rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 8h6M9 12h6M9 16h4" />
  </svg>
)
const BookIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 6c-2-1.5-5-2-8-1.5v14c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5v-14c-3-.5-6 0-8 1.5z" /><path d="M12 6v14" />
  </svg>
)

export function ViewToggle({ book, onChange }: { book: boolean; onChange: (book: boolean) => void }) {
  const { t } = useTranslation()
  const seg = (on: boolean) =>
    `h-8 px-3 sm:px-3.5 rounded-full flex items-center gap-1.5 text-[13px] font-semibold transition-colors ${on ? '' : 'text-white/75 hover:text-white'}`
  return (
    <div role="group" aria-label={t('deck.viewSwitch', 'Ansicht')}
      className="flex items-center gap-0.5 p-1 rounded-full shadow-lg"
      style={{ background: 'rgba(27,27,34,0.9)', border: '1px solid rgba(194,161,94,0.35)' }}>
      <button type="button" aria-pressed={!book} onClick={() => { if (book) onChange(false) }}
        className={seg(!book)} style={!book ? { background: GOLD, color: DARK } : undefined}>
        <PageIcon />{t('deck.viewPage', 'Seite')}
      </button>
      <button type="button" aria-pressed={book} onClick={() => { unlockBookAudio(); if (!book) onChange(true) }}
        className={seg(book)} style={book ? { background: GOLD, color: DARK } : undefined}>
        <BookIcon />{t('deck.viewBook', 'Buch')}
      </button>
    </div>
  )
}

/** Umschalter über der Scroll-Seite: oben in der Mitte, beim Runterscrollen weg,
 *  beim Hochscrollen wieder da. */
export function TopViewToggle({ onBook }: { onBook: () => void }) {
  const [shown, setShown] = useState(true)
  useEffect(() => {
    let last = window.scrollY, raf = 0
    const on = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const y = window.scrollY
        if (y < 120) setShown(true)
        else if (y > last + 6) setShown(false)
        else if (y < last - 6) setShown(true)
        else return
        last = y
      })
    }
    window.addEventListener('scroll', on, { passive: true })
    return () => { window.removeEventListener('scroll', on); cancelAnimationFrame(raf) }
  }, [])
  return (
    <div className="fixed inset-x-0 z-50 flex justify-center pointer-events-none print:hidden transition-transform duration-300"
      style={{ top: 'max(12px, env(safe-area-inset-top))', transform: shown ? 'none' : 'translateY(-90px)' }}>
      <div className="pointer-events-auto"><ViewToggle book={false} onChange={b => { if (b) onBook() }} /></div>
    </div>
  )
}

// ── Buch ───────────────────────────────────────────────────────────────────────
export interface BookCover { image?: string; forLine?: string; logo: string }

type Els = { root: HTMLDivElement; f: HTMLElement; b: HTMLElement; fs: HTMLElement; bs: HTMLElement; cast: HTMLElement }
const q = (root: HTMLElement, sel: string) => root.querySelector(sel) as HTMLElement
const els = (root: HTMLDivElement): Els => ({
  root, f: q(root, '[data-f]'), b: q(root, '[data-b]'), fs: q(root, '[data-fs]'), bs: q(root, '[data-bs]'), cast: q(root, '[data-cast]'),
})
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const easeInOut = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2)
const easeOut = (k: number) => 1 - Math.pow(1 - k, 3)
const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false } }

// Ein Element, das selbst waagerecht scrollt (Bildleisten): dort wischt man nicht die Seite um.
function inHScroller(el: HTMLElement | null, stop: HTMLElement | null) {
  for (let n = el; n && n !== stop; n = n.parentElement) {
    if (n.scrollWidth > n.clientWidth + 2) {
      const ox = getComputedStyle(n).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
  }
  return false
}
// Hintergrund des letzten Abschnitts: füllt den Rest der Seite, wenn der Inhalt kürzer ist.
function bottomBg(el: Element | null): string | null {
  for (let n = el, depth = 0; n && depth < 6; depth++) {
    const c = getComputedStyle(n).backgroundColor
    if (c && c !== 'transparent' && !/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(c)) return c
    let last: Element | null = n.lastElementChild
    while (last && ['absolute', 'fixed'].includes(getComputedStyle(last).position)) last = last.previousElementSibling
    n = last
  }
  return null
}

function ringYs(h: number) {
  if (h < 80) return []
  const n = Math.max(6, Math.round((h - 44) / 32))
  const pad = 22
  return Array.from({ length: n }, (_, k) => pad + (k * (h - 2 * pad)) / (n - 1))
}

function Holes({ ys, h, dark }: { ys: number[]; h: number; dark?: boolean }) {
  return (
    <svg aria-hidden className="absolute left-0 top-0 pointer-events-none" width={BIND + 2} height={h}>
      {ys.map(y => (
        <g key={y}>
          <circle cx={HOLE_X} cy={y} r={3.8} fill={dark ? '#0b0b0f' : '#3a3226'} />
          <circle cx={HOLE_X} cy={y} r={3.8} fill="none" stroke={dark ? 'rgba(194,161,94,.45)' : 'rgba(0,0,0,.18)'} strokeWidth={0.9} />
        </g>
      ))}
    </svg>
  )
}

// Doppelte Drahtschlaufen (Wire-O) in Gold, halb über dem Papier, halb dahinter.
function Rings({ ys, h }: { ys: number[]; h: number }) {
  const off = 18 // SVG beginnt 18 px links vom Papier
  return (
    <svg aria-hidden className="absolute top-0 pointer-events-none" style={{ left: -off, zIndex: 5 }} width={off + BIND} height={h}>
      <defs>
        <linearGradient id="hpWire" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fff4d2" />
          <stop offset=".35" stopColor="#e3c47f" />
          <stop offset=".7" stopColor="#a6813e" />
          <stop offset="1" stopColor="#6b5124" />
        </linearGradient>
        <filter id="hpWireShadow" x="-20%" y="-50%" width="140%" height="250%"><feGaussianBlur stdDeviation="1.1" /></filter>
      </defs>
      {ys.map(y => (
        <g key={y}>
          {[-2.4, 2.4].map(dy => (
            <g key={dy}>
              <rect x={3} y={y + dy - 1.2} width={off + HOLE_X - 1} height={3.4} rx={1.7} fill="rgba(0,0,0,.4)" filter="url(#hpWireShadow)" transform="translate(1.5 2)" />
              <rect x={2} y={y + dy - 1.7} width={off + HOLE_X} height={3.4} rx={1.7} fill="url(#hpWire)" />
            </g>
          ))}
        </g>
      ))}
    </svg>
  )
}

// Inhaltsseite: scrollt in sich, Hinweis, wenn unten noch etwas kommt.
function PageScroller({ active, n, title, logo, children }: { active: boolean; n: number; title: string; logo: string; children: ReactNode }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = () => setMore(active && el.scrollHeight - el.clientHeight > 60 && el.scrollTop < 24)
    const measure = () => { el.style.backgroundColor = bottomBg(el.firstElementChild) ?? CREAM; check() }
    measure()
    const tm = setTimeout(measure, 1200) // Bilder laden nach
    el.addEventListener('scroll', check, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
    return () => { clearTimeout(tm); el.removeEventListener('scroll', check); ro?.disconnect() }
  }, [active])
  return (
    <>
      <div ref={ref} className="absolute inset-0 overflow-y-auto overscroll-contain hpbook-page"
        style={{ left: BIND, touchAction: 'pan-y pinch-zoom' }}>
        {/* Kopfzeile wie im Buch: auf jeder Seite gleich */}
        <div className="sticky top-0 z-[3] flex items-center gap-2.5 sm:gap-3 min-h-12 sm:min-h-14 py-1.5 pl-3.5 pr-3 sm:px-8"
          style={{ background: CREAM, borderBottom: '1px solid rgba(194,161,94,.45)' }}>
          <span className="font-heading italic text-lg sm:text-xl tabular-nums leading-none" style={{ color: GOLD }}>{String(n).padStart(2, '0')}</span>
          <span aria-hidden className="w-px h-5 shrink-0" style={{ background: 'rgba(194,161,94,.5)' }} />
          <span className="font-heading font-bold text-[14px] sm:text-lg leading-tight line-clamp-2 min-w-0" style={{ color: DARK }}>{title}</span>
          <img src={logo} alt="" aria-hidden className="ml-auto h-5 sm:h-7 w-auto rounded shrink-0 pointer-events-none"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        </div>
        {children}
      </div>
      {more && (
        <div className="absolute bottom-4 inset-x-0 flex justify-center pointer-events-none" style={{ paddingLeft: BIND }}>
          <span className="px-3 py-1.5 rounded-full text-[12px] font-semibold text-white shadow-lg flex items-center gap-1.5"
            style={{ background: 'rgba(27,27,34,.82)', animation: 'hpBookNudge 1.8s ease-in-out infinite' }}>
            {t('deck.bookScrollHint', 'Weiter nach unten')} <span aria-hidden>↓</span>
          </span>
        </div>
      )}
    </>
  )
}

function CoverFace({ cover, onOpen }: { cover: BookCover; onOpen: () => void }) {
  const { t } = useTranslation()
  return (
    <button type="button" onClick={onOpen} aria-label={t('deck.bookOpen', 'Buch öffnen')}
      className="absolute inset-0 w-full h-full text-center cursor-pointer overflow-hidden"
      style={{ background: `radial-gradient(120% 90% at 30% 18%, #2c2c38 0%, ${DARK} 55%, #111116 100%)` }}>
      {/* Leinenstruktur */}
      <span aria-hidden className="absolute inset-0 opacity-60" style={{
        backgroundImage: 'repeating-linear-gradient(0deg, rgba(255,255,255,.022) 0 1px, transparent 1px 3px), repeating-linear-gradient(90deg, rgba(0,0,0,.09) 0 1px, transparent 1px 4px)',
      }} />
      <span aria-hidden className="absolute rounded-md top-[18px] bottom-[18px] right-[18px] left-[30px] sm:top-[28px] sm:bottom-[28px] sm:right-[28px] sm:left-[44px]"
        style={{ border: '1px solid rgba(194,161,94,.55)', boxShadow: 'inset 0 0 0 5px rgba(27,27,34,0), inset 0 0 0 6px rgba(194,161,94,.22)' }} />
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-3 sm:gap-4 px-10 sm:px-16 py-10 sm:py-14" style={{ paddingLeft: BIND + 28 }}>
        <img src={cover.logo} alt="Happy Property" className="h-11 sm:h-14 w-auto rounded-md shrink-0"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />
        <span className="text-[11px] sm:text-xs font-semibold uppercase tracking-[0.32em]" style={{ color: GOLD, textShadow: '0 1px 0 rgba(0,0,0,.5)' }}>
          {t('deck.bookCoverKicker', 'Persönliches Exposé')}
        </span>
        <span aria-hidden className="block w-12 h-px" style={{ background: GOLD }} />
        {cover.image && (
          <span className="block w-[82%] max-w-[560px] aspect-[4/3] rounded-sm overflow-hidden shrink"
            style={{ maxHeight: '42%', border: '1px solid rgba(194,161,94,.6)', boxShadow: '0 14px 34px rgba(0,0,0,.55)' }}>
            <img src={cover.image} alt="" className="w-full h-full object-cover" draggable={false} />
          </span>
        )}
        <span className="font-heading italic text-white/90 text-lg sm:text-2xl leading-snug">
          {cover.forLine || t('deck.bookCoverFor', 'Für dich zusammengestellt')}
        </span>
        <span className="mt-1 sm:mt-2 px-4 py-2 rounded-full text-[13px] font-semibold flex items-center gap-2 shrink-0"
          style={{ color: DARK, background: GOLD, animation: 'hpBookNudge 1.8s ease-in-out infinite' }}>
          {t('deck.bookOpenHint', 'Zum Öffnen tippen')} <span aria-hidden>→</span>
        </span>
      </span>
    </button>
  )
}

// Eselsohr unten rechts: zeigt, dass man umblättern kann, und blättert per Klick.
function Corner({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation()
  return (
    <button type="button" aria-label={t('deck.next', 'Weiter')} onClick={onClick}
      className="group absolute right-0 bottom-0 w-16 h-16 flex items-end justify-end" style={{ zIndex: 3 }}>
      <span className="relative block w-8 h-8 group-hover:w-12 group-hover:h-12 transition-all duration-300 ease-out">
        <span className="absolute inset-0" style={{ background: 'linear-gradient(315deg, #ded3bd 0%, #e9e0cc 45%, rgba(0,0,0,0) 50%)' }} />
        <span className="absolute inset-0" style={{
          background: `linear-gradient(315deg, rgba(0,0,0,0) 50%, #fffaf0 50%, ${PAPER_BACK} 100%)`,
          filter: 'drop-shadow(-2px -2px 3px rgba(0,0,0,.22))', borderTopLeftRadius: 4,
        }} />
      </span>
    </button>
  )
}

const IconBtn = ({ label, onClick, disabled, children, className = 'flex' }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; className?: string }) => (
  <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled}
    className={`${className} w-8 h-8 sm:w-9 sm:h-9 shrink-0 rounded-full items-center justify-center text-white/85 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent transition`}>
    {children}
  </button>
)

export function DeckBook({ count, renderPage, titles, cover, onClose }: {
  count: number
  renderPage: (i: number) => ReactNode
  /** Überschrift je Inhaltsseite für den Seitenkopf */
  titles: string[]
  cover: BookCover
  /** page = zuletzt offene Inhaltsseite (0-basiert), -1 = Umschlag */
  onClose: (page: number) => void
}) {
  const { t } = useTranslation()
  const total = count + 1
  const [cur, setCur] = useState(0)
  const [sound, setSound] = useState(readSound)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [fs, setFs] = useState(false)
  const bookRef = useRef<HTMLDivElement>(null)
  const sheets = useRef(new Map<number, HTMLDivElement>())
  const curRef = useRef(0)
  const sizeRef = useRef(size)
  const soundRef = useRef(sound)
  const anim = useRef({ busy: false, pending: 0 as 0 | 1 | -1, raf: 0, touched: false })
  const drag = useRef<null | { id: number; x: number; y: number; on: boolean; dir: 1 | -1; a: number; lastX: number; lastT: number; v: number }>(null)
  const noClick = useRef(false)
  curRef.current = cur
  sizeRef.current = size
  soundRef.current = sound
  const canFs = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen

  // Größe des Buchs messen (Ringe, Perspektive, Wischweg)
  useLayoutEffect(() => {
    const el = bookRef.current
    if (!el) return
    const measure = () => setSize(s => (s.w === el.clientWidth && s.h === el.clientHeight) ? s : { w: el.clientWidth, h: el.clientHeight })
    measure()
    if (typeof ResizeObserver === 'undefined') { window.addEventListener('resize', measure); return () => window.removeEventListener('resize', measure) }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Seite hinter dem Buch nicht mitscrollen lassen
  useEffect(() => {
    const html = document.documentElement
    const prev = html.style.overflow
    html.style.overflow = 'hidden'
    return () => { html.style.overflow = prev; cancelAnimationFrame(anim.current.raf) }
  }, [])

  useEffect(() => {
    const on = () => setFs(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  // Ruhezustand aller Blätter: umgeblätterte unsichtbar, alles flach, keine Schatten.
  const rest = () => {
    for (const [s, root] of sheets.current) {
      const e = els(root)
      root.style.transform = ''
      root.style.opacity = ''
      root.style.visibility = s < curRef.current ? 'hidden' : ''
      e.f.style.visibility = ''
      e.b.style.visibility = 'hidden'
      e.fs.style.opacity = '0'
      e.bs.style.opacity = '0'
      e.cast.style.opacity = '0'
    }
  }
  useLayoutEffect(rest, [cur, total])

  // Ein Bild der Drehung. a: 0 = flach rechts (aufgeschlagen), -180 = umgeblättert links.
  const frame = (dir: 1 | -1, a: number) => {
    const c = curRef.current
    const mRoot = sheets.current.get(dir === 1 ? c : c - 1)
    const bRoot = sheets.current.get(dir === 1 ? c + 1 : c)
    if (!mRoot) return
    const m = els(mRoot)
    const W = sizeRef.current.w || 1
    const P = Math.max(1800, W * 5)
    const deg = clamp(-a, 0, 180)
    const rad = (deg * Math.PI) / 180
    const lift = Math.sin(rad)
    const front = deg < 90
    mRoot.style.visibility = 'visible'
    mRoot.style.transform = `perspective(${P}px) rotateY(${-deg}deg)`
    // Hinter den Ringen verschwinden statt hart auszublenden
    mRoot.style.opacity = deg > 150 ? String(clamp(1 - (deg - 150) / 30, 0, 1)) : ''
    m.f.style.visibility = front ? 'visible' : 'hidden'
    m.b.style.visibility = front ? 'hidden' : 'visible'
    m.fs.style.opacity = front ? String(lift * 0.85) : '0'
    m.bs.style.opacity = front ? '0' : String(lift * 0.85)
    if (bRoot) {
      const cast = els(bRoot).cast
      const cos = Math.cos(rad)
      if (cos > 0) {
        // Schatten der Blattkante auf der Seite darunter (mit Perspektive projiziert)
        const edge = (W * cos * P) / (P - W * lift)
        const len = 30 + 170 * lift
        cast.style.background = `linear-gradient(to right, rgba(0,0,0,0) ${edge - 1}px, rgba(0,0,0,${(0.34 * lift).toFixed(3)}) ${edge}px, rgba(0,0,0,0) ${edge + len}px)`
      } else {
        const len = 40 + 220 * lift
        cast.style.background = `linear-gradient(to right, rgba(0,0,0,${(0.3 * lift).toFixed(3)}) 0px, rgba(0,0,0,0) ${len}px)`
      }
      cast.style.opacity = '1'
    }
  }

  const tween = (dir: 1 | -1, from: number, to: number, ms: number, ease: (k: number) => number, done: () => void) => {
    const t0 = performance.now()
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms)
      frame(dir, from + (to - from) * ease(k))
      if (k < 1) anim.current.raf = requestAnimationFrame(step)
      else done()
    }
    anim.current.raf = requestAnimationFrame(step)
  }

  const commit = (dir: 1 | -1) => {
    const next = curRef.current + dir
    curRef.current = next
    anim.current.busy = false
    setCur(next)
    flushPending()
  }
  const cancel = () => { anim.current.busy = false; rest(); flushPending() }
  // Während einer Drehung gedrückt: danach gleich weiter, etwas schneller
  const flushPending = () => requestAnimationFrame(() => {
    const p = anim.current.pending
    anim.current.pending = 0
    if (p) turnRef.current(p, true)
  })

  const isCoverTurn = (dir: 1 | -1) => (dir === 1 && curRef.current === 0) || (dir === -1 && curRef.current === 1)

  const turn = (dir: 1 | -1, quick = false) => {
    anim.current.touched = true
    if (anim.current.busy) { anim.current.pending = dir; return }
    const target = curRef.current + dir
    if (target < 0 || target >= total) return
    unlockBookAudio()
    const coverTurn = isCoverTurn(dir)
    const ms = (coverTurn ? 950 : 720) * (quick ? 0.7 : 1)
    if (soundRef.current) playTurn((ms / 1000) * 0.97, coverTurn ? 'cover' : 'page')
    if (reducedMotion()) { curRef.current = target; setCur(target); return }
    anim.current.busy = true
    tween(dir, dir === 1 ? 0 : -180, dir === 1 ? -180 : 0, ms, easeInOut, () => commit(dir))
  }
  const turnRef = useRef(turn)
  turnRef.current = turn

  // Umschlag hebt sich kurz an, wenn niemand etwas tut: zeigt, dass er aufgeht.
  useEffect(() => {
    if (cur !== 0) return
    const tm = setTimeout(() => {
      if (anim.current.busy || anim.current.touched || curRef.current !== 0 || reducedMotion()) return
      anim.current.busy = true
      tween(1, 0, -22, 520, easeOut, () => tween(1, -22, 0, 620, easeInOut, cancel))
    }, 1400)
    return () => clearTimeout(tm)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur])

  // Tastatur: Pfeile und Bild auf/ab blättern, Escape schließt
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tg = e.target as HTMLElement | null
      if (tg?.closest('input,textarea,select,[contenteditable="true"]')) return
      if (document.querySelector('[aria-modal="true"]')) return // Foto-Vollbild oder Formular offen
      if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); turnRef.current(1) }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); turnRef.current(-1) }
      else if (e.key === 'Escape' && !document.fullscreenElement) onClose(curRef.current - 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Wischen / Ziehen: das Blatt folgt dem Finger
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (anim.current.busy || e.defaultPrevented) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const tg = e.target as HTMLElement
    if (tg.closest('input,textarea,select,iframe,[aria-modal="true"]')) return
    // Auf einem Video wird geblättert, nur nicht auf der Steuerleiste (Zeitleiste ziehen)
    if (tg instanceof HTMLVideoElement && tg.controls && e.clientY > tg.getBoundingClientRect().bottom - 56) return
    if (inHScroller(tg, bookRef.current)) return
    const now = performance.now()
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, dir: 1, a: 0, lastX: e.clientX, lastT: now, v: 0 }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (!d.on) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
      if (Math.abs(dy) >= Math.abs(dx)) { drag.current = null; return }
      const dir: 1 | -1 = dx < 0 ? 1 : -1
      const c = curRef.current
      if (anim.current.busy || (dir === 1 && c >= total - 1) || (dir === -1 && c <= 0)) { drag.current = null; return }
      d.on = true; d.dir = dir
      anim.current.busy = true
      anim.current.touched = true
      unlockBookAudio()
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* egal */ }
    }
    const W = sizeRef.current.w || 1
    const p = clamp((d.dir === 1 ? -dx : dx) / (W * 0.85), 0, 1)
    d.a = d.dir === 1 ? -180 * p : -180 + 180 * p
    const now = performance.now()
    d.v = (e.clientX - d.lastX) / Math.max(1, now - d.lastT)
    d.lastX = e.clientX; d.lastT = now
    frame(d.dir, d.a)
  }
  const onPointerEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    if (!d.on) return
    noClick.current = true
    setTimeout(() => { noClick.current = false }, 80)
    const p = d.dir === 1 ? -d.a / 180 : (d.a + 180) / 180
    const v = performance.now() - d.lastT > 90 ? 0 : d.v // losgelassen nach Stillstand: kein Schwung
    const vForward = d.dir === 1 ? -v : v   // px/ms in Blätterrichtung
    const ok = e.type !== 'pointercancel' && vForward > -0.4 && (p > 0.38 || vForward > 0.45)
    if (ok) {
      const ms = clamp(560 * (1 - p), 140, 520)
      if (soundRef.current) playTurn(ms / 1000, isCoverTurn(d.dir) ? 'cover' : 'page')
      tween(d.dir, d.a, d.dir === 1 ? -180 : 0, ms, easeOut, () => commit(d.dir))
    } else {
      tween(d.dir, d.a, d.dir === 1 ? 0 : -180, 240, easeOut, cancel)
    }
  }

  const toggleSound = () => {
    const on = !sound
    setSound(on); writeSound(on)
    if (on) { unlockBookAudio(); playTurn(0.35, 'page') }
  }
  const toggleFs = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else void document.documentElement.requestFullscreen?.().catch(() => {})
  }

  const ys = ringYs(size.h)
  const idxs = [cur + 1, cur, cur - 1].filter(s => s >= 0 && s < total) // DOM-Reihenfolge: obere Blätter zuletzt
  const left = total - 1 - cur
  const progress = total > 1 ? cur / (total - 1) : 1

  return (
    <div className="fixed inset-0 z-[45] flex flex-col print:hidden"
      style={{ background: 'radial-gradient(ellipse at 50% 38%, #2b2b35 0%, #15151b 62%, #0d0d11 100%)', animation: 'hpBookFade .3s ease-out' }}>
      {/* Leiste oben */}
      <div className="relative z-10 shrink-0 flex items-center justify-between gap-1.5 sm:gap-2 px-1.5 sm:px-4"
        style={{ height: 56, marginTop: 'env(safe-area-inset-top)', background: 'rgba(12,12,16,.75)' }}>
        <div className="sm:flex-1 sm:basis-0 flex items-center min-w-0">
          <IconBtn label={t('deck.prev', 'Zurück')} onClick={() => turn(-1)} disabled={cur === 0}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
          </IconBtn>
          <span className="text-xs sm:text-sm tabular-nums text-white/70 min-w-[38px] sm:min-w-[44px] text-center whitespace-nowrap">
            {cur === 0 ? t('deck.bookCoverShort', 'Titel') : `${cur} / ${count}`}
          </span>
          <IconBtn label={t('deck.next', 'Weiter')} onClick={() => turn(1)} disabled={cur >= total - 1}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
          </IconBtn>
        </div>
        <ViewToggle book onChange={b => { if (!b) onClose(cur - 1) }} />
        <div className="sm:flex-1 sm:basis-0 flex items-center justify-end gap-1">
          <IconBtn label={sound ? t('deck.bookSoundOff', 'Ton aus') : t('deck.bookSoundOn', 'Ton an')} onClick={toggleSound}>
            {sound ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 9v6h4l5 4V5L8 9H4z" /><path d="M17 9l5 6M22 9l-5 6" /></svg>
            )}
          </IconBtn>
          {canFs && (
            <span className="hidden sm:inline-flex">
              <IconBtn label={t('deck.fullscreen', 'Vollbild')} onClick={toggleFs}>
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  {fs ? <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" /> : <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />}
                </svg>
              </IconBtn>
            </span>
          )}
        </div>
        <div className="absolute left-0 bottom-0 h-[2px] transition-all duration-500" style={{ width: `${progress * 100}%`, background: GOLD }} />
      </div>

      {/* Tisch mit dem Buch */}
      <div className="relative flex-1 min-h-0 pt-4 sm:pt-6 pl-[30px] pr-[18px] sm:px-20 pb-[calc(84px+env(safe-area-inset-bottom))] sm:pb-[100px]">
        <div ref={bookRef} className="relative h-full mx-auto select-none"
          style={{ maxWidth: 1180, touchAction: 'pan-y pinch-zoom', animation: 'hpBookArrive .6s cubic-bezier(.2,.8,.2,1)', ['--hp-book-h' as string]: `${size.h || 600}px` }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
          onClickCapture={e => { if (noClick.current) { e.preventDefault(); e.stopPropagation() } }}
          onDragStart={e => e.preventDefault()}>
          {/* Rückdeckel und Papierstapel */}
          <div aria-hidden className="absolute rounded-[10px]" style={{ top: -6, bottom: -9, left: -4, right: -12, background: `linear-gradient(135deg, #2a2a34, ${DARK} 60%, #101015)`, boxShadow: '0 30px 60px rgba(0,0,0,.55), 0 8px 18px rgba(0,0,0,.35)' }} />
          {cur > 0 && <div aria-hidden className="absolute" style={{ top: -6, bottom: -9, left: -30, width: 14, borderRadius: '8px 0 0 8px', background: `linear-gradient(90deg, #121217, ${DARK})`, boxShadow: '-4px 10px 20px rgba(0,0,0,.4)' }} />}
          {[3, 2, 1].filter(k => k <= left).map(k => (
            <div key={k} aria-hidden className="absolute inset-0" style={{
              transform: `translate(${k * 2.2}px, ${k * 1.8}px)`, borderRadius: SHEET_RADIUS,
              background: ['#efe7d6', '#e7dec9', '#ded4bd'][k - 1], boxShadow: '0 1px 1px rgba(0,0,0,.15)',
            }} />
          ))}

          {idxs.map(s => (
            <div key={s} ref={el => { if (el) sheets.current.set(s, el); else sheets.current.delete(s) }}
              className="absolute inset-0" style={{ transformOrigin: 'left center' }}>
              <div data-f className="absolute inset-0 overflow-hidden" style={{ borderRadius: SHEET_RADIUS, background: s === 0 ? DARK : CREAM, boxShadow: '0 1px 2px rgba(0,0,0,.25)' }}>
                {s === 0 ? <CoverFace cover={cover} onOpen={() => turn(1)} /> : (
                  <PageScroller active={s === cur} n={s} title={titles[s - 1] ?? ''} logo={cover.logo}>
                    <InBookCtx.Provider value>
                      <VideoAutoCtx.Provider value={s === cur}>{renderPage(s - 1)}</VideoAutoCtx.Provider>
                    </InBookCtx.Provider>
                  </PageScroller>
                )}
                <Holes ys={ys} h={size.h} dark={s === 0} />
                <div aria-hidden className="absolute inset-y-0 left-0 w-10 pointer-events-none" style={{ background: 'linear-gradient(to right, rgba(0,0,0,.16), rgba(0,0,0,0))' }} />
                {s > 0 && s === cur && s < total - 1 && <Corner onClick={() => turn(1)} />}
                {/* Wischstreifen am rechten Rand (Touch): blättert auch, wenn die Seite voll mit einem eingebetteten Video ist */}
                {s > 0 && s === cur && <div aria-hidden className="hpbook-edge absolute right-0 top-12 bottom-16 w-5" style={{ zIndex: 4 }} />}
                <div data-fs aria-hidden className="absolute inset-0 pointer-events-none" style={{ opacity: 0, background: 'linear-gradient(to right, rgba(0,0,0,.28), rgba(0,0,0,.08) 55%, rgba(255,255,255,.14))' }} />
                <div data-cast aria-hidden className="absolute inset-0 pointer-events-none" style={{ opacity: 0 }} />
              </div>
              <div data-b aria-hidden className="absolute inset-0 overflow-hidden" style={{ visibility: 'hidden', borderRadius: SHEET_RADIUS, background: s === 0 ? '#25252e' : PAPER_BACK }}>
                <Holes ys={ys} h={size.h} dark={s === 0} />
                <div className="absolute inset-y-0 left-0 w-10" style={{ background: 'linear-gradient(to right, rgba(0,0,0,.14), rgba(0,0,0,0))' }} />
                <div data-bs className="absolute inset-0" style={{ opacity: 0, background: 'linear-gradient(to right, rgba(0,0,0,.1), rgba(255,255,255,.16))' }} />
              </div>
            </div>
          ))}

          <Rings ys={ys} h={size.h} />
        </div>

        {/* Große Pfeile neben dem Buch (ab Tablet) */}
        <button type="button" aria-label={t('deck.prev', 'Zurück')} onClick={() => turn(-1)} disabled={cur === 0}
          className="hidden sm:flex absolute left-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full items-center justify-center text-white/70 hover:text-white bg-white/5 hover:bg-white/15 disabled:opacity-0 transition">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M15 6l-6 6 6 6" /></svg>
        </button>
        <button type="button" aria-label={t('deck.next', 'Weiter')} onClick={() => turn(1)} disabled={cur >= total - 1}
          className="hidden sm:flex absolute right-4 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full items-center justify-center text-white/70 hover:text-white bg-white/5 hover:bg-white/15 disabled:opacity-0 transition">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M9 6l6 6-6 6" /></svg>
        </button>
      </div>

      <style>{`
@keyframes hpBookFade{from{opacity:0}to{opacity:1}}
@keyframes hpBookArrive{from{opacity:0;transform:translateY(26px) scale(.94)}to{opacity:1;transform:none}}
@keyframes hpBookNudge{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@media (prefers-reduced-motion: reduce){[style*="hpBook"]{animation:none!important}}
@media (pointer: fine){.hpbook-edge{display:none}}
.hpbook-page .hpweb{background-color:transparent}
.hpbook-page .hpweb > section:first-child{margin-top:0}
`}</style>
    </div>
  )
}
