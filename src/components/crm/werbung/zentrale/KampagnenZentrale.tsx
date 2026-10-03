import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { useAuth } from '../../../../lib/auth'
import type { AdAction } from '../../../../lib/crmTypes'
import type { ActionItem } from '../../../ui/ActionMenu'
import { useConfirm } from '../../../ui/ConfirmDialog'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { dbFehlerText } from '../autopilot/werbeTexte'
import { USD_PRO_EUR_FALLBACK } from '../felder'
import { useWerbeFormat } from '../format'
import { fehlerText } from '../kampagnen/builderApi'
import DuplizierenDialog from '../kampagnen/DuplizierenDialog'
import MassenDialog from '../kampagnen/MassenDialog'
import { ladeUsdProEur, useWerbeKontext } from '../useWerbeDaten'
import { anzeigenVormerken, ebenenSchalten, warteschlangeAnstossen, type BulkErgebnis, type Schaltziel } from './aktionen'
import {
  ladeAnsichten, ladeKennzahlen, ladeZuletzt, neueId, speichereAnsichten, speichereKennzahlen, speichereZuletzt,
  type Ansicht, type Sortierung, type StatusFilter, type ZentraleEbene,
} from './ansichten'
import AufschluesselungDialog, { type AufschluesselungZiel } from './AufschluesselungDialog'
import EmpfehlungenDialog from './EmpfehlungenDialog'
import { alleKnoten, baueBaum, knotenDerEbene, knotenKey } from './baum'
import { berichteFehlerText, ladeInsights, ladeStatus } from './berichteApi'
import { baueCsv, csvEinheit, csvId, csvZahl, ladeCsvHerunter, type CsvZelle } from './csv'
import { ebeneLabel, textWert, veraenderung } from './darstellung'
import { ladeSpiegel } from './spiegel'
import SpaltenDialog from './SpaltenDialog'
import {
  addiere, brauchtMeta, EIGEN_PREFIX, felderFuer, formatVon, kompiliereEigene, presetVon, PRESETS, SPALTE, wertVon,
  type EigeneKennzahl,
} from './spalten'
import { auslieferungVon, istAn } from './status'
import type { BerichtFelder, Ebene, Knoten, LiveStatus, Spiegel, Vergleich, Werte, ZeitraumWahl } from './typen'
import VerlaufDialog, { type VerlaufZiel } from './VerlaufDialog'
import ZentraleTabelle, { type Zeile } from './ZentraleTabelle'
import ZeitraumDialog from './ZeitraumDialog'
import { aktuellerZeitraum, effektiverVergleich, VERGLEICH_AUS, zeitraumText } from './zeitraum'

// ── Kampagnen-Zentrale (Plan B, Werbemanager Meta-Parität) ───────────────────
// Eine Tabelle Kampagne > Anzeigengruppe > Werbeanzeige wie bei Meta, aber
// übersichtlicher: Auslieferung inkl. Lernphase, Budget, Ergebnisse, Kosten pro
// Ergebnis und CRM-Qualität in einer Zeile. Spalten-Voreinstellungen, Spalten
// anpassen, eigene Kennzahlen, gespeicherte Ansichten (Browser), freier
// Zeitraum + Vergleich, Filter, Suche, Aufschlüsselung, „Welche Variante
// gewinnt", CSV-Export, Verlauf und Auswahl mit Werkzeugleiste.
//
// Daten: Aggregate aus useWerbeKontext() (Datenbank, sofort), Spiegeltabellen
// (seriell, nach dem Laden der Seite), Meta-Zahlen und Live-Status nur auf
// Knopfdruck über meta-berichte, Abrufe strikt nacheinander.

interface Props {
  /** Offene Aktionen je Anzeige (Warteschlange aus dem Statistik-Reiter) */
  pendingByAd: Map<string, AdAction>
}

interface MetaDaten {
  sig: string
  felder: BerichtFelder
  werte: Map<string, Werte>
  vergleich: Map<string, Werte> | null
  stand: string | null
  cached: boolean
  unvollstaendig: boolean
  veraltet: boolean
  hinweise: string[]
}

type MassenItem = { level: Ebene; id: string; name: string; daily_budget_cents?: number | null; status?: string | null }

const LEERE_KARTE = new Map<string, Werte>()
const EBENEN: Ebene[] = ['campaign', 'adset', 'ad']

export default function KampagnenZentrale({ pendingByAd }: Props) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const confirm = useConfirm()
  const { profile } = useAuth()
  const [, setSearch] = useSearchParams()
  const {
    segment, days, loading, catalog, byAd, byAdset, byCampaign, campaignsSorted, crmVisible,
    fetchAll, openPreview, openSettings, showToast, setActions, settings,
  } = useWerbeKontext()

  // ── Ansicht (Spalten, Ebene, Filter, Sortierung) ───────────────────────────
  const [start] = useState(() => ladeZuletzt())
  const [preset, setPreset] = useState<string>(start?.preset ?? 'leistung')
  const [spalten, setSpalten] = useState<string[]>(start?.spalten?.length ? start.spalten : PRESETS[0].spalten)
  const [ebene, setEbene] = useState<ZentraleEbene>(start?.ebene ?? 'baum')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(start?.status ?? 'alle')
  const [nurMitAusgaben, setNurMitAusgaben] = useState<boolean>(start?.nurMitAusgaben ?? false)
  const [suche, setSuche] = useState('')
  const [sort, setSort] = useState<Sortierung | null>(start?.sort ?? null)
  const [ansichten, setAnsichten] = useState<Ansicht[]>(() => ladeAnsichten())
  const [ansichtId, setAnsichtId] = useState('')
  const [kennzahlen, setKennzahlen] = useState<EigeneKennzahl[]>(() => ladeKennzahlen())
  const eigene = useMemo(() => kompiliereEigene(kennzahlen), [kennzahlen])

  useEffect(() => {
    speichereZuletzt({ id: 'zuletzt', name: '', preset, spalten, ebene, status: statusFilter, nurMitAusgaben, suche: '', sort })
  }, [preset, spalten, ebene, statusFilter, nurMitAusgaben, sort])

  const [offen, setOffen] = useState<Set<string>>(new Set())
  const [auswahl, setAuswahl] = useState<Set<string>>(new Set())
  useEffect(() => { setAuswahl(new Set()); setOffen(new Set()) }, [segment])

  // ── Zeitraum + Vergleich ────────────────────────────────────────────────────
  const [zeitraum, setZeitraum] = useState<ZeitraumWahl>({ art: 'kopf' })
  const [vergleich, setVergleich] = useState<Vergleich>(VERGLEICH_AUS)
  const [zeitraumOffen, setZeitraumOffen] = useState(false)
  const bereich = aktuellerZeitraum(zeitraum, days)
  const vglBereich = effektiverVergleich(vergleich, bereich)
  const sig = `${bereich.since}|${bereich.until}|${vglBereich ? `${vglBereich.since}|${vglBereich.until}` : '-'}`

  // ── Spiegel + Kurs (Datenbank, seriell, nach dem Laden der Seitendaten) ─────
  const [spiegel, setSpiegel] = useState<Spiegel | null>(null)
  const [kurs, setKurs] = useState<number>(USD_PRO_EUR_FALLBACK)
  const spiegelLauf = useRef(0)
  const spiegelNeu = useCallback(async () => {
    const nr = ++spiegelLauf.current
    try {
      const s = await ladeSpiegel(segment)
      if (nr === spiegelLauf.current) setSpiegel(s)
    } catch (err) {
      console.warn('[Zentrale] Spiegel:', err)
    }
  }, [segment])
  useEffect(() => {
    if (loading) return
    void (async () => {
      await spiegelNeu()
      const k = await ladeUsdProEur()
      if (k) setKurs(k)
    })()
  }, [loading, catalog, spiegelNeu])

  // ── Live-Status von Meta (auf Knopfdruck) ───────────────────────────────────
  const [live, setLive] = useState<Map<string, LiveStatus>>(new Map())
  const [liveStand, setLiveStand] = useState<string | null>(null)
  const [liveLaedt, setLiveLaedt] = useState(false)

  // ── Meta-Zahlen (auf Knopfdruck bzw. nach „Aktualisieren" im Zeitraum) ─────
  const [metaDaten, setMetaDaten] = useState<MetaDaten | null>(null)
  const [metaLaedt, setMetaLaedt] = useState<string | null>(null)
  const [metaFehler, setMetaFehler] = useState<string | null>(null)

  const sichtbareSpalten = useMemo(() => spalten.filter(k => {
    if (k.startsWith(EIGEN_PREFIX)) return eigene.has(k)
    const d = SPALTE.get(k)
    return !!d && (crmVisible || d.quelle !== 'crm')
  }), [spalten, eigene, crmVisible])

  const felder = felderFuer(sichtbareSpalten, preset)
  const metaPasst = metaDaten?.sig === sig
  const spaltenBrauchenMeta = sichtbareSpalten.some(k => brauchtMeta(k, eigene))
  const metaNoetig = zeitraum.art === 'frei' || vergleich.an || spaltenBrauchenMeta
  const felderFehlen = metaPasst && felder !== 'standard' && metaDaten?.felder !== felder
  const metaKarte: Map<string, Werte> | null = metaPasst && metaDaten ? metaDaten.werte : zeitraum.art === 'frei' ? LEERE_KARTE : null
  const vergleichKarte = metaPasst && vergleich.an ? metaDaten?.vergleich ?? null : null

  // Lauf-Zähler: ein neuer Abruf (z. B. anderer Zeitraum) überholt den alten;
  // der alte bricht nach seinem laufenden Aufruf ab und fasst den Zustand nicht an
  const metaLauf = useRef(0)
  const metaLaden = useCallback(async (z: ZeitraumWahl, v: Vergleich, frisch = false) => {
    const nr = ++metaLauf.current
    const aktuell = () => nr === metaLauf.current
    const b = aktuellerZeitraum(z, days)
    const cmp = effektiverVergleich(v, b) ?? undefined
    const s = `${b.since}|${b.until}|${cmp ? `${cmp.since}|${cmp.until}` : '-'}`
    const werte = new Map<string, Werte>()
    const vgl = cmp ? new Map<string, Werte>() : null
    let stand: string | null = null
    let cached = true
    let unvollstaendig = false
    let veraltet = false
    const hinweise = new Set<string>()
    setMetaFehler(null)
    try {
      for (let i = 0; i < EBENEN.length; i++) {
        if (!aktuell()) return
        const level = EBENEN[i]
        setMetaLaedt(t('crm.werbung.zentrale.meta.laedtEbene', 'Hole {{ebene}} von Meta ({{i}} von 3) …', { ebene: ebeneLabel(level, t, true), i: i + 1 }))
        const r = await ladeInsights({
          level, since: b.since, until: b.until, compare: cmp, felder, time_increment: 'all_days', ...(frisch ? { frisch: true } : {}),
        }, kurs)
        if (!aktuell()) return
        for (const z2 of r.rows) {
          if (!z2.id) continue
          const key = knotenKey(level, z2.id)
          werte.set(key, addiere(werte.get(key) ?? {}, z2.werte))
        }
        if (vgl) {
          for (const z2 of r.compare_rows ?? []) {
            if (!z2.id) continue
            const key = knotenKey(level, z2.id)
            vgl.set(key, addiere(vgl.get(key) ?? {}, z2.werte))
          }
        }
        if (r.fetched_at && (!stand || r.fetched_at < stand)) stand = r.fetched_at
        cached = cached && r.cached
        unvollstaendig = unvollstaendig || r.unvollstaendig
        veraltet = veraltet || r.veraltet
        for (const h of r.hinweise) hinweise.add(h)
      }
      if (aktuell()) setMetaDaten({ sig: s, felder, werte, vergleich: vgl, stand, cached, unvollstaendig, veraltet, hinweise: [...hinweise].slice(0, 5) })
    } catch (err) {
      if (aktuell()) setMetaFehler(berichteFehlerText(err, t))
    } finally {
      if (aktuell()) setMetaLaedt(null)
    }
  }, [days, felder, kurs, t])

  const zeitraumAnwenden = (z: ZeitraumWahl, v: Vergleich) => {
    setZeitraum(z)
    setVergleich(v)
    setZeitraumOffen(false)
    if (z.art === 'frei' || v.an) void metaLaden(z, v)
  }

  // ── Baum ────────────────────────────────────────────────────────────────────
  const frischSeit = useMemo(() => new Date(Date.now() - 30 * 86_400_000).toISOString(), [])
  // CRM-Zahlen gibt es nur für den Zeitraum oben. Bei freiem Zeitraum bleiben die
  // CRM-Spalten leer, sonst teilten Kosten pro Termin & Co. Zahlen zweier Zeiträume.
  const crmImBaum = crmVisible && zeitraum.art !== 'frei'
  const baum = useMemo(() => baueBaum({
    catalog, reihenfolge: campaignsSorted.map(([id]) => id), byCampaign, byAdset, byAd,
    crm: crmImBaum, spiegel, live, meta: metaKarte, frischSeit,
  }), [catalog, campaignsSorted, byCampaign, byAdset, byAd, crmImBaum, spiegel, live, metaKarte, frischSeit])

  const alle = useMemo(() => alleKnoten(baum), [baum])
  const knotenNachKey = useMemo(() => new Map(alle.map(k => [k.key, k])), [alle])
  const catalogNachId = useMemo(() => new Map(catalog.map(c => [c.ad_id, c])), [catalog])

  const herkunft = useCallback((k: Knoten): string => {
    const kn = knotenNachKey.get(knotenKey('campaign', k.campaignId))?.name ?? k.campaignId
    if (k.level === 'ad' && k.adsetId) {
      const gn = knotenNachKey.get(knotenKey('adset', k.adsetId))?.name ?? k.adsetId
      return `${kn} › ${gn}`
    }
    return kn
  }, [knotenNachKey])

  // ── Filter, Suche, Sortierung ──────────────────────────────────────────────
  const sucheNorm = suche.trim().toLowerCase()
  const filterAktiv = !!sucheNorm || statusFilter !== 'alle' || nurMitAusgaben

  const { zeilen, summenKnoten } = useMemo(() => {
    const passtStatus = (k: Knoten) => statusFilter === 'alle' || auslieferungVon(k).kategorie === statusFilter
    const passtAusgaben = (k: Knoten) => !nurMitAusgaben || (k.werte.ausgaben ?? 0) > 0
    const passtSuche = (k: Knoten) => !sucheNorm || k.name.toLowerCase().includes(sucheNorm) || k.id.includes(sucheNorm)
    const eigenTreffer = (k: Knoten, vt: boolean) => (vt ? passtStatus(k) && passtAusgaben(k) : passtSuche(k) && passtStatus(k) && passtAusgaben(k))

    const cache = new Map<string, boolean>()
    const treffer = (k: Knoten, vt: boolean): boolean => {
      if (!filterAktiv) return true
      const ck = `${k.key}|${vt ? 1 : 0}`
      const c = cache.get(ck)
      if (c !== undefined) return c
      const eigen = eigenTreffer(k, vt)
      const nvt = vt || (eigen && !!sucheNorm)
      const r = eigen || k.kinder.some(x => treffer(x, nvt))
      cache.set(ck, r)
      return r
    }

    const zahl = (k: Knoten, key: string) => wertVon(key, k.werte, eigene)
    const sortiere = (ks: Knoten[]): Knoten[] => {
      if (!sort) return ks
      const f = sort.ab ? -1 : 1
      if (sort.key === 'name') return [...ks].sort((a, b) => f * a.name.localeCompare(b.name, fmt.locale))
      if (formatVon(sort.key, eigene) === 'text') {
        return [...ks].sort((a, b) => f * textWert(a, sort.key, kurs, t, fmt).localeCompare(textWert(b, sort.key, kurs, t, fmt), fmt.locale))
      }
      return [...ks].sort((a, b) => {
        const x = zahl(a, sort.key), y = zahl(b, sort.key)
        if (x == null && y == null) return 0
        if (x == null) return 1
        if (y == null) return -1
        return f * (x - y)
      })
    }

    const out: Zeile[] = []
    const summe: Knoten[] = []
    if (ebene === 'baum') {
      const lauf = (ks: Knoten[], tiefe: number, vt: boolean, gezaehlt: boolean) => {
        for (const k of sortiere(ks.filter(x => treffer(x, vt)))) {
          const eigen = !filterAktiv || eigenTreffer(k, vt)
          const nvt = vt || (eigen && !!sucheNorm)
          const kinder = k.kinder.filter(x => treffer(x, nvt))
          const autoOffen = filterAktiv && !eigen && kinder.length > 0
          const istOffen = kinder.length > 0 && (offen.has(k.key) || autoOffen)
          out.push({ k, tiefe, kinder: kinder.length, offen: istOffen, gedimmt: filterAktiv && !eigen })
          const zaehlt = eigen && !gezaehlt
          if (zaehlt) summe.push(k)
          if (istOffen) lauf(kinder, tiefe + 1, nvt, gezaehlt || zaehlt)
        }
      }
      lauf(baum, 0, false, false)
    } else {
      for (const k of sortiere(knotenDerEbene(baum, ebene).filter(x => !filterAktiv || eigenTreffer(x, false)))) {
        out.push({ k, tiefe: 0, kinder: 0, offen: false, gedimmt: false })
        summe.push(k)
      }
    }
    return { zeilen: out, summenKnoten: summe }
  }, [baum, ebene, offen, sucheNorm, statusFilter, nurMitAusgaben, filterAktiv, sort, eigene, kurs, t, fmt])

  const summe = useMemo(() => {
    const w: Werte = {}
    for (const k of summenKnoten) addiere(w, k.werte)
    let v: Werte | null = null
    if (vergleichKarte) {
      v = {}
      for (const k of summenKnoten) addiere(v, vergleichKarte.get(k.key) ?? {})
    }
    return { werte: w, vergleich: v, anzahl: summenKnoten.length }
  }, [summenKnoten, vergleichKarte])

  const wartetAufMeta = useMemo(() => new Set(
    (metaPasst && !felderFehlen) ? [] : sichtbareSpalten.filter(k => brauchtMeta(k, eigene)),
  ), [metaPasst, felderFehlen, sichtbareSpalten, eigene])

  // ── Auswahl ────────────────────────────────────────────────────────────────
  const ausgewaehlt = useMemo(
    () => [...auswahl].map(k => knotenNachKey.get(k)).filter((k): k is Knoten => !!k),
    [auswahl, knotenNachKey],
  )
  const toggleAuswahl = (key: string) => setAuswahl(prev => {
    const s = new Set(prev); if (s.has(key)) s.delete(key); else s.add(key); return s
  })
  // „Alle auswählen" nimmt nur echte Treffer: keine grauen Wegzeilen und im Baum
  // nur die oberste Treffer-Ebene (wie die Gesamt-Zeile), damit nicht nebenbei
  // ganze Kampagnen oder deren Kinder mitgeschaltet werden.
  const auswahlbar = useMemo(() => summenKnoten.map(k => k.key), [summenKnoten])
  const alleAuswahl = (an: boolean) => setAuswahl(an ? new Set(auswahlbar) : new Set())
  const aufklappen = (key: string) => setOffen(prev => {
    const s = new Set(prev); if (s.has(key)) s.delete(key); else s.add(key); return s
  })

  // ── Dialoge ────────────────────────────────────────────────────────────────
  const [dupItems, setDupItems] = useState<Knoten[] | null>(null)
  const [massenItems, setMassenItems] = useState<Knoten[] | null>(null)
  const [aufZiel, setAufZiel] = useState<AufschluesselungZiel | null>(null)
  const [verlaufZiel, setVerlaufZiel] = useState<VerlaufZiel | null>(null)
  const [spaltenOffen, setSpaltenOffen] = useState(false)
  const [empfehlungenOffen, setEmpfehlungenOffen] = useState(false)
  const [speichernOffen, setSpeichernOffen] = useState(false)
  const [ansichtName, setAnsichtName] = useState('')
  const [schaltet, setSchaltet] = useState(false)

  const nachAenderung = useCallback(() => { void fetchAll() }, [fetchAll])

  // ── Aktionen ───────────────────────────────────────────────────────────────
  const bearbeiten = (k: Knoten) => {
    const next = new URLSearchParams(window.location.search)
    next.set('tab', 'kampagnen')
    next.set('bearbeiten', `${k.level}:${k.id}`)
    setSearch(next)
  }

  const grund = t('crm.ads.reasonManual', 'Manuell im Werbemanager')

  const schalten = async (items: Knoten[], ziel: Schaltziel) => {
    if (schaltet) return
    const betroffen = items.filter(k => (ziel === 'pause' ? istAn(k) : !istAn(k)) && !(k.level === 'ad' && pendingByAd.has(k.id)))
    if (!betroffen.length) {
      showToast(ziel === 'pause'
        ? t('crm.werbung.zentrale.schalten.schonAus', 'Die gewählten Zeilen sind schon aus.')
        : t('crm.werbung.zentrale.schalten.schonAn', 'Die gewählten Zeilen sind schon an.'))
      return
    }
    const anzahl = (l: Ebene) => betroffen.filter(k => k.level === l).length
    const teile = EBENEN.filter(l => anzahl(l) > 0).map(l => `${anzahl(l)} ${ebeneLabel(l, t, anzahl(l) !== 1)}`)
    const ok = await confirm({
      title: t('crm.werbung.zentrale.schalten.titel', 'Das ändert sich bei Meta'),
      message: (
        <div className="space-y-2 text-sm text-gray-700">
          <p>
            {ziel === 'pause'
              ? t('crm.werbung.zentrale.schalten.pauseText', 'Pausiert werden: {{was}}.', { was: teile.join(', ') })
              : t('crm.werbung.zentrale.schalten.aktivText', 'Aktiviert werden: {{was}}.', { was: teile.join(', ') })}
          </p>
          <ul className="list-disc pl-5 text-xs text-gray-600 max-h-32 overflow-y-auto">
            {betroffen.slice(0, 8).map(k => <li key={k.key} className="truncate">{k.name}</li>)}
            {betroffen.length > 8 && <li>{t('crm.werbung.zentrale.schalten.weitere', 'und {{n}} weitere', { n: betroffen.length - 8 })}</li>}
          </ul>
          <p className="text-xs text-gray-500">
            {ziel === 'pause'
              ? t('crm.werbung.zentrale.schalten.pauseHinweis', 'Pausierte Zeilen geben kein Geld mehr aus. Bleibt eine Anzeigengruppe 7 Tage oder länger pausiert, startet die Lernphase beim Einschalten neu.')
              : anzahl('campaign') + anzahl('adset') > 0
                ? t('crm.werbung.zentrale.schalten.aktivHinweis', 'Beim Aktivieren von Kampagnen und Anzeigengruppen prüft der Server die Leitplanke (Tageslimit {{limit}}). Neue oder lange pausierte Anzeigengruppen starten in der Lernphase.', { limit: fmt.eur(settings.max_account_daily_budget) })
                : t('crm.werbung.zentrale.schalten.aktivHinweisAnzeigen', 'Anzeigen geben aus dem Budget ihrer Anzeigengruppe aus, eine eigene Prüfung des Tageslimits gibt es dafür nicht. Das Einschalten kann die Lernphase der Anzeigengruppe neu starten.')}
          </p>
        </div>
      ),
      confirmLabel: ziel === 'pause' ? t('crm.werbung.zentrale.pausieren', 'Pausieren') : t('crm.werbung.zentrale.aktivieren', 'Aktivieren'),
    })
    if (!ok) return
    setSchaltet(true)
    // Nach geschalteten Kampagnen/Gruppen immer neu laden, auch wenn danach etwas scheitert
    let neuLaden = false
    try {
      let okAnzahl = 0
      const fehlerMeldungen: string[] = []
      // Kampagnen + Anzeigengruppen zuerst (meta-builder bulk, sonst update_entity):
      // scheitert das Einschalten ganz, werden die Anzeigen nicht halb mit eingeschaltet
      const rest = betroffen.filter((k): k is Knoten & { level: 'campaign' | 'adset' } => k.level !== 'ad')
      let ergebnisse: BulkErgebnis[] = []
      let ueberBulk = true
      let ebenenGescheitert = false
      if (rest.length) {
        try {
          const r = await ebenenSchalten(rest.map(k => ({ level: k.level, id: k.id })), ziel, e => fehlerText(e, t))
          ergebnisse = r.ergebnisse
          ueberBulk = r.ueberBulk
        } catch (err) {
          ebenenGescheitert = true
          fehlerMeldungen.push(t('crm.werbung.zentrale.schalten.bulkFehler', 'Kampagnen/Anzeigengruppen: {{fehler}}', { fehler: fehlerText(err, t) }))
        }
      }
      const gut = ergebnisse.filter(r => r.ok)
      const schlecht = ergebnisse.filter(r => !r.ok)
      // Alle Kampagnen/Gruppen abgelehnt (z. B. Leitplanke): Anzeigen nicht halb mit einschalten
      if (ergebnisse.length > 0 && gut.length === 0) ebenenGescheitert = true
      okAnzahl += gut.length
      if (gut.length) { statusNachSchalten(gut.map(r => r.id), ziel, ueberBulk); neuLaden = true }
      if (schlecht.length) {
        fehlerMeldungen.push(t('crm.werbung.zentrale.schalten.teilweise', 'Fehlgeschlagen ({{n}}): {{fehler}}', { n: schlecht.length, fehler: schlecht[0].error ?? '' }))
      }

      // Anzeigen: Warteschlange (ein Insert, ein Anstoß)
      const ads = betroffen.filter(k => k.level === 'ad')
      if (ads.length && ziel === 'activate' && ebenenGescheitert) {
        fehlerMeldungen.push(t('crm.werbung.zentrale.schalten.anzeigenNichtAktiviert', 'Die Anzeigen wurden deshalb nicht aktiviert.'))
      } else if (ads.length) {
        const neu = await anzeigenVormerken(ads.map(k => {
          const c = catalogNachId.get(k.id)
          return { ad_id: k.id, ad_name: c?.ad_name ?? k.name, campaign_name: c?.campaign_name ?? null }
        }), ziel, grund, segment, profile?.id ?? null)
        setActions(prev => [...neu, ...prev])
        okAnzahl += neu.length
        warteschlangeAnstossen(nachAenderung)
      }

      if (fehlerMeldungen.length) {
        showToast(`❌ ${fehlerMeldungen.join(' ')}`)
      } else if (okAnzahl > 0) {
        showToast(`✅ ${ziel === 'pause'
          ? t('crm.werbung.zentrale.schalten.okPause', 'Pausieren bei Meta angestoßen ({{n}}).', { n: okAnzahl })
          : t('crm.werbung.zentrale.schalten.okAktiv', 'Aktivieren bei Meta angestoßen ({{n}}).', { n: okAnzahl })}`)
      }
      if (okAnzahl > 0) setAuswahl(new Set())
    } catch (err) {
      console.error('[Zentrale] schalten:', err)
      showToast(`❌ ${dbFehlerText(t, err)}`)
    } finally {
      setSchaltet(false)
      if (neuLaden) nachAenderung()
    }
  }

  // Nach erfolgreichem Schalten nichts erfinden: der Schalter zeigt den gesetzten
  // Status, die Auslieferung kommt aus dem Spiegel (bulk zieht ihn auf dem Server
  // nach, fetchAll lädt ihn neu). update_entity zieht den Spiegel nicht nach,
  // dann den echten Stand bei Meta lesen (nur diese IDs).
  const statusNachSchalten = (ids: string[], ziel: Schaltziel, spiegelAktuell: boolean) => {
    const status = ziel === 'pause' ? 'PAUSED' : 'ACTIVE'
    const setze = (eff: string | null) => setLive(prev => {
      const m = new Map(prev)
      for (const id of ids) m.set(id, { id, configured_status: status, effective_status: eff, learning: null, issues: null, review_feedback: null })
      return m
    })
    setze(null)
    if (spiegelAktuell) return
    void ladeStatus(ids)
      .then(items => setLive(prev => { const m = new Map(prev); for (const i of items) m.set(i.id, i); return m }))
      // Berichte-Funktion nicht erreichbar: Pausiert ist sicher aus, Aktiviert bleibt offen
      .catch(() => { if (ziel === 'pause') setze('PAUSED') })
  }

  // Auch der Schalter einer Zeile zeigt vorher „Das ändert sich bei Meta" (SPEC2)
  const schalteEinzeln = (k: Knoten) => {
    if (k.level === 'ad' && pendingByAd.has(k.id)) return
    void schalten([k], istAn(k) ? 'pause' : 'activate')
  }

  const ladeLive = async () => {
    if (liveLaedt) return
    const ids = [...new Set([
      ...knotenDerEbene(baum, 'campaign').map(k => k.id),
      ...knotenDerEbene(baum, 'adset').map(k => k.id),
      ...zeilen.filter(z => z.k.level === 'ad').map(z => z.k.id),
    ])].slice(0, 250)
    if (!ids.length) return
    setLiveLaedt(true)
    try {
      const items = await ladeStatus(ids)
      setLive(prev => { const m = new Map(prev); for (const i of items) m.set(i.id, i); return m })
      setLiveStand(new Date().toISOString())
    } catch (err) {
      showToast(`❌ ${berichteFehlerText(err, t)}`)
    } finally {
      setLiveLaedt(false)
    }
  }

  const zeilenAktionen = (k: Knoten): ActionItem[] => [
    { id: 'bearbeiten', label: t('crm.werbung.zentrale.bearbeiten', 'Bearbeiten'), icon: 'edit', onClick: () => bearbeiten(k) },
    { id: 'einstellungen', label: t('crm.werbung.zentrale.einstellungen', 'Einstellungen ansehen'), icon: 'settings', onClick: () => openSettings(k.campaignId) },
    { id: 'duplizieren', label: t('crm.werbung.zentrale.duplizieren', 'Duplizieren'), icon: 'plus', onClick: () => setDupItems([k]) },
    { id: 'aufschluesselung', label: t('crm.werbung.zentrale.aufschluesselung', 'Aufschlüsselung'), icon: 'statistics', onClick: () => setAufZiel({ level: k.level, id: k.id, name: k.name }) },
    { id: 'verlauf', label: t('crm.werbung.zentrale.verlaufKnopf', 'Verlauf'), icon: 'clock', onClick: () => setVerlaufZiel({ id: k.id, name: k.name }) },
    { id: 'vorschau', label: t('crm.ads.previewBtn', 'Vorschau'), icon: 'thumbnail', hidden: k.level !== 'ad', onClick: () => { const c = catalogNachId.get(k.id); if (c) openPreview(c) } },
    {
      id: 'schalten', label: istAn(k) ? t('crm.werbung.zentrale.pausieren', 'Pausieren') : t('crm.werbung.zentrale.aktivieren', 'Aktivieren'),
      disabled: k.level === 'ad' && pendingByAd.has(k.id), onClick: () => schalteEinzeln(k),
    },
  ]

  const vorschau = (k: Knoten) => { const c = catalogNachId.get(k.id); if (c) openPreview(c) }

  // ── Ansichten + Spalten ────────────────────────────────────────────────────
  const ansichtAnwenden = (a: Ansicht) => {
    setPreset(a.preset); setSpalten(a.spalten.length ? a.spalten : PRESETS[0].spalten); setEbene(a.ebene)
    setStatusFilter(a.status); setNurMitAusgaben(a.nurMitAusgaben); setSuche(a.suche); setSort(a.sort)
  }
  const ansichtWaehlen = (id: string) => {
    setAnsichtId(id)
    if (!id) {
      ansichtAnwenden({ id: '', name: '', preset: 'leistung', spalten: PRESETS[0].spalten, ebene: 'baum', status: 'alle', nurMitAusgaben: false, suche: '', sort: null })
      return
    }
    const a = ansichten.find(x => x.id === id)
    if (a) ansichtAnwenden(a)
  }
  const ansichtSpeichern = () => {
    const name = ansichtName.trim().slice(0, 60)
    if (!name) return
    const a: Ansicht = { id: neueId(), name, preset, spalten, ebene, status: statusFilter, nurMitAusgaben, suche, sort }
    const liste = [...ansichten.filter(x => x.name !== name), a]
    setAnsichten(liste)
    setAnsichtId(a.id)
    setSpeichernOffen(false)
    setAnsichtName('')
    if (speichereAnsichten(liste)) showToast(`✅ ${t('crm.werbung.zentrale.ansicht.gespeichert', 'Ansicht „{{name}}" gespeichert', { name })}`)
    else showToast(`❌ ${t('crm.werbung.zentrale.ansicht.speicherGesperrt', 'Der Browser-Speicher ist gesperrt. Die Ansicht gilt nur bis zum Neuladen.')}`)
  }
  const ansichtLoeschen = async () => {
    const a = ansichten.find(x => x.id === ansichtId)
    if (!a) return
    const ok = await confirm({
      title: t('crm.werbung.zentrale.ansicht.loeschenTitel', 'Ansicht entfernen?'),
      message: t('crm.werbung.zentrale.ansicht.loeschenText', 'Die gespeicherte Ansicht „{{name}}" wird aus diesem Browser entfernt. Bei Meta ändert sich nichts.', { name: a.name }),
      confirmLabel: t('crm.werbung.zentrale.ansicht.entfernen', 'Entfernen'),
    })
    if (!ok) return
    const liste = ansichten.filter(x => x.id !== a.id)
    setAnsichten(liste)
    speichereAnsichten(liste)
    setAnsichtId('')
  }

  const presetWaehlen = (id: string) => {
    if (id === '__anpassen') { setSpaltenOffen(true); return }
    const p = presetVon(id)
    if (!p) return
    setPreset(p.id)
    setSpalten(p.spalten)
  }
  const spaltenUebernehmen = (s: string[], k: EigeneKennzahl[]) => {
    setSpalten(s)
    setKennzahlen(k)
    if (!speichereKennzahlen(k)) showToast(`❌ ${t('crm.werbung.zentrale.ansicht.speicherGesperrt', 'Der Browser-Speicher ist gesperrt. Die Ansicht gilt nur bis zum Neuladen.')}`)
    const gleich = PRESETS.find(p => p.spalten.length === s.length && p.spalten.every((x, i) => x === s[i]))
    setPreset(gleich ? gleich.id : 'eigen')
    setSpaltenOffen(false)
  }

  const sortieren = (key: string) => setSort(prev => {
    const start = key !== 'name'      // Zahlen zuerst absteigend, Namen aufsteigend
    if (prev?.key !== key) return { key, ab: start }
    if (prev.ab === start) return { key, ab: !start }
    return null
  })

  // ── CSV-Export der aktuellen Ansicht ───────────────────────────────────────
  const exportieren = () => {
    const spaltenLabel = (key: string) => {
      if (key.startsWith(EIGEN_PREFIX)) return eigene.get(key)?.def.name ?? key
      const d = SPALTE.get(key)
      return d ? t(d.label.k, d.label.d) : key
    }
    const kopf: string[] = [
      t('crm.werbung.zentrale.csvKopf.ebene', 'Ebene'), t('crm.werbung.zentrale.csvKopf.name', 'Name'), 'ID',
      t('crm.werbung.zentrale.csvKopf.kampagne', 'Kampagne'), t('crm.werbung.zentrale.csvKopf.gruppe', 'Anzeigengruppe'),
    ]
    for (const key of sichtbareSpalten) {
      const f = formatVon(key, eigene)
      kopf.push(`${spaltenLabel(key)}${csvEinheit(f)}`)
      if (vergleichKarte && f !== 'text') {
        kopf.push(`${spaltenLabel(key)} ${t('crm.werbung.zentrale.csvKopf.vergleich', 'Vergleich')}${csvEinheit(f)}`)
        kopf.push(`${spaltenLabel(key)} ${t('crm.werbung.zentrale.csvKopf.aenderung', 'Änderung')} (%)`)
      }
    }
    const werteZeile = (w: Werte, vgl: Werte | null, k: Knoten | null): CsvZelle[] => {
      const out: CsvZelle[] = []
      for (const key of sichtbareSpalten) {
        const f = formatVon(key, eigene)
        // Textspalten ohne Vergleichsspalten (siehe Kopf)
        if (f === 'text') { out.push(k ? textWert(k, key, kurs, t, fmt) : ''); continue }
        const v = wertVon(key, w, eigene)
        out.push(csvZahl(v, f))
        if (vergleichKarte) {
          const vv = vgl ? wertVon(key, vgl, eigene) : null
          out.push(csvZahl(vv, f))
          out.push(csvZahl(veraenderung(v, vv), 'prozent'))
        }
      }
      return out
    }
    const kName = (id: string) => knotenNachKey.get(knotenKey('campaign', id))?.name ?? id
    const gName = (id: string | null) => (id ? knotenNachKey.get(knotenKey('adset', id))?.name ?? id : '')
    const rows: CsvZelle[][] = zeilen.map(z => [
      ebeneLabel(z.k.level, t), z.k.name, csvId(z.k.id),
      z.k.level === 'campaign' ? '' : kName(z.k.campaignId),
      z.k.level === 'ad' ? gName(z.k.adsetId) : '',
      ...werteZeile(z.k.werte, vergleichKarte ? vergleichKarte.get(z.k.key) ?? {} : null, z.k),
    ])
    rows.push([t('crm.werbung.zentrale.csvKopf.summe', 'Gesamt'), '', '', '', '', ...werteZeile(summe.werte, summe.vergleich, null)])
    ladeCsvHerunter(baueCsv(kopf, rows), `kampagnen-zentrale_${bereich.since}_${bereich.until}.csv`)
  }

  // ── Texte für die Hinweise ─────────────────────────────────────────────────
  const zeitText = zeitraum.art === 'kopf'
    ? t('crm.werbung.zentrale.zeit.kopfKurz', 'Wie oben ({{n}} Tage)', { n: days })
    : zeitraumText(bereich.since, bereich.until, fmt.locale)
  const standZeit = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(fmt.locale, { hour: '2-digit', minute: '2-digit' }) : '')

  const presetWert = presetVon(preset) ? preset : 'eigen'
  const ebenenWahl: Array<{ id: ZentraleEbene; label: string }> = [
    { id: 'baum', label: t('crm.werbung.zentrale.ebene.alle', 'Alle Ebenen') },
    { id: 'campaign', label: ebeneLabel('campaign', t, true) },
    { id: 'adset', label: ebeneLabel('adset', t, true) },
    { id: 'ad', label: ebeneLabel('ad', t, true) },
  ]
  const auswahlFuerDialog = (ks: Knoten[]) => ks.map(k => ({ level: k.level, id: k.id, name: k.name }))
  const massenFuerDialog = (ks: Knoten[]): MassenItem[] => ks.map(k => ({
    level: k.level, id: k.id, name: k.name, daily_budget_cents: k.budgetTagCents, status: k.status,
  }))
  const BTN = 'px-2.5 py-1.5 rounded-lg border border-gray-200 bg-white text-xs font-semibold text-gray-700 hover:border-gray-400 disabled:opacity-40 disabled:hover:border-gray-200 whitespace-nowrap'
  const SEL = 'border border-gray-200 rounded-lg px-2 py-1.5 text-xs bg-white text-gray-700 max-w-full'

  return (
    <div className="rounded-2xl border border-gray-200 bg-white overflow-hidden min-w-0">
      {/* Kopf: Titel, Zeitraum, Ansicht, Spalten, Export */}
      <div className="px-4 py-3 border-b border-gray-100 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-bold text-gray-700 mr-auto">{t('crm.werbung.zentrale.titel', 'Kampagnen-Zentrale')}</h2>
          <button type="button" className={BTN} onClick={() => setZeitraumOffen(true)}>
            📅 {zeitText}{vergleich.an && <span className="font-normal text-gray-500"> · {t('crm.werbung.zentrale.zeit.mitVergleich', 'mit Vergleich')}</span>}
          </button>
          <select value={ansichtId} onChange={e => ansichtWaehlen(e.target.value)} className={SEL}
            aria-label={t('crm.werbung.zentrale.ansicht.label', 'Gespeicherte Ansicht')}>
            <option value="">{t('crm.werbung.zentrale.ansicht.standard', 'Ansicht: Standard')}</option>
            {ansichten.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <button type="button" className={BTN} onClick={() => { setAnsichtName(ansichten.find(a => a.id === ansichtId)?.name ?? ''); setSpeichernOffen(true) }}>
            {t('crm.werbung.zentrale.ansicht.speichern', 'Ansicht speichern')}
          </button>
          {ansichtId && (
            <button type="button" className={BTN} onClick={() => void ansichtLoeschen()}>
              {t('crm.werbung.zentrale.ansicht.entfernen', 'Entfernen')}
            </button>
          )}
          <select value={presetWert} onChange={e => presetWaehlen(e.target.value)} className={SEL}
            aria-label={t('crm.werbung.zentrale.spaltenLabel', 'Spalten')}>
            {PRESETS.map(p => <option key={p.id} value={p.id}>{t('crm.werbung.zentrale.spaltenPrefix', 'Spalten: {{name}}', { name: t(p.label.k, p.label.d) })}</option>)}
            {presetWert === 'eigen' && <option value="eigen">{t('crm.werbung.zentrale.spaltenEigen', 'Spalten: Eigene Auswahl')}</option>}
            <option value="__anpassen">{t('crm.werbung.zentrale.spaltenAnpassen', 'Spalten anpassen …')}</option>
          </select>
          <button type="button" className={BTN} onClick={exportieren} disabled={zeilen.length === 0}>
            ⬇ {t('crm.werbung.zentrale.export', 'Export (CSV)')}
          </button>
        </div>

        {/* Ebene, Suche, Filter */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden max-w-full overflow-x-auto">
            {ebenenWahl.map(e => (
              <button key={e.id} type="button" onClick={() => setEbene(e.id)} aria-pressed={ebene === e.id}
                className={`px-2.5 py-1.5 text-xs font-semibold whitespace-nowrap ${ebene === e.id ? 'bg-hp-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {e.label}
              </button>
            ))}
          </div>
          <input type="search" value={suche} onChange={e => setSuche(e.target.value)}
            placeholder={t('crm.werbung.zentrale.suche', 'Suchen nach Name oder ID')}
            className="border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs flex-1 min-w-[160px] max-w-xs" />
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as StatusFilter)} className={SEL}
            aria-label={t('crm.werbung.zentrale.filter.label', 'Auslieferung filtern')}>
            <option value="alle">{t('crm.werbung.zentrale.filter.alle', 'Auslieferung: alle')}</option>
            <option value="aktiv">{t('crm.werbung.zentrale.filter.aktiv', 'Aktiv')}</option>
            <option value="lernphase">{t('crm.werbung.zentrale.filter.lernphase', 'Lernphase')}</option>
            <option value="pruefung">{t('crm.werbung.zentrale.filter.pruefung', 'In Prüfung')}</option>
            <option value="probleme">{t('crm.werbung.zentrale.filter.probleme', 'Abgelehnt oder mit Problemen')}</option>
            <option value="aus">{t('crm.werbung.zentrale.filter.aus', 'Aus')}</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-gray-600 whitespace-nowrap">
            <input type="checkbox" checked={nurMitAusgaben} onChange={e => setNurMitAusgaben(e.target.checked)} />
            {t('crm.werbung.zentrale.filter.ausgaben', 'Nur mit Ausgaben')}
          </label>
          {ebene === 'baum' && (
            <>
              <button type="button" className={BTN} onClick={() => setOffen(new Set(alle.filter(k => k.kinder.length > 0).map(k => k.key)))}>
                {t('crm.werbung.zentrale.alleAuf', 'Alle aufklappen')}
              </button>
              {offen.size > 0 && (
                <button type="button" className={BTN} onClick={() => setOffen(new Set())}>
                  {t('crm.werbung.zentrale.alleZu', 'Alle zuklappen')}
                </button>
              )}
            </>
          )}
          <button type="button" className={`${BTN} ml-auto`} onClick={() => void ladeLive()} disabled={liveLaedt || alle.length === 0}
            title={t('crm.werbung.zentrale.liveTitel', 'Auslieferung und Lernphase jetzt direkt bei Meta abfragen')}>
            {liveLaedt ? <Spinner size="sm" className="inline-block align-middle mr-1" /> : '⟳ '}
            {t('crm.werbung.zentrale.live', 'Status von Meta')}
          </button>
          <button type="button" className={BTN} onClick={() => setVerlaufZiel({ id: null, name: null })}>
            🕘 {t('crm.werbung.zentrale.verlaufKonto', 'Aktivitätenverlauf')}
          </button>
          {segment === 'meta' && (
            <button type="button" className={BTN} onClick={() => setEmpfehlungenOffen(true)}
              title={t('crm.werbung.zentrale.empfehlungen.knopfTitel', 'Potenzialbewertung und Empfehlungen von Meta lesen (nichts wird geändert)')}>
              💡 {t('crm.werbung.zentrale.empfehlungen.knopf', 'Empfehlungen von Meta')}
            </button>
          )}
        </div>

        {/* Auswahl-Werkzeugleiste */}
        {ausgewaehlt.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-xl border border-orange-200 bg-orange-50/60 px-3 py-2">
            <span className="text-xs font-semibold text-gray-800 mr-1">
              {t('crm.werbung.zentrale.ausgewaehlt', '{{n}} ausgewählt', { n: ausgewaehlt.length })}
            </span>
            <button type="button" className={BTN} disabled={ausgewaehlt.length !== 1} onClick={() => bearbeiten(ausgewaehlt[0])}
              title={ausgewaehlt.length !== 1 ? t('crm.werbung.zentrale.nurEine', 'Bitte genau eine Zeile wählen') : undefined}>
              ✏️ {t('crm.werbung.zentrale.bearbeiten', 'Bearbeiten')}
            </button>
            <button type="button" className={BTN} onClick={() => setDupItems(ausgewaehlt)}>
              ⧉ {t('crm.werbung.zentrale.duplizieren', 'Duplizieren')}
            </button>
            <button type="button" className={BTN} onClick={() => setMassenItems(ausgewaehlt)}>
              ☰ {t('crm.werbung.zentrale.massen', 'Massenbearbeitung')}
            </button>
            <button type="button" className={BTN} disabled={schaltet} onClick={() => void schalten(ausgewaehlt, 'pause')}>
              ⏸ {t('crm.werbung.zentrale.pausieren', 'Pausieren')}
            </button>
            <button type="button" className={BTN} disabled={schaltet} onClick={() => void schalten(ausgewaehlt, 'activate')}>
              ▶ {t('crm.werbung.zentrale.aktivieren', 'Aktivieren')}
            </button>
            <button type="button" className={BTN} disabled={ausgewaehlt.length !== 1}
              onClick={() => { const k = ausgewaehlt[0]; setAufZiel({ level: k.level, id: k.id, name: k.name }) }}>
              📊 {t('crm.werbung.zentrale.aufschluesselung', 'Aufschlüsselung')}
            </button>
            <button type="button" className={BTN} disabled={ausgewaehlt.length !== 1}
              onClick={() => { const k = ausgewaehlt[0]; setVerlaufZiel({ id: k.id, name: k.name }) }}>
              🕘 {t('crm.werbung.zentrale.verlaufKnopf', 'Verlauf')}
            </button>
            <button type="button" className="ml-auto text-xs text-gray-500 underline" onClick={() => setAuswahl(new Set())}>
              {t('crm.werbung.zentrale.auswahlAufheben', 'Auswahl aufheben')}
            </button>
          </div>
        )}

        {/* Hinweise: Meta-Zahlen, Spiegel, Live-Stand */}
        {metaLaedt && (
          <div className="flex items-center gap-2 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900">
            <Spinner size="sm" /> {metaLaedt}
          </div>
        )}
        {metaFehler && !metaLaedt && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <span className="flex-1 min-w-0">{metaFehler}</span>
            <button type="button" className={BTN} onClick={() => void metaLaden(zeitraum, vergleich)}>{t('crm.werbung.zentrale.nochmal', 'Erneut versuchen')}</button>
          </div>
        )}
        {!metaLaedt && !metaFehler && metaNoetig && (!metaPasst || felderFehlen) && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="flex-1 min-w-0">
              {felderFehlen
                ? t('crm.werbung.zentrale.meta.felderFehlen', 'Für diese Spalten fehlen noch Zahlen von Meta.')
                : zeitraum.art === 'frei' || vergleich.an
                  ? t('crm.werbung.zentrale.meta.zeitraum', 'Für diesen Zeitraum kommen die Zahlen direkt von Meta.')
                  : t('crm.werbung.zentrale.meta.spalten', 'Einige Spalten gibt es nur direkt von Meta (nicht im täglichen Sync).')}
            </span>
            <button type="button" className={BTN} onClick={() => void metaLaden(zeitraum, vergleich)}>
              {t('crm.werbung.zentrale.meta.laden', 'Von Meta laden')}
            </button>
          </div>
        )}
        {metaPasst && metaDaten && (
          <p className="text-[11px] text-gray-500">
            {t('crm.werbung.zentrale.meta.stand', 'Zahlen direkt von Meta für {{zeitraum}}', { zeitraum: zeitraumText(bereich.since, bereich.until, fmt.locale) })}
            {vglBereich && <> · {t('crm.werbung.zentrale.meta.vergleich', 'verglichen mit {{zeitraum}}', { zeitraum: zeitraumText(vglBereich.since, vglBereich.until, fmt.locale) })}</>}
            {metaDaten.stand && <> · {t('crm.werbung.zentrale.stand', 'Stand {{zeit}}', { zeit: standZeit(metaDaten.stand) })}</>}
            {metaDaten.cached && <> · {t('crm.werbung.zentrale.zwischenspeicher', 'aus dem Zwischenspeicher')}</>}
            {crmVisible && zeitraum.art === 'frei' && <> · {t('crm.werbung.zentrale.meta.crmHinweis', 'CRM-Spalten bleiben bei freiem Zeitraum leer (CRM-Zahlen nur für den Zeitraum oben, {{n}} Tage).', { n: days })}</>}
            {' '}<button type="button" className="underline" onClick={() => void metaLaden(zeitraum, vergleich, true)}>{t('crm.werbung.zentrale.meta.neu', 'Neu laden')}</button>
            {zeitraum.art === 'frei' || vergleich.an ? (
              <> · <button type="button" className="underline" onClick={() => { setZeitraum({ art: 'kopf' }); setVergleich(VERGLEICH_AUS) }}>
                {t('crm.werbung.zentrale.meta.zurueck', 'Zurück zum Zeitraum oben')}
              </button></>
            ) : null}
          </p>
        )}
        {metaPasst && metaDaten && (metaDaten.unvollstaendig || metaDaten.veraltet || metaDaten.hinweise.length > 0) && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 space-y-0.5">
            {metaDaten.unvollstaendig && <p>{t('crm.werbung.zentrale.meta.unvollstaendig', 'Meta hat nicht alles geliefert (Abruf-Grenze erreicht). Die Zahlen können unvollständig sein.')}</p>}
            {metaDaten.veraltet && <p>{t('crm.werbung.zentrale.meta.veraltet', 'Meta bremst gerade, angezeigt wird ein älterer Stand aus dem Zwischenspeicher.')}</p>}
            {metaDaten.hinweise.map(h => <p key={h}>{h}</p>)}
          </div>
        )}
        {(spiegel?.unvollstaendig || liveStand || !crmVisible) && (
          <p className="text-[11px] text-gray-400">
            {spiegel?.unvollstaendig && t('crm.werbung.zentrale.spiegelFehlt', 'Budget, Gebote und Lernphase aus dem täglichen Abgleich fehlen noch. „Status von Meta" holt Auslieferung und Lernphase direkt.')}
            {liveStand && <> {t('crm.werbung.zentrale.liveStand', 'Live-Status von Meta: {{zeit}}', { zeit: standZeit(liveStand) })}</>}
            {!crmVisible && <> {t('crm.werbung.zentrale.ohneCrm', 'CRM-Spalten siehst du nur mit dem Pipeline-Recht.')}</>}
          </p>
        )}
      </div>

      <ZentraleTabelle
        zeilen={zeilen} ebene={ebene} spalten={sichtbareSpalten} eigene={eigene}
        vergleich={vergleichKarte} summe={summe} wartetAufMeta={wartetAufMeta} kurs={kurs}
        sort={sort} onSort={sortieren}
        auswahl={auswahl} auswahlbar={auswahlbar} onAuswahl={toggleAuswahl} onAlleAuswahl={alleAuswahl} onAufklappen={aufklappen}
        pendingByAd={pendingByAd} onSchalten={schalteEinzeln} aktionen={zeilenAktionen} onVorschau={vorschau}
        herkunft={herkunft}
      />

      {filterAktiv && (
        <p className="px-4 py-2 text-[11px] text-gray-400 border-t border-gray-100">
          {t('crm.werbung.zentrale.filterHinweis', 'Filter aktiv: grau = nur als Weg zu einem Treffer sichtbar.')}
        </p>
      )}

      {/* Dialoge */}
      <ZeitraumDialog offen={zeitraumOffen} tage={days} zeitraum={zeitraum} vergleich={vergleich}
        onClose={() => setZeitraumOffen(false)} onAktualisieren={zeitraumAnwenden} />
      <SpaltenDialog offen={spaltenOffen} spalten={spalten} kennzahlen={kennzahlen} crmSichtbar={crmVisible}
        onClose={() => setSpaltenOffen(false)} onUebernehmen={spaltenUebernehmen} />
      <AufschluesselungDialog ziel={aufZiel} since={bereich.since} until={bereich.until} kurs={kurs} onClose={() => setAufZiel(null)} />
      <VerlaufDialog ziel={verlaufZiel} since={bereich.since} until={bereich.until} onClose={() => setVerlaufZiel(null)} />
      <EmpfehlungenDialog offen={empfehlungenOffen} onClose={() => setEmpfehlungenOffen(false)}
        nameVon={id => knotenNachKey.get(knotenKey('campaign', id))?.name ?? knotenNachKey.get(knotenKey('adset', id))?.name ?? knotenNachKey.get(knotenKey('ad', id))?.name ?? null} />
      <DuplizierenDialog offen={!!dupItems} items={auswahlFuerDialog(dupItems ?? [])}
        onClose={() => setDupItems(null)} onFertig={() => { setDupItems(null); setAuswahl(new Set()); nachAenderung() }} />
      <MassenDialog offen={!!massenItems} items={massenFuerDialog(massenItems ?? [])}
        onClose={() => setMassenItems(null)} onFertig={() => { setMassenItems(null); setAuswahl(new Set()); nachAenderung() }} />
      <Modal open={speichernOffen} onClose={() => setSpeichernOffen(false)} size="sm"
        title={t('crm.werbung.zentrale.ansicht.speichernTitel', 'Ansicht speichern')}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="hp-btn hp-btn-ghost" onClick={() => setSpeichernOffen(false)}>{t('common.cancel', 'Abbrechen')}</button>
            <button type="button" className="hp-btn hp-btn-primary" disabled={!ansichtName.trim()} onClick={ansichtSpeichern}>{t('common.save', 'Speichern')}</button>
          </div>
        }>
        <label className="text-xs text-gray-500 flex flex-col gap-1">
          {t('crm.werbung.zentrale.ansicht.name', 'Name der Ansicht')}
          <input value={ansichtName} onChange={e => setAnsichtName(e.target.value)} maxLength={60} autoFocus
            onKeyDown={e => { if (e.key === 'Enter') ansichtSpeichern() }}
            placeholder={t('crm.werbung.zentrale.ansicht.platzhalter', 'z. B. Plan B nach Terminen')}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-sm" />
        </label>
        <p className="mt-2 text-[11px] text-gray-400">
          {t('crm.werbung.zentrale.ansicht.hinweis', 'Gespeichert werden Spalten, Ebene, Filter, Suche und Sortierung, nur in diesem Browser.')}
        </p>
      </Modal>
    </div>
  )
}
