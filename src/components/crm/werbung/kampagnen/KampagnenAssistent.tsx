import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Badge from '../../../ui/Badge'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { useConfirm } from '../../../ui/ConfirmDialog'
import { useAuth } from '../../../../lib/auth'
import {
  HP_DEFAULT_LINK, HP_PIXEL_ID, TEMPLATES, hasErrors,
  type AdDraft, type AdsetDraft, type BuilderSettings, type CatalogResponse, type DraftSpec,
  type EditApplyResponse, type EditDiffResponse, type Level,
} from '../../../../lib/metaSpec'
import { lintHasBlockers } from '../../../../lib/metaLint'
import { USD_PRO_EUR_FALLBACK } from '../felder'
import { useWerbeFormat } from '../format'
import { ladeUsdProEur, useWerbeKontext } from '../useWerbeDaten'
import AnzeigengruppenFormular from './AnzeigengruppenFormular'
import AnzeigenFormular from './AnzeigenFormular'
import EntwurfBaum, { StatusBadge, knotenListe } from './EntwurfBaum'
import KampagnenFormular from './KampagnenFormular'
import { feldId } from './Bausteine'
import PruefPanel from './PruefPanel'
import VorschauPanel from './VorschauPanel'
import AenderungenDialog from './AenderungenDialog'
import DuplizierenDialog from './DuplizierenDialog'
import { fehlerCode, fehlerText, ladeKatalog, vorgabenAus } from './builderApi'
import { sperrGrund, type EditZiel } from './bearbeitenTypen'
import { CTA_STANDARD, zielArtenFuer, zielUmstellen } from './r23Typen'
import {
  AssistentKontext, anzeigeAngelegt, belegteKeys, gruppeAngelegt, leererEntwurf, neueAnzeige, neueAnzeigengruppe,
  neueKennung, neuerKey, paarPartner, passeAnzeigengruppeAn, useEntwurf, useLeitplanke,
  type AssistentStart, type AssistentWerte, type UebernehmenGruende,
} from './useEntwurf'

// ── Kampagnen-Assistent (Vollbild) ───────────────────────────────────────────
// Links der Aufbau (Kampagne > Anzeigengruppen > Anzeigen, Ampel je Knoten),
// in der Mitte das Formular in Metas Reihenfolge, rechts Vorschau und Prüfung.
// Speichert automatisch. Unten: Weiter, Prüfen bei Meta, Bei Meta anlegen
// (pausiert, Schleife create/resume mit Fortschritt) und Aktivieren (mit
// Rückfrage und Leitplanke). Ohne Freischaltung (ad_settings.builder_enabled)
// bleiben die Schreib-Knöpfe gesperrt, mit Erklärung.
// Bearbeiten-Modus (laufende Kampagne, Anzeigengruppe oder Anzeige aus
// edit_load): gleiche Oberfläche, gesperrte Felder grau mit Grund, unten
// „Änderungen prüfen" -> Zusammenfassung „Das ändert sich bei Meta" (edit_diff)
// -> „Bei Meta übernehmen" (edit_apply). Neues wird hier nicht angelegt,
// Duplizieren geht über den Dialog.

interface Props {
  start: AssistentStart
  einstellungen: BuilderSettings | null
  onClose: () => void
  /** Bearbeiten: Entwurf verwerfen und frisch von Meta laden (edit_load neu_laden); true = geladen */
  onNeuVonMeta?: (ziel: EditZiel) => Promise<boolean>
}

export default function KampagnenAssistent({ start, einstellungen, onClose, onNeuVonMeta }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const confirm = useConfirm()
  const fmt = useWerbeFormat()
  const { profile } = useAuth()
  const { settings: seitenSettings } = useWerbeKontext()
  const istAdmin = profile?.role === 'admin'

  const [katalog, setKatalog] = useState<CatalogResponse | null>(null)
  const [katalogFehler, setKatalogFehler] = useState<string | null>(null)
  const [kurs, setKurs] = useState<number>(USD_PRO_EUR_FALLBACK)
  const [sel, setSel] = useState<string>('campaign')
  const [pruefLaeuft, setPruefLaeuft] = useState(false)
  const [forceGrund, setForceGrund] = useState('')
  const [schliesst, setSchliesst] = useState(false)
  const mitteRef = useRef<HTMLDivElement>(null)
  // Bearbeiten: Änderungsdialog (edit_diff / edit_apply)
  const [diffOffen, setDiffOffen] = useState(false)
  const [diffLaedt, setDiffLaedt] = useState(false)
  const [diff, setDiff] = useState<EditDiffResponse | null>(null)
  const [diffFehler, setDiffFehler] = useState<string | null>(null)
  const [ergebnis, setErgebnis] = useState<EditApplyResponse | null>(null)
  const [uebernimmt, setUebernimmt] = useState(false)
  const [housingVerlangt, setHousingVerlangt] = useState(false)
  const [dupItems, setDupItems] = useState<Array<{ level: Level; id: string; name: string }>>([])
  const [suche, setSuche] = useState('')

  useEffect(() => {
    let abbruch = false
    ladeKatalog().then(k => { if (!abbruch) setKatalog(k) }).catch(err => {
      console.warn('[Kampagnen] Katalog:', err)
      if (!abbruch) setKatalogFehler(fehlerText(err, t))
    })
    void ladeUsdProEur().then(k => { if (!abbruch && k) setKurs(k) })
    return () => { abbruch = true }
    // nur beim Öffnen
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const vorgaben = useMemo(() => vorgabenAus(einstellungen, katalog), [einstellungen, katalog])
  const verboteneNamen = useMemo(() => katalog?.lint_context?.forbidden_names ?? [], [katalog])
  const ersatzName = t('crm.werbung.builder.neueKampagne', 'Neue Kampagne')
  const [leer] = useState<DraftSpec>(() => leererEntwurf({}, ersatzName))
  const e = useEntwurf(start, { verboteneNamen, ersatzName, leer })

  const schreibSperre = vorgaben.builderEnabled === false
    ? t('crm.werbung.builder.gesperrt', 'Freischaltung durch Sven ausstehend')
    : null
  const gepaart = e.templateKey === 'plan_b'
  const limitEur = vorgaben.limitEur ?? seitenSettings.max_account_daily_budget
  const leitplanke = useLeitplanke(e.spec, e.validation, limitEur)

  /** Element sichtbar machen: umgebende „Alle Einstellungen" öffnen, hinscrollen, kurz markieren */
  const zeige = (el: HTMLElement | null) => {
    if (!el) return
    let p: HTMLElement | null = el.parentElement
    while (p) {
      if (p instanceof HTMLDetailsElement && !p.open) p.open = true
      p = p.parentElement
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('ring-2', 'ring-hp-highlight', 'rounded-lg')
    setTimeout(() => el.classList.remove('ring-2', 'ring-hp-highlight', 'rounded-lg'), 1600)
  }

  const springeZu = (node: string, field?: string) => {
    setSel(node)
    if (!field) return
    setTimeout(() => zeige(document.getElementById(feldId(field))), 80)
  }

  // „Einstellung finden": erstes Feld im aktuellen Formular, dessen Name den Suchtext enthält
  const finde = () => {
    const q = suche.trim().toLowerCase()
    if (!q || !mitteRef.current) return
    const treffer = Array.from(mitteRef.current.querySelectorAll<HTMLElement>('[data-einstellung]'))
      .find(el => (el.dataset.einstellung ?? '').toLowerCase().indexOf(q) >= 0)
    if (treffer) zeige(treffer)
    else toast.info(t('crm.werbung.bearbeiten.sucheNichts', 'Keine Einstellung „{{q}}“ in diesem Formular. Andere Ebene im Aufbau wählen.', { q: suche.trim() }))
  }
  const sucheTaste = (ev: KeyboardEvent<HTMLInputElement>) => { if (ev.key === 'Enter') { ev.preventDefault(); finde() } }

  // Beim Knotenwechsel die Mitte nach oben (Desktop: eigene Scroll-Spalte)
  useEffect(() => { mitteRef.current?.scrollTo?.({ top: 0 }) }, [sel])

  // Gelöschter Knoten: zurück zur Kampagne
  const knoten = knotenListe(e.spec, t)
  const knotenKey = knoten.map(k => k.node).join('|')
  useEffect(() => {
    if (knotenKey.split('|').indexOf(sel) < 0) setSel('campaign')
  }, [knotenKey, sel])

  const bearbeiten = e.modus === 'bearbeiten'
  const sperre = (node: string, feld: string): string | undefined => {
    if (!bearbeiten) return undefined
    const g = sperrGrund(e.locks, node, feld)
    return g ? t(g[0], g[1]) : undefined
  }
  const werte: AssistentWerte = { e, katalog, vorgaben, kurs, schreibSperre, gepaart, springeZu, bearbeiten, sperre }

  // Bearbeiten: gleich die geöffnete Ebene zeigen (Anzeigengruppe oder Anzeige)
  const zielGewaehlt = useRef(false)
  useEffect(() => {
    const z = e.ziel
    if (zielGewaehlt.current || !bearbeiten || !z || e.laden) return
    zielGewaehlt.current = true
    const node = z.level === 'campaign' ? 'campaign'
      : z.level === 'adset' ? e.spec.adsets.find(a => a.existing_id === z.id)?.key
        : e.spec.ads.find(a => a.existing_id === z.id)?.key
    if (node) setSel(node)
  }, [bearbeiten, e.ziel, e.laden, e.spec])

  // Knoten mit Änderungen gegenüber dem Stand bei Meta (lokaler Vergleich)
  const geaenderteKnoten = useMemo(() => {
    const out = new Set<string>()
    for (const c of e.lokalDiff?.changes ?? []) if (!c.blocked) out.add(c.node)
    return out
  }, [e.lokalDiff])
  const anzahlAenderungen = (e.lokalDiff?.changes ?? []).filter(c => !c.blocked).length

  // ── Aufbau ändern ─────────────────────────────────────────────────────────
  const entwurfVorgaben = {
    pageId: vorgaben.pageId, igUserId: vorgaben.igUserId, pixelId: vorgaben.pixelId ?? HP_PIXEL_ID,
    link: vorgaben.link, dsaBeneficiary: vorgaben.dsaBeneficiary, dsaPayor: vorgaben.dsaPayor,
  }

  const neueGruppe = () => {
    const key = neuerKey('as', belegteKeys(e.spec, e.metaIds, 'adsets'))
    e.update(d => {
      const n = d.adsets.length + 1
      let a: AdsetDraft = neueAnzeigengruppe(key, t('crm.werbung.builder.baum.gruppeName', 'Anzeigengruppe {{n}}', { n }), entwurfVorgaben, d.campaign.special_ad_category_country?.length ? d.campaign.special_ad_category_country : ['DE'])
      a = passeAnzeigengruppeAn(a, d.campaign.objective, entwurfVorgaben.pixelId)
      const vorbild = d.adsets.find(x => !x.existing_id)
      if (d.campaign.budget_level === 'campaign') a = { ...a, daily_budget_cents: undefined, lifetime_budget_cents: undefined }
      else if (d.hp?.budgets_synchron && vorbild) a = { ...a, daily_budget_cents: vorbild.daily_budget_cents, lifetime_budget_cents: vorbild.lifetime_budget_cents }
      return { ...d, adsets: [...d.adsets, a] }
    })
    setSel(key)
  }

  const neueAnz = (adsetKey: string) => {
    const key = neuerKey('ad', belegteKeys(e.spec, e.metaIds, 'ads'))
    e.update(d => {
      const as = d.adsets.find(a => a.key === adsetKey)
      let ad: AdDraft = neueAnzeige(key, adsetKey, entwurfVorgaben, t('crm.werbung.builder.baum.anzeigeName', 'Anzeige {{n}}', { n: d.ads.length + 1 }))
      // Ziel und Button passend zum Conversion-Ort der Gruppe (Sofortformular, WhatsApp, Anruf, Website + Formular ...)
      const art = zielArtenFuer(as?.destination)[0]
      if (art && art !== ad.destination.kind) {
        ad = { ...ad, destination: zielUmstellen(ad.destination, art, entwurfVorgaben.link || HP_DEFAULT_LINK), cta_type: CTA_STANDARD[art] }
      }
      return { ...d, ads: [...d.ads, ad] }
    })
    setSel(key)
  }

  const neuesPaar = () => {
    const d0 = e.spec
    if (!d0.adsets.some(a => a.key === 'lang') || !d0.adsets.some(a => a.key === 'kurz')) {
      toast.error(t('crm.werbung.builder.baum.paarFehlt', 'Für Paare braucht es die Anzeigengruppen „Kalt · Lang“ und „Kalt · Kurz“ der Vorlage.'))
      return
    }
    const kennung = neueKennung(d0, e.metaIds)
    const paar = TEMPLATES.plan_b.pair({
      kennung, primary_texts: [''], headlines: [''], media: {},
      page_id: entwurfVorgaben.pageId ?? undefined, instagram_user_id: entwurfVorgaben.igUserId ?? undefined,
    })
    e.update(d => ({ ...d, ads: [...d.ads, ...paar] }))
    setSel(paar[0].key)
  }

  const duplizieren = (node: string) => {
    const d0 = e.spec
    if (bearbeiten) {
      const as0 = d0.adsets.find(a => a.key === node)
      const ad0 = d0.ads.find(a => a.key === node)
      const ziel = as0?.existing_id
        ? { level: 'adset' as const, id: as0.existing_id, name: as0.name }
        : ad0?.existing_id ? { level: 'ad' as const, id: ad0.existing_id, name: ad0.name } : null
      if (ziel) setDupItems([ziel])
      return
    }
    const as = d0.adsets.find(a => a.key === node)
    if (as) {
      const key = neuerKey('as', belegteKeys(d0, e.metaIds, 'adsets'))
      const adKeys = belegteKeys(d0, e.metaIds, 'ads')
      const kopien: AdDraft[] = []
      for (const ad of d0.ads.filter(x => x.adset_key === node)) {
        const k = neuerKey('ad', [...adKeys, ...kopien.map(x => x.key)])
        const { existing_id: _a, ...rest } = ad
        void _a
        kopien.push({ ...JSON.parse(JSON.stringify(rest)) as AdDraft, key: k, adset_key: key })
      }
      // Felder, die nur edit_apply schreibt (beim Anlegen nicht gesendet), nicht mitkopieren
      const {
        existing_id: _b, status: _s, meta_status: _m, adset_schedule: _z, budget_schedule_specs: _p,
        daily_min_spend_target_cents: _l1, daily_spend_cap_cents: _l2, lifetime_min_spend_target_cents: _l3, lifetime_spend_cap_cents: _l4,
        ...restAs
      } = as
      void _b; void _s; void _m; void _z; void _p; void _l1; void _l2; void _l3; void _l4
      const neu: AdsetDraft = { ...JSON.parse(JSON.stringify(restAs)) as AdsetDraft, key, name: `${as.name} ${t('crm.werbung.builder.baum.kopie', 'Kopie')}` }
      e.update(d => ({ ...d, adsets: [...d.adsets, passeAnzeigengruppeAn(neu, d.campaign.objective, entwurfVorgaben.pixelId)], ads: [...d.ads, ...kopien] }))
      setSel(key)
      return
    }
    const ad = d0.ads.find(a => a.key === node)
    if (!ad) return
    const key = neuerKey('ad', belegteKeys(d0, e.metaIds, 'ads'))
    const { existing_id: _c, ...rest } = ad
    void _c
    e.update(d => ({ ...d, ads: [...d.ads, { ...JSON.parse(JSON.stringify(rest)) as AdDraft, key, name: `${ad.name} ${t('crm.werbung.builder.baum.kopie', 'Kopie')}` }] }))
    setSel(key)
  }

  const entfernen = async (node: string) => {
    const d0 = e.spec
    const as = d0.adsets.find(a => a.key === node)
    const ad = d0.ads.find(a => a.key === node)
    const partner = ad && gepaart ? paarPartner(d0, node) : undefined
    // Schon bei Meta angelegt (auch Partner oder Anzeigen der Gruppe): bleibt im Entwurf
    const ids = e.metaIds
    const gesperrt = as
      ? !!as.existing_id || gruppeAngelegt(ids, node) || d0.ads.some(x => x.adset_key === node && anzeigeAngelegt(ids, x.key))
      : !!ad && (!!ad.existing_id || anzeigeAngelegt(ids, node) || (!!partner && anzeigeAngelegt(ids, partner.key)))
    if (gesperrt) {
      toast.error(t('crm.werbung.builder.baum.entfernenGesperrt', 'Schon bei Meta angelegt: lässt sich nicht mehr aus dem Entwurf nehmen.'))
      return
    }
    const ok = await confirm({
      title: as
        ? t('crm.werbung.builder.baum.gruppeEntfernenTitel', 'Anzeigengruppe aus dem Entwurf nehmen?')
        : t('crm.werbung.builder.baum.anzeigeEntfernenTitel', 'Anzeige aus dem Entwurf nehmen?'),
      message: as
        ? t('crm.werbung.builder.baum.gruppeEntfernenText', '„{{name}}“ und ihre {{n}} Anzeigen werden aus dem Entwurf entfernt. Bei Meta wird nichts gelöscht.', { name: as.name, n: d0.ads.filter(x => x.adset_key === node).length })
        : partner
          ? t('crm.werbung.builder.baum.paarEntfernenText', 'Das Paar „{{name}}“ und „{{partner}}“ wird aus dem Entwurf entfernt.', { name: ad?.name, partner: partner.name })
          : t('crm.werbung.builder.baum.anzeigeEntfernenText', '„{{name}}“ wird aus dem Entwurf entfernt.', { name: ad?.name }),
      confirmLabel: t('crm.werbung.builder.baum.entfernenKurz', 'Entfernen'),
      tone: 'danger',
    })
    if (!ok) return
    e.update(d => {
      if (as) return { ...d, adsets: d.adsets.filter(a => a.key !== node), ads: d.ads.filter(a => a.adset_key !== node) }
      const weg = [node, ...(partner ? [partner.key] : [])]
      return { ...d, ads: d.ads.filter(a => weg.indexOf(a.key) < 0) }
    })
    setSel(as ? 'campaign' : (ad?.adset_key ?? 'campaign'))
  }

  // ── Meta ──────────────────────────────────────────────────────────────────
  const pruefen = async () => {
    setPruefLaeuft(true)
    try {
      const v = await e.pruefen()
      if (v.ok) toast.success(t('crm.werbung.builder.pruefOk', 'Meta hat den Entwurf geprüft: keine Fehler.'))
      else toast.info(t('crm.werbung.builder.pruefMitFehlern', 'Meta hat den Entwurf geprüft und meldet Fehler. Details rechts.'))
    } catch (err) {
      toast.error(fehlerText(err, t))
    } finally {
      setPruefLaeuft(false)
    }
  }

  const hatNeues = !e.spec.campaign.existing_id || e.spec.adsets.some(a => !a.existing_id) || e.spec.ads.some(a => !a.existing_id)
  const metaFehler = !!e.validation && !e.pruefungVeraltet && e.validation.meta.some(r => !r.ok && !r.skipped)
  const blocker = lintHasBlockers(e.lint)
  const forceOk = istAdmin && forceGrund.trim().length >= 10
  const fortsetzen = e.status === 'partial' || e.status === 'failed' || e.status === 'creating'
  const gruende: string[] = []
  if (schreibSperre) gruende.push(`${schreibSperre}.`)
  if (!hatNeues) gruende.push(t('crm.werbung.builder.grund.nichtsNeues', 'Nichts Neues zum Anlegen.'))
  if (hasErrors(e.issues)) gruende.push(t('crm.werbung.builder.grund.fehler', 'Erst die Fehler beheben (rote Punkte).'))
  if (blocker && !forceOk) {
    gruende.push(istAdmin
      ? t('crm.werbung.builder.grund.blockerAdmin', 'Compliance-Blocker beheben oder im Prüfbereich eine Begründung eintragen.')
      : t('crm.werbung.builder.grund.blocker', 'Erst die Compliance-Blocker beheben.'))
  }
  if (e.pruefungVeraltet) gruende.push(t('crm.werbung.builder.grund.pruefen', 'Erst „Prüfen bei Meta“ (gilt 30 Minuten).'))
  else if (metaFehler) gruende.push(t('crm.werbung.builder.grund.metaFehler', 'Meta meldet noch Fehler.'))
  const darfAnlegen = gruende.length === 0 && !e.fortschritt.laeuft && !e.nurLesen

  const anlegen = async () => {
    const ok = await confirm({
      title: t('crm.werbung.builder.anlegenTitel', 'Bei Meta anlegen?'),
      message: t('crm.werbung.builder.anlegenText', 'Alles wird pausiert angelegt. Es entstehen keine Kosten, bis jemand aktiviert.'),
      confirmLabel: fortsetzen ? t('crm.werbung.builder.fortsetzen', 'Fortsetzen') : t('crm.werbung.builder.anlegenKurz', 'Anlegen'),
    })
    if (!ok) return
    try {
      const r = await e.anlegen(blocker && forceOk ? forceGrund.trim() : undefined)
      if (r?.error) toast.error(r.error.hint || r.error.error)
      else if (r && !r.next) toast.success(t('crm.werbung.builder.angelegt', 'Bei Meta angelegt (pausiert).'))
      else toast.info(t('crm.werbung.builder.teilweise', 'Teilweise angelegt. „Fortsetzen“ macht weiter.'))
    } catch (err) {
      toast.error(fehlerText(err, t))
    }
  }

  const lp = leitplanke
  const kannAktivieren = e.status === 'created' && !schreibSperre && !e.fortschritt.laeuft
  const aktivieren = async () => {
    const zeile = t('crm.werbung.builder.pruef.leitplankeZeile', 'heute aktiv {{aktiv}} + diese Kampagne {{diese}} ≤ Limit {{limit}}', {
      aktiv: lp.aktivEur === null ? '?' : fmt.eur(lp.aktivEur), diese: fmt.eur(lp.dieseEur), limit: lp.limitEur === null ? '?' : fmt.eur(lp.limitEur),
    })
    const ok = await confirm({
      title: t('crm.werbung.builder.aktivierenTitel', 'Kampagne jetzt aktivieren?'),
      message: (
        <span className="block space-y-2">
          <span className="block">{t('crm.werbung.builder.aktivierenText', 'Meta beginnt sofort mit der Auslieferung und es entstehen Kosten. Anzeigen, Anzeigengruppen und Kampagne werden aktiv geschaltet.')}</span>
          <span className={`block rounded-lg px-2 py-1 text-xs tabular-nums ${lp.ok === false ? 'bg-red-50 text-red-800' : 'bg-gray-50 text-gray-700'}`}>{zeile}</span>
        </span>
      ),
      confirmLabel: t('crm.werbung.builder.aktivierenKurz', 'Aktivieren'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const r = await e.aktivieren()
      toast.success(t('crm.werbung.builder.aktiviert', 'Aktiviert: {{n}} Objekte laufen. Heute aktiv danach {{eur}}.', { n: r.activated.length, eur: fmt.eur(r.guardrail.afterEur) }))
    } catch (err) {
      if (fehlerCode(err) === 'guardrail_exceeded') toast.error(t('crm.werbung.builder.fehler.guardrail_exceeded', 'Das Tageslimit des Werbekontos würde überschritten.'))
      else toast.error(fehlerText(err, t))
    }
  }

  const verwerfen = async () => {
    const ok = await confirm({
      title: t('crm.werbung.builder.verwerfenTitel', 'Entwurf verwerfen?'),
      message: t('crm.werbung.builder.verwerfenText', 'Der Entwurf verschwindet aus der Liste. Bei Meta wird nichts gelöscht.'),
      confirmLabel: t('crm.werbung.builder.verwerfen', 'Verwerfen'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      await e.verwerfen()
      toast.success(t('crm.werbung.builder.verworfen', 'Entwurf verworfen'))
      onClose()
    } catch (err) {
      toast.error(fehlerText(err, t))
    }
  }

  // ── Bearbeiten: Änderungen prüfen und übernehmen ─────────────────────────
  const aenderungenPruefen = async () => {
    setDiffOffen(true)
    setDiffLaedt(true)
    setDiff(null)
    setDiffFehler(null)
    setErgebnis(null)
    setHousingVerlangt(false)
    try {
      setDiff(await e.aenderungenLaden())
    } catch (err) {
      setDiffFehler(err instanceof Error && err.message === 'nicht_gespeichert'
        ? t('crm.werbung.bearbeiten.nichtGespeichert', 'Der Entwurf ließ sich nicht speichern. Bitte Verbindung prüfen und noch einmal.')
        : fehlerText(err, t))
    } finally {
      setDiffLaedt(false)
    }
  }

  const aenderungenUebernehmen = async (gruende: UebernehmenGruende) => {
    setUebernimmt(true)
    try {
      const r = await e.aenderungenUebernehmen(gruende)
      setErgebnis(r)
      if (r.failed.length) toast.info(t('crm.werbung.bearbeiten.teilweiseUebernommen', '{{n}} Änderungen übernommen, {{f}} fehlgeschlagen.', { n: r.applied.length, f: r.failed.length }))
      else toast.success(t('crm.werbung.bearbeiten.uebernommen', '{{n}} Änderungen bei Meta übernommen.', { n: r.applied.length }))
    } catch (err) {
      // Kampagne ohne Wohnen: Zusammenfassung stehen lassen, Admin kann begründen
      if (fehlerCode(err) === 'housing_required') {
        setHousingVerlangt(true)
        toast.error(fehlerText(err, t))
        return
      }
      if (fehlerCode(err) === 'guardrail_exceeded') setDiffFehler(t('crm.werbung.builder.fehler.guardrail_exceeded', 'Das Tageslimit des Werbekontos würde überschritten.'))
      else setDiffFehler(err instanceof Error && err.message === 'nicht_gespeichert'
        ? t('crm.werbung.bearbeiten.nichtGespeichert', 'Der Entwurf ließ sich nicht speichern. Bitte Verbindung prüfen und noch einmal.')
        : fehlerText(err, t))
      setDiff(null)
    } finally {
      setUebernimmt(false)
    }
  }

  const neuVonMeta = async () => {
    const ziel = e.ziel
    if (!onNeuVonMeta || !ziel) return
    const ok = await confirm({
      title: t('crm.werbung.bearbeiten.neuLadenTitel', 'Neu von Meta laden?'),
      message: t('crm.werbung.bearbeiten.neuLadenText', 'Deine noch nicht übernommenen Änderungen gehen verloren. Bei Meta ändert sich nichts.'),
      confirmLabel: t('crm.werbung.bearbeiten.neuLaden', 'Neu von Meta laden'),
    })
    if (!ok) return
    // Erst Speichern stoppen und abwarten, sonst überschriebe dieser alte Stand die frisch geladene Zeile
    const freigeben = await e.einfrieren()
    const geladen = await onNeuVonMeta(ziel)
    if (!geladen) freigeben()
  }

  const schliessen = async () => {
    if (schliesst) return
    setSchliesst(true)
    try { await e.sichern() } finally { onClose() }
  }

  const idx = knoten.findIndex(k => k.node === sel)
  const naechster = idx >= 0 && idx < knoten.length - 1 ? knoten[idx + 1] : null
  const selAd = e.spec.ads.find(a => a.key === sel)
    ?? e.spec.ads.find(a => a.adset_key === sel)
    ?? e.spec.ads[0]
  const istGruppe = e.spec.adsets.some(a => a.key === sel)
  const istAnzeige = e.spec.ads.some(a => a.key === sel)

  const speicherText = {
    ruhig: '',
    wartet: t('crm.werbung.builder.speichern.wartet', 'Änderungen …'),
    laeuft: t('crm.werbung.builder.speichern.laeuft', 'Speichert …'),
    gespeichert: t('crm.werbung.builder.speichern.gespeichert', 'Gespeichert'),
    fehler: t('crm.werbung.builder.speichern.fehler', 'Nicht gespeichert'),
  }[e.speichern]

  const fs = e.fortschritt
  const fsProzent = fs.gesamt > 0 ? Math.min(100, Math.round((fs.erledigt.length / fs.gesamt) * 100)) : 0

  const titel = (
    <span className="flex flex-wrap items-center gap-2">
      {bearbeiten && <Badge tone="info">{t('crm.werbung.bearbeiten.badge', 'Bearbeiten')}</Badge>}
      <span className="min-w-0 truncate">{e.spec.campaign.name || ersatzName}</span>
      {e.status && !bearbeiten && <StatusBadge status={e.status} />}
      {gepaart && <Badge tone="info">{t('crm.werbung.builder.planB', 'Plan B')}</Badge>}
    </span>
  )

  const footerBearbeiten = (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 text-[11px] text-gray-500 sm:mr-auto">
        <span className={e.speichern === 'fehler' ? 'font-semibold text-red-700' : ''} title={e.speicherFehler ?? undefined}>{speicherText}</span>
        {' '}
        <span>{e.lokalDiff
          ? t('crm.werbung.bearbeiten.anzahlLokal', '{{n}} Änderungen gegenüber Meta', { n: anzahlAenderungen })
          : t('crm.werbung.bearbeiten.vergleichFehlt', 'Vergleich mit Meta beim Prüfen.')}</span>
      </div>
      <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
        <button type="button" onClick={() => void schliessen()} className="hp-btn hp-btn-ghost px-2 text-sm">{t('crm.werbung.builder.schliessen', 'Schließen')}</button>
        {e.id && e.status !== 'discarded' ? (
          <button type="button" onClick={() => void verwerfen()} className="hp-btn hp-btn-ghost px-2 text-sm text-red-700">{t('crm.werbung.builder.verwerfen', 'Verwerfen')}</button>
        ) : <span className="sm:hidden" />}
        {naechster ? (
          <button type="button" onClick={() => setSel(naechster.node)} className="hp-btn hp-btn-ghost px-2 text-sm">{t('crm.werbung.builder.weiter', 'Weiter')}</button>
        ) : <span className="sm:hidden" />}
      </div>
      <button type="button" onClick={() => void aenderungenPruefen()} disabled={e.nurLesen || diffLaedt}
        className="hp-btn hp-btn-primary disabled:opacity-50">
        {diffLaedt && <Spinner size="sm" />}
        {t('crm.werbung.bearbeiten.pruefen', 'Änderungen prüfen')}
        {e.lokalDiff && anzahlAenderungen > 0 && <span className="ml-1 rounded-full bg-white/20 px-1.5 text-xs tabular-nums">{anzahlAenderungen}</span>}
      </button>
    </div>
  )

  const footer = (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center">
      <div className="min-w-0 text-[11px] text-gray-500 sm:mr-auto">
        <span className={e.speichern === 'fehler' ? 'font-semibold text-red-700' : ''} title={e.speicherFehler ?? undefined}>{speicherText}</span>
        {!e.nurLesen && gruende.length > 0 && e.status !== 'created' && (
          <span className="line-clamp-2 text-gray-500 sm:line-clamp-none" title={gruende.join(' ')}>
            {t('crm.werbung.builder.grund.titel', 'Anlegen noch nicht möglich:')} {gruende.join(' ')}
          </span>
        )}
      </div>
      {/* Telefon: Nebenaktionen in einer Zeile, Prüfen und Anlegen darunter; ab sm alles in einer Reihe */}
      <div className="grid grid-cols-3 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end">
        <button type="button" onClick={() => void schliessen()} className="hp-btn hp-btn-ghost px-2 text-sm">{t('crm.werbung.builder.schliessen', 'Schließen')}</button>
        {e.id && e.status !== 'created' && e.status !== 'creating' && e.status !== 'discarded' ? (
          <button type="button" onClick={() => void verwerfen()} className="hp-btn hp-btn-ghost px-2 text-sm text-red-700">{t('crm.werbung.builder.verwerfen', 'Verwerfen')}</button>
        ) : <span className="sm:hidden" />}
        {naechster ? (
          <button type="button" onClick={() => setSel(naechster.node)} className="hp-btn hp-btn-ghost px-2 text-sm">{t('crm.werbung.builder.weiter', 'Weiter')}</button>
        ) : <span className="sm:hidden" />}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        {!e.nurLesen && (
          <button type="button" onClick={() => void pruefen()} disabled={pruefLaeuft} className="hp-btn hp-btn-accent disabled:opacity-50">
            {pruefLaeuft && <Spinner size="sm" />}
            {t('crm.werbung.builder.pruef.beiMeta', 'Prüfen bei Meta')}
          </button>
        )}
        {e.status !== 'created' && e.status !== 'discarded' && (
          <button type="button" onClick={() => void anlegen()} disabled={!darfAnlegen}
            title={gruende.join(' ') || undefined} className="hp-btn hp-btn-primary disabled:opacity-50">
            {fs.laeuft && <Spinner size="sm" />}
            {fortsetzen ? t('crm.werbung.builder.fortsetzenLang', 'Anlegen fortsetzen (pausiert)') : t('crm.werbung.builder.anlegen', 'Bei Meta anlegen (pausiert)')}
          </button>
        )}
        {e.status === 'created' && (
          <button type="button" onClick={() => void aktivieren()} disabled={!kannAktivieren}
            title={schreibSperre ?? undefined} className="hp-btn hp-btn-primary disabled:opacity-50">
            {t('crm.werbung.builder.aktivieren', 'Aktivieren …')}
          </button>
        )}
      </div>
    </div>
  )

  return (
    <AssistentKontext.Provider value={werte}>
      <Modal open onClose={() => void schliessen()} size="full" title={titel} footer={bearbeiten ? footerBearbeiten : footer} closeOnBackdrop={false} bodyClassName="p-0">
        {e.laden ? (
          <div className="flex justify-center py-24"><Spinner size="lg" /></div>
        ) : e.ladeFehler ? (
          <div className="p-6 text-sm text-red-700">{t('crm.werbung.builder.ladeFehler', 'Der Entwurf konnte nicht geladen werden: {{fehler}}', { fehler: e.ladeFehler })}</div>
        ) : (
          <div className="flex flex-col lg:grid lg:h-full lg:grid-cols-[15rem_minmax(0,1fr)_22rem]">
            <aside className="border-b border-gray-100 p-3 lg:min-h-0 lg:overflow-y-auto lg:border-b-0 lg:border-r">
              <EntwurfBaum sel={sel} onSelect={setSel} onNeueGruppe={neueGruppe} onNeueAnzeige={neueAnz}
                onNeuesPaar={neuesPaar} onDuplizieren={duplizieren} onEntfernen={n => void entfernen(n)}
                geaendert={geaenderteKnoten} />
            </aside>

            <div ref={mitteRef} className="min-w-0 space-y-3 bg-hp-cream/40 p-3 sm:p-4 lg:min-h-0 lg:overflow-y-auto">
              <div className="flex items-center gap-2">
                <input type="search" value={suche} onChange={ev => setSuche(ev.target.value)} onKeyDown={sucheTaste}
                  placeholder={t('crm.werbung.bearbeiten.suche', 'Einstellung finden …')} aria-label={t('crm.werbung.bearbeiten.suche', 'Einstellung finden …')}
                  className="min-w-0 flex-1 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-orange-200" />
                <button type="button" onClick={finde} disabled={!suche.trim()} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1.5 text-xs disabled:opacity-50">
                  {t('crm.werbung.bearbeiten.finden', 'Finden')}
                </button>
              </div>
              {bearbeiten && (
                <div role="note" className="rounded-lg border border-hp-navy/15 bg-white px-3 py-2 text-xs text-hp-navy">
                  <span className="font-semibold">{t('crm.werbung.bearbeiten.bannerTitel', 'Du bearbeitest laufende Werbung bei Meta.')}</span>{' '}
                  {t('crm.werbung.bearbeiten.bannerText', 'Gespeichert wird nur hier. Erst „Änderungen prüfen“ zeigt, was sich bei Meta ändert, und erst deine Bestätigung schreibt es. 🔒-Felder lässt Meta nicht mehr ändern.')}
                  {onNeuVonMeta && e.ziel && (
                    <button type="button" onClick={() => void neuVonMeta()} className="ml-1 font-semibold underline">
                      {t('crm.werbung.bearbeiten.neuLaden', 'Neu von Meta laden')}
                    </button>
                  )}
                </div>
              )}
              {schreibSperre && (
                <div role="note" className="rounded-lg border border-hp-navy/15 bg-white px-3 py-2 text-xs text-hp-navy">
                  <span className="font-semibold">{schreibSperre}.</span>{' '}
                  {t('crm.werbung.builder.gesperrtText', 'Entwürfe kannst du schon bauen und lokal prüfen. Medien hochladen, Meta-Vorschau, Anlegen und Aktivieren gehen erst nach der Freischaltung.')}
                </div>
              )}
              {katalogFehler && (
                <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  {t('crm.werbung.builder.katalogFehler', 'Seiten, Pixel und Formulare von Meta konnten nicht geladen werden ({{fehler}}). IDs lassen sich trotzdem von Hand eintragen.', { fehler: katalogFehler })}
                </div>
              )}
              {start.art !== 'laden' && (start.hinweise ?? []).length > 0 && (sel === 'campaign' || bearbeiten) && (
                <div role="note" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  <p className="font-semibold">{t('crm.werbung.builder.importHinweise', 'Hinweise zur Übernahme:')}</p>
                  <ul className="mt-0.5 list-disc pl-4">{(start.hinweise ?? []).map((h, i) => <li key={i}>{h}</li>)}</ul>
                </div>
              )}
              {e.nurLesen && e.status !== 'discarded' && !bearbeiten && (
                <div role="note" className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
                  {e.status === 'created'
                    ? t('crm.werbung.builder.nurLesenAngelegt', 'Bei Meta angelegt (pausiert). Der Entwurf ist jetzt schreibgeschützt; Änderungen bitte als neuen Entwurf.')
                    : t('crm.werbung.builder.nurLesenLaeuft', 'Wird gerade bei Meta angelegt. Der Entwurf ist so lange schreibgeschützt.')}
                </div>
              )}
              {(fs.laeuft || fs.erledigt.length > 0) && (
                <div role="status" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-hp-navy">
                      {fs.laeuft ? t('crm.werbung.builder.fortschritt.laeuft', 'Wird bei Meta angelegt …') : t('crm.werbung.builder.fortschritt.fertig', 'Anlegen beendet')}
                    </span>
                    <span className="tabular-nums text-gray-500">{t('crm.werbung.builder.fortschritt.schritte', '{{n}} von {{m}} Schritten', { n: fs.erledigt.length, m: Math.max(fs.gesamt, fs.erledigt.length) })}</span>
                  </div>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100">
                    <div className="h-full rounded-full bg-hp-navy transition-[width] duration-300" style={{ width: `${fsProzent}%` }} />
                  </div>
                  {fs.naechster && <p className="mt-1 text-[11px] text-gray-500">{t('crm.werbung.builder.fortschritt.naechster', 'Als Nächstes: {{schritt}}', { schritt: fs.naechster })}</p>}
                  {fs.fehler && <p className="mt-1 text-[11px] text-red-700">{fs.fehler}</p>}
                </div>
              )}
              {e.lastError && !fs.laeuft && e.status !== 'created' && (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                  <span className="font-semibold">{t('crm.werbung.builder.letzterFehler', 'Letzter Fehler beim Anlegen')}</span>
                  {' '}({e.lastError.step}{e.lastError.key ? ` · ${e.lastError.key}` : ''}): {e.lastError.user_msg ?? String(e.lastError.code ?? '')}
                </div>
              )}

              {istAnzeige ? <AnzeigenFormular key={sel} adKey={sel} />
                : istGruppe ? <AnzeigengruppenFormular key={sel} adsetKey={sel} />
                  : <KampagnenFormular />}
            </div>

            <aside className="space-y-5 border-t border-gray-100 p-3 sm:p-4 lg:min-h-0 lg:overflow-y-auto lg:border-l lg:border-t-0">
              <VorschauPanel ad={selAd} />
              <PruefPanel leitplanke={leitplanke} onPruefen={() => void pruefen()} pruefLaeuft={pruefLaeuft}
                istAdmin={istAdmin} forceGrund={forceGrund} setForceGrund={setForceGrund}
                onAenderungenPruefen={() => void aenderungenPruefen()} anzahlAenderungen={e.lokalDiff ? anzahlAenderungen : null} />
            </aside>
          </div>
        )}
      </Modal>

      {bearbeiten && (
        <AenderungenDialog offen={diffOffen} laedt={diffLaedt} diff={diff} fehler={diffFehler} ergebnis={ergebnis} uebernimmt={uebernimmt}
          spec={e.spec} kurs={kurs} istAdmin={istAdmin} schreibSperre={schreibSperre} housingVerlangt={housingVerlangt}
          onClose={() => setDiffOffen(false)}
          onUebernehmen={g => void aenderungenUebernehmen(g)}
          onWeiter={() => { setDiffOffen(false); setErgebnis(null) }}
          onFertig={() => { setDiffOffen(false); onClose() }}
          onSpringe={(node, field) => { setDiffOffen(false); springeZu(node, field) }} />
      )}
      <DuplizierenDialog offen={dupItems.length > 0} items={dupItems} onClose={() => setDupItems([])} />
    </AssistentKontext.Provider>
  )
}
