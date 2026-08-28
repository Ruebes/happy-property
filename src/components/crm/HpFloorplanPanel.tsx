// HP-Grundrisse: standardisierte Grundrisse im Happy-Property-Stil je Wohnung,
// automatisch aus dem Original-Bauträgerplan (Edge Function hp-floorplan:
// Quelle finden → Higgsfield-Restyle → Vision-Verifikation → deck_assets.unit_floorplans).
// Panel im Projektformular Medien-Tab; Status wird über deck_assets.hp_floorplans gepollt.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

type UnitRow = { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null }
type HpState = { status?: string; url?: string; verified?: boolean; issues?: string[]; error?: string; at?: string }
type DA = {
  unit_floorplans?: Record<string, string>
  hp_floorplans?: Record<string, HpState>
}

const normU = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '')

export default function HpFloorplanPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const [units, setUnits] = useState<UnitRow[]>([])
  const [da, setDa] = useState<DA>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [msg, setMsg] = useState<string | null>(null)
  const pollRef = useRef<number | null>(null)

  const load = useCallback(async () => {
    const [{ data: u }, { data: p }] = await Promise.all([
      supabase.from('crm_project_units')
        .select('id, unit_number, bedrooms, size_sqm')
        .eq('project_id', projectId)
        .not('status', 'in', '(sold,reserved)')
        .order('unit_number'),
      supabase.from('crm_projects').select('deck_assets').eq('id', projectId).maybeSingle(),
    ])
    setUnits((u ?? []) as UnitRow[])
    setDa(((p?.deck_assets ?? {}) as DA))
    return ((p?.deck_assets ?? {}) as DA)
  }, [projectId])

  useEffect(() => { void load() }, [load])

  // Solange irgendein Grundriss laeuft, alle 5 s nachladen (Muster LeadAngebote).
  useEffect(() => {
    const running = Object.values(da.hp_floorplans ?? {}).some(s => s.status === 'running')
    if (!running) { if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null }; return }
    if (pollRef.current) return
    pollRef.current = window.setInterval(() => { void load() }, 5000)
    return () => { if (pollRef.current) { window.clearInterval(pollRef.current); pollRef.current = null } }
  }, [da, load])

  const start = async (u: UnitRow) => {
    setBusy(b => ({ ...b, [u.id]: true }))
    setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('hp-floorplan', {
        body: { project_id: projectId, unit_number: u.unit_number },
      })
      const res = data as { ok?: boolean; error?: string } | null
      if (error || res?.error) setMsg(`${u.unit_number}: ${res?.error ?? error?.message ?? t('crm.project.hpfp.startFailed', 'Start fehlgeschlagen')}`)
      await load()
    } finally {
      setBusy(b => ({ ...b, [u.id]: false }))
    }
  }

  if (!units.length) return null
  const fpMap: Record<string, string> = {}
  for (const [k, v] of Object.entries(da.unit_floorplans ?? {})) fpMap[normU(k)] = v

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {t('crm.project.hpfp.title', 'HP-Grundrisse (automatisch aus dem Bauträger-Plan)')}
      </label>
      <p className="text-xs text-gray-400 mb-2">
        {t('crm.project.hpfp.help', 'Zeichnet den Original-Grundriss im Happy-Property-Stil nach (Wände 1:1, keine erfundenen Maße; echte Flächen stehen als Text unter dem Plan im Deck). Ergebnis fließt automatisch in neue Decks.')}
      </p>
      <div className="space-y-1.5">
        {units.map(u => {
          const key = normU(u.unit_number)
          const st = (da.hp_floorplans ?? {})[key]
          const existing = fpMap[key]
          const running = st?.status === 'running'
          return (
            <div key={u.id} className="flex items-center gap-2 text-sm">
              <span className="w-24 shrink-0 font-medium text-gray-800">{u.unit_number}</span>
              <span className="flex-1 text-xs text-gray-500 truncate">
                {running && <span className="text-orange-600">⏳ {t('crm.project.hpfp.running', 'wird gezeichnet…')}</span>}
                {!running && st?.status === 'error' && <span className="text-red-600" title={st.error}>⚠ {t('crm.project.hpfp.error', 'Fehler')}: {st.error?.slice(0, 80)}</span>}
                {!running && st?.status !== 'error' && existing && (
                  <a href={existing} target="_blank" rel="noopener noreferrer" className="text-green-700 hover:underline">
                    ✓ {t('crm.project.hpfp.done', 'Grundriss vorhanden')}{st?.verified === false ? ` · ${t('crm.project.hpfp.unverified', 'nicht verifiziert - bitte ansehen')}` : ''} ↗
                  </a>
                )}
                {!running && !st && !existing && <span>{t('crm.project.hpfp.missing', 'kein Grundriss hinterlegt')}</span>}
              </span>
              <button
                type="button"
                onClick={() => void start(u)}
                disabled={running || busy[u.id]}
                className="px-2.5 py-1 rounded-lg text-xs font-medium border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
              >
                {existing ? t('crm.project.hpfp.redo', 'Neu zeichnen') : t('crm.project.hpfp.create', 'Erzeugen')}
              </button>
            </div>
          )
        })}
      </div>
      {msg && <p className="text-xs mt-2 rounded-lg px-3 py-2 text-red-600 bg-red-50">{msg}</p>}
    </div>
  )
}
