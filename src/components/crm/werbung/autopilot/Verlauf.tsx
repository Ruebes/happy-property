import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail } from '../../../../lib/fnError'
import { WERBE_LOG_ARTEN, type WerbeAusfuehrAntwort, type WerbeLogEintrag } from '../../../../lib/werbungTypes'
import Badge from '../../../ui/Badge'
import { useConfirm } from '../../../ui/ConfirmDialog'
import EmptyState from '../../../ui/EmptyState'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { LOG_FELDER } from './abfragen'
import { VorherNachher } from './Evidenz'
import type { WerbeRechte } from './useWerbeRechte'
import { akteurLabel, aktionLabel, dbFehlerText, ebeneLabel, fehltSchema, logArtLabel, logArtTon, zahl, zeitKurz } from './werbeTexte'

// ── Verlauf: das Autopilot-Log der letzten 30 Tage, filterbar nach Art ──────
// Rückgängig gibt es für erfolgreich ausgeführte Änderungen bei Meta (art
// ausfuehrung, ergebnis ok, mit action_id): werbe-ausfuehren
// {modus:'rueckgaengig', action_id} legt eine Gegen-Aktion an und führt sie
// durch dieselben Leitplanken aus (Änderungsfenster, Budgetgrenzen).

const TAGE = 30
const RUECKGAENGIG_AKTIONEN = new Set(['pause', 'activate', 'budget_set', 'ersatz_aktivieren'])

export default function Verlauf({ rechte }: { rechte: WerbeRechte }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const confirm = useConfirm()
  const [art, setArt] = useState('')
  const [loading, setLoading] = useState(true)
  const [fehlt, setFehlt] = useState(false)
  const [eintraege, setEintraege] = useState<WerbeLogEintrag[]>([])
  const [rueckgaengig, setRueckgaengig] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<number | null>(null)

  const laden = useCallback(async () => {
    setLoading(true)
    try {
      const seit = new Date(Date.now() - TAGE * 86_400_000).toISOString()
      let q = supabase.from('ad_autopilot_log').select(LOG_FELDER).gte('ts', seit)
      q = art ? q.eq('art', art) : q.neq('art', 'bewertung')
      const { data, error } = await q.order('ts', { ascending: false }).limit(200)
      if (error) throw error
      const rows = (data as unknown as WerbeLogEintrag[] | null) ?? []
      setEintraege(rows)
      // Danach: welche ausgeführten Aktionen sind schon zurückgenommen?
      const ids = [...new Set(rows.filter(r => r.art === 'ausfuehrung' && r.ergebnis === 'ok' && r.action_id).map(r => r.action_id as string))]
      const erledigt = new Set<string>()
      if (ids.length) {
        const { data: u, error: e2 } = await supabase.from('ad_actions').select('undo_of').in('undo_of', ids).limit(500)
        if (e2) console.warn('[Autopilot] Rückgängig-Abgleich:', e2)
        for (const r of (u as Array<{ undo_of: string | null }> | null) ?? []) if (r.undo_of) erledigt.add(r.undo_of)
      }
      setRueckgaengig(erledigt)
      setFehlt(false)
    } catch (err) {
      if (fehltSchema(err)) setFehlt(true)
      else {
        console.error('[Autopilot] Verlauf:', err)
        toast.error(dbFehlerText(t, err))
      }
      setEintraege([])
    } finally {
      setLoading(false)
    }
  }, [art, t, toast])

  useEffect(() => { void laden() }, [laden])

  const zuruecknehmen = async (e: WerbeLogEintrag) => {
    if (!e.action_id) return
    const ok = await confirm({
      title: t('crm.werbung.autopilot.verlauf.rueckFrage', 'Änderung rückgängig machen?'),
      message: t('crm.werbung.autopilot.verlauf.rueckText', '{{objekt}}: der vorherige Zustand wird bei Meta wiederhergestellt. Das läuft durch dieselben Leitplanken; Budget und Aktivieren nur im Änderungsfenster.', {
        objekt: e.entity_name || e.entity_id || '-',
      }),
      confirmLabel: t('crm.werbung.autopilot.verlauf.rueckgaengig', 'Rückgängig'),
    })
    if (!ok) return
    setBusy(e.id)
    try {
      const { data, error } = await supabase.functions.invoke('werbe-ausfuehren', {
        body: { modus: 'rueckgaengig', action_id: e.action_id },
      })
      if (error) {
        const d = await fnErrorDetail(error)
        throw new Error(d.hint ? `${d.message} (${d.hint})` : d.message)
      }
      const r = (data ?? {}) as WerbeAusfuehrAntwort
      const n = zahl(r.ausgefuehrt) ?? 0
      const uebersprungen = Array.isArray(r.uebersprungen) ? r.uebersprungen : []
      if (r.error) toast.error(r.error)
      else if (r.gestoppt) toast.error(t('crm.werbung.autopilot.verlauf.rueckGestoppt', 'Der Autopilot hat gestoppt: {{grund}}', { grund: r.gestoppt }))
      else if ((zahl(r.fehlgeschlagen) ?? 0) > 0) toast.error(t('crm.werbung.autopilot.verlauf.rueckFehler', 'Rückgängig ist fehlgeschlagen, siehe Verlauf.'))
      else if (n > 0) toast.success(t('crm.werbung.autopilot.verlauf.rueckOk', 'Rückgängig gemacht'))
      else if (uebersprungen.length) toast.info(t('crm.werbung.autopilot.verlauf.rueckWartet', 'Vorgemerkt, noch nicht ausgeführt: {{grund}}', { grund: uebersprungen[0].grund }))
      else toast.success(t('crm.werbung.autopilot.verlauf.rueckVorgemerkt', 'Rückgängig vorgemerkt'))
      await laden()
    } catch (err) {
      console.error('[Autopilot] Rückgängig:', err)
      toast.error(err instanceof Error ? err.message : dbFehlerText(t, err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="block">
          <span className="text-xs font-medium text-gray-600">{t('crm.werbung.autopilot.verlauf.art', 'Art')}</span>
          <select className="hp-input mt-1 min-w-[12rem]" value={art} onChange={e => setArt(e.target.value)}>
            <option value="">{t('crm.werbung.autopilot.verlauf.alle', 'Alle (ohne Bewertungen)')}</option>
            {WERBE_LOG_ARTEN.map(a => <option key={a} value={a}>{logArtLabel(t, a)}</option>)}
          </select>
        </label>
        <p className="text-xs text-gray-500">{t('crm.werbung.autopilot.verlauf.zeitraum', 'Letzte {{tage}} Tage, höchstens 200 Einträge', { tage: TAGE })}</p>
      </div>

      {loading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : fehlt ? (
        <EmptyState compact icon="rules" title={t('crm.werbung.autopilot.nichtFreigeschaltet', 'Noch nicht freigeschaltet')}
          text={t('crm.werbung.autopilot.nichtFreigeschaltetText', 'Die Datenbank-Erweiterung für den Autopiloten ist noch nicht eingespielt.')} />
      ) : !eintraege.length ? (
        <EmptyState compact icon="rules" title={t('crm.werbung.autopilot.verlauf.leer', 'Keine Einträge in diesem Zeitraum')} />
      ) : (
        <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100 bg-white">
          {eintraege.map(e => {
            const kannZurueck = rechte.darfEntscheiden && e.art === 'ausfuehrung' && e.ergebnis === 'ok' && !!e.action_id
              && RUECKGAENGIG_AKTIONEN.has(e.aktion ?? '') && !rueckgaengig.has(e.action_id ?? '') && !e.undo_of
            const grund = typeof e.evidence?.grund === 'string' ? e.evidence.grund : null
            return (
              <li key={e.id} className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-3 py-2.5">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={logArtTon(e.art, e.ergebnis)}>{logArtLabel(t, e.art)}</Badge>
                    {e.rule_key && <Badge>{e.rule_key}</Badge>}
                    {e.aktion && <span className="text-xs text-gray-600">{aktionLabel(t, e.aktion)}</span>}
                    <span className="text-xs text-gray-500 tabular-nums">{zeitKurz(e.ts, fmt.locale)}</span>
                    <span className="text-xs text-gray-400">{akteurLabel(t, e.akteur_art)}</span>
                  </div>
                  {(e.entity_name || e.entity_id) && (
                    <p className="truncate text-sm text-gray-800" title={e.entity_id ?? undefined}>
                      <span className="text-gray-500">{ebeneLabel(t, e.entity_level)}: </span>{e.entity_name || e.entity_id}
                    </p>
                  )}
                  <VorherNachher before={e.before} after={e.after} fx={zahl(e.evidence?.fx)} />
                  {(e.ergebnis || grund) && (
                    <p className="text-xs text-gray-500">
                      {e.ergebnis && <span>{t('crm.werbung.autopilot.verlauf.ergebnis', 'Ergebnis: {{e}}', { e: e.ergebnis })}</span>}
                      {e.ergebnis && grund && ' · '}
                      {grund && <span>{t('crm.werbung.autopilot.verlauf.grund', 'Grund: {{g}}', { g: grund })}</span>}
                    </p>
                  )}
                </div>
                {kannZurueck && (
                  <button type="button" className="hp-btn hp-btn-ghost" disabled={busy !== null} onClick={() => void zuruecknehmen(e)}>
                    {busy === e.id ? t('crm.werbung.autopilot.vorschlag.laeuft', 'Läuft …') : t('crm.werbung.autopilot.verlauf.rueckgaengig', 'Rückgängig')}
                  </button>
                )}
                {e.art === 'ausfuehrung' && e.action_id && rueckgaengig.has(e.action_id) && (
                  <Badge>{t('crm.werbung.autopilot.verlauf.zurueckgenommen', 'Zurückgenommen')}</Badge>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
