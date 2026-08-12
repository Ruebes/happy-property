import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'
import { CustomSelect } from '../../../components/CustomSelect'
import SequenceEditor from '../../../components/crm/SequenceEditor'

// FlowBuilder lazy: React Flow ist ein eigener grosser Chunk — nur laden, wenn
// wirklich ein visueller Flow geoeffnet wird.
const FlowBuilder = lazy(() => import('../../../components/crm/FlowBuilder'))

// ── Workflows (Funnel-Sektion) ──────────────────────────────────────────────
// Verwaltung aller Automations-Workflows: anlegen, aktivieren, bearbeiten,
// löschen. Ein Workflow startet, wenn sich jemand in die gewählte
// Empfängerliste einträgt (Double-Opt-In bestätigt). Der eigentliche Aufbau
// (Wartezeit / E-Mail / WhatsApp / Listen-Update / Wenn-Dann-Split) passiert
// im Flow-Builder (SequenceEditor) — derselbe Editor, der auch in den
// Empfängerlisten über „⚙️ Automation" erreichbar ist.

interface WorkflowRow {
  id: string
  name: string
  active: boolean
  list_id: string
  listName: string
  steps: number
  enrolled: number
}

interface FlowRow {
  id: string
  name: string
  status: string
  trigger_type: string
  nodes: number
  active_runs: number
}

export default function Workflows() {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const basePath = '/admin/crm'
  const [rows, setRows] = useState<WorkflowRow[]>([])
  const [flows, setFlows] = useState<FlowRow[]>([])
  const [lists, setLists] = useState<Array<{ value: string; label: string }>>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<{ sequenceId: string; listId: string; listName: string } | null>(null)
  const [flowEditing, setFlowEditing] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newList, setNewList] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: seqs }, { data: nl }, { data: st }, { data: en }, { data: fw }, { data: fr }] = await Promise.all([
        supabase.from('list_sequences').select('id, name, active, list_id, newsletter_lists(name)').order('created_at', { ascending: false }),
        supabase.from('newsletter_lists').select('id, name').order('name'),
        supabase.from('sequence_steps').select('sequence_id'),
        supabase.from('sequence_enrollments').select('sequence_id'),
        supabase.from('funnel_workflows').select('id, name, status, trigger_type, graph').order('created_at', { ascending: false }),
        supabase.from('funnel_workflow_runs').select('workflow_id').eq('status', 'active'),
      ])
      const stepCount = new Map<string, number>()
      for (const s of ((st as Array<{ sequence_id: string }> | null) ?? [])) stepCount.set(s.sequence_id, (stepCount.get(s.sequence_id) ?? 0) + 1)
      const enrCount = new Map<string, number>()
      for (const e of ((en as Array<{ sequence_id: string }> | null) ?? [])) enrCount.set(e.sequence_id, (enrCount.get(e.sequence_id) ?? 0) + 1)
      setRows((((seqs as unknown) as Array<{ id: string; name: string; active: boolean; list_id: string; newsletter_lists: { name: string } | null }> | null) ?? []).map(s => ({
        id: s.id, name: s.name, active: s.active, list_id: s.list_id,
        listName: s.newsletter_lists?.name ?? '?',
        steps: stepCount.get(s.id) ?? 0, enrolled: enrCount.get(s.id) ?? 0,
      })))
      setLists((((nl as Array<{ id: string; name: string }> | null) ?? [])).map(l => ({ value: l.id, label: l.name })))
      const runCount = new Map<string, number>()
      for (const r of ((fr as Array<{ workflow_id: string }> | null) ?? [])) runCount.set(r.workflow_id, (runCount.get(r.workflow_id) ?? 0) + 1)
      setFlows((((fw as Array<{ id: string; name: string; status: string; trigger_type: string; graph: { nodes?: unknown[] } | null }> | null) ?? [])).map(f => ({
        id: f.id, name: f.name, status: f.status, trigger_type: f.trigger_type,
        nodes: Math.max(0, (f.graph?.nodes?.length ?? 1) - 1),   // Trigger-Knoten nicht mitzählen
        active_runs: runCount.get(f.id) ?? 0,
      })))
    } catch (e) {
      console.error('[Workflows] load:', e); setRows([])
    } finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  // ── Visuelle Flows (funnel_workflows) ────────────────────────────────────
  const createFlow = async () => {
    setBusy(true)
    try {
      const { data, error } = await supabase.from('funnel_workflows')
        .insert({ name: t('crm.flow2.newName', 'Neuer Flow'), status: 'draft', trigger_type: 'manual', created_by: profile?.id ?? null,
          graph: { nodes: [{ id: 'start', type: 'trigger', position: { x: 250, y: 40 }, data: {} }], edges: [] } })
        .select('id').single()
      if (error) throw error
      setFlowEditing((data as { id: string }).id)
    } catch (e) { console.error('[Workflows] createFlow:', e) } finally { setBusy(false) }
  }
  const toggleFlow = async (f: FlowRow) => {
    const next = f.status === 'active' ? 'paused' : 'active'
    setFlows(fs => fs.map(x => x.id === f.id ? { ...x, status: next } : x))
    const { error } = await supabase.from('funnel_workflows').update({ status: next, updated_at: new Date().toISOString() }).eq('id', f.id)
    if (error) { console.error('[Workflows] toggleFlow:', error); setFlows(fs => fs.map(x => x.id === f.id ? { ...x, status: f.status } : x)) }
  }
  const removeFlow = async (f: FlowRow) => {
    if (!window.confirm(t('crm.flow2.deleteConfirm', 'Flow „{{name}}" wirklich löschen? Alle laufenden Kontakte werden gestoppt.', { name: f.name }))) return
    const { error } = await supabase.from('funnel_workflows').delete().eq('id', f.id)
    if (error) { console.error('[Workflows] removeFlow:', error); return }
    setFlows(fs => fs.filter(x => x.id !== f.id))
  }
  const TRIGGER_LABEL: Record<string, string> = {
    manual: t('crm.flow2.trManual', 'Manuell / Liste'),
    funnel_signup: t('crm.flow2.trFunnel', 'Neuer Funnel-Lead'),
    pipeline_phase: t('crm.flow2.trPhase', 'Pipeline-Phase'),
    list: t('crm.flow2.trList', 'Listen-Eintritt'),
  }

  const createWorkflow = async () => {
    if (!newList) { setErr(t('crm.wf.pickListErr', 'Bitte eine Empfängerliste als Start-Auslöser wählen.')); return }
    setBusy(true); setErr('')
    try {
      const { data, error } = await supabase.from('list_sequences')
        .insert({ list_id: newList, name: newName.trim() || t('crm.wf.newName', 'Neuer Workflow'), active: false, trigger: 'on_confirm' })
        .select('id').single()
      if (error) throw error
      const listName = lists.find(l => l.value === newList)?.label ?? ''
      setCreating(false); setNewName(''); setNewList('')
      setEditing({ sequenceId: (data as { id: string }).id, listId: newList, listName })
    } catch (e) {
      console.error('[Workflows] create:', e); setErr(t('crm.wf.createErr', 'Anlegen fehlgeschlagen.'))
    } finally { setBusy(false) }
  }

  const toggleActive = async (r: WorkflowRow) => {
    setRows(rs => rs.map(x => x.id === r.id ? { ...x, active: !r.active } : x))
    const { error } = await supabase.from('list_sequences').update({ active: !r.active }).eq('id', r.id)
    if (error) {
      console.error('[Workflows] toggle:', error)
      setRows(rs => rs.map(x => x.id === r.id ? { ...x, active: r.active } : x))
    }
  }

  const remove = async (r: WorkflowRow) => {
    if (!window.confirm(t('crm.wf.deleteConfirm', 'Workflow „{{name}}" wirklich löschen? Bereits eingeplante Nachrichten laufender Kontakte bleiben bestehen.', { name: r.name }))) return
    try {
      await supabase.from('sequence_enrollments').delete().eq('sequence_id', r.id)
      await supabase.from('sequence_steps').delete().eq('sequence_id', r.id)
      const { error } = await supabase.from('list_sequences').delete().eq('id', r.id)
      if (error) throw error
      setRows(rs => rs.filter(x => x.id !== r.id))
    } catch (e) { console.error('[Workflows] delete:', e) }
  }

  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  return (
    <DashboardLayout basePath={basePath}>
      <div className="max-w-4xl mx-auto px-4 py-6">
        {/* ── Visuelle Flows (Canvas-Builder) ──────────────────────────────── */}
        <div className="flex items-center justify-between mb-1">
          <h1 className="text-xl font-bold text-gray-900">🧩 {t('crm.flow2.title', 'Flows')}</h1>
          <button onClick={() => void createFlow()} disabled={busy}
            className="px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
            + {t('crm.flow2.new', 'Neuer Flow')}
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          {t('crm.flow2.subtitle', 'Visueller Workflow-Builder: Time Delay, E-Mail, WhatsApp, Listen-Update und Wenn/Dann-Splits frei verbinden. Start manuell, per Liste, bei neuem Funnel-Lead oder Pipeline-Phase.')}
        </p>
        {loading ? null : flows.length === 0 ? (
          <div className="text-center border-2 border-dashed border-gray-200 rounded-2xl py-10 px-6 mb-8">
            <p className="text-3xl mb-2">🧩</p>
            <p className="text-sm text-gray-600 font-medium">{t('crm.flow2.empty', 'Noch keine Flows.')}</p>
            <p className="text-xs text-gray-400 mt-1">{t('crm.flow2.emptyHint', 'Leg mit „Neuer Flow" den ersten visuellen Workflow an.')}</p>
          </div>
        ) : (
          <div className="space-y-3 mb-8">
            {flows.map(f => (
              <div key={f.id} className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[180px]">
                  <p className="text-sm font-semibold text-gray-900">{f.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {t('crm.wf.trigger', 'Start')}: {TRIGGER_LABEL[f.trigger_type] ?? f.trigger_type}
                    {' · '}{t('crm.wf.steps', '{{n}} Bausteine', { n: f.nodes })}
                    {f.active_runs > 0 && <>{' · '}{t('crm.flow2.running', '{{n}} laufend', { n: f.active_runs })}</>}
                  </p>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${f.status === 'active' ? 'bg-emerald-50 text-emerald-700' : f.status === 'paused' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                  {f.status === 'active' ? t('crm.flow2.stActive', 'Aktiv') : f.status === 'paused' ? t('crm.flow2.stPaused', 'Pausiert') : t('crm.flow2.stDraft', 'Entwurf')}
                </span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => void toggleFlow(f)}
                    className={`w-11 h-6 rounded-full relative transition-colors ${f.status === 'active' ? '' : 'bg-gray-200'}`}
                    style={f.status === 'active' ? { backgroundColor: '#ff795d' } : undefined}
                    title={t('crm.flow2.toggleTip', 'Aktiv = Kontakte durchlaufen den Flow (Cron alle 5 Minuten)')}>
                    <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${f.status === 'active' ? 'left-5' : 'left-0.5'}`} />
                  </button>
                  <button onClick={() => setFlowEditing(f.id)}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50">
                    ✏️ {t('common.edit', 'Bearbeiten')}
                  </button>
                  <button onClick={() => void removeFlow(f)} className="w-8 h-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Listen-Workflows (bestehende Sequenzen) ──────────────────────── */}
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-gray-900">🔀 {t('crm.wf.title', 'Listen-Workflows')}</h2>
          <button onClick={() => { setCreating(true); setErr('') }}
            className="px-3 py-1.5 rounded-xl text-sm font-medium border border-gray-200 hover:bg-gray-50">
            + {t('crm.wf.new', 'Neuer Workflow')}
          </button>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          {t('crm.wf.subtitle', 'Automatische Abläufe mit Wartezeiten, E-Mails, WhatsApp, Listen-Updates und Wenn/Dann-Verzweigungen. Ein Workflow startet, sobald sich jemand in die gewählte Empfängerliste einträgt und bestätigt.')}
        </p>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : rows.length === 0 ? (
          <div className="text-center border-2 border-dashed border-gray-200 rounded-2xl py-14 px-6">
            <p className="text-3xl mb-2">🔀</p>
            <p className="text-sm text-gray-600 font-medium">{t('crm.wf.empty', 'Noch keine Workflows.')}</p>
            <p className="text-xs text-gray-400 mt-1">{t('crm.wf.emptyHint', 'Leg mit „Neuer Workflow" den ersten Ablauf an - z.B. eine Willkommensstrecke für Newsletter-Anmeldungen.')}</p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows.map(r => (
              <div key={r.id} className="bg-white border border-gray-200 rounded-2xl px-4 py-3.5 flex flex-wrap items-center gap-3">
                <div className="flex-1 min-w-[180px]">
                  <p className="text-sm font-semibold text-gray-900">{r.name}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {t('crm.wf.trigger', 'Start')}: {t('crm.wf.triggerList', 'Anmeldung zu „{{list}}"', { list: r.listName })}
                    {' · '}{t('crm.wf.steps', '{{n}} Bausteine', { n: r.steps })}
                    {r.enrolled > 0 && <>{' · '}{t('crm.seq.enrolled', '{{n}} eingeschrieben', { n: r.enrolled })}</>}
                  </p>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${r.active ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                  {r.active ? t('crm.wf.active', 'Aktiv') : t('crm.wf.inactive', 'Pausiert')}
                </span>
                <div className="flex items-center gap-1.5">
                  <button onClick={() => toggleActive(r)}
                    className={`w-11 h-6 rounded-full relative transition-colors ${r.active ? '' : 'bg-gray-200'}`}
                    style={r.active ? { backgroundColor: '#ff795d' } : undefined}
                    title={t('crm.wf.toggleTip', 'Aktiv = neue Anmeldungen durchlaufen den Workflow')}>
                    <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${r.active ? 'left-5' : 'left-0.5'}`} />
                  </button>
                  <button onClick={() => setEditing({ sequenceId: r.id, listId: r.list_id, listName: r.listName })}
                    className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50">
                    ✏️ {t('common.edit', 'Bearbeiten')}
                  </button>
                  <button onClick={() => remove(r)} className="w-8 h-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-[11px] text-gray-400 mt-6">
          {t('crm.wf.crossLink', 'Tipp: Dieselben Workflows findest du auch bei den Empfängerlisten unter „⚙️ Automation".')}
        </p>
      </div>

      {creating && (
        <div className="fixed inset-0 z-[60] bg-black/40 flex items-center justify-center p-4" onClick={() => setCreating(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900">{t('crm.wf.new', 'Neuer Workflow')}</h2>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wf.name', 'Name')}</label>
              <input className={inp} value={newName} onChange={e => setNewName(e.target.value)}
                placeholder={t('crm.wf.namePh', 'z.B. Willkommensstrecke Newsletter')} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.wf.triggerLabel', 'Start-Auslöser: Anmeldung zu Liste')}</label>
              <CustomSelect value={newList} onChange={setNewList}
                options={[{ value: '', label: t('crm.flow.pickList', 'Liste wählen …') }, ...lists]} />
              <p className="text-[11px] text-gray-400 mt-1">{t('crm.wf.triggerHint', 'Der Workflow startet für jeden, der sich in diese Liste einträgt und die Anmeldung bestätigt.')}</p>
            </div>
            {err && <p className="text-sm text-red-600">{err}</p>}
            <div className="flex justify-end gap-2 pt-1">
              <button onClick={() => setCreating(false)} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
              <button onClick={() => void createWorkflow()} disabled={busy}
                className="px-5 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
                {busy ? '…' : t('crm.wf.createGo', 'Anlegen & Flow bauen')}
              </button>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <SequenceEditor sequenceId={editing.sequenceId} listId={editing.listId} listName={editing.listName}
          onClose={() => { setEditing(null); void load() }} />
      )}

      {flowEditing && (
        <Suspense fallback={<div className="fixed inset-0 z-[70] bg-white flex items-center justify-center"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>}>
          <FlowBuilder workflowId={flowEditing} onClose={() => { setFlowEditing(null); void load() }} />
        </Suspense>
      )}
    </DashboardLayout>
  )
}
