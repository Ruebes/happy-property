import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import EmptyState from '../../ui/EmptyState'
import Spinner from '../../ui/Spinner'
import { KOMMENTAR_PLATTFORM_LABEL, type Kommentar, type KommentareListResponse, type KommentarPlattform } from '../../../lib/werbeKonto'
import { useWerbeRechte } from './autopilot/useWerbeRechte'
import { useWerbeFormat } from './format'
import { useWerbeKontext } from './useWerbeDaten'
import { EINGABE_KLEIN, Hinweis, SchreibSperre } from './zielgruppen/Bausteine'
import BeitragKarte from './kommentare/BeitragKarte'
import { filtere, gruppiere, ladeKommentare, type KommentarFilter, type Zeitraum } from './kommentare/kommentareApi'
import { ladeMessEinstellungen, messFehlerText, nacheinander, relativeZeit } from './messung/messungApi'

// ── Reiter „Kommentare" des Werbemanagers ────────────────────────────────────
// Kommentare unter den Anzeigen (Facebook und Instagram), gruppiert nach Anzeige
// bzw. Beitrag. Filter: nur unbeantwortete (Standard), Plattform, Zeitraum,
// Suche, ausgeblendete zeigen. Antworten und Aus-/Einblenden nur per Klick mit
// Bestätigung (meta-konto). Gelesen wird einmal je Zeitraum; Filter wirken im
// Browser, damit jeder Wechsel keinen neuen Meta-Abruf kostet (Konto auf
// „Limited access"). Von Kommentierenden zeigen wir nur den Namen.

const MEHR_BEITRAEGE = 60

export default function KommentareTab() {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const { loading: seiteLaedt } = useWerbeKontext()
  const rechte = useWerbeRechte()

  const [tage, setTage] = useState<Zeitraum>(30)
  const [mehr, setMehr] = useState(false)
  const [antwort, setAntwort] = useState<KommentareListResponse | null>(null)
  const [kommentare, setKommentare] = useState<Kommentar[]>([])
  const [laden, setLaden] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [builderEnabled, setBuilderEnabled] = useState<boolean | null>(null)
  const [filter, setFilter] = useState<KommentarFilter>({ nurOffen: true, plattform: 'alle', suche: '', mitAusgeblendeten: true })

  const lade = useCallback(async (zeitraum: Zeitraum, mehrBeitraege: boolean) => {
    setLaden(true)
    try {
      const r = await nacheinander(() => ladeKommentare(zeitraum, mehrBeitraege ? MEHR_BEITRAEGE : undefined))
      setAntwort(r)
      setKommentare(r.kommentare)
      setFehler(null)
    } catch (err) {
      console.error('[Kommentare] Liste:', err)
      setFehler(messFehlerText(err, t, 'konto'))
    } finally {
      setLaden(false)
    }
  }, [t])

  // Erst nach den Seitendaten (Micro-Instanz, nie parallel)
  const gestartet = useRef(false)
  useEffect(() => {
    if (seiteLaedt || gestartet.current) return
    gestartet.current = true
    void nacheinander(() => ladeMessEinstellungen(true)).then(e => setBuilderEnabled(e.builderEnabled))
    void lade(tage, false)
  }, [seiteLaedt, lade, tage])

  const wechsleZeitraum = (z: Zeitraum) => {
    if (z === tage) return
    setTage(z)
    setMehr(false)
    void lade(z, false)
  }

  const aendere = useCallback((neu: Kommentar) => {
    setKommentare(liste => liste.map(k => (k.id === neu.id && k.plattform === neu.plattform ? neu : k)))
  }, [])

  const sichtbar = useMemo(() => filtere(kommentare, filter), [kommentare, filter])
  const gruppen = useMemo(() => gruppiere(sichtbar, antwort), [sichtbar, antwort])
  const offenGesamt = useMemo(() => kommentare.filter(k => !k.beantwortet && !k.ausgeblendet).length, [kommentare])
  const anzahlJe = useMemo(() => {
    const m: Record<'alle' | KommentarPlattform, number> = { alle: 0, facebook: 0, instagram: 0 }
    for (const k of filtere(kommentare, { ...filter, plattform: 'alle' })) { m.alle++; m[k.plattform]++ }
    return m
  }, [kommentare, filter])

  const schreibSperre = !rechte.darfEntscheiden
    ? t('crm.werbung.kommentare.sperre.keinRecht', 'Dafür fehlt dir das Recht Werbemanager. Lesen geht, Antworten nicht.')
    : builderEnabled === false
      ? t('crm.werbung.kommentare.sperre.builder', 'Antworten und Ausblenden sind noch gesperrt: Freischaltung durch Sven ausstehend.')
      : null

  const setzeFilter = (p: Partial<KommentarFilter>) => setFilter(f => ({ ...f, ...p }))
  const chip = (aktiv: boolean) => `rounded-full border px-3 py-1 text-xs font-medium ${aktiv ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 sm:mr-auto">
          <h2 className="font-heading text-xl text-hp-navy">{t('crm.werbung.kommentare.titel', 'Kommentare')}</h2>
          <p className="mt-0.5 text-sm text-gray-600">
            {t('crm.werbung.kommentare.text', 'Kommentare unter euren Anzeigen bei Facebook und Instagram an einem Ort: lesen, beantworten, ausblenden. Schnelle, freundliche Antworten verbessern die Anzeige.')}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 whitespace-nowrap">
          {antwort && (
            <span className="text-xs text-gray-500">{t('crm.werbung.kommentare.stand', 'Stand {{zeit}}', { zeit: relativeZeit(antwort.geladen, fmt.locale) })}</span>
          )}
          <button type="button" onClick={() => void lade(tage, mehr)} disabled={laden} className="hp-btn hp-btn-ghost">
            {laden && <Spinner size="sm" />}
            {t('crm.werbung.kommentare.aktualisieren', 'Aktualisieren')}
          </button>
        </div>
      </div>

      <SchreibSperre grund={schreibSperre} />

      {/* Filter */}
      <div className="flex flex-col gap-2 rounded-xl border border-gray-200 bg-white p-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('crm.werbung.kommentare.filter.status', 'Status')}>
          <button type="button" onClick={() => setzeFilter({ nurOffen: true })} aria-pressed={filter.nurOffen} className={chip(filter.nurOffen)}>
            {t('crm.werbung.kommentare.filter.offen', 'Unbeantwortet')} <span className="tabular-nums opacity-70">{offenGesamt}</span>
          </button>
          <button type="button" onClick={() => setzeFilter({ nurOffen: false })} aria-pressed={!filter.nurOffen} className={chip(!filter.nurOffen)}>
            {t('crm.werbung.kommentare.filter.alle', 'Alle')} <span className="tabular-nums opacity-70">{kommentare.length}</span>
          </button>
          <span className="mx-1 hidden h-5 w-px bg-gray-200 sm:inline-block" aria-hidden="true" />
          {(['alle', 'facebook', 'instagram'] as const).map(p => (
            <button key={p} type="button" onClick={() => setzeFilter({ plattform: p })} aria-pressed={filter.plattform === p} className={chip(filter.plattform === p)}>
              {p === 'alle' ? t('crm.werbung.kommentare.filter.allePlattformen', 'Alle Plattformen') : KOMMENTAR_PLATTFORM_LABEL[p]}
              {' '}<span className="tabular-nums opacity-70">{anzahlJe[p]}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input value={filter.suche} onChange={e => setzeFilter({ suche: e.target.value })}
            placeholder={t('crm.werbung.kommentare.suche', 'Text, Name oder Anzeige suchen …')}
            aria-label={t('crm.werbung.kommentare.suche', 'Text, Name oder Anzeige suchen …')} className={`${EINGABE_KLEIN} sm:max-w-xs`} />
          <div className="flex gap-1" role="group" aria-label={t('crm.werbung.kommentare.filter.zeitraum', 'Zeitraum')}>
            {([7, 30, 90] as const).map(z => (
              <button key={z} type="button" onClick={() => wechsleZeitraum(z)} aria-pressed={tage === z} disabled={laden} className={chip(tage === z)}>
                {t('crm.werbung.kommentare.tageN', '{{n}} Tage', { n: z })}
              </button>
            ))}
          </div>
          {!filter.nurOffen && (
            <label className="flex items-center gap-2 whitespace-nowrap text-xs text-gray-600 sm:ml-auto">
              <input type="checkbox" checked={filter.mitAusgeblendeten} onChange={e => setzeFilter({ mitAusgeblendeten: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300 text-hp-navy" />
              {t('crm.werbung.kommentare.filter.ausgeblendete', 'Ausgeblendete zeigen')}
            </label>
          )}
        </div>
      </div>

      {antwort?.gekuerzt && (
        <Hinweis ton="info">
          {t('crm.werbung.kommentare.gekuerzt', 'Nicht alle Beiträge wurden abgefragt (Obergrenze oder Meta-Auslastung).')}
          {!mehr && (
            <button type="button" onClick={() => { setMehr(true); void lade(tage, true) }} disabled={laden}
              className="ml-2 font-semibold underline-offset-2 hover:underline">
              {t('crm.werbung.kommentare.mehrLaden', 'Mehr Beiträge laden')}
            </button>
          )}
        </Hinweis>
      )}
      {(antwort?.hinweise ?? []).map((h, i) => <Hinweis key={i} ton="info">{h}</Hinweis>)}

      {fehler && !antwort ? (
        <div className="hp-card">
          <EmptyState icon="alert" title={t('crm.werbung.kommentare.ladeFehler', 'Kommentare konnten nicht geladen werden')}
            text={<span className="break-words">{fehler}</span>}
            action={<button type="button" onClick={() => void lade(tage, mehr)} className="hp-btn hp-btn-ghost">{t('crm.werbung.kommentare.nochmal', 'Nochmal laden')}</button>} />
        </div>
      ) : !antwort ? (
        <div className="space-y-3" aria-hidden="true">
          {[0, 1, 2].map(i => <div key={i} className="h-28 animate-pulse rounded-xl bg-gray-100" />)}
        </div>
      ) : (
        <>
          {fehler && <Hinweis ton="fehler">{fehler}</Hinweis>}
          {gruppen.length === 0 ? (
            <div className="hp-card">
              <EmptyState icon="messages"
                title={kommentare.length
                  ? (filter.nurOffen ? t('crm.werbung.kommentare.alleErledigt', 'Alles beantwortet') : t('crm.werbung.kommentare.keinTreffer', 'Kein Kommentar passt zum Filter'))
                  : t('crm.werbung.kommentare.leer', 'Keine Kommentare in diesem Zeitraum')}
                text={kommentare.length && filter.nurOffen
                  ? t('crm.werbung.kommentare.alleErledigtText', 'Zu allen Kommentaren gibt es eine Antwort von euch oder sie sind ausgeblendet.')
                  : undefined} />
            </div>
          ) : (
            <div className="space-y-3">
              {gruppen.map(g => <BeitragKarte key={`${g.plattform}:${g.beitragId}`} g={g} schreibSperre={schreibSperre} onAenderung={aendere} />)}
            </div>
          )}
          <p className="text-[11px] text-gray-500">
            {t('crm.werbung.kommentare.fuss', '{{anzeigen}} Anzeigen geprüft, {{ohne}} davon noch ohne veröffentlichten Beitrag.', { anzeigen: fmt.int(antwort.anzeigen_geprueft), ohne: fmt.int(antwort.anzeigen_ohne_beitrag) })}
          </p>
        </>
      )}
    </div>
  )
}
