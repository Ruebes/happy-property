// ── Piktogramme im HP-Stil (inline SVG = sofort geladen) ─────────────────────
// Genutzt vom öffentlichen Funnel (/termin) und vom Funnel-Editor (Icon-Picker).
const NAVY = '#1a2332'
const CORAL = '#ff795d'

export default function FunnelIcon({ kind, className }: { kind: string; className?: string }) {
  const s = { fill: 'none', stroke: NAVY, strokeWidth: 2.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const }
  const c = { ...s, stroke: CORAL }
  return (
    <svg viewBox="0 0 64 64" className={className ?? 'w-12 h-12 md:w-14 md:h-14'} aria-hidden="true">
      {kind === 'steuern' && (<>
        <path {...s} d="M32 6 L52 14 V30 C52 44 43 53 32 58 C21 53 12 44 12 30 V14 Z" />
        <circle {...c} cx="25" cy="26" r="4" /><circle {...c} cx="39" cy="40" r="4" /><line {...c} x1="40" y1="22" x2="24" y2="44" />
      </>)}
      {kind === 'kapital' && (<>
        <rect {...s} x="10" y="38" width="9" height="16" rx="1.5" /><rect {...s} x="26" y="28" width="9" height="26" rx="1.5" /><rect {...s} x="42" y="18" width="9" height="36" rx="1.5" />
        <path {...c} d="M10 24 C22 20 30 16 44 8" /><path {...c} d="M36 8 H45 V17" />
      </>)}
      {kind === 'auswandern' && (<>
        <circle {...c} cx="32" cy="26" r="9" />
        <line {...c} x1="32" y1="8" x2="32" y2="12" /><line {...c} x1="14" y1="26" x2="18" y2="26" /><line {...c} x1="46" y1="26" x2="50" y2="26" /><line {...c} x1="19" y1="13" x2="22" y2="16" /><line {...c} x1="45" y1="13" x2="42" y2="16" />
        <path {...s} d="M8 46 C14 42 20 42 26 46 C32 50 38 50 44 46 C50 42 56 42 58 44" />
        <path {...s} d="M8 55 C14 51 20 51 26 55 C32 59 38 59 44 55 C50 51 56 51 58 53" />
      </>)}
      {kind === 'langfristig' && (<>
        <path {...s} d="M10 30 L30 14 L50 30" /><path {...s} d="M16 28 V52 H36 V28" />
        <circle {...c} cx="46" cy="46" r="10" /><path {...c} d="M46 40 V46 L51 49" />
      </>)}
      {kind === 'unsicher' && (<>
        <circle {...s} cx="32" cy="32" r="22" />
        <path {...c} d="M40 24 L36 36 L24 40 L28 28 Z" /><circle cx="32" cy="10" r="2" fill={CORAL} stroke="none" />
      </>)}
    </svg>
  )
}

// Kachel-Bildseite einer Option: eigenes Bild > Piktogramm > Emoji
export function OptionVisual({ icon, emoji, image_url }: { icon?: string; emoji?: string; image_url?: string }) {
  if (image_url) return <img src={image_url} alt="" className="w-16 h-16 md:w-20 md:h-20 object-cover rounded-xl" loading="lazy" />
  if (icon) return <span className="rounded-full p-3" style={{ background: 'rgba(255,121,93,0.08)' }}><FunnelIcon kind={icon} /></span>
  if (emoji) return <span className="text-4xl md:text-5xl leading-none">{emoji}</span>
  return <span className="rounded-full p-3" style={{ background: 'rgba(255,121,93,0.08)' }}><FunnelIcon kind="unsicher" /></span>
}
