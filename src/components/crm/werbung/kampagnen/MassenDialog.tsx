import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useConfirm } from '../../../ui/ConfirmDialog'
import { LIMITS } from '../../../../lib/metaSpec'
import { INPUT_CLS, USD_PRO_EUR_FALLBACK, UsdEurHinweis, parseDollar } from '../felder'
import { useWerbeFormat } from '../format'
import { ladeUsdProEur } from '../useWerbeDaten'
import { builderCall, fehlerText } from './builderApi'
import {
  BUDGET_LERN_SCHWELLE, MASSEN_MAX,
  type MassenErgebnis, type MassenPatch, type MassenRequest, type MassenResponse, type ObjektStatus,
} from './bearbeitenTypen'
import { LernphaseBadge, ebeneName, geldText, statusText, useSchreibSperre, wertText } from './bearbeitenHelfer'

// ── Massenbearbeitung (mehrere Kampagnen, Anzeigengruppen oder Anzeigen) ─────
// Status, Tagesbudget (neuer Betrag oder Prozent), Enddatum, Namenszusatz.
// Vorschau je Objekt mit Lernphasen-Hinweis (Budget um mehr als 20 % geändert)
// und dem, was der Server ganz ablehnt (bulk.ts: ein abgelehntes Objekt behält
// auch Status und Name), Rückfrage, dann meta-builder mode 'bulk' mit confirm. Die Leitplanke prüft
// der Server einmal für alle Erhöhungen zusammen; Meta erlaubt Budget-
// änderungen höchstens 4x pro Stunde je Objekt. Höchstens 50 Objekte.

export interface MassenDialogProps {
  offen: boolean
  items: Array<{
    level: 'campaign' | 'adset' | 'ad'
    id: string
    name: string
    daily_budget_cents?: number | null
    status?: string | null
  }>
  onClose: () => void
  onFertig?: () => void
}

type BudgetArt = 'gleich' | 'betrag' | 'prozent'

export default function MassenDialog({ offen, items, onClose, onFertig }: MassenDialogProps): JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const confirm = useConfirm()
  const fmt = useWerbeFormat()
  const { sperre } = useSchreibSperre(offen)

  const [status, setStatus] = useState<'' | ObjektStatus>('')
  const [budgetArt, setBudgetArt] = useState<BudgetArt>('gleich')
  const [betrag, setBetrag] = useState('')
  const [prozent, setProzent] = useState('')
  const [endeAn, setEndeAn] = useState(false)
  const [ende, setEnde] = useState('')
  const [suffix, setSuffix] = useState('')
  const [laeuft, setLaeuft] = useState(false)
  const [ergebnis, setErgebnis] = useState<MassenErgebnis[] | null>(null)
  const [kurs, setKurs] = useState(USD_PRO_EUR_FALLBACK)

  useEffect(() => {
    if (!offen) return
    setStatus(''); setBudgetArt('gleich'); setBetrag(''); setProzent(''); setEndeAn(false); setEnde(''); setSuffix('')
    setErgebnis(null); setLaeuft(false)
    let abbruch = false
    void ladeUsdProEur().then(k => { if (!abbruch && k) setKurs(k) })
    return () => { abbruch = true }
  }, [offen])

  const betragCents = (() => {
    const v = parseDollar(betrag)
    return v != null && v > 0 ? Math.round(v * 100) : null
  })()
  const prozentWert = (() => {
    const v = parseFloat(prozent.replace(',', '.').replace(/\s/g, ''))
    return Number.isFinite(v) && v !== 0 ? Math.round(v * 10) / 10 : null
  })()
  const endeIso = (() => {
    if (!endeAn || !ende) return null
    const d = new Date(ende)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  })()
  const suffixClean = suffix.replace(/[\u2012-\u2015]/g, '-').trimEnd()

  const budgetAktiv = budgetArt !== 'gleich'

  // Was ändert sich je Objekt? (Vorschau, die Werte rechnet der Server noch einmal)
  // Der Server lehnt ein Objekt GANZ ab (auch Status und Name), wenn Budget oder Ende
  // dafür nicht gehen: Anzeigen ohne Budget/Ende, ohne eigenes Tagesbudget beim neuen
  // Betrag, Grenzen. Beim Prozent ändert er auch ein Laufzeitbudget (hier nicht bekannt).
  const vorschau = useMemo(() => items.map(i => {
    const hatBudget = i.level !== 'ad' && typeof i.daily_budget_cents === 'number' && i.daily_budget_cents > 0
    const alt = hatBudget ? (i.daily_budget_cents as number) : null
    let neu: number | null = null
    if (hatBudget && budgetArt === 'betrag' && betragCents) neu = betragCents
    if (hatBudget && budgetArt === 'prozent' && prozentWert !== null) neu = Math.round((alt as number) * (1 + prozentWert / 100))
    const pct = alt && neu !== null ? Math.round(((neu - alt) / alt) * 100) : null
    let abgelehnt: string | null = null
    let unsicher: string | null = null
    if (budgetAktiv && !hatBudget) {
      if (i.level === 'ad') abgelehnt = t('crm.werbung.bearbeiten.masse.abgelehntAnzeigeBudget', 'Anzeigen haben kein eigenes Budget.')
      else if (budgetArt === 'betrag') abgelehnt = t('crm.werbung.bearbeiten.masse.abgelehntKeinTagesbudget', 'Kein eigenes Tagesbudget (Laufzeitbudget oder Budget in der Kampagne).')
      else unsicher = t('crm.werbung.bearbeiten.masse.laufzeitOderAbgelehnt', 'Kein eigenes Tagesbudget: ein Laufzeitbudget ändert sich um denselben Prozentsatz, ohne eigenes Budget wird das ganze Objekt abgelehnt.')
    }
    if (!abgelehnt && neu !== null && (neu < LIMITS.dailyBudgetMinCents || neu > LIMITS.dailyBudgetMaxCents)) {
      abgelehnt = t('crm.werbung.bearbeiten.masse.abgelehntGrenze', 'Das neue Tagesbudget läge außerhalb der Grenzen.')
    }
    if (!abgelehnt && endeIso && i.level === 'ad') abgelehnt = t('crm.werbung.bearbeiten.masse.abgelehntAnzeigeEnde', 'Anzeigen haben kein eigenes Enddatum.')
    const statusNeu = status && (i.status ?? '').toUpperCase() !== status ? status : null
    return { ...i, hatBudget, alt, neu, pct, statusNeu, abgelehnt, unsicher }
  }), [items, budgetAktiv, budgetArt, betragCents, prozentWert, endeIso, status, t])

  const abgelehnt = vorschau.filter(v => !!v.abgelehnt).length
  const unsicher = vorschau.filter(v => !!v.unsicher).length
  const aktiviert = vorschau.filter(v => v.statusNeu === 'ACTIVE' && !v.abgelehnt).length
  const lernWarnung = vorschau.filter(v => !v.abgelehnt && v.pct !== null && Math.abs(v.pct) > BUDGET_LERN_SCHWELLE).length

  const patch: MassenPatch = {}
  if (status) patch.status = status
  if (budgetArt === 'betrag' && betragCents) patch.daily_budget_cents = betragCents
  if (budgetArt === 'prozent' && prozentWert !== null) patch.budget_prozent = prozentWert
  if (endeIso) patch.end_time = endeIso
  if (suffixClean.trim()) patch.name_suffix = suffixClean

  const gruende: string[] = []
  if (sperre) gruende.push(sperre)
  if (!items.length) gruende.push(t('crm.werbung.bearbeiten.dup.nichtsGewaehlt', 'Nichts ausgewählt.'))
  if (items.length > MASSEN_MAX) gruende.push(t('crm.werbung.bearbeiten.zuViele', 'Höchstens {{max}} Objekte auf einmal.', { max: MASSEN_MAX }))
  if (budgetArt === 'betrag' && !betragCents) gruende.push(t('crm.werbung.bearbeiten.masse.betragFehlt', 'Bitte einen Betrag in $ eintragen.'))
  if (budgetArt === 'prozent' && prozentWert === null) gruende.push(t('crm.werbung.bearbeiten.masse.prozentFehlt', 'Bitte eine Änderung in Prozent eintragen, z. B. 10 oder -20.'))
  if (budgetArt === 'prozent' && prozentWert !== null && (prozentWert < -90 || prozentWert > 100)) gruende.push(t('crm.werbung.bearbeiten.masse.prozentGrenze', 'Prozent zwischen -90 und +100.'))
  if (endeAn && !endeIso) gruende.push(t('crm.werbung.bearbeiten.masse.endeFehlt', 'Bitte ein Enddatum wählen.'))
  if (!Object.keys(patch).length) gruende.push(t('crm.werbung.bearbeiten.masse.nichts', 'Noch keine Änderung gewählt.'))

  const anwenden = async () => {
    const zeilen: string[] = []
    if (patch.status) zeilen.push(t('crm.werbung.bearbeiten.masse.zStatus', 'Status: {{s}}', { s: statusText(t, patch.status) }))
    if (patch.daily_budget_cents) zeilen.push(t('crm.werbung.bearbeiten.masse.zBetrag', 'Tagesbudget: {{b}}', { b: geldText(fmt, patch.daily_budget_cents, kurs) }))
    if (patch.budget_prozent !== undefined) zeilen.push(t('crm.werbung.bearbeiten.masse.zProzentBudget', 'Budget: {{p}} %', { p: `${patch.budget_prozent > 0 ? '+' : ''}${patch.budget_prozent}` }))
    if (patch.end_time) zeilen.push(t('crm.werbung.bearbeiten.masse.zEnde', 'Enddatum: {{d}}', { d: wertText(t, fmt, kurs, 'end_time', patch.end_time) }))
    if (patch.name_suffix) zeilen.push(t('crm.werbung.bearbeiten.masse.zName', 'Name + „{{s}}“', { s: patch.name_suffix }))
    const ok = await confirm({
      title: t('crm.werbung.bearbeiten.masse.frage', '{{n}} Objekte bei Meta ändern?', { n: items.length }),
      message: (
        <span className="block space-y-1.5">
          <span className="block">{zeilen.join(' · ')}</span>
          {aktiviert > 0 && <span className="block text-red-800">{t('crm.werbung.bearbeiten.masse.aktivWarnung', '{{n}} Objekte werden aktiv: Meta liefert sofort aus, es entstehen Kosten. Die Leitplanke wird für alle zusammen geprüft.', { n: aktiviert })}</span>}
          {lernWarnung > 0 && <span className="block text-amber-800">{t('crm.werbung.bearbeiten.masse.lernWarnung', 'Bei {{n}} Objekten ändert sich das Budget um mehr als 20 %: die Lernphase kann neu starten.', { n: lernWarnung })}</span>}
          {abgelehnt > 0 && <span className="block text-red-800">{t('crm.werbung.bearbeiten.masse.abgelehntWarnung', '{{n}} Objekte lehnt Meta ganz ab: dort ändern sich auch Status und Name nicht.', { n: abgelehnt })}</span>}
        </span>
      ),
      confirmLabel: t('crm.werbung.bearbeiten.masse.ok', 'Bei Meta ändern'),
      tone: aktiviert > 0 ? 'danger' : 'default',
    })
    if (!ok) return
    setLaeuft(true)
    try {
      const req: MassenRequest = { items: items.map(i => ({ level: i.level, id: i.id })), patch, confirm: true }
      const r: MassenResponse = await builderCall('bulk', req)
      const res = Array.isArray(r?.results) ? r.results : []
      setErgebnis(res)
      const gut = res.filter(x => x.ok).length
      const schlecht = res.length - gut
      if (gut && !schlecht) toast.success(t('crm.werbung.bearbeiten.masse.fertig', '{{n}} Objekte bei Meta geändert.', { n: gut }))
      else if (gut) toast.info(t('crm.werbung.bearbeiten.masse.teilweise', '{{n}} geändert, {{f}} fehlgeschlagen. Details im Fenster.', { n: gut, f: schlecht }))
      else toast.error(t('crm.werbung.bearbeiten.masse.fehlgeschlagen', 'Nichts geändert. Details im Fenster.'))
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setLaeuft(false)
    }
  }

  const schliessen = () => {
    if (laeuft) return
    if (ergebnis && ergebnis.some(x => x.ok)) onFertig?.()
    onClose()
  }

  const name = (id: string) => items.find(i => i.id === id)?.name ?? id

  // Vorher/Nachher aus bulk: Objekte feldweise (nur Geändertes), sonst als Ganzes
  const FELD_TEXT: Record<string, string> = {
    status: t('crm.werbung.bearbeiten.masse.status', 'Status'),
    daily_budget: t('crm.werbung.bearbeiten.masse.budget', 'Tagesbudget'),
    daily_budget_cents: t('crm.werbung.bearbeiten.masse.budget', 'Tagesbudget'),
    end_time: t('crm.werbung.bearbeiten.masse.ende', 'Enddatum'),
    stop_time: t('crm.werbung.bearbeiten.masse.ende', 'Enddatum'),
    name: t('crm.werbung.bearbeiten.masse.nameFeld', 'Name'),
  }
  const vorherNachher = (b: unknown, a: unknown): string[] => {
    const istObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
    if (istObj(b) || istObj(a)) {
      const bo = istObj(b) ? b : {}
      const ao = istObj(a) ? a : {}
      const keys = [...Object.keys(bo), ...Object.keys(ao)].filter((k, i, arr) => arr.indexOf(k) === i)
      return keys
        .filter(k => JSON.stringify(bo[k]) !== JSON.stringify(ao[k]))
        .map(k => `${FELD_TEXT[k] ?? k}: ${wertText(t, fmt, kurs, k, bo[k])} → ${wertText(t, fmt, kurs, k, ao[k])}`)
    }
    return [`${wertText(t, fmt, kurs, 'bulk', b)} → ${wertText(t, fmt, kurs, 'bulk', a)}`]
  }

  const footer = ergebnis ? (
    <div className="flex w-full justify-end">
      <button type="button" onClick={schliessen} className="hp-btn hp-btn-primary">{t('crm.werbung.bearbeiten.schliessen', 'Schließen')}</button>
    </div>
  ) : (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <p className="min-w-0 text-[11px] text-gray-500 sm:mr-auto">{gruende.join(' ')}</p>
      <div className="flex gap-2">
        <button type="button" onClick={schliessen} disabled={laeuft} className="hp-btn hp-btn-ghost">{t('crm.werbung.bearbeiten.abbrechen', 'Abbrechen')}</button>
        <button type="button" onClick={() => void anwenden()} disabled={laeuft || gruende.length > 0} className="hp-btn hp-btn-primary disabled:opacity-50">
          {laeuft && <Spinner size="sm" />}
          {t('crm.werbung.bearbeiten.masse.knopf', 'Änderungen prüfen und anwenden')}
        </button>
      </div>
    </div>
  )

  const radio = 'flex items-center gap-1.5 text-xs text-gray-700'

  return (
    <Modal open={offen} onClose={schliessen} size="xl" closeOnBackdrop={!laeuft} footer={footer}
      title={t('crm.werbung.bearbeiten.masse.titel', 'Massenbearbeitung ({{n}})', { n: items.length })}>
      {ergebnis ? (
        <div className="space-y-2 text-sm">
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {ergebnis.map((r, i) => (
              <li key={`${r.level}-${r.id}-${i}`} className="px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={r.ok ? 'text-emerald-700' : 'text-red-700'} aria-hidden="true">{r.ok ? '✓' : '✕'}</span>
                  <Badge tone="neutral">{ebeneName(t, r.level)}</Badge>
                  <span className="min-w-0 flex-1 truncate font-medium text-gray-800" title={r.id}>{name(r.id)}</span>
                </div>
                {r.ok && (r.before !== undefined || r.after !== undefined) && (
                  <ul className="mt-0.5 space-y-0.5 pl-6 text-gray-500">
                    {vorherNachher(r.before, r.after).map((z, j) => <li key={j}>{z}</li>)}
                  </ul>
                )}
                {!r.ok && <p className="mt-0.5 pl-6 text-red-700">{r.error || t('crm.werbung.bearbeiten.masse.unbekannt', 'Unbekannter Fehler')}</p>}
                {r.hinweis && <p className="mt-0.5 pl-6 text-amber-800">{r.hinweis}</p>}
              </li>
            ))}
          </ul>
          {!ergebnis.length && <p className="text-xs text-gray-500">{t('crm.werbung.bearbeiten.masse.keineAntwort', 'Meta hat keine Ergebnisse gemeldet.')}</p>}
        </div>
      ) : (
        <div className="space-y-4 text-sm">
          <div className="grid gap-4 md:grid-cols-2">
            <fieldset className="space-y-1.5">
              <legend className="text-[11px] font-semibold text-gray-500">{t('crm.werbung.bearbeiten.masse.status', 'Status')}</legend>
              {([['', t('crm.werbung.bearbeiten.masse.unveraendert', 'Unverändert')], ['ACTIVE', t('crm.werbung.bearbeiten.status.ACTIVE', 'Aktiv')], ['PAUSED', t('crm.werbung.bearbeiten.status.PAUSED', 'Pausiert')]] as const).map(([v, l]) => (
                <label key={v || 'gleich'} className={radio}>
                  <input type="radio" name="masse-status" checked={status === v} onChange={() => setStatus(v)} />{l}
                </label>
              ))}
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[11px] font-semibold text-gray-500">{t('crm.werbung.bearbeiten.masse.budget', 'Tagesbudget')}</legend>
              <label className={radio}><input type="radio" name="masse-budget" checked={budgetArt === 'gleich'} onChange={() => setBudgetArt('gleich')} />{t('crm.werbung.bearbeiten.masse.unveraendert', 'Unverändert')}</label>
              <label className={radio}><input type="radio" name="masse-budget" checked={budgetArt === 'betrag'} onChange={() => setBudgetArt('betrag')} />{t('crm.werbung.bearbeiten.masse.betrag', 'Neuer Betrag für alle')}</label>
              {budgetArt === 'betrag' && (
                <div className="pl-6">
                  <div className="relative">
                    <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
                    <input inputMode="decimal" value={betrag} onChange={ev => setBetrag(ev.target.value)} aria-label={t('crm.werbung.bearbeiten.masse.betrag', 'Neuer Betrag für alle')}
                      className={`${INPUT_CLS} mt-0 pl-5 tabular-nums`} />
                  </div>
                  <UsdEurHinweis usd={betrag} kurs={kurs} />
                </div>
              )}
              <label className={radio}><input type="radio" name="masse-budget" checked={budgetArt === 'prozent'} onChange={() => setBudgetArt('prozent')} />{t('crm.werbung.bearbeiten.masse.prozent', 'Um Prozent ändern')}</label>
              {budgetArt === 'prozent' && (
                <div className="pl-6">
                  <div className="relative">
                    <input inputMode="decimal" value={prozent} onChange={ev => setProzent(ev.target.value)} placeholder="+10 / -20"
                      aria-label={t('crm.werbung.bearbeiten.masse.prozent', 'Um Prozent ändern')} className={`${INPUT_CLS} mt-0 pr-6 tabular-nums`} />
                    <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">%</span>
                  </div>
                </div>
              )}
              {budgetAktiv && (
                <p className="text-[10px] leading-snug text-gray-500">
                  {budgetArt === 'prozent'
                    ? t('crm.werbung.bearbeiten.masse.budgetHilfeProzent', 'Ändert das eigene Budget jedes Objekts, auch ein Laufzeitbudget. Meta erlaubt Budgetänderungen höchstens 4-mal pro Stunde je Objekt.')
                    : t('crm.werbung.bearbeiten.masse.budgetHilfeBetrag', 'Geht nur bei Objekten mit eigenem Tagesbudget. Meta erlaubt Budgetänderungen höchstens 4-mal pro Stunde je Objekt.')}
                  {abgelehnt > 0 && <span className="text-red-700">{` ${t('crm.werbung.bearbeiten.masse.abgelehntHilfe', '{{n}} Objekte werden ganz abgelehnt, auch Status und Name bleiben dort unverändert. Besser getrennt bearbeiten.', { n: abgelehnt })}`}</span>}
                  {unsicher > 0 && ` ${t('crm.werbung.bearbeiten.masse.unsicherHilfe', '{{n}} ohne eigenes Tagesbudget: mit Laufzeitbudget ändert es sich mit, ohne eigenes Budget wird das Objekt ganz abgelehnt.', { n: unsicher })}`}
                </p>
              )}
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[11px] font-semibold text-gray-500">{t('crm.werbung.bearbeiten.masse.ende', 'Enddatum')}</legend>
              <label className={radio}>
                <input type="checkbox" checked={endeAn} onChange={ev => setEndeAn(ev.target.checked)} className="h-4 w-4 rounded border-gray-300" />
                {t('crm.werbung.bearbeiten.masse.endeSetzen', 'Enddatum für alle setzen')}
              </label>
              {endeAn && (
                <input type="datetime-local" value={ende} onChange={ev => setEnde(ev.target.value)} aria-label={t('crm.werbung.bearbeiten.masse.ende', 'Enddatum')} className={`${INPUT_CLS} ml-6 w-[calc(100%-1.5rem)]`} />
              )}
              <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.bearbeiten.masse.endeHilfe', 'Bei Kampagnen das Enddatum der Kampagne, bei Anzeigengruppen ihr eigenes. Anzeigen haben kein Enddatum.')}</p>
            </fieldset>

            <fieldset className="space-y-1.5">
              <legend className="text-[11px] font-semibold text-gray-500">{t('crm.werbung.bearbeiten.masse.name', 'Namenszusatz')}</legend>
              <input value={suffix} onChange={ev => setSuffix(ev.target.value)} maxLength={60}
                placeholder={t('crm.werbung.bearbeiten.masse.namePh', 'z. B. Oktober')} aria-label={t('crm.werbung.bearbeiten.masse.name', 'Namenszusatz')} className={INPUT_CLS} />
              <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.bearbeiten.masse.nameHilfe', 'Wird hinten an den Namen gehängt, mit Leerzeichen davor.')}</p>
            </fieldset>
          </div>

          <div>
            <p className="mb-1 text-[11px] font-semibold text-gray-500">{t('crm.werbung.bearbeiten.masse.vorschau', 'Vorschau')}</p>
            <ul className="max-h-72 divide-y divide-gray-100 overflow-y-auto rounded-lg border border-gray-200">
              {vorschau.map(v => (
                <li key={`${v.level}-${v.id}`} className="px-3 py-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="neutral">{ebeneName(t, v.level)}</Badge>
                    <span className="min-w-0 flex-1 truncate font-medium text-gray-800" title={v.id}>
                      {v.name || v.id}{suffixClean.trim() && !v.abgelehnt ? <span className="text-hp-navy"> {suffixClean.trim()}</span> : null}
                    </span>
                    {v.statusNeu && !v.abgelehnt && (
                      <Badge tone={v.statusNeu === 'ACTIVE' ? 'danger' : 'info'}>{statusText(t, v.status)} → {statusText(t, v.statusNeu)}</Badge>
                    )}
                    {v.abgelehnt && <Badge tone="danger">{t('crm.werbung.bearbeiten.masse.wirdAbgelehnt', 'wird abgelehnt')}</Badge>}
                  </div>
                  {v.abgelehnt && (
                    <p className="mt-0.5 pl-1 text-red-700">{v.abgelehnt} {t('crm.werbung.bearbeiten.masse.bleibtGanz', 'Status und Name bleiben dann auch unverändert.')}</p>
                  )}
                  {budgetAktiv && !v.abgelehnt && (
                    <p className="mt-0.5 flex flex-wrap items-center gap-2 pl-1 text-gray-600 tabular-nums">
                      {v.hatBudget && v.alt !== null ? (
                        v.neu !== null ? (
                          <>
                            <span>{geldText(fmt, v.alt, kurs)} → {geldText(fmt, v.neu, kurs)}</span>
                            {v.pct !== null && <span className={v.pct > 0 ? 'text-emerald-700' : 'text-red-700'}>{v.pct > 0 ? '+' : ''}{v.pct} %</span>}
                            {v.pct !== null && Math.abs(v.pct) > BUDGET_LERN_SCHWELLE && <LernphaseBadge text={t('crm.werbung.bearbeiten.lernphaseKann', 'Lernphase kann neu starten')} />}
                          </>
                        ) : <span>{geldText(fmt, v.alt, kurs)}</span>
                      ) : (
                        <span className="text-amber-800">{v.unsicher ?? t('crm.werbung.bearbeiten.masse.keinBudget', 'kein eigenes Tagesbudget')}</span>
                      )}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </div>

          {aktiviert > 0 && (
            <p role="note" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {t('crm.werbung.bearbeiten.masse.aktivHinweis', 'Aktivieren startet die Auslieferung sofort. Die Leitplanke (Summe aller aktiven Tagesbudgets) prüft der Server für alle zusammen und lehnt ab, wenn das Limit überschritten wäre.')}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
