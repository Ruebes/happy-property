import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'
import { NumberStepper } from '../NumberStepper'

// ── Automations-Editor je Empfängerliste ────────────────────────────────────
// Definiert die Mail-/WhatsApp-Sequenz, die ein Abonnent NACH der Bestätigung
// (Double-Opt-In) automatisch durchläuft. Beim Bestätigen schreibt die Edge
// subscriber-optin die Schritte als scheduled_messages ein — der bestehende
// Scheduler (process-scheduled-messages) versendet sie zeitversetzt.
//
// Datenmodell: list_sequences (1 pro Liste) → sequence_steps (geordnet).
// delay_minutes = Verzögerung ab Bestätigung. Platzhalter {{vorname}} erlaubt.

type Unit = 'min' | 'std' | 'tag'
interface StepForm {
  id?: string
  delayValue: number
  delayUnit: Unit
  channel: 'email' | 'whatsapp' | 'both'
  email_subject: string
  email_body: string
  whatsapp_text: string
  whatsapp_image_url: string
}

const minutesToDelay = (m: number): { delayValue: number; delayUnit: Unit } =>
  m > 0 && m % 1440 === 0 ? { delayValue: m / 1440, delayUnit: 'tag' }
  : m > 0 && m % 60 === 0 ? { delayValue: m / 60, delayUnit: 'std' }
  : { delayValue: m, delayUnit: 'min' }
const delayToMinutes = (v: number, u: Unit) => Math.max(0, Math.round(v)) * (u === 'tag' ? 1440 : u === 'std' ? 60 : 1)

const emptyStep = (): StepForm => ({
  delayValue: 0, delayUnit: 'min', channel: 'email',
  email_subject: '', email_body: '', whatsapp_text: '', whatsapp_image_url: '',
})

export default function SequenceEditor({ listId, listName, onClose }: { listId: string; listName: string; onClose: () => void }) {
  const { t } = useTranslation()
  const [seqId, setSeqId] = useState<string | null>(null)
  const [seqName, setSeqName] = useState('Automation')
  const [seqActive, setSeqActive] = useState(true)
  const [steps, setSteps] = useState<StepForm[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enrolled, setEnrolled] = useState<number>(0)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { data: seqs } = await supabase.from('list_sequences')
        .select('id, name, active').eq('list_id', listId).order('created_at').limit(1)
      const seq = (seqs as { id: string; name: string; active: boolean }[] | null)?.[0]
      if (seq) {
        setSeqId(seq.id); setSeqName(seq.name); setSeqActive(seq.active)
        const { data: st } = await supabase.from('sequence_steps')
          .select('*').eq('sequence_id', seq.id).order('step_order')
        setSteps(((st as Record<string, unknown>[] | null) ?? []).map(s => ({
          id: s.id as string,
          ...minutesToDelay(Number(s.delay_minutes ?? 0)),
          channel: (s.channel as StepForm['channel']) ?? 'email',
          email_subject: (s.email_subject as string) ?? '',
          email_body: (s.email_body as string) ?? '',
          whatsapp_text: (s.whatsapp_text as string) ?? '',
          whatsapp_image_url: (s.whatsapp_image_url as string) ?? '',
        })))
        const { count } = await supabase.from('sequence_enrollments')
          .select('id', { count: 'exact', head: true }).eq('sequence_id', seq.id)
        setEnrolled(count ?? 0)
      } else {
        setSeqId(null); setSeqName('Automation'); setSeqActive(true); setSteps([emptyStep()]); setEnrolled(0)
      }
    } catch (e) {
      console.error('[SequenceEditor] load:', e); setErr(t('crm.seq.loadErr', 'Konnte die Automation nicht laden.'))
    } finally { setLoading(false) }
  }, [listId, t])
  useEffect(() => { void load() }, [load])

  const setStep = (i: number, patch: Partial<StepForm>) => setSteps(s => s.map((x, idx) => idx === i ? { ...x, ...patch } : x))
  const addStep = () => setSteps(s => [...s, emptyStep()])
  const removeStep = (i: number) => setSteps(s => s.filter((_, idx) => idx !== i))
  const move = (i: number, dir: -1 | 1) => setSteps(s => {
    const j = i + dir; if (j < 0 || j >= s.length) return s
    const n = [...s];[n[i], n[j]] = [n[j], n[i]]; return n
  })

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
      const rows = steps
        .filter(s => (s.channel === 'email' ? s.email_body.trim() : s.whatsapp_text.trim()))
        .map((s, idx) => ({
          sequence_id: id, step_order: idx + 1, delay_minutes: delayToMinutes(s.delayValue, s.delayUnit),
          channel: s.channel, active: true,
          email_subject: s.channel !== 'whatsapp' ? s.email_subject.trim() || null : null,
          email_body: s.channel !== 'whatsapp' ? s.email_body.trim() || null : null,
          whatsapp_text: s.channel !== 'email' ? s.whatsapp_text.trim() || null : null,
          whatsapp_image_url: s.channel !== 'email' ? (s.whatsapp_image_url.trim() || null) : null,
        }))
      if (rows.length) {
        const { error } = await supabase.from('sequence_steps').insert(rows)
        if (error) throw error
      }
      onClose()
    } catch (e) {
      console.error('[SequenceEditor] save:', e); setErr(t('crm.seq.saveErr', 'Speichern fehlgeschlagen.'))
    } finally { setSaving(false) }
  }

  const CHANNELS = [
    { value: 'email', label: t('crm.seq.email', 'E-Mail') },
    { value: 'whatsapp', label: t('crm.seq.whatsapp', 'WhatsApp') },
    { value: 'both', label: t('crm.seq.both', 'E-Mail + WhatsApp') },
  ]
  const UNITS = [
    { value: 'min', label: t('crm.seq.minutes', 'Minuten') },
    { value: 'std', label: t('crm.seq.hours', 'Stunden') },
    { value: 'tag', label: t('crm.seq.days', 'Tage') },
  ]
  const inp = 'w-full rounded-xl border border-gray-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-100 focus:border-orange-400'

  return (
    <div className="fixed inset-0 z-[60] bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 sticky top-0 bg-white rounded-t-2xl">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{t('crm.seq.title', 'Automation')}</h2>
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
              {t('crm.seq.hint', 'Diese Nachrichten gehen automatisch raus, sobald jemand seine Anmeldung bestätigt. Platzhalter {{vorname}} wird durch den Vornamen ersetzt.')}
            </p>

            {steps.map((s, i) => (
              <div key={i} className="border border-gray-200 rounded-xl p-4 space-y-3 relative">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-800">{t('crm.seq.step', 'Schritt')} {i + 1}</span>
                  <div className="flex items-center gap-1">
                    <button onClick={() => move(i, -1)} disabled={i === 0} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↑</button>
                    <button onClick={() => move(i, 1)} disabled={i === steps.length - 1} className="w-7 h-7 rounded-lg text-gray-400 hover:bg-gray-100 disabled:opacity-30">↓</button>
                    <button onClick={() => removeStep(i)} className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50">🗑</button>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end">
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.seq.after', 'Nach')}</label>
                    <NumberStepper value={s.delayValue} min={0} onChange={v => setStep(i, { delayValue: v })} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">&nbsp;</label>
                    <CustomSelect value={s.delayUnit} onChange={v => setStep(i, { delayUnit: v as Unit })} options={UNITS} />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-500 mb-1">{t('crm.seq.channel', 'Kanal')}</label>
                    <CustomSelect value={s.channel} onChange={v => setStep(i, { channel: v as StepForm['channel'] })} options={CHANNELS} />
                  </div>
                </div>
                {i === 0 && s.delayValue === 0 && (
                  <p className="text-[11px] text-gray-400">{t('crm.seq.immediate', '0 = sofort nach der Bestätigung')}</p>
                )}

                {s.channel !== 'whatsapp' && (
                  <div className="space-y-2">
                    <input className={inp} placeholder={t('crm.seq.subject', 'Betreff der E-Mail')} value={s.email_subject} onChange={e => setStep(i, { email_subject: e.target.value })} />
                    <textarea className={`${inp} min-h-[110px]`} placeholder={t('crm.seq.emailBody', 'Text der E-Mail … (HTML erlaubt)')} value={s.email_body} onChange={e => setStep(i, { email_body: e.target.value })} />
                  </div>
                )}
                {s.channel !== 'email' && (
                  <div className="space-y-2">
                    <textarea className={`${inp} min-h-[80px]`} placeholder={t('crm.seq.waText', 'WhatsApp-Text …')} value={s.whatsapp_text} onChange={e => setStep(i, { whatsapp_text: e.target.value })} />
                    <input className={inp} placeholder={t('crm.seq.waImage', 'Bild-URL (optional)')} value={s.whatsapp_image_url} onChange={e => setStep(i, { whatsapp_image_url: e.target.value })} />
                  </div>
                )}
              </div>
            ))}

            <button onClick={addStep} className="w-full py-2.5 rounded-xl border-2 border-dashed border-gray-200 text-sm text-gray-500 hover:border-orange-300 hover:text-orange-600">
              + {t('crm.seq.addStep', 'Schritt hinzufügen')}
            </button>

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
