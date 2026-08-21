import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ReactFlow, Background, Controls, addEdge, applyNodeChanges, applyEdgeChanges,
  Handle, Position,
  type Node, type Edge, type NodeProps, type Connection, type NodeChange, type EdgeChange,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { supabase } from '../../lib/supabase'
import { useAuth, hasPerm } from '../../lib/auth'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'

// ── FlowBuilder — visueller Workflow-Editor (Funnel-Section) ────────────────
// Baut den Graphen eines funnel_workflows: Knoten (Time Delay, E-Mail, WhatsApp,
// Listen-Update, Wenn/Dann-Split) per Palette hinzufügen, per Drag verbinden,
// per Klick konfigurieren. Gespeichert wird {nodes, edges} in
// funnel_workflows.graph; ausgeführt von der Edge Function run-workflows.
// Split-Knoten hat ZWEI Ausgänge (yes/no) — die Bedingung wird zur Laufzeit
// gegen engagement_events geprüft (E-Mail geöffnet / Angebot / Berechnung).

const CORAL = '#ff795d'

const NODE_META: Record<string, { icon: string; labelKey: string; labelDe: string; color: string }> = {
  trigger:     { icon: '🚀', labelKey: 'crm.flow2.nTrigger',  labelDe: 'Start',            color: 'border-gray-300 bg-gray-50' },
  delay:       { icon: '⏱',  labelKey: 'crm.flow2.nDelay',    labelDe: 'Time Delay',       color: 'border-amber-200 bg-amber-50' },
  email:       { icon: '✉️', labelKey: 'crm.flow2.nEmail',    labelDe: 'E-Mail',           color: 'border-sky-200 bg-sky-50' },
  whatsapp:    { icon: '💬', labelKey: 'crm.flow2.nWhatsapp', labelDe: 'WhatsApp',         color: 'border-emerald-200 bg-emerald-50' },
  list_update: { icon: '📋', labelKey: 'crm.flow2.nList',     labelDe: 'Listen-Update',    color: 'border-violet-200 bg-violet-50' },
  split:       { icon: '🔀', labelKey: 'crm.flow2.nSplit',    labelDe: 'Split (Wenn/Dann)', color: 'border-rose-200 bg-rose-50' },
}

// Kurz-Zusammenfassung im Knoten (damit der Flow lesbar bleibt)
function nodeSummary(type: string, d: Record<string, unknown>, lists: Array<{ value: string; label: string }>): string {
  if (type === 'delay') return `${Number(d.amount) || 0} ${String(d.unit ?? 'minutes')}`
  if (type === 'email') return String(d.subject ?? '') || '—'
  if (type === 'whatsapp') return String(d.text ?? '').slice(0, 40) || '—'
  if (type === 'list_update') {
    const ln = lists.find(l => l.value === String(d.list_id ?? ''))?.label ?? '?'
    return `${d.op === 'remove' ? '−' : '+'} ${ln}`
  }
  if (type === 'split') {
    const c = String(d.condition ?? 'email_opened')
    return c === 'deck_viewed' ? 'Angebot angesehen?' : c === 'calc_viewed' ? 'Berechnung angesehen?' : 'E-Mail geöffnet?'
  }
  return ''
}

// ── Custom Node ──────────────────────────────────────────────────────────────
function FlowNode({ id, type, data, selected }: NodeProps) {
  const meta = NODE_META[type ?? 'trigger'] ?? NODE_META.trigger
  const d = (data ?? {}) as Record<string, unknown>
  const lists = (d.__lists as Array<{ value: string; label: string }> | undefined) ?? []
  const summary = nodeSummary(type ?? '', d, lists)
  return (
    <div className={`rounded-xl border-2 px-3 py-2 shadow-sm min-w-[150px] max-w-[220px] ${meta.color} ${selected ? 'ring-2 ring-orange-400' : ''}`}>
      {type !== 'trigger' && <Handle type="target" position={Position.Top} className="!bg-gray-400" />}
      <div className="flex items-center gap-1.5">
        <span>{meta.icon}</span>
        <span className="text-xs font-bold text-gray-800">{meta.labelDe}</span>
      </div>
      {summary && <p className="text-[10px] text-gray-500 mt-0.5 truncate" title={summary}>{summary}</p>}
      {type === 'split' ? (
        <>
          <div className="flex justify-between text-[9px] font-semibold mt-1 px-0.5"><span className="text-emerald-600">✓ Ja</span><span className="text-rose-500">✗ Nein</span></div>
          <Handle id="yes" type="source" position={Position.Bottom} style={{ left: '25%' }} className="!bg-emerald-500" />
          <Handle id="no" type="source" position={Position.Bottom} style={{ left: '75%' }} className="!bg-rose-400" />
        </>
      ) : (
        <Handle type="source" position={Position.Bottom} className="!bg-gray-400" />
      )}
      <span className="hidden">{id}</span>
    </div>
  )
}
const nodeTypes = { trigger: FlowNode, delay: FlowNode, email: FlowNode, whatsapp: FlowNode, list_update: FlowNode, split: FlowNode }

const newId = () => (crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : `${Date.now()}`)

interface Props { workflowId: string; onClose: () => void }

export default function FlowBuilder({ workflowId, onClose }: Props) {
  const { t } = useTranslation()
  const { profile } = useAuth()
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  const [name, setName] = useState('')
  const [status, setStatus] = useState('draft')
  const [triggerType, setTriggerType] = useState('manual')
  const [triggerPhase, setTriggerPhase] = useState('')
  const [triggerList, setTriggerList] = useState('')     // Empfängerliste beim Auslöser „Liste"
  const [selId, setSelId] = useState<string | null>(null)
  const [lists, setLists] = useState<Array<{ value: string; label: string }>>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [enrollOpen, setEnrollOpen] = useState(false)
  const [runStats, setRunStats] = useState({ active: 0, completed: 0 })

  const showMsg = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  // Laden
  useEffect(() => {
    void (async () => {
      const [{ data: wf }, { data: nl }, { data: runs }] = await Promise.all([
        supabase.from('funnel_workflows').select('name, status, trigger_type, trigger_config, graph').eq('id', workflowId).maybeSingle(),
        supabase.from('newsletter_lists').select('id, name').order('name'),
        supabase.from('funnel_workflow_runs').select('status').eq('workflow_id', workflowId),
      ])
      const listOpts = (((nl as Array<{ id: string; name: string }> | null) ?? [])).map(l => ({ value: l.id, label: l.name }))
      setLists(listOpts)
      const w = wf as { name: string; status: string; trigger_type: string; trigger_config: { phase?: string; list_id?: string } | null; graph: { nodes?: Node[]; edges?: Edge[] } | null } | null
      if (w) {
        setName(w.name); setStatus(w.status); setTriggerType(w.trigger_type)
        setTriggerPhase(w.trigger_config?.phase ?? ''); setTriggerList(w.trigger_config?.list_id ?? '')
        const g = w.graph ?? { nodes: [], edges: [] }
        let ns = (g.nodes ?? []) as Node[]
        if (!ns.length) ns = [{ id: 'start', type: 'trigger', position: { x: 250, y: 40 }, data: {} }]
        // Listen-Optionen in die Node-Daten spiegeln (für die Kurz-Zusammenfassung)
        setNodes(ns.map(n => ({ ...n, data: { ...(n.data ?? {}), __lists: listOpts } })))
        setEdges((g.edges ?? []) as Edge[])
      }
      const rs = (runs as Array<{ status: string }> | null) ?? []
      setRunStats({ active: rs.filter(r => r.status === 'active').length, completed: rs.filter(r => r.status === 'completed').length })
    })()
  }, [workflowId])

  const onNodesChange = useCallback((ch: NodeChange[]) => setNodes(ns => applyNodeChanges(ch, ns)), [])
  const onEdgesChange = useCallback((ch: EdgeChange[]) => setEdges(es => applyEdgeChanges(ch, es)), [])
  const onConnect = useCallback((c: Connection) => setEdges(es => addEdge({ ...c, animated: true }, es)), [])

  const addNode = (type: string) => {
    const id = `${type}-${newId()}`
    const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y), 0)
    const defaults: Record<string, Record<string, unknown>> = {
      delay: { amount: 1, unit: 'days' },
      email: { subject: '', html: '' },
      whatsapp: { text: '' },
      list_update: { op: 'add', list_id: '' },
      split: { condition: 'email_opened' },
    }
    setNodes(ns => [...ns, { id, type, position: { x: 250, y: maxY + 120 }, data: { ...(defaults[type] ?? {}), __lists: lists } }])
    setSelId(id)
  }

  const patchSel = (patch: Record<string, unknown>) => {
    if (!selId) return
    setNodes(ns => ns.map(n => n.id === selId ? { ...n, data: { ...(n.data ?? {}), ...patch } } : n))
  }
  const removeSel = () => {
    if (!selId) return
    setNodes(ns => ns.filter(n => n.id !== selId))
    setEdges(es => es.filter(e => e.source !== selId && e.target !== selId))
    setSelId(null)
  }

  const save = async (newStatus?: string) => {
    setSaving(true)
    try {
      // __lists (UI-Beiwerk) nicht mitspeichern
      const cleanNodes = nodes.map(n => { const { __lists: _l, ...rest } = (n.data ?? {}) as Record<string, unknown>; return { id: n.id, type: n.type, position: n.position, data: rest } })
      const cleanEdges = edges.map(e => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null }))
      const patch: Record<string, unknown> = {
        name: name.trim() || 'Workflow',
        graph: { nodes: cleanNodes, edges: cleanEdges },
        trigger_type: triggerType,
        trigger_config: triggerType === 'pipeline_phase' ? { phase: triggerPhase }
                      : triggerType === 'list' ? { list_id: triggerList } : {},
        updated_at: new Date().toISOString(),
      }
      if (newStatus) patch.status = newStatus
      const { error } = await supabase.from('funnel_workflows').update(patch).eq('id', workflowId)
      if (error) throw error
      if (newStatus) setStatus(newStatus)
      showMsg(t('crm.flow2.saved', 'Gespeichert ✓'))
    } catch (e) {
      console.error('[FlowBuilder] save:', e)
      showMsg(`❌ ${t('crm.flow2.saveErr', 'Speichern fehlgeschlagen')}`)
    } finally { setSaving(false) }
  }

  const sel = nodes.find(n => n.id === selId)
  const selData = (sel?.data ?? {}) as Record<string, unknown>
  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  const PHASES = useMemo(() => [
    'neu', 'erstkontakt', 'immobilienauswahl', 'reservierung', 'finanzierung_de', 'finanzierung_cy', 'kaufvertrag', 'anzahlung', 'provision_erhalten',
  ].map(p => ({ value: p, label: p })), [])

  return (
    <div className="fixed inset-0 z-[70] bg-white flex flex-col">
      {/* Kopfzeile */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 flex-wrap">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 hover:bg-gray-50">← {t('common.back', 'Zurück')}</button>
        <input className="text-base font-bold text-gray-900 outline-none border-b border-transparent focus:border-orange-300 min-w-[180px]" value={name} onChange={e => setName(e.target.value)} />
        <span className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${status === 'active' ? 'bg-emerald-50 text-emerald-700' : status === 'paused' ? 'bg-amber-50 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
          {status === 'active' ? t('crm.flow2.stActive', 'Aktiv') : status === 'paused' ? t('crm.flow2.stPaused', 'Pausiert') : t('crm.flow2.stDraft', 'Entwurf')}
        </span>
        <span className="text-[11px] text-gray-400">{t('crm.flow2.runStats', '{{a}} laufend · {{c}} abgeschlossen', { a: runStats.active, c: runStats.completed })}</span>
        <div className="flex-1" />
        {msg && <span className="text-xs text-gray-500">{msg}</span>}
        <button onClick={() => setEnrollOpen(true)} className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50">👥 {t('crm.flow2.enroll', 'Kontakte hinzufügen')}</button>
        <button onClick={() => void save()} disabled={saving} className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 hover:bg-gray-50 disabled:opacity-50">💾 {t('common.save', 'Speichern')}</button>
        {status === 'active'
          ? <button onClick={() => void save('paused')} className="px-4 py-1.5 rounded-lg text-white text-xs font-semibold bg-amber-500">⏸ {t('crm.flow2.pause', 'Pausieren')}</button>
          : <button onClick={() => void save('active')} className="px-4 py-1.5 rounded-lg text-white text-xs font-semibold" style={{ backgroundColor: CORAL }}>▶ {t('crm.flow2.activate', 'Aktivieren')}</button>}
      </div>

      <div className="flex flex-1 min-h-0">
        {/* Palette */}
        <div className="w-44 border-r border-gray-100 p-3 space-y-2 overflow-y-auto">
          <p className="text-[11px] font-semibold text-gray-400 uppercase">{t('crm.flow2.palette', 'Bausteine')}</p>
          {(['delay', 'email', 'whatsapp', 'list_update', 'split'] as const).map(ty => (
            <button key={ty} onClick={() => addNode(ty)}
              className={`w-full text-left rounded-xl border px-3 py-2 text-xs font-medium hover:shadow-sm ${NODE_META[ty].color}`}>
              {NODE_META[ty].icon} {t(NODE_META[ty].labelKey, NODE_META[ty].labelDe)}
            </button>
          ))}
          <div className="pt-3 border-t border-gray-100">
            <p className="text-[11px] font-semibold text-gray-400 uppercase mb-1">{t('crm.flow2.trigger', 'Auslöser')}</p>
            <CustomSelect value={triggerType} onChange={setTriggerType} options={[
              { value: 'manual', label: t('crm.flow2.trManual', 'Manuell starten'), hint: t('crm.flow2.trManualHint', 'Kontakte von Hand einschreiben') },
              { value: 'list', label: t('crm.flow2.trList2', 'Eintrag in Liste'), hint: t('crm.flow2.trListHint', 'startet, sobald sich jemand einträgt') },
              { value: 'funnel_signup', label: t('crm.flow2.trFunnel', 'Neuer Funnel-Lead') },
              { value: 'pipeline_phase', label: t('crm.flow2.trPhase', 'Pipeline-Phase') },
            ]} />
            {/* Auslöser „Liste": alle Empfängerlisten zur Auswahl - vorher gab es
                dafür gar kein Feld und der Flow wusste nicht, welche Liste gemeint
                ist (Sven 21.8.). */}
            {triggerType === 'list' && (
              <div className="mt-2">
                <CustomSelect value={triggerList} onChange={setTriggerList}
                  options={[{ value: '', label: t('crm.flow.pickList', 'Liste wählen …') }, ...lists]} />
                {!lists.length && <p className="text-[11px] text-amber-600 mt-1">{t('crm.flow2.noLists', 'Noch keine Empfängerliste angelegt.')}</p>}
              </div>
            )}
            {triggerType === 'pipeline_phase' && (
              <div className="mt-2"><CustomSelect value={triggerPhase} onChange={setTriggerPhase} options={[{ value: '', label: t('crm.flow2.pickPhase', 'Phase wählen …') }, ...PHASES]} /></div>
            )}
          </div>
          <p className="text-[10px] text-gray-400 pt-2">{t('crm.flow2.hint', 'Knoten unten/oben per Drag an den Punkten verbinden. Split: linker Punkt = Ja, rechter = Nein.')}</p>
        </div>

        {/* Canvas */}
        <div className="flex-1">
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelId(n.id)} onPaneClick={() => setSelId(null)}
            fitView proOptions={{ hideAttribution: true }}>
            <Background gap={18} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        {/* Konfig-Panel */}
        {sel && sel.type !== 'trigger' && (
          <div className="w-80 border-l border-gray-100 p-4 space-y-3 overflow-y-auto">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-gray-900">{NODE_META[sel.type ?? '']?.icon} {t(NODE_META[sel.type ?? '']?.labelKey ?? '', NODE_META[sel.type ?? '']?.labelDe ?? '')}</p>
              <button onClick={removeSel} className="w-8 h-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
            </div>

            {sel.type === 'delay' && (
              <div className="flex items-center gap-2">
                <NumberStepper value={Number(selData.amount) || 1} onChange={v => patchSel({ amount: v })} min={1} max={90} />
                <CustomSelect value={String(selData.unit ?? 'days')} onChange={v => patchSel({ unit: v })} options={[
                  { value: 'minutes', label: t('crm.flow2.uMin', 'Minuten') },
                  { value: 'hours', label: t('crm.flow2.uHours', 'Stunden') },
                  { value: 'days', label: t('crm.flow2.uDays', 'Tage') },
                ]} />
              </div>
            )}

            {sel.type === 'email' && (<>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.flow2.subject', 'Betreff')}</label>
                <input className={inp} value={String(selData.subject ?? '')} onChange={e => patchSel({ subject: e.target.value })} placeholder="z.B. Dein Investment-Update" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.flow2.emailBody', 'Inhalt (HTML oder Text)')}</label>
                <textarea className={`${inp} min-h-[180px] font-mono text-xs`} value={String(selData.html ?? '')} onChange={e => patchSel({ html: e.target.value })} placeholder={'<p>Hallo {{vorname}},</p>\n<p>…</p>'} />
              </div>
              <p className="text-[10px] text-gray-400">{t('crm.flow2.vars', 'Platzhalter: {{vorname}}, {{nachname}}, {{name}}')}</p>
            </>)}

            {sel.type === 'whatsapp' && (<>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.flow2.waText', 'Nachricht')}</label>
                <textarea className={`${inp} min-h-[160px]`} value={String(selData.text ?? '')} onChange={e => patchSel({ text: e.target.value })} placeholder={'Hallo {{vorname}} 🐾\n…'} />
              </div>
              <p className="text-[10px] text-gray-400">{t('crm.flow2.vars', 'Platzhalter: {{vorname}}, {{nachname}}, {{name}}')}</p>
            </>)}

            {sel.type === 'list_update' && (<>
              <CustomSelect value={String(selData.op ?? 'add')} onChange={v => patchSel({ op: v })} options={[
                { value: 'add', label: t('crm.flow2.listAdd', 'Zur Liste hinzufügen') },
                { value: 'remove', label: t('crm.flow2.listRemove', 'Aus Liste entfernen') },
              ]} />
              <CustomSelect value={String(selData.list_id ?? '')} onChange={v => patchSel({ list_id: v })} options={[{ value: '', label: t('crm.flow.pickList', 'Liste wählen …') }, ...lists]} />
            </>)}

            {sel.type === 'split' && (<>
              <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.flow2.condition', 'Bedingung (Wenn …)')}</label>
              <CustomSelect value={String(selData.condition ?? 'email_opened')} onChange={v => patchSel({ condition: v })} options={[
                { value: 'email_opened', label: t('crm.flow2.cEmail', 'E-Mail geöffnet (seit Flow-Start)') },
                { value: 'deck_viewed', label: t('crm.flow2.cDeck', 'Angebot (Deck) angesehen') },
                { value: 'calc_viewed', label: t('crm.flow2.cCalc', 'Berechnung angesehen') },
              ]} />
              <p className="text-[10px] text-gray-400">{t('crm.flow2.splitHint', 'Trifft die Bedingung zu → Ja-Ausgang (links). Sonst → Nein-Ausgang (rechts). Tipp: davor ein Time Delay setzen, damit Zeit zum Öffnen bleibt.')}</p>
            </>)}
          </div>
        )}
      </div>

      {enrollOpen && <EnrollModal workflowId={workflowId} lists={lists} canLeads={hasPerm(profile, 'pipeline')} onClose={(added) => { setEnrollOpen(false); if (added) showMsg(t('crm.flow2.enrolled', '{{n}} Kontakte eingeschrieben', { n: added })) }} />}
    </div>
  )
}

// ── Kontakte einschreiben (manuell: Leads suchen ODER ganze Liste) ──────────
function EnrollModal({ workflowId, lists, canLeads, onClose }: { workflowId: string; lists: Array<{ value: string; label: string }>; canLeads: boolean; onClose: (added?: number) => void }) {
  const { t } = useTranslation()
  const [q, setQ] = useState('')
  const [found, setFound] = useState<Array<{ id: string; name: string; email: string | null }>>([])
  const [listId, setListId] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!canLeads || q.trim().length < 2) { setFound([]); return }
    const h = setTimeout(async () => {
      const { data } = await supabase.from('leads')
        .select('id, first_name, last_name, email')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`)
        .limit(8)
      setFound((((data as Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null }> | null) ?? [])).map(l => ({ id: l.id, name: `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim(), email: l.email })))
    }, 300)
    return () => clearTimeout(h)
  }, [q, canLeads])

  const enrollLead = async (leadId: string) => {
    setBusy(true); setErr('')
    try {
      const { data: ex } = await supabase.from('funnel_workflow_runs').select('id').eq('workflow_id', workflowId).eq('lead_id', leadId).eq('status', 'active').limit(1)
      if (ex && ex.length) { setErr(t('crm.flow2.already', 'Kontakt läuft bereits in diesem Workflow.')); return }
      const { error } = await supabase.from('funnel_workflow_runs').insert({ workflow_id: workflowId, lead_id: leadId })
      if (error) throw error
      onClose(1)
    } catch (e) { console.error('[FlowBuilder] enroll lead:', e); setErr(t('crm.flow2.enrollErr', 'Einschreiben fehlgeschlagen.')) } finally { setBusy(false) }
  }

  const enrollList = async () => {
    if (!listId) return
    setBusy(true); setErr('')
    try {
      const { data: mem } = await supabase.from('newsletter_list_members').select('subscriber_id').eq('list_id', listId)
      const subIds = (((mem as Array<{ subscriber_id: string }> | null) ?? [])).map(m => m.subscriber_id)
      if (!subIds.length) { setErr(t('crm.flow2.listEmpty', 'Diese Liste hat keine Abonnenten.')); return }
      const { data: ex } = await supabase.from('funnel_workflow_runs').select('subscriber_id').eq('workflow_id', workflowId).eq('status', 'active').not('subscriber_id', 'is', null)
      const existing = new Set((((ex as Array<{ subscriber_id: string }> | null) ?? [])).map(r => r.subscriber_id))
      const fresh = subIds.filter(s => !existing.has(s))
      if (!fresh.length) { setErr(t('crm.flow2.allEnrolled', 'Alle Abonnenten dieser Liste laufen bereits.')); return }
      const { error } = await supabase.from('funnel_workflow_runs').insert(fresh.map(s => ({ workflow_id: workflowId, subscriber_id: s })))
      if (error) throw error
      onClose(fresh.length)
    } catch (e) { console.error('[FlowBuilder] enroll list:', e); setErr(t('crm.flow2.enrollErr', 'Einschreiben fehlgeschlagen.')) } finally { setBusy(false) }
  }

  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'
  return (
    <div className="fixed inset-0 z-[80] bg-black/40 flex items-center justify-center p-4" onClick={() => onClose()}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-900">👥 {t('crm.flow2.enroll', 'Kontakte hinzufügen')}</h2>
        {canLeads && (
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.flow2.searchLead', 'Lead suchen (Name oder E-Mail)')}</label>
            <input className={inp} value={q} onChange={e => setQ(e.target.value)} placeholder="z.B. Tino" />
            {found.length > 0 && (
              <div className="mt-1 border border-gray-100 rounded-xl divide-y divide-gray-50 max-h-48 overflow-y-auto">
                {found.map(l => (
                  <button key={l.id} disabled={busy} onClick={() => void enrollLead(l.id)} className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50">
                    {l.name || l.email}<span className="text-xs text-gray-400 ml-2">{l.email}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.flow2.wholeList', 'Oder: komplette Empfängerliste einschreiben')}</label>
          <div className="flex gap-2">
            <div className="flex-1"><CustomSelect value={listId} onChange={setListId} options={[{ value: '', label: t('crm.flow.pickList', 'Liste wählen …') }, ...lists]} /></div>
            <button onClick={() => void enrollList()} disabled={busy || !listId} className="px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50" style={{ backgroundColor: CORAL }}>
              {busy ? '…' : t('crm.flow2.enrollGo', 'Einschreiben')}
            </button>
          </div>
        </div>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <div className="flex justify-end"><button onClick={() => onClose()} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.close', 'Schließen')}</button></div>
      </div>
    </div>
  )
}
