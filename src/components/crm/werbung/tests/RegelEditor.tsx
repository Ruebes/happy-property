import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  REGEL_AKTIONEN, REGEL_FELDER, REGEL_GESPERRTE_AKTIONEN, REGEL_GRENZEN, REGEL_ZEITRAEUME, REGEL_ZEITRAUM_EMPFOHLEN,
  type GesperrteOption, type RegelAktion, type RegelBedingung, type RegelBudgetAenderung, type RegelFeld, type RegelFeldInfo,
  type RegelFilter, type RegelOperator, type RegelZeitfenster, type RegelZeitplan, type RegelZeitraum, type RuleCreateRequest,
  type SteuerungEbene,
} from '../../../../lib/werbeSteuerung'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { useWerbeKontext } from '../useWerbeDaten'
import {
  Abschnitt, EINGABE_KLEIN, Einstellung, Haken, Hinweis, Kacheln, MetaAenderungDialog, SchreibSperre, type AenderungPunkt,
} from '../zielgruppen/Bausteine'
import ObjektWahl from './ObjektWahl'
import { wahlObjekte } from './objekte'
import { steuerungCall, steuerungFehlerText } from './steuerungApi'
import {
  aktionErklaerung, aktionLabel, bedingungText, budgetText, ebeneLabel, feldErklaerung, feldLabel, filterZusatz, geltungText,
  operatorLabel, zahlAusEingabe, zahlFuerEingabe, zeitplanLabel, zeitraumLabel,
} from './texte'
import { usePruefung } from './usePruefung'

// ── Editor „Neue Regel" (Meta: Automatisierte Regeln > Regel erstellen) ──────
// Abschnitte wie bei Meta: Regel anwenden auf, Aktion, Bedingungen (mit
// Zeitrahmen), Zeitplan. Oben jeweils das Wichtigste mit HP-Empfehlung,
// Feinheiten unter „Alle Einstellungen". Geld in Euro (der Server rechnet in
// die Kontowährung um). Was Ausgaben erhöhen kann (Aktivieren, Budget erhöhen),
// darf nur ein Admin, nur für ausgewählte Objekte und mit Obergrenze. Neue
// Regeln starten ausgeschaltet, außer „sofort einschalten" ist gesetzt. Vor dem
// Anlegen prüft der Server den Auftrag (vorschau: true), dann rule_create.

type FilterArt = 'alle' | 'ausgewaehlt' | 'name'

interface BedingungZeile {
  feld: RegelFeld
  operator: RegelOperator
  wert: string
  bis: string
}

export interface RegelStartwerte {
  /** Vorlagen-Schlüssel (nur fürs Protokoll) */
  key?: string
  titel?: string
  anfrage: RuleCreateRequest
}

export interface RegelInfo {
  felder: readonly RegelFeldInfo[]
  gesperrte: readonly GesperrteOption[]
  empfaenger: Array<{ id: string; name: string }>
}

const TAGE = [1, 2, 3, 4, 5, 6, 0] as const
const OPERATOREN: readonly RegelOperator[] = ['groesser', 'kleiner', 'zwischen', 'nicht_zwischen']
const istBereich = (op: RegelOperator) => op === 'zwischen' || op === 'nicht_zwischen'

const zeile = (b: RegelBedingung, locale: string): BedingungZeile => ({
  feld: b.feld,
  operator: b.operator,
  wert: zahlFuerEingabe(Array.isArray(b.wert) ? b.wert[0] : b.wert, locale),
  bis: Array.isArray(b.wert) ? zahlFuerEingabe(b.wert[1], locale) : '',
})
const minutenText = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const uhrzeit = (m: number) => (m === 1440 ? '24:00' : minutenText(m))
/** Ein Zeitfenster lässt sich mit Tagen + von/bis (halbstündlich) im Editor abbilden */
const fensterEinfach = (z: RegelZeitfenster): boolean => z.tage.length > 0 && z.von_minute != null && z.bis_minute != null &&
  z.von_minute % 30 === 0 && z.bis_minute % 30 === 0 && z.von_minute < z.bis_minute

/** Gesperrte Meta-Aktionen mit übersetzbarem Text */
function gesperrtText(t: TFunction, g: GesperrteOption): { label: string; grund: string } {
  const m: Record<string, { label: string; grund: string }> = {
    gebot_anpassen: {
      label: t('crm.werbung.regeln.gesperrt.gebot_anpassen.label', 'Manuelles Gebot anpassen'),
      grund: t('crm.werbung.regeln.gesperrt.gebot_anpassen.grund', 'Happy Property nutzt keine manuellen Gebote; Gebotsänderungen starten zudem die Lernphase neu.'),
    },
    umkreis_erweitern: {
      label: t('crm.werbung.regeln.gesperrt.umkreis_erweitern.label', 'Umkreis erweitern'),
      grund: t('crm.werbung.regeln.gesperrt.umkreis_erweitern.grund', 'Ändert die Zielgruppe. Unter der Sonderkategorie Wohnen ist das nicht erlaubt.'),
    },
    interessen_lockern: {
      label: t('crm.werbung.regeln.gesperrt.interessen_lockern.label', 'Interessen lockern'),
      grund: t('crm.werbung.regeln.gesperrt.interessen_lockern.grund', 'Ändert die Zielgruppe. Unter der Sonderkategorie Wohnen ist das nicht erlaubt.'),
    },
    budget_umverteilen: {
      label: t('crm.werbung.regeln.gesperrt.budget_umverteilen.label', 'Budget umverteilen'),
      grund: t('crm.werbung.regeln.gesperrt.budget_umverteilen.grund', 'Pausiert Anzeigengruppen und verschiebt Budget ohne CRM-Leitplanke. Das übernimmt bei uns der Autopilot.'),
    },
    anzeigen_rotieren: {
      label: t('crm.werbung.regeln.gesperrt.anzeigen_rotieren.label', 'Werbeanzeigen rotieren'),
      grund: t('crm.werbung.regeln.gesperrt.anzeigen_rotieren.grund', 'Meta kennt keine Termine. Der Autopilot tauscht Werbemittel nach CRM-Qualität.'),
    },
  }
  return m[g.key] ?? { label: g.label, grund: g.grund }
}

export default function RegelEditor({ offen, start, info, onClose, onFertig, schreibSperre, pruefSperre, istAdmin }: {
  offen: boolean
  /** Vorbelegung (Vorlage oder Kopie einer Regel), sonst leer mit HP-Empfehlung */
  start: RegelStartwerte | null
  /** Felder, gesperrte Aktionen, Empfänger aus dem Modus vorlagen (sonst die Konstanten) */
  info: RegelInfo | null
  onClose: () => void
  onFertig: () => void
  schreibSperre: string | null
  /** Prüfen (vorschau) braucht nur das Recht Werbung; Anlegen zusätzlich die Freischaltung */
  pruefSperre: string | null
  istAdmin: boolean
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const fmt = useWerbeFormat()
  const { catalog, byAd, byAdset, byCampaign } = useWerbeKontext()

  const [name, setName] = useState('')
  const [ebene, setEbene] = useState<SteuerungEbene>('ad')
  const [filterArt, setFilterArt] = useState<FilterArt>('alle')
  const [ids, setIds] = useState<string[]>([])
  const [nameEnthaelt, setNameEnthaelt] = useState('')
  const [kampagnenname, setKampagnenname] = useState('')
  // Teile des Filters einer kopierten Regel, die der Editor nicht einzeln zeigt (Kampagnen-/Gruppen-IDs,
  // Name neben festen IDs, Kampagnenname auf Kampagnen-Ebene): werden sichtbar mitgeschickt
  const [festFilter, setFestFilter] = useState<RegelFilter>({})
  // Zeitfenster einer kopierten Regel, die der Editor nicht abbilden kann: gelten, bis neu festgelegt
  const [festFenster, setFestFenster] = useState<RegelZeitfenster[] | null>(null)
  const [aktion, setAktion] = useState<RegelAktion>('nur_benachrichtigen')
  const [budgetArt, setBudgetArt] = useState<RegelBudgetAenderung['art']>('prozent')
  const [richtung, setRichtung] = useState<'senken' | 'erhoehen'>('senken')
  const [budgetWert, setBudgetWert] = useState('20')
  const [grenze, setGrenze] = useState(String(REGEL_GRENZEN.budget_untergrenze_eur))
  const [maxAusf, setMaxAusf] = useState('')
  const [abstand, setAbstand] = useState(String(REGEL_GRENZEN.standard_mindestabstand_stunden))
  const [bedingungen, setBedingungen] = useState<BedingungZeile[]>([])
  const [zeitraum, setZeitraum] = useState<RegelZeitraum>(REGEL_ZEITRAUM_EMPFOHLEN)
  const [zeitplan, setZeitplan] = useState<RegelZeitplan>('taeglich')
  const [tage, setTage] = useState<number[]>([1, 2, 3, 4, 5])
  const [von, setVon] = useState(8 * 60)
  const [bis, setBis] = useState(20 * 60)
  const [empfaenger, setEmpfaenger] = useState<string[]>([])
  const [aktivieren, setAktivieren] = useState(false)
  const [bestaetigen, setBestaetigen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Beim Öffnen: Vorlage oder Kopie übernehmen, sonst HP-Standard (Hinweis bei Ausgaben ohne Ergebnis)
  useEffect(() => {
    if (!offen) return
    const r = start?.anfrage
    const f = r?.filter
    const loc = fmt.locale
    const ebene0 = r?.ebene ?? 'ad'
    const art: FilterArt = f?.ids?.length ? 'ausgewaehlt' : f?.name_enthaelt ? 'name' : 'alle'
    const kampagnennameSichtbar = art !== 'ausgewaehlt' && ebene0 !== 'campaign'
    setName(r?.name ?? '')
    setEbene(ebene0)
    setFilterArt(art)
    setIds(f?.ids ?? [])
    setNameEnthaelt(art === 'name' ? f?.name_enthaelt ?? '' : '')
    setKampagnenname(kampagnennameSichtbar ? f?.kampagnenname_enthaelt ?? '' : '')
    setFestFilter({
      ...(f?.kampagnen_ids?.length ? { kampagnen_ids: f.kampagnen_ids } : {}),
      ...(f?.anzeigengruppen_ids?.length ? { anzeigengruppen_ids: f.anzeigengruppen_ids } : {}),
      ...(art === 'ausgewaehlt' && f?.name_enthaelt ? { name_enthaelt: f.name_enthaelt } : {}),
      ...(!kampagnennameSichtbar && f?.kampagnenname_enthaelt ? { kampagnenname_enthaelt: f.kampagnenname_enthaelt } : {}),
    })
    setAktion(r?.aktion ?? 'nur_benachrichtigen')
    const b = r?.aktion_wert
    setBudgetArt(b?.art ?? 'prozent')
    setRichtung((b?.wert ?? -1) > 0 ? 'erhoehen' : 'senken')
    setBudgetWert(zahlFuerEingabe(Math.abs(b?.wert ?? 20), loc))
    setGrenze(b?.grenze_eur != null ? zahlFuerEingabe(b.grenze_eur, loc) : (b?.wert ?? -1) > 0 ? '' : String(REGEL_GRENZEN.budget_untergrenze_eur))
    setMaxAusf(b?.max_ausfuehrungen != null ? String(b.max_ausfuehrungen) : '')
    setAbstand(String(b?.mindestabstand_stunden ?? REGEL_GRENZEN.standard_mindestabstand_stunden))
    setBedingungen(r ? r.bedingungen.map(x => zeile(x, loc)) : [
      { feld: 'spent', operator: 'groesser', wert: '100', bis: '' },
      { feld: 'results', operator: 'kleiner', wert: '1', bis: '' },
    ])
    setZeitraum(r?.zeitraum ?? REGEL_ZEITRAUM_EMPFOHLEN)
    setZeitplan(r?.zeitplan ?? 'taeglich')
    const alleFenster = r?.zeitplan_eigen ?? []
    const fenster = alleFenster.length === 1 && fensterEinfach(alleFenster[0]) ? alleFenster[0] : undefined
    setFestFenster(r?.zeitplan === 'eigen' && alleFenster.length && !fenster ? alleFenster : null)
    setTage(fenster?.tage ?? [1, 2, 3, 4, 5])
    setVon(fenster?.von_minute ?? 8 * 60)
    setBis(fenster?.bis_minute ?? 20 * 60)
    setEmpfaenger(r?.empfaenger_ids ?? [])
    setAktivieren(false)
    setBestaetigen(false)
    setBusy(false)
  }, [offen, start, fmt.locale])

  const felder = info?.felder?.length ? info.felder : REGEL_FELDER
  const gesperrte = info?.gesperrte?.length ? info.gesperrte : REGEL_GESPERRTE_AKTIONEN
  const felderEbene = felder.filter(f => f.ebenen.includes(ebene))
  const objekte = useMemo(() => wahlObjekte(catalog, ebene, { byAd, byAdset, byCampaign }), [catalog, ebene, byAd, byAdset, byCampaign])

  // Budget gibt es nur bei Anzeigengruppe oder Kampagne
  useEffect(() => { if (ebene === 'ad' && aktion === 'budget_aendern') setAktion('nur_benachrichtigen') }, [ebene, aktion])

  const riskant = aktion === 'unpause' || (aktion === 'budget_aendern' && richtung === 'erhoehen')
  // Was Ausgaben erhöhen kann, gilt nur für ausgewählte Objekte
  useEffect(() => { if (riskant) setFilterArt('ausgewaehlt') }, [riskant])
  const zahlAus = (s: string) => zahlAusEingabe(s, fmt.locale)
  const wertZahl = zahlAus(budgetWert)
  const grenzeZahl = zahlAus(grenze)
  const maxAusfZahl = zahlAus(maxAusf)
  const abstandZahl = zahlAus(abstand)

  const budget: RegelBudgetAenderung | undefined = aktion !== 'budget_aendern' || wertZahl == null ? undefined : {
    art: budgetArt,
    wert: (richtung === 'senken' ? -1 : 1) * Math.abs(wertZahl),
    ...(grenzeZahl != null ? { grenze_eur: grenzeZahl } : {}),
    ...(maxAusfZahl != null ? { max_ausfuehrungen: Math.round(maxAusfZahl) } : {}),
    ...(abstandZahl != null ? { mindestabstand_stunden: Math.round(abstandZahl) } : {}),
  }

  const geprueft: RegelBedingung[] = bedingungen.flatMap((b): RegelBedingung[] => {
    const w = zahlAus(b.wert)
    if (w == null) return []
    if (istBereich(b.operator)) {
      const w2 = zahlAus(b.bis)
      return w2 == null ? [] : [{ feld: b.feld, operator: b.operator, wert: [Math.min(w, w2), Math.max(w, w2)] }]
    }
    return [{ feld: b.feld, operator: b.operator, wert: w }]
  })

  const budgetFehler = (): string | null => {
    if (aktion !== 'budget_aendern') return null
    if (wertZahl == null || wertZahl <= 0) return t('crm.werbung.regeln.editor.fBudgetWert', 'Gib an, um wie viel das Budget geändert wird.')
    if (budgetArt === 'prozent' && richtung === 'senken' && wertZahl > REGEL_GRENZEN.max_senkung_prozent) {
      return t('crm.werbung.regeln.editor.fSenken', 'Höchstens {{n}} % senken.', { n: REGEL_GRENZEN.max_senkung_prozent })
    }
    if (budgetArt === 'prozent' && richtung === 'erhoehen' && wertZahl > REGEL_GRENZEN.max_erhoehung_prozent) {
      return t('crm.werbung.regeln.editor.fErhoehenProzent', 'Höchstens {{n}} % je Schritt erhöhen.', { n: REGEL_GRENZEN.max_erhoehung_prozent })
    }
    if (budgetArt === 'betrag' && richtung === 'erhoehen' && wertZahl > REGEL_GRENZEN.max_erhoehung_eur) {
      return t('crm.werbung.regeln.editor.fErhoehenEur', 'Höchstens {{n}} € je Schritt erhöhen.', { n: REGEL_GRENZEN.max_erhoehung_eur })
    }
    const minAbstand = richtung === 'erhoehen' ? REGEL_GRENZEN.min_mindestabstand_erhoehen_stunden : 1
    if (abstandZahl == null || !Number.isInteger(abstandZahl) || abstandZahl < minAbstand || abstandZahl > 720) {
      return t('crm.werbung.regeln.editor.fAbstandBereich', 'Mindestabstand: ganze Stunden von {{min}} bis 720.', { min: minAbstand })
    }
    if (richtung === 'senken' && grenzeZahl != null && grenzeZahl <= 0) return t('crm.werbung.regeln.editor.fUntergrenze', 'Die Untergrenze muss über 0 € liegen.')
    if (richtung === 'erhoehen') {
      if (grenzeZahl == null || grenzeZahl <= 0) return t('crm.werbung.regeln.editor.fObergrenze', 'Beim Erhöhen ist eine Obergrenze für das Tagesbudget Pflicht.')
      if (maxAusfZahl == null || maxAusfZahl < 1 || maxAusfZahl > REGEL_GRENZEN.max_ausfuehrungen) {
        return t('crm.werbung.regeln.editor.fMaxAusf', 'Beim Erhöhen: wie oft je Objekt höchstens (1 bis {{n}}).', { n: REGEL_GRENZEN.max_ausfuehrungen })
      }
    }
    return null
  }

  const fehler: string | null = !name.trim()
    ? t('crm.werbung.regeln.editor.fRegelname', 'Gib der Regel einen Namen.')
    : riskant && !istAdmin
      ? t('crm.werbung.regeln.editor.fAdmin', 'Aktivieren und Budget erhöhen per Meta-Regel darf nur ein Admin (Sven), weil es Ausgaben erhöht.')
      : riskant && filterArt !== 'ausgewaehlt'
        ? t('crm.werbung.regeln.editor.fRiskantIds', 'Aktivieren und Budget erhöhen nur für ausgewählte Objekte, nie für alle.')
        : filterArt === 'ausgewaehlt' && ids.length === 0
          ? t('crm.werbung.regeln.editor.fIds', 'Wähle mindestens ein Objekt aus oder nimm „Alle aktiven“.')
          : filterArt === 'name' && !nameEnthaelt.trim()
            ? t('crm.werbung.regeln.editor.fName', 'Gib an, was im Namen stehen soll.')
            : festFilter.anzeigengruppen_ids?.length && ebene !== 'ad'
            ? t('crm.werbung.regeln.editor.fFestGruppen', 'Die übernommene Einschränkung auf Anzeigengruppen geht nur, wenn die Regel für Werbeanzeigen gilt. Ebene zurückstellen oder die Einschränkung entfernen.')
            : bedingungen.some(b => !felderEbene.some(f => f.feld === b.feld))
            ? t('crm.werbung.regeln.editor.fFeldEbene', 'Mindestens eine Kennzahl gibt es auf dieser Ebene nicht. Bitte eine andere wählen.')
            : bedingungen.length === 0
              ? t('crm.werbung.regeln.editor.fKeine', 'Mindestens eine Bedingung ist nötig.')
              : geprueft.length !== bedingungen.length
                ? t('crm.werbung.regeln.editor.fWert', 'Jede Bedingung braucht eine Zahl (bei „zwischen“ zwei).')
                : geprueft.some(b => (Array.isArray(b.wert) ? b.wert[0] : b.wert) < 0)
                  ? t('crm.werbung.regeln.editor.fNegativ', 'Werte dürfen nicht negativ sein.')
                  : geprueft.some(b => Array.isArray(b.wert) && b.wert[0] === b.wert[1])
                    ? t('crm.werbung.regeln.editor.fBereich', 'Bei „zwischen“ muss „bis“ größer als „von“ sein.')
                    : geprueft.some(b => b.operator === 'kleiner' && b.wert === 0)
                      ? t('crm.werbung.regeln.editor.fKleinerNull', '„Kleiner als 0“ trifft nie zu. Für „keine“ bitte „kleiner als 1“.')
                      : new Set(geprueft.map(b => `${b.feld}|${b.operator}`)).size !== geprueft.length
                        ? t('crm.werbung.regeln.editor.fDoppelt', 'Eine Bedingung steht doppelt (gleiche Kennzahl und gleicher Vergleich).')
                        : budgetFehler() ?? (zeitplan === 'eigen' && !festFenster && (tage.length === 0 || von >= bis)
                    ? t('crm.werbung.regeln.editor.fZeitplan', 'Benutzerdefiniert: mindestens einen Tag wählen, „von“ vor „bis“.')
                    : null)

  const warnungen = useMemo(() => {
    const w: string[] = []
    if (aktion === 'unpause') w.push(t('crm.werbung.regeln.editor.wAktivieren', 'Aktivieren per Meta-Regel erhöht Ausgaben. Der Server prüft dabei die Tages-Leitplanke des Werbekontos, nur für ausgewählte Objekte.'))
    if (aktion === 'budget_aendern' && richtung === 'erhoehen') w.push(t('crm.werbung.regeln.editor.wErhoehen', 'Budget erhöhen per Meta-Regel sieht keine CRM-Qualität. Skalieren besser über den Autopiloten.'))
    if (aktion === 'budget_aendern' && budgetArt === 'prozent' && (wertZahl ?? 0) > REGEL_GRENZEN.lernphase_prozent) {
      w.push(t('crm.werbung.regeln.editor.wLernphase', 'Mehr als {{n}} % Budget-Änderung kann die Lernphase neu starten.', { n: REGEL_GRENZEN.lernphase_prozent }))
    }
    if (filterArt === 'alle' && Object.keys(festFilter).length === 0 && (aktion === 'pause' || aktion === 'budget_aendern')) {
      w.push(t('crm.werbung.regeln.editor.wAlle', 'Die Regel wirkt auf alle aktiven {{objekte}} im Werbekonto, auch auf neue.', { objekte: ebeneLabel(t, ebene) }))
    }
    if (aktion === 'pause' && geprueft.some(b => felder.find(f => f.feld === b.feld)?.kosten)) {
      w.push(t('crm.werbung.regeln.editor.wKosten', 'Meta lehnt Kosten-Bedingungen bei Regeln, die ausschalten, manchmal ab. Dann besser Ausgaben und Ergebnisse kombinieren.'))
    }
    if (aktion !== 'nur_benachrichtigen') w.push(t('crm.werbung.regeln.editor.wAutopilot', 'Der Autopilot kann dieselben Objekte steuern. Die Meta-Regel wirkt zusätzlich und sieht keine CRM-Qualität.'))
    return w
  }, [aktion, richtung, budgetArt, wertZahl, filterArt, festFilter, ebene, geprueft, felder, t])

  // Gesendeter Filter: Übernommenes aus einer Kopie plus die Eingaben. Der Kampagnenname zählt
  // nur, solange sein Feld sichtbar ist (nicht bei Ausgewählten, nicht auf Kampagnen-Ebene).
  const filter: RegelFilter = {
    ...festFilter,
    ...(filterArt === 'ausgewaehlt'
      ? { ids }
      : {
        ...(filterArt === 'name' && nameEnthaelt.trim() ? { name_enthaelt: nameEnthaelt.trim() } : {}),
        ...(ebene !== 'campaign' && kampagnenname.trim() ? { kampagnenname_enthaelt: kampagnenname.trim() } : {}),
      }),
  }

  const anfrage = (vorschau: boolean): RuleCreateRequest => {
    return {
      name: name.trim(),
      ebene,
      ...(Object.keys(filter).length ? { filter } : {}),
      bedingungen: geprueft,
      zeitraum,
      aktion,
      ...(budget ? { aktion_wert: budget } : {}),
      zeitplan,
      ...(zeitplan === 'eigen' ? { zeitplan_eigen: festFenster ?? [{ tage: [...tage].sort((a, b) => a - b), von_minute: von, bis_minute: bis }] } : {}),
      ...(empfaenger.length ? { empfaenger_ids: empfaenger } : {}),
      ...(aktivieren ? { aktivieren: true } : {}),
      ...(start?.key ? { vorlage: start.key } : {}),
      ...(vorschau ? { vorschau: true } : {}),
    }
  }

  const pruefung = usePruefung(offen && bestaetigen, async () => {
    const r = await steuerungCall('rule_create', anfrage(true))
    return { zeilen: r.zusammenfassung ?? [], hinweise: r.hinweise ?? [] }
  })

  const geltung = geltungText(t, ebene, filter)
  const aktionText = aktion === 'budget_aendern' ? budgetText(t, fmt.locale, budget) : aktionLabel(t, aktion, ebene)

  const punkte: AenderungPunkt[] = [
    { art: 'neu', text: t('crm.werbung.regeln.editor.pNeu', 'Neue automatisierte Regel „{{name}}“ bei Meta.', { name: name.trim() }) },
    { art: 'neu', text: t('crm.werbung.regeln.editor.pWenn', 'Wenn {{bed}} ({{zeitraum}})', { bed: geprueft.map(b => bedingungText(t, fmt.locale, b)).join(t('crm.werbung.regeln.und', ' und ')), zeitraum: zeitraumLabel(t, zeitraum) }) },
    { art: aktion === 'nur_benachrichtigen' ? 'neu' : 'achtung', text: t('crm.werbung.regeln.editor.pDann', 'Dann: {{aktion}} für {{filter}}.', { aktion: aktionText, filter: geltung }) },
    { art: 'neu', text: t('crm.werbung.regeln.editor.pZeitplan', 'Zeitplan: {{z}}', { z: zeitplanLabel(t, zeitplan) }) },
    aktivieren
      ? { art: 'achtung', text: t('crm.werbung.regeln.editor.pAktiv', 'Die Regel ist sofort eingeschaltet.') }
      : { art: 'gleich', text: t('crm.werbung.regeln.editor.pAus', 'Die Regel startet ausgeschaltet. Einschalten in der Liste, wenn alles passt.') },
    { art: 'gleich', text: t('crm.werbung.regeln.editor.pGleich', 'Zielgruppen und Orte ändert die Regel nie (Wohnen-sicher). Nichts wird gelöscht.') },
  ]

  const lernphase = aktion === 'nur_benachrichtigen'
    ? t('crm.werbung.regeln.editor.lNur', 'Startet nicht neu: die Regel schickt nur eine Nachricht.')
    : aktion === 'budget_aendern'
      ? t('crm.werbung.regeln.editor.lBudget', 'Erst wenn die Bedingungen zutreffen. Budget-Änderungen über 20 % können die Lernphase neu starten.')
      : t('crm.werbung.regeln.editor.lStatus', 'Erst wenn die Bedingungen zutreffen. Pausieren stoppt die Auslieferung; nach dem Wieder-Aktivieren kann die Lernphase neu starten.')

  const anlegen = async () => {
    if (busy || schreibSperre || fehler || pruefung.sperre) return
    setBusy(true)
    try {
      const r = await steuerungCall('rule_create', anfrage(false))
      toast.success(r.status === 'ENABLED'
        ? t('crm.werbung.regeln.editor.erfolgAktiv', 'Regel bei Meta angelegt und eingeschaltet.')
        : t('crm.werbung.regeln.editor.erfolg', 'Regel bei Meta angelegt (ausgeschaltet).'))
      setBestaetigen(false)
      onFertig()
      onClose()
    } catch (err) {
      toast.error(steuerungFehlerText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const setzeBedingung = (i: number, patch: Partial<BedingungZeile>) => setBedingungen(bs => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)))
  const einheit = (feld: string) => {
    const e = felder.find(f => f.feld === feld)?.einheit
    return e === 'eur' ? '€' : e === 'prozent' ? '%' : e === 'stunden' ? 'h' : ''
  }
  const pille = (an: boolean) => `rounded-full border px-3 py-1 text-xs font-medium ${an ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`
  const riskantGrund = istAdmin ? null : t('crm.werbung.regeln.editor.nurAdmin', 'Nur Admin (Sven): erhöht Ausgaben.')
  const tagKurz = (d: number) => new Date(Date.UTC(2026, 0, 4 + d)).toLocaleDateString(fmt.locale, { weekday: 'short', timeZone: 'UTC' })
  const fensterText = (z: RegelZeitfenster): string => {
    const tageText = z.tage.length ? [...z.tage].sort((a, b) => a - b).map(tagKurz).join(', ') : t('crm.werbung.regeln.editor.fensterJedenTag', 'jeden Tag')
    const zeit = z.von_minute == null
      ? t('crm.werbung.regeln.editor.fensterGanztags', 'ganztags, halbstündlich')
      : z.bis_minute == null || z.bis_minute === z.von_minute
        ? t('crm.werbung.regeln.editor.fensterUm', 'um {{zeit}}', { zeit: uhrzeit(z.von_minute) })
        : t('crm.werbung.regeln.editor.fensterVonBis', '{{von}} bis {{bis}}', { von: uhrzeit(z.von_minute), bis: uhrzeit(z.bis_minute) })
    return `${tageText} ${zeit}`
  }

  return (
    <>
      <Modal open={offen && !bestaetigen} onClose={onClose} size="lg" closeOnBackdrop={false}
        title={start?.titel ? t('crm.werbung.regeln.editor.titelVorlage', 'Regel aus Vorlage: {{name}}', { name: start.titel }) : t('crm.werbung.regeln.editor.titel', 'Neue Regel')}
        footer={(
          <>
            <button type="button" onClick={onClose} className="hp-btn hp-btn-ghost">{t('crm.werbung.tests.abbrechen', 'Abbrechen')}</button>
            <button type="button" onClick={() => setBestaetigen(true)} disabled={!!fehler || !!pruefSperre} title={pruefSperre ?? undefined} className="hp-btn hp-btn-primary">
              {t('crm.werbung.regeln.editor.weiter', 'Prüfen und anlegen')}
            </button>
          </>
        )}>
        <div className="space-y-4">
          <SchreibSperre grund={schreibSperre} />
          <Einstellung fuer="regel-name" label={t('crm.werbung.regeln.editor.name', 'Regelname')}
            erklaerung={t('crm.werbung.regeln.editor.nameText', 'So erscheint die Regel bei Meta unter „Regeln verwalten“.')}>
            <input id="regel-name" value={name} maxLength={100} onChange={e => setName(e.target.value)} className={EINGABE_KLEIN} />
          </Einstellung>

          {/* 1. Anwenden auf */}
          <Abschnitt nummer={1} titel={t('crm.werbung.regeln.editor.anwenden', 'Regel anwenden auf')}
            alleOffen={filterArt !== 'alle' || !!kampagnenname}
            alle={(
              <div className="space-y-4">
                <Einstellung label={t('crm.werbung.regeln.editor.filter', 'Welche davon')}
                  erklaerung={t('crm.werbung.regeln.editor.filterText', 'Alle aktiven ist am einfachsten. Ausgewählte oder ein Namensteil, wenn die Regel nur für eine Kampagne gelten soll.')}>
                  <Kacheln<FilterArt> name="regel-filter" wert={filterArt} onChange={setFilterArt} spalten={3} optionen={[
                    { wert: 'alle', titel: t('crm.werbung.regeln.editor.fAlle', 'Alle aktiven'), empfohlen: !riskant, gesperrt: riskant ? t('crm.werbung.regeln.editor.alleGesperrt', 'Nicht bei Aktionen, die Ausgaben erhöhen.') : null },
                    { wert: 'ausgewaehlt', titel: t('crm.werbung.regeln.editor.fAusgewaehlt', 'Ausgewählte'), empfohlen: riskant },
                    { wert: 'name', titel: t('crm.werbung.regeln.editor.fNameEnthaelt', 'Name enthält'), gesperrt: riskant ? t('crm.werbung.regeln.editor.alleGesperrt', 'Nicht bei Aktionen, die Ausgaben erhöhen.') : null },
                  ]} />
                  {filterArt === 'ausgewaehlt' && <div className="mt-2"><ObjektWahl objekte={objekte} gewaehlt={ids} onChange={setIds} max={REGEL_GRENZEN.max_ids} /></div>}
                  {filterArt === 'name' && (
                    <input value={nameEnthaelt} onChange={e => setNameEnthaelt(e.target.value)} maxLength={100}
                      placeholder={t('crm.werbung.regeln.editor.nameBeispiel', 'z. B. Plan-B')} aria-label={t('crm.werbung.regeln.editor.fNameEnthaelt', 'Name enthält')}
                      className={`${EINGABE_KLEIN} mt-2 sm:max-w-xs`} />
                  )}
                </Einstellung>
                {filterArt !== 'ausgewaehlt' && ebene !== 'campaign' && (
                  <Einstellung fuer="regel-kampagnenname" label={t('crm.werbung.regeln.editor.kampagnenname', 'Nur in Kampagnen, deren Name enthält')}
                    erklaerung={t('crm.werbung.regeln.editor.kampagnennameText', 'Optional. Grenzt die Regel auf bestimmte Kampagnen ein, z. B. nur Plan-B.')}>
                    <input id="regel-kampagnenname" value={kampagnenname} onChange={e => setKampagnenname(e.target.value)} maxLength={100} className={`${EINGABE_KLEIN} sm:max-w-xs`} />
                  </Einstellung>
                )}
              </div>
            )}>
            <Kacheln<SteuerungEbene> name="regel-ebene" wert={ebene} onChange={v => { setEbene(v); setIds([]) }} spalten={3} optionen={[
              { wert: 'ad', titel: ebeneLabel(t, 'ad'), empfohlen: true, text: t('crm.werbung.regeln.editor.eAd', 'Einzelne Anzeigen, z. B. eine teure abschalten.') },
              { wert: 'adset', titel: ebeneLabel(t, 'adset'), text: t('crm.werbung.regeln.editor.eAdset', 'Ganze Gruppen, auch Budget anpassen.') },
              { wert: 'campaign', titel: ebeneLabel(t, 'campaign'), text: t('crm.werbung.regeln.editor.eCampaign', 'Ganze Kampagnen.') },
            ]} />
            <p className="text-xs text-gray-500">{t('crm.werbung.regeln.editor.wirktAuf', 'Wirkt auf: {{filter}}', { filter: geltung })}</p>
            {filterZusatz(t, festFilter).length > 0 && (
              <Hinweis ton="info">
                {t('crm.werbung.regeln.editor.festFilter', 'Aus der kopierten Regel übernommen und mitgeschickt: {{text}}.', { text: filterZusatz(t, festFilter).join(', ') })}
                {' '}
                <button type="button" onClick={() => setFestFilter({})} className="font-semibold text-hp-navy underline">
                  {t('crm.werbung.regeln.editor.festFilterWeg', 'Einschränkung entfernen')}
                </button>
              </Hinweis>
            )}
          </Abschnitt>

          {/* 2. Aktion */}
          <Abschnitt nummer={2} titel={t('crm.werbung.regeln.editor.aktion', 'Aktion')}
            untertitel={t('crm.werbung.regeln.editor.aktionText', 'Was Meta tut, wenn alle Bedingungen zutreffen.')}
            alleOffen={aktion === 'budget_aendern' && richtung === 'erhoehen'}
            alle={(
              <div className="space-y-4">
                <Einstellung label={t('crm.werbung.regeln.editor.empfaenger', 'Benachrichtigung an')}
                  erklaerung={t('crm.werbung.regeln.editor.empfaengerText', 'Ohne Auswahl meldet Meta nur dem System-Nutzer des CRM. Die Meldungen stehen auch im Verlauf.')}>
                  {(info?.empfaenger ?? []).length === 0 ? (
                    <p className="text-xs text-gray-500">{t('crm.werbung.regeln.editor.keineEmpfaenger', 'Meta hat keine Nutzer des Werbekontos geliefert.')}</p>
                  ) : (
                    <div className="space-y-1">
                      {(info?.empfaenger ?? []).map(p => (
                        <Haken key={p.id} checked={empfaenger.includes(p.id)} label={p.name}
                          onChange={an => setEmpfaenger(e => (an ? [...e, p.id] : e.filter(x => x !== p.id)))} />
                      ))}
                    </div>
                  )}
                </Einstellung>
                {aktion === 'budget_aendern' && (
                  <>
                    <Einstellung fuer="regel-abstand" label={t('crm.werbung.regeln.editor.abstand', 'Mindestabstand je Objekt (Stunden)')}
                      erklaerung={t('crm.werbung.regeln.editor.abstandText', 'Schützt die Lernphase: dasselbe Budget wird höchstens so oft geändert. Standard 72 Stunden.')}>
                      <input id="regel-abstand" value={abstand} onChange={e => setAbstand(e.target.value)} inputMode="numeric" className={`${EINGABE_KLEIN} w-24 tabular-nums`} />
                    </Einstellung>
                    <Einstellung fuer="regel-maxausf" label={t('crm.werbung.regeln.editor.maxAusf', 'Höchstens so oft je Objekt')}
                      erklaerung={richtung === 'erhoehen'
                        ? t('crm.werbung.regeln.editor.maxAusfPflicht', 'Pflicht beim Erhöhen, damit das Budget nicht immer weiter wächst.')
                        : t('crm.werbung.regeln.editor.maxAusfText', 'Optional. Leer = ohne Grenze.')}>
                      <input id="regel-maxausf" value={maxAusf} onChange={e => setMaxAusf(e.target.value)} inputMode="numeric" className={`${EINGABE_KLEIN} w-24 tabular-nums`} />
                    </Einstellung>
                  </>
                )}
                <Einstellung label={t('crm.werbung.regeln.editor.gesperrteTitel', 'Weitere Aktionen bei Meta')}
                  erklaerung={t('crm.werbung.regeln.editor.gesperrteText', 'Sichtbar, damit klar ist, warum es sie hier nicht gibt.')}>
                  <ul className="space-y-1.5">
                    {gesperrte.map(g => {
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
            <Kacheln<RegelAktion> name="regel-aktion" wert={aktion} spalten={2} onChange={setAktion}
              optionen={REGEL_AKTIONEN.map(a => ({
                wert: a,
                titel: aktionLabel(t, a, a === 'pause' || a === 'unpause' ? ebene : null),
                text: aktionErklaerung(t, a),
                empfohlen: a === 'nur_benachrichtigen' || a === 'pause',
                gesperrt: a === 'budget_aendern' && ebene === 'ad'
                  ? t('crm.werbung.regeln.editor.aBudgetAd', 'Budgets liegen bei Anzeigengruppe oder Kampagne, nicht bei der einzelnen Werbeanzeige.')
                  : a === 'unpause' ? riskantGrund : null,
              }))} />
            {gesperrte.length > 0 && (
              <p className="rounded-md bg-gray-50 px-2 py-1 text-xs leading-snug text-gray-600">
                🔒 {t('crm.werbung.regeln.editor.gesperrtKurz', 'Bei Meta gibt es noch: {{liste}}. Hier gesperrt, Gründe unter „Alle Einstellungen“.', { liste: gesperrte.map(g => gesperrtText(t, g).label).join(', ') })}
              </p>
            )}
            {aktion === 'budget_aendern' && (
              <div className="space-y-2 rounded-lg border border-gray-200 p-3">
                <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('crm.werbung.regeln.editor.richtung', 'Richtung')}>
                  <button type="button" aria-pressed={richtung === 'senken'} className={pille(richtung === 'senken')}
                    onClick={() => { if (richtung !== 'senken') { setRichtung('senken'); setGrenze(String(REGEL_GRENZEN.budget_untergrenze_eur)) } }}>
                    {t('crm.werbung.regeln.editor.senken', 'Senken')}
                  </button>
                  <button type="button" aria-pressed={richtung === 'erhoehen'} disabled={!istAdmin} title={riskantGrund ?? undefined}
                    onClick={() => { if (richtung !== 'erhoehen') { setRichtung('erhoehen'); setGrenze('') } }}
                    className={`${pille(richtung === 'erhoehen')} disabled:cursor-not-allowed disabled:opacity-50`}>
                    {istAdmin ? t('crm.werbung.regeln.editor.erhoehen', 'Erhöhen') : `🔒 ${t('crm.werbung.regeln.editor.erhoehenAdmin', 'Erhöhen (nur Admin)')}`}
                  </button>
                  <span className="mx-1 w-px self-stretch bg-gray-200" aria-hidden="true" />
                  <button type="button" aria-pressed={budgetArt === 'prozent'} onClick={() => setBudgetArt('prozent')} className={pille(budgetArt === 'prozent')}>%</button>
                  <button type="button" aria-pressed={budgetArt === 'betrag'} onClick={() => setBudgetArt('betrag')} className={pille(budgetArt === 'betrag')}>€</button>
                </div>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="text-xs text-gray-600">
                    {budgetArt === 'prozent' ? t('crm.werbung.regeln.editor.umProzent', 'um %') : t('crm.werbung.regeln.editor.umEuro', 'um €')}
                    <input value={budgetWert} onChange={e => setBudgetWert(e.target.value)} inputMode="decimal" className={`${EINGABE_KLEIN} mt-0.5 w-24 tabular-nums`} />
                  </label>
                  <label className="text-xs text-gray-600">
                    {richtung === 'senken' ? t('crm.werbung.regeln.editor.untergrenze', 'nicht unter (€ am Tag)') : t('crm.werbung.regeln.editor.obergrenze', 'höchstens (€ am Tag)')}
                    <input value={grenze} onChange={e => setGrenze(e.target.value)} inputMode="decimal" className={`${EINGABE_KLEIN} mt-0.5 w-28 tabular-nums`} />
                  </label>
                </div>
                <p className="text-xs text-gray-500">{t('crm.werbung.regeln.editor.budgetEmpf', 'Empfohlen für Happy Property: 20 % senken, nicht unter 30 € am Tag.')}</p>
              </div>
            )}
          </Abschnitt>

          {/* 3. Bedingungen */}
          <Abschnitt nummer={3} titel={t('crm.werbung.regeln.editor.bedingungen', 'Bedingungen')}
            untertitel={t('crm.werbung.regeln.editor.bedingungenText', 'Alle Bedingungen müssen gleichzeitig zutreffen.')}
            alle={(
              <ul className="space-y-1 text-xs text-gray-600">
                {felderEbene.map(f => <li key={f.feld}><span className="font-semibold text-gray-700">{feldLabel(t, f.feld)}:</span> {feldErklaerung(t, f.feld)}</li>)}
              </ul>
            )}>
            <div className="space-y-2">
              {bedingungen.map((b, i) => (
                <div key={i} className="grid gap-2 rounded-lg border border-gray-200 p-2 sm:grid-cols-[1fr_9rem_1fr_auto] sm:items-center">
                  <select value={b.feld} onChange={e => setzeBedingung(i, { feld: e.target.value as RegelFeld })} className={EINGABE_KLEIN}
                    aria-label={t('crm.werbung.regeln.editor.feld', 'Kennzahl')}>
                    {!felderEbene.some(f => f.feld === b.feld) && <option value={b.feld} disabled>{feldLabel(t, b.feld)}</option>}
                    <optgroup label={t('crm.werbung.regeln.editor.wichtig', 'Das Wichtigste')}>
                      {felderEbene.filter(f => f.wichtig).map(f => <option key={f.feld} value={f.feld}>{feldLabel(t, f.feld)}</option>)}
                    </optgroup>
                    <optgroup label={t('crm.werbung.regeln.editor.weitere', 'Weitere Kennzahlen')}>
                      {felderEbene.filter(f => !f.wichtig).map(f => <option key={f.feld} value={f.feld}>{feldLabel(t, f.feld)}</option>)}
                    </optgroup>
                  </select>
                  <select value={b.operator} onChange={e => setzeBedingung(i, { operator: e.target.value as RegelOperator })} className={EINGABE_KLEIN}
                    aria-label={t('crm.werbung.regeln.editor.operator', 'Vergleich')}>
                    {OPERATOREN.map(o => <option key={o} value={o}>{operatorLabel(t, o)}</option>)}
                  </select>
                  <div className="flex items-center gap-1">
                    <input value={b.wert} onChange={e => setzeBedingung(i, { wert: e.target.value })} inputMode="decimal"
                      aria-label={t('crm.werbung.regeln.editor.wert', 'Wert')} className={`${EINGABE_KLEIN} tabular-nums`} />
                    {istBereich(b.operator) && (
                      <>
                        <span className="text-xs text-gray-500">{t('crm.werbung.regeln.editor.und', 'und')}</span>
                        <input value={b.bis} onChange={e => setzeBedingung(i, { bis: e.target.value })} inputMode="decimal"
                          aria-label={t('crm.werbung.regeln.editor.bis', 'bis')} className={`${EINGABE_KLEIN} tabular-nums`} />
                      </>
                    )}
                    {einheit(b.feld) && <span className="shrink-0 text-xs text-gray-500">{einheit(b.feld)}</span>}
                  </div>
                  <button type="button" onClick={() => setBedingungen(bs => bs.filter((_, j) => j !== i))} disabled={bedingungen.length <= 1}
                    aria-label={t('crm.werbung.regeln.editor.entfernen', 'Bedingung entfernen')}
                    className="hp-btn hp-btn-ghost min-h-0 px-2 py-1 text-xs">✕</button>
                  {feldErklaerung(t, b.feld) && <p className="text-[11px] leading-snug text-gray-500 sm:col-span-4">{feldErklaerung(t, b.feld)}</p>}
                  {!felderEbene.some(f => f.feld === b.feld) && (
                    <p className="text-[11px] text-red-700 sm:col-span-4">{t('crm.werbung.regeln.editor.feldEbene', 'Diese Kennzahl gibt es auf dieser Ebene nicht.')}</p>
                  )}
                </div>
              ))}
              <button type="button" onClick={() => setBedingungen(bs => [...bs, { feld: 'frequency', operator: 'groesser', wert: '', bis: '' }])}
                disabled={bedingungen.length >= REGEL_GRENZEN.max_bedingungen} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
                + {t('crm.werbung.regeln.editor.neueBedingung', 'Bedingung hinzufügen')}
              </button>
            </div>
            <Einstellung fuer="regel-zeitraum" label={t('crm.werbung.regeln.editor.zeitrahmen', 'Zeitrahmen')} empfohlen={zeitraum === REGEL_ZEITRAUM_EMPFOHLEN}
              erklaerung={t('crm.werbung.regeln.editor.zeitrahmenText', 'Über welchen Zeitraum Meta die Zahlen zusammenzählt. 7 Tage glätten Ausreißer einzelner Tage.')}>
              <select id="regel-zeitraum" value={zeitraum} onChange={e => setZeitraum(e.target.value as RegelZeitraum)} className={`${EINGABE_KLEIN} sm:max-w-xs`}>
                {REGEL_ZEITRAEUME.map(z => <option key={z} value={z}>{zeitraumLabel(t, z)}</option>)}
              </select>
            </Einstellung>
          </Abschnitt>

          {/* 4. Zeitplan */}
          <Abschnitt nummer={4} titel={t('crm.werbung.regeln.editor.zeitplan', 'Zeitplan')}
            untertitel={t('crm.werbung.regeln.editor.zeitplanText', 'Wann Meta die Bedingungen prüft.')}
            alleOffen={zeitplan === 'eigen'}
            alle={(
              <div className="space-y-2">
                <Kacheln<RegelZeitplan> name="regel-zeitplan-eigen" wert={zeitplan} onChange={setZeitplan} spalten={1} optionen={[
                  { wert: 'eigen', titel: zeitplanLabel(t, 'eigen'), text: t('crm.werbung.regeln.editor.zEigen', 'Nur an bestimmten Wochentagen und Uhrzeiten (halbstündlich wählbar).') },
                ]} />
                {zeitplan === 'eigen' && festFenster && (
                  <Hinweis ton="info">
                    {t('crm.werbung.regeln.editor.festFenster', 'Zeitplan aus der kopierten Regel, wird so mitgeschickt: {{text}}.', { text: festFenster.map(fensterText).join('; ') })}
                    {' '}
                    <button type="button" onClick={() => setFestFenster(null)} className="font-semibold text-hp-navy underline">
                      {t('crm.werbung.regeln.editor.festFensterNeu', 'Zeitplan neu festlegen')}
                    </button>
                  </Hinweis>
                )}
                {zeitplan === 'eigen' && !festFenster && (
                  <>
                    <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('crm.werbung.regeln.editor.tage', 'Tage')}>
                      {TAGE.map(d => {
                        const an = tage.includes(d)
                        const label = tagKurz(d)
                        return (
                          <button key={d} type="button" aria-pressed={an} onClick={() => setTage(ts => (an ? ts.filter(x => x !== d) : [...ts, d]))} className={pille(an)}>
                            {label}
                          </button>
                        )
                      })}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                      <label>{t('crm.werbung.regeln.editor.von', 'von')}
                        <select value={von} onChange={e => setVon(Number(e.target.value))} className={`${EINGABE_KLEIN} ml-1 w-auto`}>
                          {Array.from({ length: 48 }, (_, i) => i * 30).map(m => <option key={m} value={m}>{minutenText(m)}</option>)}
                        </select>
                      </label>
                      <label>{t('crm.werbung.regeln.editor.bisZeit', 'bis')}
                        <select value={bis} onChange={e => setBis(Number(e.target.value))} className={`${EINGABE_KLEIN} ml-1 w-auto`}>
                          {Array.from({ length: 48 }, (_, i) => (i + 1) * 30).map(m => <option key={m} value={m}>{m === 1440 ? '24:00' : minutenText(m)}</option>)}
                        </select>
                      </label>
                      <span>{t('crm.werbung.regeln.editor.kontozeit', 'Zeitzone des Werbekontos')}</span>
                    </div>
                  </>
                )}
              </div>
            )}>
            <Kacheln<RegelZeitplan> name="regel-zeitplan" wert={zeitplan} onChange={setZeitplan} spalten={2} optionen={[
              { wert: 'laufend', titel: zeitplanLabel(t, 'laufend'), empfohlen: aktion === 'pause',
                text: t('crm.werbung.regeln.editor.zLaufend', 'Meta prüft etwa alle 30 Minuten. Richtig für eine Notbremse.') },
              { wert: 'taeglich', titel: zeitplanLabel(t, 'taeglich'), empfohlen: aktion !== 'pause',
                text: t('crm.werbung.regeln.editor.zTaeglich', 'Meta prüft einmal am Tag um Mitternacht (Zeitzone des Werbekontos). Richtig für Hinweise und Budget.') },
            ]} />
          </Abschnitt>

          <Haken checked={aktivieren} onChange={setAktivieren} disabled={riskant && !istAdmin}
            label={t('crm.werbung.regeln.editor.aktivieren', 'Regel sofort einschalten')}
            hilfe={t('crm.werbung.regeln.editor.aktivierenText', 'Empfohlen: aus lassen, die Regel in der Liste ansehen und dann einschalten. Wie bei Kampagnen startet alles erst einmal aus.')} />

          <Hinweis ton="info">
            {t('crm.werbung.regeln.editor.wohnen', 'Regeln ändern nie Zielgruppe oder Orte. Damit bleiben sie unter der Sonderkategorie Wohnen erlaubt.')}
          </Hinweis>
          {fehler && <Hinweis ton="fehler">{fehler}</Hinweis>}
          {!fehler && warnungen.map((w, i) => <Hinweis key={i} ton="warnung">{w}</Hinweis>)}
        </div>
      </Modal>

      <MetaAenderungDialog offen={offen && bestaetigen} onClose={() => setBestaetigen(false)} busy={busy}
        gesperrt={schreibSperre ?? fehler ?? pruefung.sperre}
        punkte={punkte} lernphase={lernphase} warnungen={warnungen}
        bestaetigen={t('crm.werbung.regeln.editor.anlegen', 'Regel anlegen')}
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
