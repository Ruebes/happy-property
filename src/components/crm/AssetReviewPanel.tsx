// Freigabe-Fach fuer den Asset-Katalog (deck_assets_catalog) eines Projekts:
//   1. Grundrisse je Wohnung (Zuschnitte aus den Bautraegerblaettern durch
//      floorplan-catalog, HP-Plaene, Handablagen) - freigeben / ablehnen /
//      fuer baugleiche Wohnungen freigeben (same_layout_as).
//   2. Bilder im Status "review" (Vision unsicher oder Ordner ≠ Vision) -
//      Wohnungstyp setzen und freigeben, oder ablehnen.
// Automatik setzt nie "approved"; das ist Svens Klick (19.9.26).
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

type Row = {
  id: string; storage_url: string; label: string | null; source_type: string; primary_category: string | null
  property_type: string; status: string; unit_key: string | null; same_layout_as: string[]; floor_labels: string[]
  dimensions_present: boolean | null; source_page: number | null; confidence: number | null; folder_hint: string | null
  meta: Record<string, unknown> | null
}
type UnitRow = { id: string; unit_number: string; unit_key: string; type: string | null }
const TYPES = ['apartment', 'villa', 'townhouse', 'project_generic', 'unknown'] as const

export default function AssetReviewPanel({ projectId }: { projectId: string }) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<Row[]>([])
  const [units, setUnits] = useState<UnitRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [report, setReport] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [{ data: r }, { data: u }, { data: p }] = await Promise.all([
      supabase.from('deck_assets_catalog')
        .select('id, storage_url, label, source_type, primary_category, property_type, status, unit_key, same_layout_as, floor_labels, dimensions_present, source_page, confidence, folder_hint, meta')
        .eq('project_id', projectId).eq('active', true).neq('status', 'rejected')
        .or('source_type.eq.floorplan,status.eq.review')
        .order('unit_key', { ascending: true, nullsFirst: false }).order('created_at'),
      supabase.from('crm_project_units').select('id, unit_number, unit_key, type').eq('project_id', projectId).order('unit_number'),
      supabase.from('crm_projects').select('deck_assets').eq('id', projectId).maybeSingle(),
    ])
    setRows((r ?? []) as Row[])
    setUnits((u ?? []) as UnitRow[])
    const fc = ((p?.deck_assets ?? {}) as { floorplan_catalog?: { at?: string; report?: Array<{ asset?: string; plans?: number; units?: string[]; skipped?: string[]; error?: string }> } }).floorplan_catalog
    if (fc?.report) {
      setReport(`${fc.at?.slice(0, 16).replace('T', ' ') ?? ''}: ` + fc.report.map(e => `${e.asset}: ${e.plans ?? 0} ${t('crm.project.assets.plans', 'Pläne')}${e.units?.length ? ` (${e.units.join(', ')})` : ''}${e.error ? ` · ⚠ ${e.error}` : ''}`).join(' · '))
    }
  }, [projectId, t])

  useEffect(() => { void load() }, [load])

  const patch = async (id: string, p: Partial<Row> & { reviewed_at?: string }) => {
    setBusy(id)
    try {
      const { error } = await supabase.from('deck_assets_catalog').update({ ...p, reviewed_at: new Date().toISOString() }).eq('id', id)
      if (error) setMsg(error.message)
      await load()
    } finally { setBusy(null) }
  }

  const runCatalog = async () => {
    setRunning(true); setMsg(null)
    try {
      const { data, error } = await supabase.functions.invoke('floorplan-catalog', { body: { project_id: projectId, force: true } })
      const d = data as { ok?: boolean; error?: string; sources?: number; note?: string } | null
      if (error || d?.error) setMsg(d?.error ?? error?.message ?? 'Fehler')
      else setMsg(d?.note ?? t('crm.project.assets.catalogStarted', '{{n}} Bauträgerblatt/-blätter werden im Hintergrund ausgewertet (1-3 Min). Danach hier neu laden.', { n: d?.sources ?? 0 }))
    } finally { setRunning(false) }
  }

  const floorplans = rows.filter(r => r.source_type === 'floorplan' && r.unit_key)
  const sheets = rows.filter(r => r.source_type === 'floorplan' && !r.unit_key)
  const reviewImgs = rows.filter(r => r.source_type !== 'floorplan' && r.status === 'review')
  const unitName = (k: string | null) => units.find(u => u.unit_key === k)?.unit_number ?? k ?? '?'
  if (!floorplans.length && !sheets.length && !reviewImgs.length) return null

  return (
    <div className="mt-3 border-t border-gray-100 pt-3">
      <div className="flex items-center justify-between gap-2 mb-1">
        <label className="block text-sm font-medium text-gray-700">{t('crm.project.assets.title', 'Grundrisse & Bilder aus dem Katalog')}</label>
        {sheets.length > 0 && (
          <button type="button" onClick={() => void runCatalog()} disabled={running}
            className="px-2.5 py-1 rounded-lg text-xs font-medium border border-orange-300 text-orange-700 hover:bg-orange-50 disabled:opacity-40 whitespace-nowrap">
            {running ? '⏳' : t('crm.project.assets.runCatalog', 'Bauträgerpläne den Wohnungen zuordnen')}
          </button>
        )}
      </div>
      <p className="text-xs text-gray-400 mb-2">
        {t('crm.project.assets.help', 'Zuschnitte aus den Bauträgerblättern kommen als „nicht freigegeben" in neue Decks (Hinweis im Prüfbericht). Freigeben = gilt als geprüfter Plan dieser Wohnung. Ablehnen = nie im Deck.')}
      </p>
      {report && <p className="text-[11px] text-gray-500 mb-2">{report}</p>}

      {floorplans.length > 0 && (
        <div className="space-y-1.5 mb-3">
          {floorplans.map(r => (
            <div key={r.id} className="flex items-center gap-2 text-sm">
              <a href={r.storage_url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                <img src={r.storage_url} alt="" className="w-16 h-12 object-contain bg-white border border-gray-200 rounded" loading="lazy" />
              </a>
              <span className="w-20 shrink-0 font-medium text-gray-800">{unitName(r.unit_key)}</span>
              <span className="flex-1 text-xs text-gray-500 truncate" title={r.label ?? ''}>
                {r.floor_labels.length ? r.floor_labels.join(' + ') : t('crm.project.assets.plan', 'Plan')}
                {r.same_layout_as.length ? ` · ${t('crm.project.assets.alsoFor', 'gilt auch für')} ${r.same_layout_as.map(unitName).join(', ')}` : ''}
                {r.dimensions_present === true ? ` · ${t('crm.project.assets.dims', 'mit Maßen')}` : r.dimensions_present === false ? ` · ${t('crm.project.assets.noDims', 'ohne Maße')}` : ''}
                {r.source_page ? ` · S.${r.source_page}` : ''}
              </span>
              <span className={`text-[11px] px-1.5 py-0.5 rounded ${r.status === 'approved' ? 'bg-green-100 text-green-700' : r.status === 'review' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-600'}`}>
                {r.status === 'approved' ? t('crm.project.assets.approved', 'freigegeben') : r.status === 'review' ? t('crm.project.assets.review', 'prüfen') : t('crm.project.assets.classified', 'automatisch')}
              </span>
              {r.status !== 'approved' && (
                <button type="button" disabled={busy === r.id} onClick={() => void patch(r.id, { status: 'approved' })}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 whitespace-nowrap">
                  {t('crm.project.assets.approve', 'Freigeben')}
                </button>
              )}
              <button type="button" disabled={busy === r.id} onClick={() => void patch(r.id, { status: 'rejected' })}
                className="px-2 py-1 rounded-lg text-xs font-medium border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 whitespace-nowrap">
                {t('crm.project.assets.reject', 'Ablehnen')}
              </button>
              <button type="button" disabled={busy === r.id}
                onClick={() => {
                  const cur = r.same_layout_as.map(unitName).join(', ')
                  const eingabe = window.prompt(t('crm.project.assets.sameLayoutPrompt', 'Für welche weiteren Wohnungen gilt dieser Grundriss (baugleich/gespiegelt)? Wohnungsnummern mit Komma:'), cur)
                  if (eingabe === null) return
                  const keys = eingabe.split(',').map(x => x.trim().toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean)
                  void patch(r.id, { same_layout_as: keys })
                }}
                className="px-2 py-1 rounded-lg text-xs font-medium border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 whitespace-nowrap"
                title={t('crm.project.assets.sameLayoutTitle', 'Plan ausdrücklich auch für baugleiche Wohnungen freigeben')}>
                =
              </button>
            </div>
          ))}
        </div>
      )}

      {sheets.length > 0 && (
        <p className="text-[11px] text-gray-500 mb-3">
          {t('crm.project.assets.sheets', '{{n}} Bauträgerblatt/-blätter im Katalog', { n: sheets.length })}: {sheets.map(s => s.label ?? s.storage_url.slice(-30)).join(' · ')}
        </p>
      )}

      {reviewImgs.length > 0 && (
        <>
          <p className="text-xs font-medium text-gray-700 mb-1">{t('crm.project.assets.reviewImages', 'Bilder zur Prüfung (Wohnungstyp unklar)')}</p>
          <div className="space-y-1.5">
            {reviewImgs.map(r => (
              <div key={r.id} className="flex items-center gap-2 text-sm">
                <a href={r.storage_url} target="_blank" rel="noopener noreferrer" className="shrink-0">
                  <img src={r.storage_url} alt="" className="w-16 h-12 object-cover border border-gray-200 rounded" loading="lazy" />
                </a>
                <span className="flex-1 text-xs text-gray-500 truncate" title={r.label ?? ''}>
                  {r.primary_category} · {r.label}{r.folder_hint ? ` · ${t('crm.project.assets.folder', 'Ordner')}: ${r.folder_hint}` : ''}
                </span>
                <select className="text-xs border border-gray-200 rounded px-1.5 py-1" value={r.property_type}
                  onChange={e => void patch(r.id, { property_type: e.target.value })}>
                  {TYPES.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
                <button type="button" disabled={busy === r.id || r.property_type === 'unknown'} onClick={() => void patch(r.id, { status: 'approved' })}
                  className="px-2.5 py-1 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-40 whitespace-nowrap">
                  {t('crm.project.assets.approve', 'Freigeben')}
                </button>
                <button type="button" disabled={busy === r.id} onClick={() => void patch(r.id, { status: 'rejected' })}
                  className="px-2 py-1 rounded-lg text-xs font-medium border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40 whitespace-nowrap">
                  {t('crm.project.assets.reject', 'Ablehnen')}
                </button>
              </div>
            ))}
          </div>
        </>
      )}
      {msg && <p className="text-xs mt-2 rounded-lg px-3 py-2 text-gray-700 bg-gray-50 border border-gray-200">{msg}</p>}
    </div>
  )
}
