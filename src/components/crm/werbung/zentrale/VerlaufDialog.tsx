import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import EmptyState from '../../../ui/EmptyState'
import Badge from '../../../ui/Badge'
import { useWerbeFormat } from '../format'
import { berichteFehlerText, ladeAktivitaeten } from './berichteApi'
import type { Etikett } from './spalten'
import type { Aktivitaet } from './typen'
import { zeitraumText } from './zeitraum'

// ── Aktivitätenverlauf (Meta /act/activities + eigenes Schreibprotokoll) ──────
// Wie die rechte Seitenleiste bei Meta: Filter nach Art der Änderung und
// „Geändert von", Suche. Ein Abruf beim Öffnen (meta-berichte activities).

type Art = 'alle' | 'budget' | 'status' | 'zielgruppe' | 'gebot' | 'zeitplan' | 'anzeigen' | 'kampagnen' | 'gruppen' | 'konto' | 'sonst'

const ARTEN: Array<{ id: Art; label: Etikett }> = [
  { id: 'alle', label: { k: 'crm.werbung.zentrale.verlauf.alle', d: 'Alle Aktivitäten' } },
  { id: 'budget', label: { k: 'crm.werbung.zentrale.verlauf.budget', d: 'Budget' } },
  { id: 'status', label: { k: 'crm.werbung.zentrale.verlauf.status', d: 'Status' } },
  { id: 'zielgruppe', label: { k: 'crm.werbung.zentrale.verlauf.zielgruppe', d: 'Targeting und Zielgruppe' } },
  { id: 'gebot', label: { k: 'crm.werbung.zentrale.verlauf.gebot', d: 'Gebot' } },
  { id: 'zeitplan', label: { k: 'crm.werbung.zentrale.verlauf.zeitplan', d: 'Zeitplan' } },
  { id: 'anzeigen', label: { k: 'crm.werbung.zentrale.verlauf.anzeigen', d: 'Werbeanzeigen' } },
  { id: 'gruppen', label: { k: 'crm.werbung.zentrale.verlauf.gruppen', d: 'Anzeigengruppen' } },
  { id: 'kampagnen', label: { k: 'crm.werbung.zentrale.verlauf.kampagnen', d: 'Kampagnen' } },
  { id: 'konto', label: { k: 'crm.werbung.zentrale.verlauf.konto', d: 'Konto' } },
  { id: 'sonst', label: { k: 'crm.werbung.zentrale.verlauf.sonst', d: 'Sonstiges' } },
]

/** Kategorien des Servers (deutsch, wie Metas Filter) -> Art */
const KATEGORIE_ART: Record<string, Art> = {
  Konto: 'konto', Werbeanzeigen: 'anzeigen', Anzeigengruppen: 'gruppen', Zielgruppe: 'zielgruppe', Targeting: 'zielgruppe',
  Gebot: 'gebot', Budget: 'budget', Kampagnen: 'kampagnen', Status: 'status', Zeitplan: 'zeitplan', Sonstiges: 'sonst',
}

/** Art einer Aktivität: Kategorie vom Server, sonst aus Metas event_type geraten */
function artVon(a: Aktivitaet): Art {
  if (a.kategorie && KATEGORIE_ART[a.kategorie]) return KATEGORIE_ART[a.kategorie]
  const e = (a.event_type ?? a.event).toLowerCase()
  const o = a.object_type.toLowerCase()
  if (/budget|spend|spending|cap/.test(e)) return 'budget'
  if (/run_status|status|pause|activate|aktiv/.test(e)) return 'status'
  if (/target|audience|zielgruppe/.test(e)) return 'zielgruppe'
  if (/bid|gebot/.test(e)) return 'gebot'
  if (/duration|schedule|zeitplan|end_time|start_time/.test(e)) return 'zeitplan'
  if (/creative|create_ad\b|ad_review|_ad_|anzeige/.test(e) || o === 'ad') return 'anzeigen'
  if (/ad_set|adset|adgroup/.test(e) || o === 'adset' || o === 'ad_set') return 'gruppen'
  if (/campaign/.test(e) || o === 'campaign') return 'kampagnen'
  if (/account|funding|billing|user/.test(e) || o === 'account') return 'konto'
  return 'sonst'
}

/** Bekannte Meta-Ereignisse auf Deutsch, sonst lesbar gemachter Rohwert */
const EREIGNISSE: Record<string, string> = {
  create_campaign_group: 'Kampagne erstellt',
  create_campaign_legacy: 'Kampagne erstellt',
  update_campaign_name: 'Kampagnenname geändert',
  update_campaign_run_status: 'Kampagnenstatus geändert',
  update_campaign_budget: 'Kampagnenbudget geändert',
  update_campaign_group_spend_cap: 'Ausgabenlimit der Kampagne geändert',
  update_campaign_duration: 'Laufzeit der Kampagne geändert',
  campaign_ended: 'Kampagne beendet',
  create_ad_set: 'Anzeigengruppe erstellt',
  update_ad_set_name: 'Name der Anzeigengruppe geändert',
  update_ad_set_run_status: 'Status der Anzeigengruppe geändert',
  update_ad_set_budget: 'Budget der Anzeigengruppe geändert',
  update_ad_set_bidding: 'Gebot der Anzeigengruppe geändert',
  update_ad_set_bid_strategy: 'Gebotsstrategie geändert',
  update_ad_set_duration: 'Laufzeit der Anzeigengruppe geändert',
  update_ad_set_target_spec: 'Targeting geändert',
  update_ad_set_optimization_goal: 'Performance-Ziel geändert',
  update_ad_set_learning_stage_status: 'Lernphase geändert',
  create_ad: 'Werbeanzeige erstellt',
  update_ad_run_status: 'Status der Werbeanzeige geändert',
  update_ad_creative: 'Anzeigengestaltung geändert',
  edit_and_update_ad_creative: 'Anzeigengestaltung bearbeitet',
  update_ad_friendly_name: 'Name der Werbeanzeige geändert',
  ad_review_approved: 'Werbeanzeige genehmigt',
  ad_review_declined: 'Werbeanzeige abgelehnt',
  first_delivery_event: 'Erste Auslieferung',
  ad_account_update_spend_limit: 'Ausgabenlimit des Kontos geändert',
  ad_account_reset_spend_limit: 'Ausgabenlimit des Kontos zurückgesetzt',
  ad_account_remove_spend_limit: 'Ausgabenlimit des Kontos entfernt',
  account_spending_limit_reached: 'Ausgabenlimit des Kontos erreicht',
  campaign_spending_limit_reached: 'Ausgabenlimit der Kampagne erreicht',
  lifetime_budget_spent: 'Laufzeitbudget aufgebraucht',
  create_audience: 'Zielgruppe erstellt',
  update_audience: 'Zielgruppe geändert',
}

function ereignisText(a: Aktivitaet, t: TFunction): string {
  const k = (a.event_type ?? a.event).toLowerCase()
  if (EREIGNISSE[k]) return t(`crm.werbung.zentrale.ereignis.${k}`, EREIGNISSE[k])
  // Der Server liefert event bereits als deutsche Bezeichnung
  if (a.event && a.event_type) return a.event
  if (/^[a-z0-9_]+$/.test(k)) { const s = k.replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }
  return a.event
}

/** „Geändert von" (Server-Werte) übersetzen */
const VON_LABEL: Record<string, { k: string; d: string }> = {
  Person: { k: 'crm.werbung.zentrale.verlauf.vonPerson', d: 'Person' },
  'Automatisierte Regel': { k: 'crm.werbung.zentrale.verlauf.vonRegel', d: 'Automatisierte Regel' },
  'Business-Identität': { k: 'crm.werbung.zentrale.verlauf.vonBusiness', d: 'Business-Identität' },
  Meta: { k: 'crm.werbung.zentrale.verlauf.vonMetaSelbst', d: 'Meta' },
  CRM: { k: 'crm.werbung.zentrale.verlauf.crm', d: 'CRM' },
  Autopilot: { k: 'crm.werbung.zentrale.verlauf.vonAutopilot', d: 'Autopilot' },
}

/** Vorher/Nachher oder kurze Details aus extra */
function detailText(extra: unknown): string {
  if (extra == null) return ''
  if (typeof extra === 'string') return extra.slice(0, 200)
  if (typeof extra !== 'object') return String(extra)
  const o = extra as Record<string, unknown>
  const v = (x: unknown) => (x == null ? '-' : typeof x === 'object' ? JSON.stringify(x).slice(0, 80) : String(x))
  const alt = o.old_value ?? o.before ?? o.vorher
  const neu = o.new_value ?? o.after ?? o.nachher
  if (alt !== undefined || neu !== undefined) return `${v(alt)} → ${v(neu)}`
  return Object.entries(o).slice(0, 3).map(([k, x]) => `${k}: ${v(x)}`).join(' · ').slice(0, 200)
}

export interface VerlaufZiel { id: string | null; name: string | null }

interface Props {
  ziel: VerlaufZiel | null
  since: string
  until: string
  onClose: () => void
}

export default function VerlaufDialog({ ziel, since, until, onClose }: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [eintraege, setEintraege] = useState<Aktivitaet[]>([])
  const [laedt, setLaedt] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [art, setArt] = useState<Art>('alle')
  const [von, setVon] = useState<string>('alle')
  const [suche, setSuche] = useState('')
  const lauf = useRef(0)

  const laden = useCallback(async (frisch = false) => {
    if (!ziel) return
    const nr = ++lauf.current
    setLaedt(true)
    setFehler(null)
    try {
      const items = await ladeAktivitaeten({ since, until, ...(ziel.id ? { object_id: ziel.id } : {}), ...(frisch ? { frisch: true } : {}) })
      if (nr === lauf.current) setEintraege(items)
    } catch (err) {
      if (nr === lauf.current) { setEintraege([]); setFehler(berichteFehlerText(err, t)) }
    } finally {
      if (nr === lauf.current) setLaedt(false)
    }
  }, [ziel, since, until, t])

  useEffect(() => { if (ziel) void laden() }, [laden, ziel])
  useEffect(() => { if (!ziel) { lauf.current++; setEintraege([]); setFehler(null); setArt('alle'); setVon('alle'); setSuche('') } }, [ziel])

  const istCrm = (a: Aktivitaet) => /crm/i.test(a.quelle ?? '') || a.geaendert_von === 'CRM' || a.geaendert_von === 'Autopilot'
    || (!a.quelle && !a.geaendert_von && /crm|werbemanager|autopilot/i.test(a.actor))
  /** „Geändert von": Server-Wert, sonst grob CRM oder Meta */
  const vonWert = (a: Aktivitaet): string => a.geaendert_von ?? (istCrm(a) ? 'CRM' : 'Meta')
  const vonText = (v: string) => (VON_LABEL[v] ? t(VON_LABEL[v].k, VON_LABEL[v].d) : v)
  const vonOptionen = useMemo(() => [...new Set(eintraege.map(vonWert))].sort(), [eintraege])

  const gefiltert = useMemo(() => {
    const q = suche.trim().toLowerCase()
    return eintraege.filter(a =>
      (art === 'alle' || artVon(a) === art)
      && (von === 'alle' || vonWert(a) === von)
      && (!q || `${a.actor} ${a.object_name} ${a.event} ${detailText(a.extra)}`.toLowerCase().includes(q)))
  }, [eintraege, art, von, suche])

  const titel = ziel?.name
    ? t('crm.werbung.zentrale.verlauf.titelObjekt', 'Verlauf: {{name}}', { name: ziel.name })
    : t('crm.werbung.zentrale.verlauf.titel', 'Aktivitätenverlauf')

  return (
    <Modal open={!!ziel} onClose={onClose} size="lg" title={titel}>
      {ziel && (
        <div className="space-y-3">
          <p className="text-xs text-gray-500">
            {zeitraumText(since, until, fmt.locale)} · {t('crm.werbung.zentrale.verlauf.quelle', 'Meta-Aktivitäten und Änderungen aus dem CRM')}
            {!laedt && <> · <button type="button" className="underline" onClick={() => void laden(true)}>{t('crm.werbung.zentrale.meta.neu', 'Neu laden')}</button></>}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <select value={art} onChange={e => setArt(e.target.value as Art)} aria-label={t('crm.werbung.zentrale.verlauf.art', 'Art der Aktivität')}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm max-w-full">
              {ARTEN.map(a => <option key={a.id} value={a.id}>{t(a.label.k, a.label.d)}</option>)}
            </select>
            <select value={von} onChange={e => setVon(e.target.value)} aria-label={t('crm.werbung.zentrale.verlauf.von', 'Geändert von')}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm max-w-full">
              <option value="alle">{t('crm.werbung.zentrale.verlauf.vonAlle', 'Geändert von: alle')}</option>
              {vonOptionen.map(v => <option key={v} value={v}>{vonText(v)}</option>)}
            </select>
            <input value={suche} onChange={e => setSuche(e.target.value)} placeholder={t('crm.werbung.zentrale.verlauf.suche', 'Suchen')}
              className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm flex-1 min-w-[140px]" />
          </div>

          {laedt && (
            <div className="flex items-center gap-2 text-sm text-gray-500 py-6 justify-center">
              <Spinner size="sm" /> {t('crm.werbung.zentrale.verlauf.laedt', 'Hole den Verlauf …')}
            </div>
          )}
          {fehler && !laedt && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 flex flex-wrap items-center gap-2">
              <span className="flex-1 min-w-0">{fehler}</span>
              <button type="button" className="hp-btn hp-btn-ghost text-xs" onClick={() => void laden()}>
                {t('crm.werbung.zentrale.nochmal', 'Erneut versuchen')}
              </button>
            </div>
          )}
          {!laedt && !fehler && gefiltert.length === 0 && (
            <EmptyState compact icon="clock" title={t('crm.werbung.zentrale.verlauf.leer', 'Keine Aktivitäten im Zeitraum')} />
          )}
          {!laedt && gefiltert.length > 0 && (
            <ul className="divide-y divide-gray-100 rounded-xl border border-gray-200 max-h-[60vh] overflow-y-auto">
              {gefiltert.map((a, i) => {
                const d = new Date(a.ts)
                const detail = detailText(a.extra)
                return (
                  <li key={`${a.ts}-${i}`} className="px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-[11px] text-gray-400 tabular-nums whitespace-nowrap">
                        {Number.isNaN(d.getTime()) ? a.ts : d.toLocaleString(fmt.locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span className="font-semibold text-gray-800">{ereignisText(a, t)}</span>
                      {istCrm(a) && <Badge tone="info">{vonText(vonWert(a))}</Badge>}
                    </div>
                    <div className="text-xs text-gray-600 break-words">
                      {a.object_name || a.object_id}
                      {a.actor && <span className="text-gray-400"> · {a.actor}</span>}
                      {!istCrm(a) && a.geaendert_von && a.geaendert_von !== 'Person' && a.geaendert_von !== a.actor && <span className="text-gray-400"> · {vonText(a.geaendert_von)}</span>}
                    </div>
                    {detail && <div className="text-[11px] text-gray-500 break-words">{detail}</div>}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Modal>
  )
}
