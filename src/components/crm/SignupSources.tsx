import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { anmeldungenAus, herkunftBadge, herkunftGruppe, type Anmeldung } from '../../lib/signupHerkunft'

// ── Woher kommen die Anmeldungen? ──────────────────────────────────────────────
// Newsletter, Immobilienguide und Masterclass je Kanal (YouTube, META, Google …).
// Datengrundlage: newsletter_subscribers.properties.herkunft_log (seit 14.10.2026),
// ältere Einträge über den source-Text. Klaviyo-Importe zählen nicht als Anmeldung.

type Zeitraum = '30' | '90' | 'alle'
type SubRow = {
  id: string; email: string | null; first_name: string | null; last_name: string | null
  source: string | null; klaviyo_id: string | null; created_at: string | null; properties: Record<string, unknown> | null
}

export default function SignupSources() {
  const { t } = useTranslation()
  const [subs, setSubs] = useState<SubRow[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [zeitraum, setZeitraum] = useState<Zeitraum>('90')
  const [filter, setFilter] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setLoading(true); setErr('')
      try {
        // Eigene Anmeldungen (ohne Klaviyo-ID) + Klaviyo-Kontakte, die sich neu eingetragen haben.
        const { data, error } = await supabase.from('newsletter_subscribers')
          .select('id, email, first_name, last_name, source, klaviyo_id, created_at, properties')
          .or('klaviyo_id.is.null,properties->herkunft_log.not.is.null')
          .order('created_at', { ascending: false }).limit(2000)
        if (error) throw error
        setSubs((data ?? []) as SubRow[])
      } catch (e) {
        console.error('[SignupSources] load:', e)
        setErr(t('crm.signupSrc.loadErr', 'Die Anmeldungen konnten nicht geladen werden.'))
      } finally { setLoading(false) }
    })()
  }, [t])

  const anmeldungen = useMemo(() => {
    const seit = zeitraum === 'alle' ? null : new Date(Date.now() - Number(zeitraum) * 86400_000)
    return anmeldungenAus(subs, seit)
  }, [subs, zeitraum])

  const formulare = useMemo(() => Array.from(new Set(anmeldungen.map(a => a.formular))).sort(), [anmeldungen])

  // Kanal-Gruppen mit Zählern, größte zuerst.
  const gruppen = useMemo(() => {
    const m = new Map<string, { kanal: string; gesamt: number; bestaetigt: number; jeFormular: Record<string, number> }>()
    for (const a of anmeldungen) {
      const g = herkunftGruppe(a.kanal)
      const z = m.get(g) ?? { kanal: g, gesamt: 0, bestaetigt: 0, jeFormular: {} }
      z.gesamt++
      if (a.bestaetigt) z.bestaetigt++
      z.jeFormular[a.formular] = (z.jeFormular[a.formular] ?? 0) + 1
      m.set(g, z)
    }
    return [...m.values()].sort((a, b) => b.gesamt - a.gesamt)
  }, [anmeldungen])

  const liste: Anmeldung[] = useMemo(
    () => (filter ? anmeldungen.filter(a => herkunftGruppe(a.kanal) === filter) : anmeldungen).slice(0, 25),
    [anmeldungen, filter],
  )

  const d2 = (s: string) => new Date(s).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })
  const chip = (aktiv: boolean) => `px-2.5 py-1 rounded-lg text-xs font-medium border transition-colors ${aktiv ? 'border-orange-300 bg-orange-50 text-orange-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-bold text-gray-900">{t('crm.signupSrc.title', 'Woher kommen die Anmeldungen?')}</h2>
          <p className="text-xs text-gray-500 mt-0.5">{t('crm.signupSrc.sub', 'Newsletter, Immobilienguide und Masterclass nach Kanal. Klaviyo-Importe zählen nicht mit.')}</p>
        </div>
        <div className="flex gap-1.5">
          {(['30', '90', 'alle'] as Zeitraum[]).map(z => (
            <button key={z} onClick={() => setZeitraum(z)} className={chip(zeitraum === z)}>
              {z === 'alle' ? t('crm.signupSrc.all', 'Alle') : t('crm.signupSrc.days', '{{n}} Tage', { n: z })}
            </button>
          ))}
        </div>
      </div>

      {err && <p className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

      {loading ? (
        <div className="flex justify-center py-8"><div className="w-7 h-7 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" /></div>
      ) : anmeldungen.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center">{t('crm.signupSrc.empty', 'In diesem Zeitraum gab es keine Anmeldungen.')}</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] font-semibold text-gray-400 uppercase tracking-wide border-b border-gray-100">
                  <th className="px-2 py-2">{t('crm.signupSrc.channel', 'Kanal')}</th>
                  <th className="px-2 py-2 text-right">{t('crm.signupSrc.total', 'Anmeldungen')}</th>
                  <th className="px-2 py-2 text-right">{t('crm.signupSrc.confirmed', 'Bestätigt')}</th>
                  {formulare.map(f => <th key={f} className="px-2 py-2 text-right whitespace-nowrap">{f}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {gruppen.map(g => {
                  const b = herkunftBadge(g.kanal)
                  const aktiv = filter === g.kanal
                  return (
                    <tr key={g.kanal} onClick={() => setFilter(aktiv ? null : g.kanal)}
                      className={`cursor-pointer transition-colors ${aktiv ? 'bg-orange-50/70' : 'hover:bg-gray-50/70'}`}
                      title={t('crm.signupSrc.rowTip', 'Anklicken: nur diese Anmeldungen unten zeigen')}>
                      <td className="px-2 py-2">
                        <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap" style={b.badge}>{b.icon} {b.label}</span>
                      </td>
                      <td className="px-2 py-2 text-right font-semibold text-gray-900">{g.gesamt}</td>
                      <td className="px-2 py-2 text-right text-gray-600">{g.bestaetigt}</td>
                      {formulare.map(f => <td key={f} className="px-2 py-2 text-right text-gray-500">{g.jeFormular[f] ?? '–'}</td>)}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-xs font-semibold text-gray-500">
                {filter
                  ? t('crm.signupSrc.latestFiltered', 'Letzte Anmeldungen über {{k}}', { k: herkunftBadge(filter).label })
                  : t('crm.signupSrc.latest', 'Letzte Anmeldungen')}
              </p>
              {filter && <button onClick={() => setFilter(null)} className="text-xs text-orange-600 hover:underline">{t('crm.signupSrc.showAll', 'Alle zeigen')}</button>}
            </div>
            <ul className="divide-y divide-gray-50 text-sm">
              {liste.map((a, i) => {
                const b = herkunftBadge(a.kanal)
                return (
                  <li key={`${a.subId}-${a.at}-${i}`} className="flex items-center gap-3 px-2 py-1.5">
                    <span className="text-gray-400 text-xs w-16 shrink-0">{d2(a.at)}</span>
                    <span className="text-gray-800 truncate flex-1 min-w-0">{a.name}</span>
                    <span className="text-xs text-gray-500 shrink-0 hidden sm:inline">{a.formular}</span>
                    <span className="text-[11px] px-2 py-0.5 rounded-full font-semibold whitespace-nowrap shrink-0" style={b.badge}>{b.icon} {b.label}</span>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap shrink-0 ${a.bestaetigt ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'}`}>
                      {a.bestaetigt ? t('crm.subs.stConfirmed', 'Bestätigt') : t('crm.subs.stPending', 'Ausstehend')}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        </>
      )}

      <p className="text-[11px] text-gray-400">
        {t('crm.signupSrc.hint', 'Erkannt über die Kennung im Link (z. B. ?src=youtube), den Website-Besuch oder die verweisende Seite. Erfasst seit 14.10.2026; ältere Anmeldungen stehen unter „Vor der Erfassung".')}
      </p>
    </div>
  )
}
