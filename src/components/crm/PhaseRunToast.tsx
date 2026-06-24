// PhaseRunToast — zeigt nach einem Phasenwechsel eine Live-Checkliste der
// automatischen Schritte (E-Mails / WhatsApp / Drive-Ordner) und wird GRÜN,
// sobald in jedem Schritt alles gelaufen ist. Rot, wenn etwas fehlschlägt.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import type { Deal, DealPhase } from '../../lib/crmTypes'

interface ScheduledRow {
  id: string
  type: 'email' | 'whatsapp' | 'both' | string
  status: 'pending' | 'scheduled' | 'sent' | 'failed' | string
  recipient: string | null
  email_subject: string | null
  error_message: string | null
}

interface Props {
  deal: Deal
  phase: DealPhase
  since: string
  onClose: () => void
}

const TERMINAL = (s: string) => s === 'sent' || s === 'failed'

export default function PhaseRunToast({ deal, phase, since, onClose }: Props) {
  const { t } = useTranslation()
  const [rows, setRows]               = useState<ScheduledRow[]>([])
  const [expectedMsgs, setExpectedMsgs] = useState<number | null>(null)
  const [driveExpected, setDriveExpected] = useState(false)
  const [driveUrl, setDriveUrl]       = useState<string | null>(null)
  const [done, setDone]               = useState(false)
  const startRef = useRef<number>(Date.now())
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Erwartete Schritte aus aktiven Automationsregeln ermitteln (einmalig).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('automation_rules')
        .select('message_type, drive_trigger')
        .eq('event_type', phase)
        .eq('is_active', true)
      if (cancelled) return
      const list = (data as { message_type: string; drive_trigger: boolean | null }[] | null) ?? []
      setExpectedMsgs(list.filter(r => ['email', 'whatsapp', 'both'].includes(r.message_type)).length)
      setDriveExpected(list.some(r => r.drive_trigger === true))
    })()
    return () => { cancelled = true }
  }, [phase])

  // Polling der tatsächlichen Ergebnisse.
  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      const [{ data: sm }, { data: ld }] = await Promise.all([
        supabase.from('scheduled_messages')
          .select('id, type, status, recipient, email_subject, error_message')
          .eq('deal_id', deal.id).eq('event_type', phase).gte('created_at', since)
          .order('created_at', { ascending: true }),
        supabase.from('leads').select('drive_folder_url').eq('id', deal.lead_id).maybeSingle(),
      ])
      if (cancelled) return
      const list = (sm as ScheduledRow[] | null) ?? []
      setRows(list)
      setDriveUrl((ld as { drive_folder_url?: string | null } | null)?.drive_folder_url ?? null)

      const elapsed = Date.now() - startRef.current
      const noPending = list.every(r => TERMINAL(r.status))
      // Genug Zeit, damit Zeilen eingetroffen sind (Insert + Sofortversand).
      const msgsSettled = noPending && (elapsed > 6000 || (expectedMsgs != null && list.length >= expectedMsgs && list.length > 0))
      const driveSettled = !driveExpected || !!((ld as { drive_folder_url?: string | null } | null)?.drive_folder_url) || elapsed > 14000
      if (msgsSettled && driveSettled) setDone(true)
    }
    poll()
    const iv = setInterval(() => {
      if (Date.now() - startRef.current > 40000) { setDone(true); clearInterval(iv); return }
      poll()
    }, 2000)
    return () => { cancelled = true; clearInterval(iv) }
  }, [deal.id, deal.lead_id, phase, since, expectedMsgs, driveExpected])

  const anyFailed = rows.some(r => r.status === 'failed')
  const allSent   = rows.length > 0 && rows.every(r => r.status === 'sent')
  const driveOk   = !driveExpected || !!driveUrl
  const nothing   = done && rows.length === 0 && !driveExpected
  const allGreen  = done && !anyFailed && (rows.length === 0 || allSent) && driveOk

  // Auto-Schließen bei grünem Ergebnis (Ref statt onClose-Dep → kein Timer-Reset pro Render).
  useEffect(() => {
    if (!(done && allGreen)) return
    const tmr = setTimeout(() => onCloseRef.current(), 5000)
    return () => clearTimeout(tmr)
  }, [done, allGreen])

  const phaseLabel = t(`crm.phases.${phase}`, phase)
  const recLabel = (r: ScheduledRow): string => {
    if (r.email_subject) return r.email_subject
    if (r.recipient === 'client') return t('crm.run.toClient', 'Nachricht an Kunde')
    if (r.recipient?.startsWith('bc:') || r.recipient?.startsWith('dc:') || r.recipient === 'unit_developer')
      return t('crm.run.toPartner', 'Nachricht an Partner')
    return t('crm.run.message', 'Nachricht')
  }
  const typeIcon = (ty: string) => ty === 'both' ? '✉️ 💬' : ty === 'whatsapp' ? '💬' : '✉️'

  // Header-Zustand
  const header = !done
    ? { bg: 'bg-amber-50 border-amber-200', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-800', label: t('crm.run.running', 'läuft …') }
    : anyFailed
      ? { bg: 'bg-red-50 border-red-200', dot: 'bg-red-500', text: 'text-red-800', label: t('crm.run.failed', 'Bitte prüfen') }
      : { bg: 'bg-green-50 border-green-300', dot: 'bg-green-500', text: 'text-green-800', label: t('crm.run.allDone', 'Alles erledigt') }

  const statusBadge = (s: string) => {
    if (s === 'sent') return <span className="text-green-600 font-semibold">✓ {t('crm.run.sent', 'gesendet')}</span>
    if (s === 'failed') return <span className="text-red-600 font-semibold">✗ {t('crm.run.fail', 'fehlgeschlagen')}</span>
    return <span className="text-amber-600">⏳ {t('crm.run.pending', 'läuft …')}</span>
  }

  return (
    <div className="fixed bottom-5 right-5 z-[120] w-[340px] max-w-[92vw] rounded-xl border bg-white shadow-2xl overflow-hidden">
      <div className={`flex items-center gap-2 px-4 py-2.5 border-b ${header.bg}`}>
        <span className={`inline-block w-2.5 h-2.5 rounded-full ${header.dot}`} />
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-semibold truncate ${header.text}`}>{phaseLabel}</div>
          <div className={`text-xs ${header.text} opacity-80`}>{header.label}</div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-lg leading-none px-1" aria-label="schließen">×</button>
      </div>

      <div className="px-4 py-3 space-y-2 max-h-[280px] overflow-y-auto">
        {rows.map(r => (
          <div key={r.id} className="flex items-start gap-2 text-[13px]">
            <span className="mt-px">{typeIcon(r.type)}</span>
            <div className="flex-1 min-w-0">
              <div className="text-gray-800 truncate">{recLabel(r)}</div>
              {r.status === 'failed' && r.error_message &&
                <div className="text-[11px] text-red-500 truncate">{r.error_message}</div>}
            </div>
            <div className="text-[12px] whitespace-nowrap">{statusBadge(r.status)}</div>
          </div>
        ))}

        {driveExpected && (
          <div className="flex items-center gap-2 text-[13px]">
            <span>📁</span>
            <div className="flex-1 text-gray-800">{t('crm.run.drive', 'Google-Drive-Ordner')}</div>
            <div className="text-[12px] whitespace-nowrap">
              {driveUrl
                ? <span className="text-green-600 font-semibold">✓ {t('crm.run.created', 'erstellt')}</span>
                : <span className="text-amber-600">⏳ {t('crm.run.pending', 'läuft …')}</span>}
            </div>
          </div>
        )}

        {nothing && (
          <div className="text-[13px] text-gray-500 py-1">
            ✓ {t('crm.run.noSteps', 'Phase gespeichert — keine automatischen Schritte hinterlegt.')}
          </div>
        )}
        {done && !nothing && expectedMsgs != null && expectedMsgs > 0 && rows.length === 0 && (
          <div className="text-[13px] text-amber-600 py-1">
            ⚠️ {t('crm.run.noneTriggered', 'Keine Nachricht ausgelöst (Opt-Out oder fehlende Vorlage?).')}
          </div>
        )}
      </div>
    </div>
  )
}
