import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { DeckAssetsCache } from '../../lib/crmTypes'

// ── Deck-Wizard ──────────────────────────────────────────────────────────────
// Aus dem Kunden heraus: Projekt → Vorschlags-Wohnung(en) → Freitext → ins Paket;
// beliebig viele über mehrere Projekte. „Alle erstellen" generiert je Wohnung ein
// personalisiertes Deck (Hintergrund + Polling) und legt EINE Begleit-Mail in den
// Postausgang (Freigabe durch Sven).

interface LeadLite { id: string; first_name: string; last_name: string; email: string | null }
interface ProjectRow { id: string; name: string; developer: string | null; deck_assets: DeckAssetsCache | null }
interface UnitRow { id: string; unit_number: string; bedrooms: number | null; size_sqm: number | null; terrace_sqm: number | null; price_net: number | null; price_gross: number | null; floor: number | null }
interface BasketItem { projectId: string; projectName: string; assets: DeckAssetsCache | null; unit: UnitRow }

const eur = (n: number | null | undefined) => n != null ? new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n) : ''
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export default function DeckWizard({ lead, onClose, onDone }: { lead: LeadLite; onClose: () => void; onDone: (msg: string) => void }) {
  const { t } = useTranslation()
  const [projects, setProjects] = useState<ProjectRow[]>([])
  const [projectId, setProjectId] = useState('')
  const [units, setUnits]       = useState<UnitRow[]>([])
  const [sel, setSel]           = useState<Set<string>>(new Set())
  const [basket, setBasket]     = useState<BasketItem[]>([])
  const [briefing, setBriefing] = useState('')
  const [angle, setAngle]       = useState<'lifestyle' | 'investment'>('lifestyle')
  const [busy, setBusy]         = useState(false)
  const [progress, setProgress] = useState('')
  const [err, setErr]           = useState('')

  useEffect(() => { void (async () => {
    const { data } = await supabase.from('crm_projects').select('id, name, developer, deck_assets').order('name')
    setProjects((data ?? []) as ProjectRow[])
  })() }, [])

  useEffect(() => { void (async () => {
    setSel(new Set())
    if (!projectId) { setUnits([]); return }
    const { data } = await supabase.from('crm_project_units')
      .select('id, unit_number, bedrooms, size_sqm, terrace_sqm, price_net, price_gross, floor')
      .eq('project_id', projectId).eq('status', 'proposal').order('unit_number')
    setUnits((data ?? []) as UnitRow[])
  })() }, [projectId])

  const project = projects.find(p => p.id === projectId)
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const addToBasket = () => {
    if (!project) return
    const adds = units.filter(u => sel.has(u.id) && !basket.some(b => b.unit.id === u.id))
      .map(u => ({ projectId: project.id, projectName: project.name, assets: project.deck_assets, unit: u }))
    setBasket(b => [...b, ...adds])
    setSel(new Set())
  }
  const removeFromBasket = (unitId: string) => setBasket(b => b.filter(x => x.unit.id !== unitId))

  // Ein personalisiertes Deck pro Wohnung erzeugen (Hintergrund) + auf Token pollen
  const genOne = async (item: BasketItem): Promise<{ token: string; label: string } | null> => {
    const a = item.assets
    if (!a?.facts) throw new Error(`${item.projectName}: ${t('crm.wizard.noFacts', 'keine Projekt-Fakten — erst „Aus Drive laden" im Projekt')}`)
    const u = item.unit
    const unitFacts = `\n\n=== DIESE WOHNUNG: ${u.unit_number} ===\n${u.bedrooms ?? '?'} Schlafzimmer · ${u.size_sqm ?? '?'} m² Innenfläche${u.terrace_sqm ? ` + ${u.terrace_sqm} m² Außenfläche` : ''}${u.floor != null ? ` · ${u.floor}. Etage` : ''}.\nPreis: ${eur(u.price_gross ?? u.price_net)}${u.price_gross && u.price_net ? ` (netto ${eur(u.price_net)})` : ''}.`
    const fp = (a.floorplans ?? []).find(f => f.floor === u.floor)?.url ?? (a.floorplans ?? [])[0]?.url
    const images = { renders: a.renders ?? [], gallery: a.gallery ?? [], floorplan: fp, map: a.map ?? undefined, mapUrl: a.mapUrl ?? undefined }
    // letztes bestehendes Deck dieser Wohnung merken → auf NEUES Token pollen
    const { data: prev } = await supabase.from('sales_decks').select('token, created_at').eq('lead_id', lead.id).eq('unit_id', u.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
    const prevTok = (prev as { token?: string } | null)?.token ?? null
    const { error } = await supabase.functions.invoke('generate-deck', { body: {
      background: true, recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), angle, briefing,
      facts: a.facts + unitFacts, images, lead_id: lead.id, project_id: item.projectId, unit_id: u.id,
    } })
    if (error) throw new Error(error.message)
    for (let i = 0; i < 36; i++) {   // bis ~3 Min
      await sleep(5000)
      const { data: row } = await supabase.from('sales_decks').select('token').eq('lead_id', lead.id).eq('unit_id', u.id).order('created_at', { ascending: false }).limit(1).maybeSingle()
      const tok = (row as { token?: string } | null)?.token ?? null
      if (tok && tok !== prevTok) return { token: tok, label: `${item.projectName} · ${u.unit_number}` }
    }
    return null
  }

  const generateAll = async () => {
    if (!basket.length) return
    setBusy(true); setErr('')
    try {
      const links: { token: string; label: string }[] = []
      for (let i = 0; i < basket.length; i++) {
        setProgress(t('crm.wizard.generating', 'Erstelle Deck') + ` ${i + 1}/${basket.length} — ${basket[i].projectName} · ${basket[i].unit.unit_number}…`)
        const r = await genOne(basket[i])
        if (r) links.push(r)
      }
      if (!links.length) throw new Error(t('crm.wizard.noneDone', 'Kein Deck fertig geworden — bitte erneut versuchen.'))
      // Begleit-Mail zusammenstellen → Postausgang (Entwurf)
      const origin = window.location.origin
      const items = links.map(l => `<li><a href="${origin}/deck/${l.token}">${l.label}</a></li>`).join('')
      const intro = briefing.trim() ? `<p>${briefing.trim()}</p>` : ''
      const body = `<p>Hallo ${lead.first_name},</p>${intro}<p>wie besprochen findest du hier deine persönlichen Sales Decks:</p><ul>${items}</ul><p>Melde dich jederzeit bei Fragen.</p><p>Bis bald,<br>Sven · Happy Property Cyprus</p>`
      const subject = links.length > 1 ? t('crm.wizard.subjectMulti', 'Deine Wohnungs-Vorschläge von Happy Property') : `${t('crm.wizard.subjectOne', 'Dein Vorschlag')}: ${links[0].label}`
      const { error: oErr } = await supabase.from('deck_outbox').insert({
        lead_id: lead.id, recipient_email: lead.email, subject, body, deck_tokens: links.map(l => l.token), status: 'draft',
      })
      if (oErr) throw new Error(oErr.message)
      onDone(`${links.length} ${t('crm.wizard.doneToast', 'Deck(s) erstellt — liegen im Postausgang zur Freigabe.')}`)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Fehler')
    } finally {
      setBusy(false); setProgress('')
    }
  }

  const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300 bg-white'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white">
          <h2 className="text-lg font-bold text-gray-900">{t('crm.wizard.title', 'Sales Deck erstellen')} — {lead.first_name} {lead.last_name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl">✕</button>
        </div>

        <div className="p-6 space-y-5">
          {/* Projekt + Wohnungen */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.project', 'Projekt')}</label>
              <select className={inputCls} value={projectId} onChange={e => setProjectId(e.target.value)}>
                <option value="">{t('crm.wizard.choose', '— wählen —')}</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.developer ? `${p.developer} · ` : ''}{p.name}</option>)}
              </select>
            </div>
          </div>

          {projectId && (
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.units', 'Vorschlags-Wohnungen')} ({units.length})</label>
              {units.length === 0 && <p className="text-sm text-gray-400">{t('crm.wizard.noUnits', 'Keine Vorschlags-Wohnungen — im Projekt „Aus Drive laden" ausführen.')}</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-52 overflow-y-auto">
                {units.map(u => (
                  <label key={u.id} className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm cursor-pointer ${sel.has(u.id) ? 'border-orange-400 bg-orange-50' : 'border-gray-200'}`}>
                    <input type="checkbox" checked={sel.has(u.id)} onChange={() => toggle(u.id)} />
                    <span><strong>{u.unit_number}</strong> · {u.bedrooms ?? '?'} SZ · {u.size_sqm ?? '?'} m² · {eur(u.price_gross ?? u.price_net)}</span>
                  </label>
                ))}
              </div>
              {sel.size > 0 && (
                <button onClick={addToBasket} className="mt-2 px-3 py-1.5 rounded-lg text-sm font-medium border border-orange-300 text-orange-700 hover:bg-orange-50">
                  + {sel.size} {t('crm.wizard.addToBasket', 'ins Paket')}
                </button>
              )}
            </div>
          )}

          {/* Paket */}
          {basket.length > 0 && (
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-500 mb-2">{t('crm.wizard.basket', 'Paket')} ({basket.length})</p>
              <div className="space-y-1">
                {basket.map(b => (
                  <div key={b.unit.id} className="flex items-center justify-between text-sm bg-white rounded-lg px-3 py-1.5">
                    <span>{b.projectName} · <strong>{b.unit.unit_number}</strong> · {eur(b.unit.price_gross ?? b.unit.price_net)}</span>
                    <button onClick={() => removeFromBasket(b.unit.id)} className="text-gray-400 hover:text-red-500">✕</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Freitext + Winkel */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.briefing', 'Freitext (für Deck-Anschreiben + Mail)')}</label>
              <textarea rows={3} className={inputCls} value={briefing} onChange={e => setBriefing(e.target.value)}
                placeholder={t('crm.wizard.briefingPh', 'z.B. Sucht 2 SZ mit Meerblick, Budget bis 450k, will vermieten…')} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wizard.angle', 'Winkel')}</label>
              <select className={inputCls} value={angle} onChange={e => setAngle(e.target.value as 'lifestyle' | 'investment')}>
                <option value="lifestyle">{t('crm.wizard.lifestyle', 'Lifestyle')}</option>
                <option value="investment">{t('crm.wizard.investment', 'Investment')}</option>
              </select>
            </div>
          </div>

          {err && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
          {busy && <p className="text-sm text-orange-700 bg-orange-50 rounded-lg px-3 py-2">⏳ {progress || t('crm.wizard.working', 'Arbeite…')}</p>}
        </div>

        <div className="flex items-center justify-between gap-3 px-6 py-4 border-t border-gray-100 sticky bottom-0 bg-white">
          <p className="text-xs text-gray-400">{t('crm.wizard.hint', 'Jede Wohnung → eigenes Deck. Eine Mail in den Postausgang.')}</p>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 border border-gray-200">{t('common.cancel', 'Abbrechen')}</button>
            <button onClick={generateAll} disabled={busy || basket.length === 0}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
              {busy ? t('crm.wizard.creating', 'Erstelle…') : `${t('crm.wizard.createAll', 'Alle Decks erstellen')} (${basket.length})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
