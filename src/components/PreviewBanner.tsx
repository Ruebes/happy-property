import { useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'

// Leiste am unteren Rand, solange der Admin ein Portal „als" jemand ansieht.
const PORTAL_NAME: Record<string, string> = {
  eigentuemer: 'Eigentümerportal',
  verwalter: 'Verwaltungsportal',
  feriengast: 'Feriengast-Portal',
}

export default function PreviewBanner() {
  const { preview, endPreview } = useAuth()
  const navigate = useNavigate()
  if (!preview) return null
  return (
    <div className="fixed bottom-0 inset-x-0 z-[1000] flex justify-center px-3 pb-3 pointer-events-none">
      <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-[#1a2332] text-white shadow-2xl px-4 py-3 text-sm max-w-full">
        <span className="font-semibold">👁 Vorschau: {PORTAL_NAME[preview.role] ?? preview.role}</span>
        <span className="text-white/70">als {preview.label} · nur ansehen, nichts wird gespeichert</span>
        <button
          onClick={() => { endPreview(); navigate('/admin/crm/vorschau') }}
          className="rounded-xl px-3 py-1.5 font-semibold text-white"
          style={{ backgroundColor: '#ff795d' }}
        >
          Vorschau beenden
        </button>
      </div>
    </div>
  )
}
