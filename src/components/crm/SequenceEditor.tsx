import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'

// ── Flow-Builder je Empfängerliste ──────────────────────────────────────────
// Baut den Automations-Flow, den ein Abonnent nach der Bestätigung (Double-
// Opt-In) durchläuft. Bausteine: Wartezeit, E-Mail, WhatsApp, Listen-Update,
// Wenn/Dann-Verzweigung (E-Mail geöffnet?). Gespeichert wird ein Baum in
// sequence_steps (parent_split_id + branch); subscriber-optin plant daraus
// scheduled_messages vor, process-scheduled-messages prüft die Split-
// Bedingung erst zur Sendezeit (seq_condition) — nur der zutreffende Ast
// wird wirklich versendet.

type Unit = 'min' | 'std' | 'tag'
type Kind = 'delay' | 'msg' | 'list_update' | 'split'

interface Block {
  key: string
  kind: Kind
  // Wartezeit
  delayValue: number
  delayUnit: Unit
  // Nachricht
  channel: 'email' | 'whatsapp' | 'both'
  email_subject: string
  email_body: string
  whatsapp_text: string
  whatsapp_image_url: string
  // Listen-Update
  listOp: 'add' | 'remove'
  listTarget: string
  // Split
  waitValue: number
  waitUnit: 'std' | 'tag'
  yes: Block[]
  no: Block[]
}

const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`)
const minutesToDelay = (m: number): { delayValue: number; delayUnit: Unit } =>
  m > 0 && m % 1440 === 0 ? { delayValue: m / 1440, delayUnit: 'tag' }
  : m > 0 && m % 60 === 0 ? { delayValue: m / 60, delayUnit: 'std' }
  : { delayValue: m, delayUnit: 'min' }
const delayToMinutes = (v: number, u: Unit) => Math.max(0, Math.round(v)) * (u === 'tag' ? 1440 : u === 'std' ? 60 : 1)

const emptyBlock = (kind: Kind): Block => ({
  key: newKey(), kind,
  delayValue: 1, delayUnit: 'tag',
  channel: 'email', email_subject: '', email_body: '', whatsapp_text: '', whatsapp_image_url: '',
  listOp: 'add', listTarget: '',
  waitValue: 1, waitUnit: 'tag', yes: [], no: [],
})

// ── Baum-Helfer (immutable) ─────────────────────────────────────────────────
const mapTree = (blocks: Block[], fn: (b: Block) => Block): Block[] =>
  blocks.map(b => fn(b.kind === 'split' ? { ...b, yes: mapTree(b.yes, fn), no: mapTree(b.no, fn) } : b))
const patchBlock = (blocks: Block[], key: string, patch: Partial<Block>): Block[] =>
  mapTree(blocks, b => b.key === key ? { ...b, ...patch } : b)
const removeBlock = (blocks: Block[], key: string): Block[] =>
  blocks.filter(b => b.key !== key).map(b => b.kind === 'split' ? { ...b, yes: removeBlock(b.yes, key), no: removeBlock(b.no, key) } : b)
const moveBlock = (blocks: Block[], key: string, dir: -1 | 1): Block[] => {
  const i = blocks.findIndex(b => b.key === key)
  if (i >= 0) {
    const j = i + dir
    if (j < 0 || j >= blocks.length) return blocks
    const n = [...blocks];[n[i], n[j]] = [n[j], n[i]]
    return n
  }
  return blocks.map(b => b.kind === 'split' ? { ...b, yes: moveBlock(b.yes, key, dir), no: moveBlock(b.no, key, dir) } : b)
}
// anhängen: parentKey=null → Wurzel-Ebene, sonst in den Ja/Nein-Ast des Splits
const appendBlock = (blocks: Block[], parentKey: string | null, branch: 'yes' | 'no' | null, blk: Block): Block[] => {
  if (!parentKey) return [...blocks, blk]
  return blocks.map(b => {
    if (b.kind !== 'split') return b
    if (b.key === parentKey && branch) return { ...b, [branch]: [...b[branch], blk] }
    return { ...b, yes: appendBlock(b.yes, parentKey, branch, blk), no: appendBlock(b.no, parentKey, branch, blk) }
  })
}

// ── Baustein-Menü ───────────────────────────────────────────────────────────
interface AddMenuProps { t: TFunction; depth: number; onAdd: (kind: Kind) => void }
function AddMenu({ t, depth, onAdd }: AddMenuProps) {
  const [open, setOpen] = useState(false)
  const items: Array<{ kind: Kind; icon: string; label: string }> = [
    { kind: 'delay', icon: '⏱', label: t('crm.flow.addDelay', 'Wartezeit') },
    { kind: 'msg', icon: '✉️', label: t('crm.flow.addMsg', 'E-Mail / WhatsApp') },
    { kind: 'list_update', icon: '📋', label: t('crm.flow.addList', 'Listen-Update') },
    ...(depth < 2 ? [{ kind: 'split' as Kind, icon: '🔀', label: t('crm.flow.addSplit', 'Wenn/Dann') }] : []),
  ]
  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="w-full py-2 rounded-xl border-2 border-dashed border-gray-200 text-sm text-gray-500 hover:border-orange-300 hover:text-orange-600">
        + {t('crm.flow.addBlock', 'Baustein hinzufügen')}
      </button>
    )
  }
  return (
    <div className="flex flex-wrap gap-2 justify-center py-1">
      {items.map(it => (
        <button key={it.kind} onClick={() => { onAdd(it.kind); setOpen(false) }}
          className="px-3 py-1.5 rounded-full border border-gray-200 text-xs font-medium text-gray-700 hover:border-orange-300 hover:bg-orange-50">
          {it.icon} {it.label}
        </button>
      ))}
      <button onClick={() => setOpen(false)} className="px-2.5 py-1.5 rounded-full text-xs text-gray-400 hover:bg-gray-100">✕</button>
    </div>
  )
}

// ── Ebene (Wurzel oder Split-Ast), rekursiv ─────────────────────────────────
interface LevelProps {
  t: TFunction
  blocks: Block[]
  depth: number
  lists: Array<{ value: string; label: string }>
  onPatch: (key: string, patch: Partial<Block>) => void
  onRemove: (key: string) => void
  onMove: (key: string, dir: -1 | 1) => void
  onAdd: (parentKey: string | null, branch: 'yes' | 'no' | null, kind: Kind) => void
  parentKey: string | null
  branch: 'yes' | 'no' | null
}
function Level(props: LevelProps) {
  const { t, blocks, depth, lists, onPatch, onRemove, onMove, onAdd, parentKey, branch } = props
  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400 bg-white'
  const UNITS = [
    { value: 'min', label: t('crm.seq.minutes', 'Minuten') },
    { value: 'std', label: t('crm.seq.hours', 'Stunden') },
    { value: 'tag', label: t('crm.seq.days', 'Tage') },
  ]
  const CHANNELS = [
    { value: 'email', label: t('crm.seq.email', 'E-Mail') },
    { value: 'whatsapp', label: t('crm.seq.whatsapp', 'WhatsApp') },
    { value: 'both', label: t('crm.seq.both', 'E-Mail + WhatsApp') },
  ]
  const LIST_OPS = [
    { value: 'add', label: t('crm.flow.listAdd', 'Hinzufügen zu') },
    { value: 'remove', label: t('crm.flow.listRemove', 'Entfernen aus') },
  ]
  const endsWithSplit = blocks.length > 0 && blocks[blocks.length - 1].kind === 'split'
  const ctl = (b: Block, i: number) => (
    <div className="flex items-center gap-1">
      <button onClick={() => onMove(b.key, -1)} disabled={i === 0} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↑</button>
      <button onClick={() => onMove(b.key, 1)} disabled={i === blocks.length - 1} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↓</button>
      <button onClick={() => onRemove(b.key)} className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
    </div>
  )
  return (
    <div className="space-y-1.5">
      {blocks.map((b, i) => (
        <div key={b.key}>
          {i > 0 && <div className="flex justify-center text-gray-300 text-xs leading-none pb-1.5">↓</div>}

          {b.kind === 'delay' && (
            <div className="border border-amber-200 bg-amber-50/60 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-amber-800">⏱ {t('crm.flow.delay', 'Wartezeit')}</span>
                {ctl(b, i)}
              </div>
              <div className="grid grid-cols-2 gap-3 max-w-xs">
                <NumberStepper value={b.delayValue} min={1} onChange={v => onPatch(b.key, { delayValue: v })} />
                <CustomSelect value={b.delayUnit} onChange={v => onPatch(b.key, { delayUnit: v as Unit })} options={UNITS} />
              </div>
            </div>
          )}

          {b.kind === 'msg' && (
            <div className="border border-gray-200 bg-white rounded-xl p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-800">{b.channel === 'whatsapp' ? '💬' : '✉️'} {t('crm.flow.message', 'Nachricht')}</span>
                {ctl(b, i)}
              </div>
              <div className="max-w-[220px]">
                <CustomSelect value={b.channel} onChange={v => onPatch(b.key, { channel: v as Block['channel'] })} options={CHANNELS} />
              </div>
              {b.channel !== 'whatsapp' && (
                <div className="space-y-2">
                  <input className={inp} placeholder={t('crm.seq.subject', 'Betreff der E-Mail')} value={b.email_subject} onChange={e => onPatch(b.key, { email_subject: e.target.value })} />
                  <textarea className={`${inp} min-h-[100px]`} placeholder={t('crm.seq.emailBody', 'Text der E-Mail … (HTML erlaubt)')} value={b.email_body} onChange={e => onPatch(b.key, { email_body: e.target.value })} />
                </div>
              )}
              {b.channel !== 'email' && (
                <div className="space-y-2">
                  <textarea className={`${inp} min-h-[70px]`} placeholder={t('crm.seq.waText', 'WhatsApp-Text …')} value={b.whatsapp_text} onChange={e => onPatch(b.key, { whatsapp_text: e.target.value })} />
                  <input className={inp} placeholder={t('crm.seq.waImage', 'Bild-URL (optional)')} value={b.whatsapp_image_url} onChange={e => onPatch(b.key, { whatsapp_image_url: e.target.value })} />
                </div>
              )}
            </div>
          )}

          {b.kind === 'list_update' && (
            <div className="border border-sky-200 bg-sky-50/60 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-sky-800">📋 {t('crm.flow.listUpdate', 'Empfängerlisten-Update')}</span>
                {ctl(b, i)}
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <CustomSelect value={b.listOp} onChange={v => onPatch(b.key, { listOp: v as Block['listOp'] })} options={LIST_OPS} />
                <CustomSelect value={b.listTarget} onChange={v => onPatch(b.key, { listTarget: v })}
                  options={[{ value: '', label: t('crm.flow.pickList', 'Liste wählen …') }, ...lists]} />
              </div>
            </div>
          )}

          {b.kind === 'split' && (
            <div className="border border-violet-200 bg-violet-50/40 rounded-xl p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-violet-800">🔀 {t('crm.flow.split', 'Wenn/Dann: E-Mail geöffnet?')}</span>
                {ctl(b, i)}
              </div>
              <div className="flex items-center gap-2 mb-3 text-xs text-gray-600">
                <span>{t('crm.flow.checkAfter', 'Prüfen nach')}</span>
                <div className="w-24"><NumberStepper value={b.waitValue} min={1} onChange={v => onPatch(b.key, { waitValue: v })} /></div>
                <div className="w-32"><CustomSelect value={b.waitUnit} onChange={v => onPatch(b.key, { waitUnit: v as Block['waitUnit'] })} options={UNITS.filter(u => u.value !== 'min')} /></div>
              </div>
              <div className="grid lg:grid-cols-2 gap-3">
                <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-2.5">
                  <p className="text-xs font-semibold text-emerald-700 mb-2">✓ {t('crm.flow.yesBranch', 'Ja - hat eine E-Mail geöffnet')}</p>
                  <Level {...props} blocks={b.yes} depth={depth + 1} parentKey={b.key} branch="yes" />
                </div>
                <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-2.5">
                  <p className="text-xs font-semibold text-gray-600 mb-2">✗ {t('crm.flow.noBranch', 'Nein - nichts geöffnet')}</p>
                  <Level {...props} blocks={b.no} depth={depth + 1} parentKey={b.key} branch="no" />
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
      {endsWithSplit ? (
        <p className="text-[11px] text-gray-400 text-center pt-1">{t('crm.flow.afterSplit', 'Nach einer Verzweigung geht es nur in den Ästen weiter.')}</p>
      ) : (
        <AddMenu t={t} depth={depth} onAdd={kind => onAdd(parentKey, branch, kind)} />
      )}
    </div>
  )
}

// ── Editor ──────────────────────────────────────────────────────────────────
export default function SequenceEditor({ listId, listName, sequenceId, onClose }: { listId: string; listName: string; sequenceId?: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [seqId, setSeqId] = useState<string | null>(null)
  const [seqName, setSeqName] = useState('Automation')
  const [seqActive, setSeqActive] = useState(true)
  const [blocks, setBlocks] = useState<Block[]>([])
  const [lists, setLists] = useState<Array<{ value: string; label: string }>>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enrolled, setEnrolled] = useState<number>(0)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: nl } = await supabase.from('newsletter_lists').select('id, name').order('name')
      setLists(((nl as Array<{ id: string; name: string }> | null) ?? []).map(l => ({ value: l.id, label: l.name })))
      // Direkt per Workflow-ID (Funnel → Workflows) oder legacy: erste Sequenz der Liste
      const q = supabase.from('list_sequences').select('id, name, active')
      const { data: seqs } = sequenceId
        ? await q.eq('id', sequenceId).limit(1)
        : await q.eq('list_id', listId).order('created_at').limit(1)
      const seq = (seqs as { id: string; name: string; active: boolean }[] | null)?.[0]
      if (seq) {
        setSeqId(seq.id); setSeqName(seq.name); setSeqActive(seq.active)
        const { data: st } = await supabase.from('sequence_steps')
          .select('*').eq('sequence_id', seq.id).order('step_order')
        const rows = (st as Array<Record<string, unknown>> | null) ?? []
        const toBlock = (r: Record<string, unknown>): Block => {
          const type = String(r.step_type ?? r.channel ?? 'email')
          const b = emptyBlock(type === 'delay' ? 'delay' : type === 'split' ? 'split' : type === 'list_update' ? 'list_update' : 'msg')
          b.key = String(r.id)
          if (b.kind === 'delay') Object.assign(b, minutesToDelay(Number(r.delay_minutes ?? 0)))
          if (b.kind === 'msg') {
            b.channel = (type === 'both' ? 'both' : type === 'whatsapp' ? 'whatsapp' : 'email')
            b.email_subject = (r.email_subject as string) ?? ''
            b.email_body = (r.email_body as string) ?? ''
            b.whatsapp_text = (r.whatsapp_text as string) ?? ''
            b.whatsapp_image_url = (r.whatsapp_image_url as string) ?? ''
          }
          if (b.kind === 'list_update') { b.listOp = (r.list_op === 'remove' ? 'remove' : 'add'); b.listTarget = (r.list_target as string) ?? '' }
          if (b.kind === 'split') {
            const h = Number(r.split_wait_hours ?? 24)
            if (h % 24 === 0) { b.waitValue = h / 24; b.waitUnit = 'tag' } else { b.waitValue = h; b.waitUnit = 'std' }
            b.yes = rows.filter(x => x.parent_split_id === r.id && x.branch === 'yes').map(toBlock)
            b.no = rows.filter(x => x.parent_split_id === r.id && x.branch === 'no').map(toBlock)
          }
          return b
        }
        setBlocks(rows.filter(r => !r.parent_split_id).map(toBlock))
        const { count } = await supabase.from('sequence_enrollments')
          .select('id', { count: 'exact', head: true }).eq('sequence_id', seq.id)
        setEnrolled(count ?? 0)
      } else {
        setSeqId(null); setSeqName('Automation'); setSeqActive(true); setBlocks([emptyBlock('msg')]); setEnrolled(0)
      }
    } catch (e) {
      console.error('[SequenceEditor] load:', e); setErr(t('crm.seq.loadErr', 'Konnte die Automation nicht laden.'))
    } finally { setLoading(false) }
  }, [listId, sequenceId, t])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    setErr(''); setSaving(true)
    try {
      let id = seqId
      if (id) {
        await supabase.from('list_sequences').update({ name: seqName.trim() || 'Automation', active: seqActive }).eq('id', id)
        await supabase.from('sequence_steps').delete().eq('sequence_id', id)
      } else {
        const { data, error } = await supabase.from('list_sequences')
          .insert({ list_id: listId, name: seqName.trim() || 'Automation', active: seqActive, trigger: 'on_confirm' })
          .select('id').single()
        if (error) throw error
        id = (data as { id: string }).id; setSeqId(id)
      }
      // Baum → flache Zeilen. Splits brauchen echte IDs für parent_split_id,
      // daher vergeben wir die UUIDs clientseitig.
      const flat: Array<Record<string, unknown>> = []
      let ord = 0
      const emit = (list: Block[], parentId: string | null, br: 'yes' | 'no' | null) => {
        for (const b of list) {
          const rowId = newKey()
          const base = { id: rowId, sequence_id: id, step_order: ++ord, active: true, parent_split_id: parentId, branch: br }
          if (b.kind === 'delay') {
            flat.push({ ...base, step_type: 'delay', channel: 'email', delay_minutes: delayToMinutes(b.delayValue, b.delayUnit) })
          } else if (b.kind === 'split') {
            flat.push({ ...base, step_type: 'split', channel: 'email', delay_minutes: 0, split_wait_hours: Math.max(1, Math.round(b.waitValue)) * (b.waitUnit === 'tag' ? 24 : 1) })
            emit(b.yes, rowId, 'yes'); emit(b.no, rowId, 'no')
          } else if (b.kind === 'list_update') {
            if (!b.listTarget) { ord--; continue }
            flat.push({ ...base, step_type: 'list_update', channel: 'email', delay_minutes: 0, list_op: b.listOp, list_target: b.listTarget })
          } else {
            const hasContent = b.channel === 'whatsapp' ? b.whatsapp_text.trim() : b.channel === 'email' ? b.email_body.trim() : (b.email_body.trim() || b.whatsapp_text.trim())
            if (!hasContent) { ord--; continue }
            flat.push({
              ...base, step_type: b.channel, channel: b.channel, delay_minutes: 0,
              email_subject: b.channel !== 'whatsapp' ? b.email_subject.trim() || null : null,
              email_body: b.channel !== 'whatsapp' ? b.email_body.trim() || null : null,
              whatsapp_text: b.channel !== 'email' ? b.whatsapp_text.trim() || null : null,
              whatsapp_image_url: b.channel !== 'email' ? (b.whatsapp_image_url.trim() || null) : null,
            })
          }
        }
      }
      emit(blocks, null, null)
      if (flat.length) {
        const { error } = await supabase.from('sequence_steps').insert(flat)
        if (error) throw error
      }
      onClose()
    } catch (e) {
      console.error('[SequenceEditor] save:', e); setErr(t('crm.seq.saveErr', 'Speichern fehlgeschlagen.'))
    } finally { setSaving(false) }
  }

  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl z-10">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{t('crm.flow.title', 'Flow-Builder')}</h2>
            <p className="text-xs text-gray-500 mt-0.5">{t('crm.seq.forList', 'Liste')}: <span className="font-medium">{listName}</span>
              {enrolled > 0 && <> · {t('crm.seq.enrolled', '{{n}} eingeschrieben', { n: enrolled })}</>}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 rounded-lg text-gray-400 hover:bg-gray-100">✕</button>
        </div>

        {loading ? (
          <div className="flex justify-center py-16"><div className="w-8 h-8 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="p-6 space-y-5">
            <div className="flex items-center justify-between gap-4 bg-gray-50 rounded-xl px-4 py-3">
              <div className="flex-1">
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.seq.name', 'Name der Automation')}</label>
                <input className={inp} value={seqName} onChange={e => setSeqName(e.target.value)} />
              </div>
              <div className="text-center">
                <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.seq.activeLabel', 'Aktiv')}</label>
                <button onClick={() => setSeqActive(a => !a)}
                  className={`w-11 h-6 rounded-full relative transition-colors ${seqActive ? '' : 'bg-gray-200'}`}
                  style={seqActive ? { backgroundColor: '#ff795d' } : undefined}>
                  <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${seqActive ? 'left-5' : 'left-0.5'}`} />
                </button>
              </div>
            </div>

            <p className="text-xs text-gray-500">
              {t('crm.flow.hint', 'Der Flow startet, sobald jemand seine Anmeldung bestätigt. Bausteine: Wartezeit, Nachricht, Listen-Update und Wenn/Dann (prüft, ob der Kontakt bis dahin eine deiner E-Mails geöffnet hat). Platzhalter {{vorname}} wird ersetzt.', { vorname: '{{vorname}}' })}
            </p>

            <Level
              t={t} blocks={blocks} depth={0} lists={lists} parentKey={null} branch={null}
              onPatch={(key, patch) => setBlocks(bl => patchBlock(bl, key, patch))}
              onRemove={key => setBlocks(bl => removeBlock(bl, key))}
              onMove={(key, dir) => setBlocks(bl => moveBlock(bl, key, dir))}
              onAdd={(parentKey, branch, kind) => setBlocks(bl => appendBlock(bl, parentKey, branch, emptyBlock(kind)))}
            />

            {err && <p className="text-sm text-red-600">{err}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm border border-gray-200 hover:bg-gray-50">{t('common.cancel', 'Abbrechen')}</button>
              <button onClick={() => void save()} disabled={saving} className="px-5 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-60" style={{ backgroundColor: '#ff795d' }}>
                {saving ? t('common.saving', 'speichert …') : t('common.save', 'Speichern')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
