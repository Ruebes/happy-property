import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../../../lib/supabase'
import type { WerbeLogEintrag, WerbeRegel } from '../../../../lib/werbungTypes'
import Badge from '../../../ui/Badge'
import EmptyState from '../../../ui/EmptyState'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { LOG_FELDER } from './abfragen'
import { EvidenzLeiste, VorherNachher } from './Evidenz'
import type { WerbeRechte } from './useWerbeRechte'
import { aktionLabel, dbFehlerText, ebeneLabel, fehltSchema, zahl, zeitKurz } from './werbeTexte'

// ── Schatten-Log: was der Autopilot getan hätte (letzte 14 Tage) ─────────────
// Daumen hoch = richtig, runter = falsch (RPC werbe_schatten_bewerten legt
// einen neuen Log-Eintrag art 'bewertung' an, das Log selbst bleibt
// unverändert). Die Übereinstimmung ist eine Grundlage fürs Hochstufen
// (mindestens 20 Einträge mit 90 % richtig).

const TAGE = 14

export default function SchattenLog({ regeln, rechte }: { regeln: ReadonlyMap<string, WerbeRegel>; rechte: WerbeRechte }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const [loading, setLoading] = useState(true)
  const [fehlt, setFehlt] = useState(false)
  const [eintraege, setEintraege] = useState<WerbeLogEintrag[]>([])
  const [urteile, setUrteile] = useState<Map<number, string>>(new Map())
  const [nurOffen, setNurOffen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)

  const laden = useCallback(async () => {
    setLoading(true)
    try {
      const seit = new Date(Date.now() - TAGE * 86_400_000).toISOString()
      const { data, error } = await supabase.from('ad_autopilot_log').select(LOG_FELDER)
        .eq('art', 'schatten').gte('ts', seit).order('ts', { ascending: false }).limit(200)
      if (error) throw error
      const rows = (data as unknown as WerbeLogEintrag[] | null) ?? []
      setEintraege(rows)
      const map = new Map<number, string>()
      if (rows.length) {
        // Danach (nicht parallel): vorhandene Bewertungen zu genau diesen Einträgen
        const { data: bw, error: e2 } = await supabase.from('ad_autopilot_log')
          .select('bezug_log_id, ergebnis, ts')
          .eq('art', 'bewertung').gte('ts', seit).in('bezug_log_id', rows.map(r => r.id))
          .order('ts', { ascending: false }).limit(500)
        if (e2) throw e2
        for (const b of (bw as Array<{ bezug_log_id: number | null; ergebnis: string | null }> | null) ?? []) {
          const id = zahl(b.bezug_log_id)
          if (id != null && b.ergebnis && !map.has(id)) map.set(id, b.ergebnis)
        }
      }
      setUrteile(map)
      setFehlt(false)
    } catch (err) {
      if (fehltSchema(err)) setFehlt(true)
      else {
        console.error('[Autopilot] Schatten-Log:', err)
        toast.error(dbFehlerText(t, err))
      }
      setEintraege([])
    } finally {
      setLoading(false)
    }
  }, [t, toast])

  useEffect(() => { void laden() }, [laden])

  const bewerten = async (id: number, urteil: 'richtig' | 'falsch') => {
    setBusy(id)
    try {
      const { error } = await supabase.rpc('werbe_schatten_bewerten', { p_log_id: id, p_urteil: urteil })
      if (error) throw error
      setUrteile(prev => new Map(prev).set(id, urteil))
    } catch (err) {
      console.error('[Autopilot] bewerten:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setBusy(null)
    }
  }

  const statistik = useMemo(() => {
    let richtig = 0, falsch = 0
    for (const e of eintraege) {
      const u = urteile.get(e.id)
      if (u === 'richtig') richtig++
      else if (u === 'falsch') falsch++
    }
    return { richtig, falsch, bewertet: richtig + falsch }
  }, [eintraege, urteile])

  const sichtbar = nurOffen ? eintraege.filter(e => !urteile.has(e.id)) : eintraege

  if (loading) return <div className="flex justify-center py-10"><Spinner /></div>
  if (fehlt) {
    return <EmptyState compact icon="rules" title={t('crm.werbung.autopilot.nichtFreigeschaltet', 'Noch nicht freigeschaltet')}
      text={t('crm.werbung.autopilot.nichtFreigeschaltetText', 'Die Datenbank-Erweiterung für den Autopiloten ist noch nicht eingespielt.')} />
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-gray-600">
          {statistik.bewertet
            ? t('crm.werbung.autopilot.schatten.statistik', '{{richtig}} von {{bewertet}} bewerteten Einträgen richtig ({{pct}}). Gesamt {{n}} in {{tage}} Tagen.', {
              richtig: statistik.richtig, bewertet: statistik.bewertet, pct: fmt.pct(statistik.richtig / statistik.bewertet), n: eintraege.length, tage: TAGE,
            })
            : t('crm.werbung.autopilot.schatten.statistikLeer', '{{n}} Einträge in {{tage}} Tagen, noch keiner bewertet.', { n: eintraege.length, tage: TAGE })}
        </p>
        <label className="inline-flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" className="h-4 w-4 accent-hp-navy" checked={nurOffen} onChange={e => setNurOffen(e.target.checked)} />
          {t('crm.werbung.autopilot.schatten.nurOffen', 'Nur unbewertete')}
        </label>
      </div>

      {!sichtbar.length ? (
        <EmptyState compact icon="rules" title={t('crm.werbung.autopilot.schatten.leer', 'Keine Schatten-Einträge')}
          text={t('crm.werbung.autopilot.schatten.leerText', 'Der Autopilot rechnet jede Nacht. Was er tun würde, erscheint hier.')} />
      ) : (
        <ul className="space-y-2">
          {sichtbar.map(e => {
            const urteil = urteile.get(e.id)
            const regel = e.rule_key ? regeln.get(e.rule_key) : undefined
            return (
              <li key={e.id} className="rounded-xl border border-gray-100 bg-white p-3 space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {e.rule_key && <Badge tone="info">{e.rule_key}</Badge>}
                      <Badge>{aktionLabel(t, e.aktion)}</Badge>
                      <span className="text-xs text-gray-500 tabular-nums">{zeitKurz(e.ts, fmt.locale)}</span>
                    </div>
                    <p className="mt-1 truncate text-sm text-gray-800" title={e.entity_id ?? undefined}>
                      <span className="text-gray-500">{ebeneLabel(t, e.entity_level)}: </span>{e.entity_name || e.entity_id || '-'}
                    </p>
                    {regel && <p className="text-xs text-gray-500">{regel.titel}</p>}
                  </div>
                  {rechte.darfEntscheiden ? (
                    <div className="flex gap-1" role="group" aria-label={t('crm.werbung.autopilot.schatten.bewerten', 'Bewerten')}>
                      <button
                        type="button"
                        aria-pressed={urteil === 'richtig'}
                        disabled={busy !== null}
                        onClick={() => void bewerten(e.id, 'richtig')}
                        title={t('crm.werbung.autopilot.schatten.richtig', 'Richtig, das hätte ich auch so gemacht')}
                        className={`hp-btn min-h-[44px] px-3 sm:min-h-[36px] ${urteil === 'richtig' ? 'bg-emerald-50 border-emerald-300 text-emerald-800' : 'hp-btn-ghost'}`}
                      >
                        <span aria-hidden="true">👍</span>
                        <span className="sr-only">{t('crm.werbung.autopilot.schatten.richtig', 'Richtig, das hätte ich auch so gemacht')}</span>
                      </button>
                      <button
                        type="button"
                        aria-pressed={urteil === 'falsch'}
                        disabled={busy !== null}
                        onClick={() => void bewerten(e.id, 'falsch')}
                        title={t('crm.werbung.autopilot.schatten.falsch', 'Falsch, das hätte ich nicht gemacht')}
                        className={`hp-btn min-h-[44px] px-3 sm:min-h-[36px] ${urteil === 'falsch' ? 'bg-red-50 border-red-300 text-red-800' : 'hp-btn-ghost'}`}
                      >
                        <span aria-hidden="true">👎</span>
                        <span className="sr-only">{t('crm.werbung.autopilot.schatten.falsch', 'Falsch, das hätte ich nicht gemacht')}</span>
                      </button>
                    </div>
                  ) : urteil ? (
                    <Badge tone={urteil === 'richtig' ? 'success' : urteil === 'falsch' ? 'danger' : 'neutral'}>{urteil}</Badge>
                  ) : null}
                </div>
                <VorherNachher before={e.before} after={e.after} fx={zahl(e.evidence?.fx)} />
                <EvidenzLeiste evidence={e.evidence} kompakt />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
