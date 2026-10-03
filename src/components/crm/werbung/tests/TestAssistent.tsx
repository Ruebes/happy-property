import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  TEST_GESPERRTE_TYPEN, TEST_GRENZEN, TEST_KENNZAHLEN, TEST_KENNZAHL_EMPFOHLEN, TEST_TYP_EMPFOHLEN, TEST_TYPEN,
  type GesperrteOption, type SteuerungEbene, type StudyCreateRequest, type TestKennzahl, type TestTyp, type TestZelleEingabe,
} from '../../../../lib/werbeSteuerung'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { useWerbeKontext } from '../useWerbeDaten'
import {
  Abschnitt, EINGABE_KLEIN, Einstellung, Hinweis, Kacheln, MetaAenderungDialog, SchreibSperre, type AenderungPunkt,
} from '../zielgruppen/Bausteine'
import ObjektWahl from './ObjektWahl'
import { wahlObjekte } from './objekte'
import { steuerungCall, steuerungFehlerText } from './steuerungApi'
import { datumKurz, kennzahlErklaerung, kennzahlLabel, typErklaerung, typLabel, zahlAusEingabe, zeitKurz } from './texte'
import { usePruefung } from './usePruefung'

// ── Assistent „Neuer A/B-Test" (Meta: A/B-Test / Experiments) ─────────────────
// Vier Schritte wie bei Meta: Variable, Varianten (Zellen), Gewinner-Kennzahl
// und Laufzeit, Prüfen. Jeder Schritt beginnt mit dem Wichtigsten (HP-Empfehlung
// vorbelegt), Feinheiten unter „Alle Einstellungen". Varianten kommen aus dem
// Anzeigen-Katalog der Seite. Vor dem Anlegen prüft der Server den Auftrag
// (vorschau: true), dann erst study_create. An den Anzeigen selbst ändert der
// Test nichts. Grenzen (Varianten, Anteile, Laufzeit) aus TEST_GRENZEN.

const BUCHSTABEN = 'ABCDE'

type Schritt = 1 | 2 | 3 | 4
type BudgetArt = 'standard' | 'anteil' | 'tages'

/** Datum/Uhrzeit für <input type="datetime-local"> in Ortszeit */
const lokal = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
const morgenFrueh = (): Date => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(0, 0, 0, 0)
  return d
}
const isoOderNull = (d: Date): string | null => (Number.isNaN(d.getTime()) ? null : d.toISOString())

/** Gesperrte Test-Arten (Wohnen, Lift-Studien) mit übersetzbarem Text */
function gesperrtText(t: TFunction, g: GesperrteOption): { label: string; grund: string } {
  const m: Record<string, { label: string; grund: string }> = {
    conversion_lift: {
      label: t('crm.werbung.tests.gesperrt.conversion_lift.label', 'Conversion-Lift'),
      grund: t('crm.werbung.tests.gesperrt.conversion_lift.grund', 'Nur mit Meta-Ansprechpartner und großem Budget, über die API nicht frei anlegbar.'),
    },
    brand_lift: {
      label: t('crm.werbung.tests.gesperrt.brand_lift.label', 'Brand-Lift'),
      grund: t('crm.werbung.tests.gesperrt.brand_lift.grund', 'Nur mit Meta-Ansprechpartner; für Leads nicht sinnvoll.'),
    },
    alter_geschlecht: {
      label: t('crm.werbung.tests.gesperrt.alter_geschlecht.label', 'Zielgruppe nach Alter oder Geschlecht'),
      grund: t('crm.werbung.tests.gesperrt.alter_geschlecht.grund', 'Sonderkategorie Wohnen: Alter und Geschlecht sind fest, ein solcher Test ist nicht erlaubt.'),
    },
  }
  return m[g.key] ?? { label: g.label, grund: g.grund }
}

export default function TestAssistent({ offen, onClose, onFertig, schreibSperre, pruefSperre }: {
  offen: boolean
  onClose: () => void
  onFertig: () => void
  schreibSperre: string | null
  /** Prüfen (vorschau) braucht nur das Recht Werbung; Anlegen zusätzlich die Freischaltung */
  pruefSperre: string | null
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const fmt = useWerbeFormat()
  const { catalog, byAd, byAdset, byCampaign } = useWerbeKontext()

  const [schritt, setSchritt] = useState<Schritt>(1)
  const [typ, setTyp] = useState<TestTyp>(TEST_TYP_EMPFOHLEN)
  const [freiEbene, setFreiEbene] = useState<'campaign' | 'adset'>('adset')
  const [gewaehlt, setGewaehlt] = useState<string[]>([])
  const [namen, setNamen] = useState<Record<string, string>>({})
  const [manuell, setManuell] = useState(false)
  const [anteile, setAnteile] = useState<Record<string, number>>({})
  const [kennzahl, setKennzahl] = useState<TestKennzahl>(TEST_KENNZAHL_EMPFOHLEN)
  const [start, setStart] = useState(() => lokal(morgenFrueh()))
  const [dauer, setDauer] = useState<number>(14)
  const [endeManuell, setEndeManuell] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [nameAngepasst, setNameAngepasst] = useState(false)
  const [beschreibung, setBeschreibung] = useState('')
  const [budgetArt, setBudgetArt] = useState<BudgetArt>('standard')
  const [budgetAnteil, setBudgetAnteil] = useState('20')
  const [budgetTag, setBudgetTag] = useState('')
  const [bestaetigen, setBestaetigen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Beim Öffnen frisch beginnen
  useEffect(() => {
    if (!offen) return
    setSchritt(1); setTyp(TEST_TYP_EMPFOHLEN); setFreiEbene('adset'); setGewaehlt([]); setNamen({}); setManuell(false)
    setAnteile({}); setKennzahl(TEST_KENNZAHL_EMPFOHLEN); setStart(lokal(morgenFrueh())); setDauer(14); setEndeManuell(null)
    setName(''); setNameAngepasst(false); setBeschreibung(''); setBudgetArt('standard'); setBudgetAnteil('20'); setBudgetTag('')
    setBestaetigen(false); setBusy(false)
  }, [offen])

  const ebene: SteuerungEbene = typ === 'anzeigengestaltung' ? 'ad' : typ === 'frei' ? freiEbene : 'adset'
  const creativeTest = ebene === 'ad'
  const objekte = useMemo(() => wahlObjekte(catalog, ebene, { byAd, byAdset, byCampaign }), [catalog, ebene, byAd, byAdset, byCampaign])

  // Ebene gewechselt: Auswahl passt nicht mehr
  useEffect(() => { setGewaehlt([]); setNamen({}); setAnteile({}) }, [ebene])

  // Name automatisch, bis er angepasst wird
  useEffect(() => {
    if (nameAngepasst) return
    const d = new Date(start)
    const datum = Number.isNaN(d.getTime()) ? '' : ` ${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })}`
    setName(t('crm.werbung.tests.assistent.nameVorschlag', 'A/B-Test {{typ}}{{datum}}', { typ: typLabel(t, typ), datum }))
  }, [typ, start, nameAngepasst, t])

  const startDatum = new Date(start)
  const endeDatum = endeManuell ? new Date(endeManuell) : new Date(startDatum.getTime() + dauer * 86_400_000)
  const tage = (endeDatum.getTime() - startDatum.getTime()) / 86_400_000
  const anteilListe = gewaehlt.map(id => anteile[id] ?? 0)
  const anteilSumme = anteilListe.reduce((s, a) => s + a, 0)
  const gleich = Math.floor(100 / Math.max(1, gewaehlt.length))

  const zellen: TestZelleEingabe[] = gewaehlt.map((id, i) => {
    const o = objekte.find(x => x.id === id)
    const standard = t('crm.werbung.tests.assistent.zelleName', 'Variante {{b}}: {{name}}', { b: BUCHSTABEN[i] ?? String(i + 1), name: o?.name ?? id })
    const z: TestZelleEingabe = { name: (namen[id]?.trim() || standard).slice(0, 100) }
    if (manuell) z.anteil = anteilListe[i]
    if (ebene === 'ad') z.ad_ids = [id]
    else if (ebene === 'adset') z.adset_ids = [id]
    else z.campaign_ids = [id]
    return z
  })

  // ── Prüfungen je Schritt (gleiche Grenzen wie der Server) ──
  const fehler2: string | null = gewaehlt.length < TEST_GRENZEN.min_zellen
    ? t('crm.werbung.tests.assistent.zuWenig', 'Wähle mindestens {{n}} Varianten.', { n: TEST_GRENZEN.min_zellen })
    : manuell && anteilListe.some(a => !Number.isInteger(a) || a < TEST_GRENZEN.min_anteil)
      ? t('crm.werbung.tests.assistent.anteilMin', 'Jede Variante braucht mindestens {{n}} % (ganze Zahl).', { n: TEST_GRENZEN.min_anteil })
      : manuell && creativeTest && anteilSumme !== 100
        ? t('crm.werbung.tests.assistent.summe', 'Die Anteile ergeben {{s}} %, beim Anzeigen-Test sind genau 100 % nötig.', { s: anteilSumme })
        : manuell && anteilSumme > 100
          ? t('crm.werbung.tests.assistent.summeMax', 'Die Anteile ergeben {{s}} %, höchstens 100 % sind möglich.', { s: anteilSumme })
          : null
  const budgetAnteilZahl = zahlAusEingabe(budgetAnteil, fmt.locale) ?? Number.NaN
  const budgetTagZahl = zahlAusEingabe(budgetTag, fmt.locale) ?? Number.NaN
  const fehlerBudget: string | null = !creativeTest || budgetArt === 'standard' ? null
    : budgetArt === 'anteil' && (!Number.isInteger(budgetAnteilZahl) || budgetAnteilZahl < 1 || budgetAnteilZahl > 100)
      ? t('crm.werbung.tests.assistent.budgetAnteilFehler', 'Testbudget-Anteil: ganze Zahl von 1 bis 100 %.')
      : budgetArt === 'tages' && !(budgetTagZahl > 0)
        ? t('crm.werbung.tests.assistent.budgetTagFehler', 'Tagesbudget für den Test in Euro angeben.')
        : null
  const fehler3: string | null = Number.isNaN(startDatum.getTime()) || Number.isNaN(endeDatum.getTime())
    ? t('crm.werbung.tests.assistent.datumFehlt', 'Start und Ende angeben.')
    : startDatum.getTime() < Date.now() - 60_000
      ? t('crm.werbung.tests.assistent.startVergangen', 'Der Start liegt in der Vergangenheit.')
      : tage < TEST_GRENZEN.min_tage || tage > TEST_GRENZEN.max_tage + 1 / 1440
        ? t('crm.werbung.tests.assistent.laufzeitGrenze', 'Laufzeit: {{min}} bis {{max}} Tage.', { min: TEST_GRENZEN.min_tage, max: TEST_GRENZEN.max_tage })
        : !name.trim()
          ? t('crm.werbung.tests.assistent.nameFehlt', 'Gib dem Test einen Namen.')
          : fehlerBudget

  // Warnungen zur Auswahl (Schritt 2) und zur Laufzeit (Schritt 3), alle im Prüfen-Schritt
  const warnungen = useMemo(() => {
    const w: Array<{ art: 'auswahl' | 'dauer'; text: string }> = []
    const gew = gewaehlt.map(id => objekte.find(o => o.id === id)).filter((o): o is NonNullable<typeof o> => !!o)
    if (gew.some(o => !o.aktiv)) {
      w.push({ art: 'auswahl', text: t('crm.werbung.tests.assistent.warnAus', 'Mindestens eine Variante ist aus. Der Test liefert erst aus, wenn du sie im Reiter Kampagnen aktivierst (mit Leitplanken-Prüfung).') })
    }
    if (creativeTest && new Set(gew.map(o => o.adsetId)).size > 1) {
      w.push({ art: 'auswahl', text: t('crm.werbung.tests.assistent.warnGruppen', 'Die Anzeigen liegen in verschiedenen Anzeigengruppen. Für einen sauberen Anzeigen-Test besser alle in dieselbe Anzeigengruppe legen.') })
    }
    if (tage >= TEST_GRENZEN.min_tage && tage < TEST_GRENZEN.empfohlen_tage) {
      w.push({ art: 'dauer', text: t('crm.werbung.tests.assistent.warnKurz', 'Meta empfiehlt mindestens {{n}} Tage, sonst ist das Ergebnis oft nicht belastbar.', { n: TEST_GRENZEN.empfohlen_tage }) })
    }
    if (kennzahl === 'kosten_pro_termin' && tage < 14) {
      w.push({ art: 'dauer', text: t('crm.werbung.tests.assistent.warnTermin', 'Kosten pro Termin braucht viele Termine je Variante. Unter 14 Tagen bleibt es meist bei „zu wenig Daten“.') })
    }
    return w
  }, [gewaehlt, objekte, creativeTest, tage, kennzahl, t])

  const weiterGesperrt = schritt === 2 ? fehler2 : schritt === 3 ? fehler3 : null

  const anfrage = (vorschau: boolean): StudyCreateRequest => ({
    typ,
    name: name.trim(),
    ...(beschreibung.trim() ? { beschreibung: beschreibung.trim() } : {}),
    start: startDatum.toISOString(),
    ende: endeDatum.toISOString(),
    kennzahl,
    zellen,
    ...(creativeTest && budgetArt === 'anteil' ? { testbudget: { anteil_prozent: budgetAnteilZahl } } : {}),
    ...(creativeTest && budgetArt === 'tages' ? { testbudget: { tagesbudget_eur: budgetTagZahl } } : {}),
    ...(vorschau ? { vorschau: true } : {}),
  })

  // Prüfung durch den Server, sobald „Das ändert sich bei Meta" offen ist
  const pruefung = usePruefung(offen && bestaetigen, async () => {
    const r = await steuerungCall('study_create', anfrage(true))
    return {
      zeilen: (r.zellen ?? []).map(z => t('crm.werbung.tests.assistent.pruefZelle', '{{name}}: {{p}} % der Zielgruppe, {{n}} Objekt(e)', { name: z.name, p: z.anteil, n: z.objekte.length })),
      hinweise: r.hinweise ?? [],
    }
  })

  const aenderung: AenderungPunkt[] = [
    { art: 'neu', text: t('crm.werbung.tests.assistent.pNeu', 'Neuer A/B-Test „{{name}}“ ({{typ}}) mit {{n}} Varianten.', { name: name.trim(), typ: typLabel(t, typ), n: zellen.length }) },
    { art: 'gleich', text: t('crm.werbung.tests.assistent.pGleich', 'Texte, Medien, Budgets und Zielgruppen der Varianten bleiben unverändert. Nichts wird gelöscht.') },
    {
      art: 'achtung',
      text: t('crm.werbung.tests.assistent.pAufteilung', 'Meta teilt die Zielgruppe auf: jede Person sieht nur eine Variante. Laufzeit {{von}} bis {{bis}}, Gewinner nach {{k}}.', {
        von: datumKurz(fmt.locale, isoOderNull(startDatum)), bis: datumKurz(fmt.locale, isoOderNull(endeDatum)), k: kennzahlLabel(t, kennzahl),
      }),
    },
    ...(creativeTest ? [{
      art: 'achtung' as const,
      text: budgetArt === 'tages'
        ? t('crm.werbung.tests.assistent.pBudgetTag', 'Testbudget: {{b}} am Tag aus dem vorhandenen Budget.', { b: fmt.eur(budgetTagZahl || 0) })
        : t('crm.werbung.tests.assistent.pBudgetAnteil', 'Testbudget: {{p}} % des vorhandenen Budgets fließen in den Test.', { p: budgetArt === 'anteil' ? budgetAnteilZahl : 20 }),
    }] : []),
  ]

  const anlegen = async () => {
    if (busy || schreibSperre || fehler2 || fehler3 || pruefung.sperre) return
    setBusy(true)
    try {
      await steuerungCall('study_create', anfrage(false))
      toast.success(t('crm.werbung.tests.assistent.erfolg', 'A/B-Test angelegt. Ergebnisse erscheinen, sobald Meta Zahlen hat.'))
      setBestaetigen(false)
      onFertig()
      onClose()
    } catch (err) {
      toast.error(steuerungFehlerText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const schrittTitel: Record<Schritt, string> = {
    1: t('crm.werbung.tests.assistent.s1', 'Variable'),
    2: t('crm.werbung.tests.assistent.s2', 'Varianten'),
    3: t('crm.werbung.tests.assistent.s3', 'Gewinner-Kennzahl und Laufzeit'),
    4: t('crm.werbung.tests.assistent.s4', 'Prüfen'),
  }

  const ebeneText = ebene === 'ad'
    ? t('crm.werbung.tests.assistent.wahlAnzeigen', 'Wähle 2 bis 5 Werbeanzeigen. Jede Anzeige wird eine Variante.')
    : ebene === 'adset'
      ? t('crm.werbung.tests.assistent.wahlGruppen', 'Wähle 2 bis 5 Anzeigengruppen. Jede Gruppe wird eine Variante.')
      : t('crm.werbung.tests.assistent.wahlKampagnen', 'Wähle 2 bis 5 Kampagnen. Jede Kampagne wird eine Variante.')

  const pille = (an: boolean) => `rounded-full border px-3 py-1 text-xs font-medium ${an ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`
  const demografie = gesperrtText(t, { key: 'alter_geschlecht', label: '', grund: '' })

  return (
    <>
      <Modal open={offen && !bestaetigen} onClose={busy ? () => undefined : onClose} size="lg" closeOnBackdrop={false}
        title={(
          <span className="flex flex-col">
            <span>{t('crm.werbung.tests.assistent.titel', 'Neuer A/B-Test')}</span>
            <span className="text-xs font-normal text-gray-500">
              {t('crm.werbung.tests.assistent.schrittVon', 'Schritt {{n}} von 4: {{titel}}', { n: schritt, titel: schrittTitel[schritt] })}
            </span>
          </span>
        )}
        footer={(
          <>
            {schritt > 1 && (
              <button type="button" onClick={() => setSchritt(s => (s - 1) as Schritt)} className="hp-btn hp-btn-ghost sm:mr-auto">
                {t('crm.werbung.tests.zurueck', 'Zurück')}
              </button>
            )}
            <button type="button" onClick={onClose} className="hp-btn hp-btn-ghost">{t('crm.werbung.tests.abbrechen', 'Abbrechen')}</button>
            {schritt < 4 ? (
              <button type="button" onClick={() => setSchritt(s => (s + 1) as Schritt)} disabled={!!weiterGesperrt} className="hp-btn hp-btn-primary">
                {t('crm.werbung.tests.weiter', 'Weiter')}
              </button>
            ) : (
              <button type="button" onClick={() => setBestaetigen(true)} disabled={!!pruefSperre || !!fehler2 || !!fehler3} title={pruefSperre ?? undefined} className="hp-btn hp-btn-primary">
                {t('crm.werbung.tests.assistent.pruefenAnlegen', 'Prüfen und anlegen')}
              </button>
            )}
          </>
        )}>
        <div className="space-y-4">
          {/* Schritt-Leiste */}
          <ol className="flex gap-1" aria-label={t('crm.werbung.tests.assistent.schritte', 'Schritte')}>
            {([1, 2, 3, 4] as const).map(n => (
              <li key={n} aria-current={n === schritt ? 'step' : undefined}
                className={`h-1.5 flex-1 rounded-full ${n <= schritt ? 'bg-hp-navy' : 'bg-gray-200'}`} />
            ))}
          </ol>

          {schritt === 1 && (
            <Abschnitt titel={t('crm.werbung.tests.assistent.s1Titel', 'Was willst du testen?')}
              untertitel={t('crm.werbung.tests.assistent.s1Text', 'Ein A/B-Test vergleicht Varianten, die sich in genau einem Punkt unterscheiden. Meta zeigt jeder Person nur eine Variante.')}
              alleOffen={typ === 'frei'}
              alle={(
                <div className="space-y-4">
                  {typ === 'frei' && (
                    <Einstellung label={t('crm.werbung.tests.assistent.freiEbene', 'Varianten sind')}
                      erklaerung={t('crm.werbung.tests.assistent.freiEbeneText', 'Ganze Kampagnen oder einzelne Anzeigengruppen gegeneinander.')}>
                      <Kacheln name="frei-ebene" wert={freiEbene} onChange={setFreiEbene} optionen={[
                        { wert: 'adset', titel: t('crm.werbung.regeln.ebene.adset', 'Anzeigengruppen'), empfohlen: true },
                        { wert: 'campaign', titel: t('crm.werbung.regeln.ebene.campaign', 'Kampagnen') },
                      ]} />
                    </Einstellung>
                  )}
                  <Einstellung label={t('crm.werbung.tests.assistent.weitereArten', 'Weitere Test-Arten bei Meta')}
                    erklaerung={t('crm.werbung.tests.assistent.weitereArtenText', 'Sichtbar, damit klar ist, warum es sie hier nicht gibt.')}>
                    <ul className="space-y-1.5">
                      {TEST_GESPERRTE_TYPEN.filter(g => g.key !== 'alter_geschlecht').map(g => {
                        const x = gesperrtText(t, g)
                        return (
                          <li key={g.key} className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600 opacity-80">
                            <span className="font-semibold text-gray-700">🔒 {x.label}</span>
                            <span className="block">{x.grund}</span>
                          </li>
                        )
                      })}
                    </ul>
                  </Einstellung>
                </div>
              )}>
              <Kacheln<TestTyp | 'alter_geschlecht'> name="test-typ" wert={typ} spalten={2}
                onChange={v => { if (v !== 'alter_geschlecht') setTyp(v) }}
                optionen={[
                  ...TEST_TYPEN.map(k => ({ wert: k, titel: typLabel(t, k), text: typErklaerung(t, k), empfohlen: k === TEST_TYP_EMPFOHLEN })),
                  { wert: 'alter_geschlecht' as const, titel: demografie.label, gesperrt: demografie.grund },
                ]} />
              {(typ === 'zielgruppe' || typ === 'platzierung') && (
                <Hinweis ton="info">
                  {typ === 'zielgruppe'
                    ? t('crm.werbung.tests.assistent.hinweisZielgruppe', 'Unter Wohnen dürfen sich die Varianten nur in Orten und eigenen Zielgruppen unterscheiden, nie in Alter oder Geschlecht. Tipp: Anzeigengruppe im Reiter Kampagnen duplizieren und bei der Kopie nur die Zielgruppe ändern.')
                    : t('crm.werbung.tests.assistent.hinweisPlatzierung', 'Tipp: Anzeigengruppe im Reiter Kampagnen duplizieren und bei der Kopie nur die Platzierungen ändern.')}
                </Hinweis>
              )}
            </Abschnitt>
          )}

          {schritt === 2 && (
            <Abschnitt titel={t('crm.werbung.tests.assistent.s2Titel', 'Varianten wählen')} untertitel={ebeneText}
              alleOffen={manuell}
              alle={(
                <div className="space-y-4">
                  <Einstellung label={t('crm.werbung.tests.assistent.aufteilung', 'Aufteilung der Zielgruppe')} empfohlen={!manuell}
                    erklaerung={t('crm.werbung.tests.assistent.aufteilungText', 'Gleichmäßig ist am fairsten. Eine eigene Aufteilung nur, wenn eine Variante bewusst weniger Reichweite bekommen soll (mindestens {{n}} % je Variante).', { n: TEST_GRENZEN.min_anteil })}>
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="checkbox" checked={manuell} className="h-4 w-4 rounded border-gray-300 text-hp-navy"
                        onChange={e => {
                          setManuell(e.target.checked)
                          if (e.target.checked) setAnteile(Object.fromEntries(gewaehlt.map((id, i) => [id, gleich + (i < 100 - gleich * gewaehlt.length ? 1 : 0)])))
                        }} />
                      {t('crm.werbung.tests.assistent.manuell', 'Anteile selbst festlegen')}
                    </label>
                  </Einstellung>
                  {gewaehlt.length > 0 && (
                    <div className="space-y-2">
                      {gewaehlt.map((id, i) => (
                        <div key={id} className="grid gap-2 sm:grid-cols-[1fr_7rem]">
                          <label className="block text-xs text-gray-600">
                            {t('crm.werbung.tests.assistent.zellNameLabel', 'Name von Variante {{b}}', { b: BUCHSTABEN[i] ?? i + 1 })}
                            <input value={namen[id] ?? ''} onChange={e => setNamen(n => ({ ...n, [id]: e.target.value }))} maxLength={100}
                              placeholder={zellen[i]?.name} className={`${EINGABE_KLEIN} mt-0.5`} />
                          </label>
                          <label className="block text-xs text-gray-600">
                            {t('crm.werbung.tests.assistent.anteil', 'Anteil in %')}
                            <input type="number" min={TEST_GRENZEN.min_anteil} max={100} step={1} disabled={!manuell} inputMode="numeric"
                              value={manuell ? anteile[id] ?? '' : ''} placeholder={manuell ? '' : t('crm.werbung.tests.assistent.gleichmaessig', 'gleich')}
                              onChange={e => setAnteile(a => ({ ...a, [id]: Math.round(Number(e.target.value) || 0) }))}
                              className={`${EINGABE_KLEIN} mt-0.5 tabular-nums`} />
                          </label>
                        </div>
                      ))}
                      {manuell && (
                        <p className={`text-xs ${fehler2 ? 'font-semibold text-red-700' : 'text-gray-500'}`}>
                          {t('crm.werbung.tests.assistent.summeText', 'Zusammen: {{s}} %', { s: anteilSumme })}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}>
              <ObjektWahl objekte={objekte} gewaehlt={gewaehlt} onChange={ids => {
                setGewaehlt(ids)
                // Neue Variante bei eigener Aufteilung: mit der Mindestgröße vorbelegen
                if (manuell) setAnteile(a => Object.fromEntries(ids.map(id => [id, a[id] ?? TEST_GRENZEN.min_anteil])))
              }} max={TEST_GRENZEN.max_zellen} />
              {gewaehlt.length > 0 && (
                <ul className="space-y-1 text-xs text-gray-600">
                  {zellen.map((z, i) => (
                    <li key={gewaehlt[i]}>• {z.name} <span className="tabular-nums text-gray-400">({manuell ? `${z.anteil ?? 0} %` : t('crm.werbung.tests.assistent.gleichmaessigLang', 'gleichmäßig')})</span></li>
                  ))}
                </ul>
              )}
              {fehler2 && gewaehlt.length > 0 && <Hinweis ton="fehler">{fehler2}</Hinweis>}
              {gewaehlt.length > 0 && warnungen.filter(w => w.art === 'auswahl').map((w, i) => <Hinweis key={i} ton="warnung">{w.text}</Hinweis>)}
            </Abschnitt>
          )}

          {schritt === 3 && (
            <>
              <Abschnitt titel={t('crm.werbung.tests.assistent.kennzahlTitel', 'Gewinner-Kennzahl')}
                untertitel={t('crm.werbung.tests.assistent.kennzahlText', 'Daran misst Meta, welche Variante gewinnt.')}
                alleOffen={kennzahl !== TEST_KENNZAHL_EMPFOHLEN}
                alle={(
                  <Kacheln<TestKennzahl> name="kennzahl-alle" wert={kennzahl} onChange={setKennzahl} spalten={2}
                    optionen={TEST_KENNZAHLEN.filter(k => k !== TEST_KENNZAHL_EMPFOHLEN).map(k => ({ wert: k, titel: kennzahlLabel(t, k), text: kennzahlErklaerung(t, k) }))} />
                )}>
                <Kacheln<TestKennzahl> name="kennzahl" wert={kennzahl} onChange={setKennzahl} spalten={1} optionen={[
                  { wert: TEST_KENNZAHL_EMPFOHLEN, titel: kennzahlLabel(t, TEST_KENNZAHL_EMPFOHLEN), empfohlen: true, text: kennzahlErklaerung(t, TEST_KENNZAHL_EMPFOHLEN) },
                ]} />
                <Hinweis ton="info">
                  {t('crm.werbung.tests.assistent.kQualitaet', 'Meta kennt nur seine eigenen Ergebnisse. Ob aus den Leads Termine und Kunden werden, zeigt der Reiter Qualität.')}
                </Hinweis>
              </Abschnitt>

              <Abschnitt titel={t('crm.werbung.tests.assistent.laufzeitTitel', 'Laufzeit und Name')}
                alleOffen={!!endeManuell || budgetArt !== 'standard'}
                alle={(
                  <div className="space-y-4">
                    <Einstellung fuer="test-ende" label={t('crm.werbung.tests.assistent.ende', 'Ende')}
                      erklaerung={t('crm.werbung.tests.assistent.endeText', 'Statt der Dauer ein festes Ende wählen.')}>
                      <input id="test-ende" type="datetime-local" value={endeManuell ?? (Number.isNaN(endeDatum.getTime()) ? '' : lokal(endeDatum))}
                        onChange={e => setEndeManuell(e.target.value || null)} className={`${EINGABE_KLEIN} sm:max-w-xs`} />
                    </Einstellung>
                    <Einstellung fuer="test-beschreibung" label={t('crm.werbung.tests.assistent.beschreibung', 'Beschreibung (optional)')}
                      erklaerung={t('crm.werbung.tests.assistent.beschreibungText', 'Was du herausfinden willst. Hilft später beim Lesen des Ergebnisses.')}>
                      <textarea id="test-beschreibung" value={beschreibung} maxLength={300} rows={2} onChange={e => setBeschreibung(e.target.value)} className={EINGABE_KLEIN} />
                    </Einstellung>
                    <Einstellung label={t('crm.werbung.tests.assistent.testbudget', 'Testbudget')} empfohlen={creativeTest && budgetArt === 'standard'}
                      erklaerung={t('crm.werbung.tests.assistent.testbudgetText', 'Beim Anzeigen-Test fließt ein Teil des vorhandenen Budgets in den Test. Standard: 20 %.')}
                      gesperrt={creativeTest ? null : t('crm.werbung.tests.assistent.testbudgetGesperrt', 'Nur beim Test der Anzeigengestaltung. Sonst nutzt der Test die Budgets der Varianten.')}>
                      {creativeTest && (
                        <div className="space-y-2">
                          <div className="flex flex-wrap gap-1.5" role="group">
                            {([
                              ['standard', t('crm.werbung.tests.assistent.budgetStandard', 'Standard (20 %)')],
                              ['anteil', t('crm.werbung.tests.assistent.budgetAnteil', 'Eigener Anteil')],
                              ['tages', t('crm.werbung.tests.assistent.budgetTag', 'Festes Tagesbudget')],
                            ] as Array<[BudgetArt, string]>).map(([k, l]) => (
                              <button key={k} type="button" aria-pressed={budgetArt === k} onClick={() => setBudgetArt(k)} className={pille(budgetArt === k)}>{l}</button>
                            ))}
                          </div>
                          {budgetArt === 'anteil' && (
                            <label className="flex items-center gap-2 text-xs text-gray-600">
                              <input value={budgetAnteil} onChange={e => setBudgetAnteil(e.target.value)} inputMode="numeric" className={`${EINGABE_KLEIN} w-20 tabular-nums`} />
                              {t('crm.werbung.tests.assistent.prozentBudget', '% des vorhandenen Budgets')}
                            </label>
                          )}
                          {budgetArt === 'tages' && (
                            <label className="flex items-center gap-2 text-xs text-gray-600">
                              <input value={budgetTag} onChange={e => setBudgetTag(e.target.value)} inputMode="decimal" className={`${EINGABE_KLEIN} w-24 tabular-nums`} />
                              {t('crm.werbung.tests.assistent.euroTag', '€ am Tag (zählt zur Leitplanke)')}
                            </label>
                          )}
                        </div>
                      )}
                    </Einstellung>
                  </div>
                )}>
                <Einstellung fuer="test-start" label={t('crm.werbung.tests.assistent.start', 'Start')}
                  erklaerung={t('crm.werbung.tests.assistent.startText', 'Ab Mitternacht ist sauber: dann zählt jeder Tag voll.')}>
                  <input id="test-start" type="datetime-local" value={start} onChange={e => setStart(e.target.value)} className={`${EINGABE_KLEIN} sm:max-w-xs`} />
                </Einstellung>
                <Einstellung label={t('crm.werbung.tests.assistent.dauer', 'Dauer')} empfohlen={!endeManuell && dauer === 14}
                  erklaerung={t('crm.werbung.tests.assistent.dauerText', 'Meta empfiehlt mindestens 7 Tage. Bei unseren Lead-Zahlen sind 14 Tage verlässlicher, höchstens 30.')}>
                  <div className="flex flex-wrap gap-1.5" role="group">
                    {[7, 14, 21, 30].map(d => (
                      <button key={d} type="button" onClick={() => { setDauer(d); setEndeManuell(null) }} aria-pressed={!endeManuell && dauer === d} className={pille(!endeManuell && dauer === d)}>
                        {t('crm.werbung.tests.assistent.tageN', '{{n}} Tage', { n: d })}
                      </button>
                    ))}
                  </div>
                </Einstellung>
                <Einstellung fuer="test-name" label={t('crm.werbung.tests.assistent.name', 'Testname')}
                  erklaerung={t('crm.werbung.tests.assistent.nameText', 'So erscheint der Test bei Meta unter Experiments.')}>
                  <input id="test-name" value={name} maxLength={200} onChange={e => { setName(e.target.value); setNameAngepasst(true) }} className={EINGABE_KLEIN} />
                </Einstellung>
                {fehler3 && <Hinweis ton="fehler">{fehler3}</Hinweis>}
                {!fehler3 && warnungen.filter(w => w.art === 'dauer').map((w, i) => <Hinweis key={i} ton="warnung">{w.text}</Hinweis>)}
              </Abschnitt>
            </>
          )}

          {schritt === 4 && (
            <section className="space-y-3">
              <dl className="grid gap-x-4 gap-y-2 rounded-xl border border-gray-200 bg-white p-4 text-sm sm:grid-cols-[10rem_1fr]">
                <dt className="text-gray-500">{t('crm.werbung.tests.assistent.name', 'Testname')}</dt>
                <dd className="font-medium text-gray-800">{name.trim()}</dd>
                <dt className="text-gray-500">{t('crm.werbung.tests.assistent.s1', 'Variable')}</dt>
                <dd className="text-gray-800">{typLabel(t, typ)}</dd>
                <dt className="text-gray-500">{t('crm.werbung.tests.assistent.s2', 'Varianten')}</dt>
                <dd className="text-gray-800">
                  <ul className="space-y-0.5">
                    {zellen.map((z, i) => <li key={gewaehlt[i]}>{z.name} <span className="text-gray-400">({manuell ? `${z.anteil ?? 0} %` : t('crm.werbung.tests.assistent.gleichmaessigLang', 'gleichmäßig')})</span></li>)}
                  </ul>
                </dd>
                <dt className="text-gray-500">{t('crm.werbung.tests.assistent.kennzahlTitel', 'Gewinner-Kennzahl')}</dt>
                <dd className="text-gray-800">{kennzahlLabel(t, kennzahl)}</dd>
                <dt className="text-gray-500">{t('crm.werbung.tests.assistent.laufzeit', 'Laufzeit')}</dt>
                <dd className="text-gray-800">
                  {zeitKurz(fmt.locale, isoOderNull(startDatum))} - {zeitKurz(fmt.locale, isoOderNull(endeDatum))}
                  <span className="text-gray-400"> ({t('crm.werbung.tests.assistent.tageN', '{{n}} Tage', { n: Math.round(tage) })})</span>
                </dd>
              </dl>
              {(fehler2 || fehler3) && <Hinweis ton="fehler">{fehler2 ?? fehler3}</Hinweis>}
              {warnungen.map((w, i) => <Hinweis key={i} ton="warnung">{w.text}</Hinweis>)}
              <SchreibSperre grund={schreibSperre} />
            </section>
          )}
        </div>
      </Modal>

      <MetaAenderungDialog offen={offen && bestaetigen} onClose={() => setBestaetigen(false)} busy={busy}
        punkte={aenderung}
        lernphase={t('crm.werbung.tests.assistent.lernphase', 'Die Varianten selbst ändern sich nicht. Weil Meta die Zielgruppe aufteilt, kann die Auslieferung neu lernen (Lernphase möglich), vor allem in den ersten Tagen.')}
        warnungen={warnungen.map(w => w.text)}
        gesperrt={schreibSperre ?? pruefung.sperre}
        bestaetigen={t('crm.werbung.tests.assistent.anlegen', 'A/B-Test anlegen')}
        onBestaetigen={() => void anlegen()}
        zusatz={(
          <>
            {pruefung.box}
            {busy && <p className="flex items-center gap-2 text-xs text-gray-500"><Spinner size="sm" />{t('crm.werbung.tests.wirdGesendet', 'Wird an Meta gesendet …')}</p>}
          </>
        )} />
    </>
  )
}
