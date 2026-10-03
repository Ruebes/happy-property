import { useEffect, useId, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  PIXEL_EREIGNISSE, WEBSITE_MAX_REGELN, WEBSITE_MAX_TAGE, WEBSITE_REGEL_ART_LABEL,
  type AudienceCreateWebsiteRequest, type WebsiteRegel, type WebsiteRegelArt,
} from '../../../../lib/werbeWerkzeuge'
import AssistentRahmen, { zielgruppeErfolg } from './AssistentRahmen'
import { Abschnitt, EINGABE_KLEIN, Einstellung, Hinweis, Kacheln } from './Bausteine'
import { useKatalog, type WerkzeugStatus } from './useWerkzeugStatus'
import { werkzeugCall } from './werkzeugeApi'

// ── Assistent „Website-Besucher" (Pixel-Regeln) ──────────────────────────────
// Vorlagen für Happy Property (Seitenbesucher ohne Termin, Funnel-Abbrecher,
// schon gebucht zum Ausschließen) oder eigene Regeln. Unter Wohnen erlaubt
// (Retargeting). Anlegen: meta-werkzeuge audience_create_website.

export interface ZielgruppenAssistentProps {
  offen: boolean
  onClose: () => void
  onZurueck: () => void
  /** Nach erfolgreichem Anlegen (Liste neu laden) */
  onFertig: () => void
  status: WerkzeugStatus
}

interface RegelZeile extends WebsiteRegel { id: number }

type Vorlage = 'ohne_termin' | 'funnel' | 'gebucht' | 'eigene'

// Seiten von Happy Property mit Pixel: Termin-Funnel im Portal, Plan-B- und Investoren-Landingpages
interface Vorschlag { id: string; regel: WebsiteRegel }
const VORSCHLAEGE: Vorschlag[] = [
  { id: 'termin', regel: { art: 'url_enthaelt', wert: '/termin' } },
  { id: 'planb', regel: { art: 'url_enthaelt', wert: 'vermoegen-absichern-zypern' } },
  { id: 'planbKurz', regel: { art: 'url_enthaelt', wert: 'vermoegen-absichern-zypern-kompakt' } },
  { id: 'investor', regel: { art: 'url_enthaelt', wert: 'immobilieninvestor-zypern' } },
  { id: 'lead', regel: { art: 'event', wert: 'Lead' } },
  { id: 'schedule', regel: { art: 'event', wert: 'Schedule' } },
]

let naechsteId = 1
const zeile = (r: WebsiteRegel): RegelZeile => ({ ...r, id: naechsteId++ })

// ausschlussTage: wie weit der Ausschluss zurückschaut. Wer in den letzten 180
// Tagen gebucht hat, bleibt draußen, auch wenn die Zielgruppe selbst nur 30 Tage
// umfasst (sonst ginge Geld an Gebuchte von vor 31 bis 180 Tagen).
const AUSSCHLUSS_TAGE_STANDARD = 180
const VORLAGEN: Record<Vorlage, { regeln: WebsiteRegel[]; ausschluss: WebsiteRegel[]; tage: number; ausschlussTage: number }> = {
  ohne_termin: {
    regeln: [VORSCHLAEGE[0].regel, VORSCHLAEGE[1].regel, VORSCHLAEGE[3].regel],
    ausschluss: [{ art: 'event', wert: 'Schedule' }],
    tage: 30,
    ausschlussTage: AUSSCHLUSS_TAGE_STANDARD,
  },
  funnel: { regeln: [VORSCHLAEGE[0].regel], ausschluss: [{ art: 'event', wert: 'Schedule' }], tage: 14, ausschlussTage: AUSSCHLUSS_TAGE_STANDARD },
  gebucht: { regeln: [{ art: 'event', wert: 'Schedule' }], ausschluss: [], tage: 180, ausschlussTage: AUSSCHLUSS_TAGE_STANDARD },
  eigene: { regeln: [], ausschluss: [], tage: 30, ausschlussTage: AUSSCHLUSS_TAGE_STANDARD },
}

function vorlageName(t: TFunction, v: Vorlage, tage: number): string {
  switch (v) {
    case 'ohne_termin': return t('crm.werbung.zielgruppen.web.name.ohneTermin', 'Website-Besucher ohne Termin {{tage}} T', { tage })
    case 'funnel': return t('crm.werbung.zielgruppen.web.name.funnel', 'Termin-Funnel ohne Buchung {{tage}} T', { tage })
    case 'gebucht': return t('crm.werbung.zielgruppen.web.name.gebucht', 'Termin gebucht {{tage}} T', { tage })
    default: return t('crm.werbung.zielgruppen.web.name.eigene', 'Website-Besucher {{tage}} T', { tage })
  }
}

export function regelArtLabel(t: TFunction, a: WebsiteRegelArt): string {
  return t(`crm.werbung.zielgruppen.web.art.${a}`, WEBSITE_REGEL_ART_LABEL[a])
}

export function regelText(t: TFunction, r: WebsiteRegel): string {
  return r.art === 'event'
    ? t('crm.werbung.zielgruppen.web.regelEvent', 'Ereignis „{{wert}}“', { wert: r.wert })
    : t('crm.werbung.zielgruppen.web.regelUrl', '{{art}} „{{wert}}“', { art: regelArtLabel(t, r.art), wert: r.wert })
}

/** Liste von Regeln mit Hinzufügen/Entfernen */
function RegelListe({ regeln, onChange, leerText, und = false }: { regeln: RegelZeile[]; onChange: (r: RegelZeile[]) => void; leerText: string; und?: boolean }) {
  const { t } = useTranslation()
  const listId = useId()
  const setze = (id: number, patch: Partial<WebsiteRegel>) => onChange(regeln.map(r => (r.id === id ? { ...r, ...patch } : r)))
  return (
    <div className="space-y-2">
      {regeln.length === 0 && <p className="text-xs text-gray-500">{leerText}</p>}
      {regeln.map((r, i) => (
        <div key={r.id} className="flex flex-col gap-2 rounded-lg border border-gray-200 p-2 sm:flex-row sm:items-center">
          <span className="text-xs text-gray-400 sm:w-8">{i > 0 ? (und ? t('crm.werbung.zielgruppen.web.und', 'und') : t('crm.werbung.zielgruppen.web.oder', 'oder')) : ''}</span>
          <select value={r.art} aria-label={t('crm.werbung.zielgruppen.web.regelArt', 'Art der Regel')}
            onChange={e => {
              const art = e.target.value as WebsiteRegelArt
              setze(r.id, { art, wert: art === 'event' ? 'Lead' : r.art === 'event' ? '' : r.wert })
            }}
            className={`${EINGABE_KLEIN} sm:w-40`}>
            {(['url_enthaelt', 'url_gleich', 'event'] as const).map(a => <option key={a} value={a}>{regelArtLabel(t, a)}</option>)}
          </select>
          {r.art === 'event' ? (
            <>
              <input value={r.wert} list={listId} onChange={e => setze(r.id, { wert: e.target.value })}
                aria-label={t('crm.werbung.zielgruppen.web.ereignis', 'Ereignis')} className={`${EINGABE_KLEIN} sm:flex-1`} />
              <datalist id={listId}>{PIXEL_EREIGNISSE.map(ev => <option key={ev} value={ev} />)}</datalist>
            </>
          ) : (
            <input value={r.wert} onChange={e => setze(r.id, { wert: e.target.value })}
              placeholder={r.art === 'url_gleich' ? 'https://portal.happy-property.com/termin' : '/termin'}
              aria-label={t('crm.werbung.zielgruppen.web.wert', 'Teil der Adresse')} className={`${EINGABE_KLEIN} sm:flex-1`} />
          )}
          <button type="button" onClick={() => onChange(regeln.filter(x => x.id !== r.id))}
            className="hp-btn hp-btn-ghost min-h-0 px-2 py-1 text-xs" aria-label={t('crm.werbung.zielgruppen.web.entfernen', 'Regel entfernen')}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" disabled={regeln.length >= WEBSITE_MAX_REGELN} onClick={() => onChange([...regeln, zeile({ art: 'url_enthaelt', wert: '' })])} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
        + {t('crm.werbung.zielgruppen.web.regelNeu', 'Regel hinzufügen')}
      </button>
    </div>
  )
}

export default function WebsiteBesucher({ offen, onClose, onZurueck, onFertig, status }: ZielgruppenAssistentProps) {
  const { t } = useTranslation()
  const { katalog } = useKatalog(offen)
  const [vorlage, setVorlage] = useState<Vorlage>('ohne_termin')
  const [regeln, setRegeln] = useState<RegelZeile[]>(() => VORLAGEN.ohne_termin.regeln.map(zeile))
  const [ausschluss, setAusschluss] = useState<RegelZeile[]>(() => VORLAGEN.ohne_termin.ausschluss.map(zeile))
  const [tage, setTage] = useState<string>('30')
  const [ausschlussTage, setAusschlussTage] = useState<string>(String(VORLAGEN.ohne_termin.ausschlussTage))
  const [name, setName] = useState('')
  const [nameEigen, setNameEigen] = useState(false)
  const [pixelId, setPixelId] = useState('')
  const [verknuepfung, setVerknuepfung] = useState<'oder' | 'und'>('oder')

  const tageZahl = Number(tage)
  const ausschlussTageZahl = Number(ausschlussTage)
  useEffect(() => {
    if (!nameEigen) setName(vorlageName(t, vorlage, Number.isFinite(tageZahl) && tageZahl > 0 ? tageZahl : 30))
  }, [vorlage, tageZahl, nameEigen, t])
  useEffect(() => { if (!pixelId && status.einstellungen?.pixelId) setPixelId(status.einstellungen.pixelId) }, [status.einstellungen, pixelId])

  const waehleVorlage = (v: Vorlage) => {
    setVorlage(v)
    setRegeln(VORLAGEN[v].regeln.map(zeile))
    setAusschluss(VORLAGEN[v].ausschluss.map(zeile))
    setTage(String(VORLAGEN[v].tage))
    setAusschlussTage(String(VORLAGEN[v].ausschlussTage))
  }

  const vorschlagNutzen = (v: Vorschlag) => {
    if (regeln.some(r => r.art === v.regel.art && r.wert === v.regel.wert)) return
    setRegeln([...regeln.filter(r => r.wert.trim()), zeile(v.regel)])
  }

  const sauber = (liste: RegelZeile[]): WebsiteRegel[] => liste
    .map(r => ({ art: r.art, wert: r.wert.trim() }))
    .filter(r => r.wert)

  const fehler = useMemo(() => {
    const f: string[] = []
    if (!name.trim()) f.push(t('crm.werbung.zielgruppen.pflicht.name', 'Name der Zielgruppe'))
    else if (name.trim().length > 200) f.push(t('crm.werbung.zielgruppen.pflicht.nameLang', 'Name höchstens 200 Zeichen'))
    if (!sauber(regeln).length) f.push(t('crm.werbung.zielgruppen.web.pflicht.regel', 'Mindestens eine Regel mit Inhalt'))
    if ([...regeln, ...ausschluss].some(r => r.art === 'url_gleich' && r.wert.trim() && !/^https:\/\/\S+$/i.test(r.wert.trim()))) {
      f.push(t('crm.werbung.zielgruppen.web.pflicht.urlGleich', '„URL ist gleich“ braucht die volle Adresse mit https://'))
    }
    if (!Number.isInteger(tageZahl) || tageZahl < 1 || tageZahl > WEBSITE_MAX_TAGE) f.push(t('crm.werbung.zielgruppen.web.pflicht.tage', 'Zeitraum zwischen 1 und {{max}} Tagen', { max: WEBSITE_MAX_TAGE }))
    if (sauber(ausschluss).length && (!Number.isInteger(ausschlussTageZahl) || ausschlussTageZahl < 1 || ausschlussTageZahl > WEBSITE_MAX_TAGE)) {
      f.push(t('crm.werbung.zielgruppen.web.pflicht.ausschlussTage', 'Ausschluss-Zeitraum zwischen 1 und {{max}} Tagen', { max: WEBSITE_MAX_TAGE }))
    }
    if (regeln.length > WEBSITE_MAX_REGELN || ausschluss.length > WEBSITE_MAX_REGELN) f.push(t('crm.werbung.zielgruppen.web.pflicht.maxRegeln', 'Höchstens {{n}} Regeln je Liste', { n: WEBSITE_MAX_REGELN }))
    if (pixelId.trim() && !/^\d{10,20}$/.test(pixelId.trim())) f.push(t('crm.werbung.zielgruppen.web.pflicht.pixel', 'Pixel-ID nur aus Ziffern'))
    return f
    // sauber ist eine reine Funktion der Regeln
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, regeln, ausschluss, tageZahl, ausschlussTageZahl, pixelId, t])


  const pixel = katalog?.pixels ?? []
  const vorschlagLabel = (id: string): string => {
    switch (id) {
      case 'termin': return t('crm.werbung.zielgruppen.web.vorschlag.termin', 'Terminseite /termin')
      case 'planb': return t('crm.werbung.zielgruppen.web.vorschlag.planb', 'Plan-B-Seite')
      case 'planbKurz': return t('crm.werbung.zielgruppen.web.vorschlag.planbKurz', 'Plan-B-Seite kompakt')
      case 'investor': return t('crm.werbung.zielgruppen.web.vorschlag.investor', 'Investoren-Seite')
      case 'lead': return t('crm.werbung.zielgruppen.web.vorschlag.lead', 'Ereignis Lead')
      case 'schedule': return t('crm.werbung.zielgruppen.web.vorschlag.schedule', 'Ereignis Termin gebucht')
      default: return id
    }
  }

  const aenderung = () => {
    const r = sauber(regeln)
    const a = sauber(ausschluss)
    return {
      punkte: [
        { art: 'neu' as const, text: t('crm.werbung.zielgruppen.web.aenderung.neu', 'Neue Website-Zielgruppe „{{name}}“ im Werbekonto', { name: name.trim() }) },
        { art: 'neu' as const, text: verknuepfung === 'und'
          ? t('crm.werbung.zielgruppen.web.aenderung.regelnUnd', 'Drin ist, wer in den letzten {{tage}} Tagen alles davon erfüllt: {{regeln}}', { tage: tageZahl, regeln: r.map(x => regelText(t, x)).join(', ') })
          : t('crm.werbung.zielgruppen.web.aenderung.regeln', 'Drin ist, wer in den letzten {{tage}} Tagen eines davon erfüllt: {{regeln}}', { tage: tageZahl, regeln: r.map(x => regelText(t, x)).join(', ') }) },
        ...(a.length ? [{ art: 'neu' as const, text: t('crm.werbung.zielgruppen.web.aenderung.ausschlussTage', 'Ausgeschlossen, wer in den letzten {{tage}} Tagen eines davon erfüllt: {{regeln}}', { tage: ausschlussTageZahl, regeln: a.map(x => regelText(t, x)).join(', ') }) }] : []),
        { art: 'gleich' as const, text: t('crm.werbung.zielgruppen.aenderung.nichtsSonst', 'Keine Kampagne, Anzeigengruppe oder Anzeige ändert sich.') },
      ],
      lernphase: t('crm.werbung.zielgruppen.aenderung.lernphaseZielgruppe', 'Startet nicht neu. Erst wenn du die Zielgruppe in einer laufenden Anzeigengruppe einsetzt, beginnt dort die Lernphase neu.'),
      warnungen: [t('crm.werbung.zielgruppen.aenderung.befuellen', 'Meta befüllt neue Zielgruppen nach und nach. Die Größe steht oft erst nach einigen Stunden da.')],
    }
  }

  const auftrag = (): AudienceCreateWebsiteRequest => ({
    name: name.trim(),
    ...(pixelId.trim() ? { pixel_id: pixelId.trim() } : {}),
    regeln: sauber(regeln),
    verknuepfung,
    tage: tageZahl,
    ...(sauber(ausschluss).length ? { ausschluss_regeln: sauber(ausschluss), ausschluss_tage: ausschlussTageZahl } : {}),
  })
  const ausfuehren = () => werkzeugCall('audience_create_website', auftrag())
  const vorschau = async () => ({ hinweise: (await werkzeugCall('audience_create_website', { ...auftrag(), vorschau: true })).hinweise ?? [] })

  const ausschlussKurz = sauber(ausschluss)

  return (
    <AssistentRahmen offen={offen} onClose={onClose} onZurueck={onZurueck} onFertig={onFertig}
      titel={t('crm.werbung.zielgruppen.web.titel', 'Neue Zielgruppe: Website-Besucher')}
      untertitel={t('crm.werbung.zielgruppen.web.untertitel', 'Personen, die bestimmte Seiten besucht oder ein Ereignis ausgelöst haben (Meta-Pixel). Ideal für Retargeting.')}
      fehler={fehler} schreibSperre={status.schreibSperre} pruefSperre={status.pruefSperre} aenderung={aenderung} ausfuehren={ausfuehren} vorschau={vorschau}
      anlegenText={t('crm.werbung.zielgruppen.anlegen', 'Bei Meta anlegen')}
      erfolgText={zielgruppeErfolg(t, name.trim())}>

      <Abschnitt nummer={1} titel={t('crm.werbung.zielgruppen.web.ziel', 'Wen willst du erreichen?')}>
        <Kacheln name="web-vorlage" wert={vorlage} onChange={waehleVorlage} optionen={[
          { wert: 'ohne_termin', empfohlen: true, titel: t('crm.werbung.zielgruppen.web.vorlage.ohneTermin', 'Besucher ohne Termin'), text: t('crm.werbung.zielgruppen.web.vorlage.ohneTerminText', 'Waren auf /termin, der Plan-B- oder Investoren-Seite, haben aber nicht gebucht (30 Tage).') },
          { wert: 'funnel', titel: t('crm.werbung.zielgruppen.web.vorlage.funnel', 'Abbrecher im Termin-Funnel'), text: t('crm.werbung.zielgruppen.web.vorlage.funnelText', 'Haben /termin geöffnet und nicht gebucht (14 Tage). Klein, aber sehr warm.') },
          { wert: 'gebucht', titel: t('crm.werbung.zielgruppen.web.vorlage.gebucht', 'Schon gebucht (zum Ausschließen)'), text: t('crm.werbung.zielgruppen.web.vorlage.gebuchtText', 'Alle mit Termin in 180 Tagen. In Neukunden-Anzeigen ausschließen, damit kein Geld an Gebuchte geht.') },
          { wert: 'eigene', titel: t('crm.werbung.zielgruppen.web.vorlage.eigene', 'Eigene Regeln'), text: t('crm.werbung.zielgruppen.web.vorlage.eigeneText', 'Seiten und Ereignisse selbst festlegen.') },
        ]} />
        <Einstellung fuer="web-name" label={t('crm.werbung.zielgruppen.feld.name', 'Name')}
          erklaerung={t('crm.werbung.zielgruppen.feld.nameHilfe', 'So heißt die Zielgruppe im Werbemanager und im Kampagnen-Assistenten.')}>
          <input id="web-name" value={name} maxLength={200} onChange={e => { setName(e.target.value); setNameEigen(true) }} className={EINGABE_KLEIN} />
        </Einstellung>
      </Abschnitt>

      <Abschnitt nummer={2} titel={t('crm.werbung.zielgruppen.web.regeln', 'Regeln')}
        alle={(
          <>
            <Einstellung fuer="web-verknuepfung" label={t('crm.werbung.zielgruppen.web.verknuepfung', 'Verknüpfung der Regeln')} empfohlen={verknuepfung === 'oder'}
              erklaerung={t('crm.werbung.zielgruppen.web.verknuepfungHilfe', '„Eine der Regeln reicht“ ergibt eine größere Zielgruppe. „Alle Regeln müssen zutreffen“ nur für enge Fälle, z. B. Seite besucht und Lead ausgelöst.')}>
              <select id="web-verknuepfung" value={verknuepfung} onChange={e => setVerknuepfung(e.target.value === 'und' ? 'und' : 'oder')} className={EINGABE_KLEIN}>
                <option value="oder">{t('crm.werbung.zielgruppen.web.oderLang', 'Eine der Regeln reicht')}</option>
                <option value="und">{t('crm.werbung.zielgruppen.web.undLang', 'Alle Regeln müssen zutreffen')}</option>
              </select>
            </Einstellung>
            <Einstellung label={t('crm.werbung.zielgruppen.web.ausschluss', 'Ausschließen')}
              erklaerung={t('crm.werbung.zielgruppen.web.ausschlussHilfe', 'Wer eine dieser Regeln erfüllt, ist nicht in der Zielgruppe, auch wenn er oben passt.')}>
              <RegelListe regeln={ausschluss} onChange={setAusschluss} leerText={t('crm.werbung.zielgruppen.web.keinAusschluss', 'Niemand wird ausgeschlossen.')} />
            </Einstellung>
            {ausschluss.length > 0 && (
              <Einstellung fuer="web-ausschluss-tage" label={t('crm.werbung.zielgruppen.web.ausschlussTage', 'Ausschluss-Zeitraum in Tagen')} empfohlen={ausschlussTageZahl === AUSSCHLUSS_TAGE_STANDARD}
                erklaerung={t('crm.werbung.zielgruppen.web.ausschlussTageHilfe', 'Wie weit der Ausschluss zurückschaut, unabhängig vom Zeitraum oben. 180 Tage: auch wer vor Monaten gebucht hat, bekommt keine Neukunden-Werbung.')}>
                <input id="web-ausschluss-tage" type="number" min={1} max={WEBSITE_MAX_TAGE} value={ausschlussTage} onChange={e => setAusschlussTage(e.target.value)} className={`${EINGABE_KLEIN} w-24`} />
              </Einstellung>
            )}
            <Einstellung fuer="web-pixel" label={t('crm.werbung.zielgruppen.web.pixel', 'Pixel (Datensatz)')}
              erklaerung={t('crm.werbung.zielgruppen.web.pixelHilfe', 'Aus welchem Pixel die Besuche kommen. Vorgabe: Standard-Pixel aus den Werbe-Einstellungen.')}>
              {pixel.length > 0 ? (
                <select id="web-pixel" value={pixelId} onChange={e => setPixelId(e.target.value)} className={EINGABE_KLEIN}>
                  {!pixel.some(p => p.id === pixelId) && pixelId && <option value={pixelId}>{pixelId}</option>}
                  {pixel.map(p => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                </select>
              ) : (
                <input id="web-pixel" value={pixelId} inputMode="numeric" onChange={e => setPixelId(e.target.value)} className={EINGABE_KLEIN} />
              )}
            </Einstellung>
          </>
        )}>
        <Einstellung label={verknuepfung === 'und' ? t('crm.werbung.zielgruppen.web.einschlussUnd', 'Drin ist, wer alles davon erfüllt') : t('crm.werbung.zielgruppen.web.einschluss', 'Drin ist, wer eines davon erfüllt')}
          erklaerung={t('crm.werbung.zielgruppen.web.einschlussHilfe', '„URL enthält“ trifft jede Seite, deren Adresse den Text enthält. Ereignisse kommen vom Pixel (Lead, Schedule = Termin gebucht).')}>
          <RegelListe regeln={regeln} onChange={setRegeln} und={verknuepfung === 'und'} leerText={t('crm.werbung.zielgruppen.web.keineRegel', 'Noch keine Regel. Nimm einen Vorschlag oder füge eine hinzu.')} />
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="text-xs text-gray-500">{t('crm.werbung.zielgruppen.web.vorschlaege', 'Vorschläge:')}</span>
            {VORSCHLAEGE.map(v => (
              <button key={v.id} type="button" onClick={() => vorschlagNutzen(v)}
                className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs text-hp-navy hover:border-hp-navy/40 hover:bg-hp-cream">
                + {vorschlagLabel(v.id)}
              </button>
            ))}
          </div>
        </Einstellung>
        <Einstellung fuer="web-tage" label={t('crm.werbung.zielgruppen.feld.tage', 'Zeitraum in Tagen')} empfohlen={tageZahl === VORLAGEN[vorlage].tage && vorlage !== 'eigene'}
          erklaerung={t('crm.werbung.zielgruppen.web.tageHilfe', 'So lange bleibt jemand nach dem letzten Besuch in der Zielgruppe (1 bis {{max}} Tage).', { max: WEBSITE_MAX_TAGE })}>
          <div className="flex flex-wrap items-center gap-2">
            <input id="web-tage" type="number" min={1} max={WEBSITE_MAX_TAGE} value={tage} onChange={e => setTage(e.target.value)} className={`${EINGABE_KLEIN} w-24`} />
            {[7, 14, 30, 90, 180].map(n => (
              <button key={n} type="button" onClick={() => setTage(String(n))} aria-pressed={tageZahl === n}
                className={`rounded-full border px-2 py-0.5 text-xs ${tageZahl === n ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {n}
              </button>
            ))}
          </div>
        </Einstellung>
        {ausschlussKurz.length > 0 && (
          <p className="text-xs text-gray-600">
            {t('crm.werbung.zielgruppen.web.ausschlussKurzTage', 'Ausgeschlossen: {{regeln}} in den letzten {{tage}} Tagen (ändern unter „Alle Einstellungen“)', { tage: ausschlussTageZahl, regeln: ausschlussKurz.map(x => regelText(t, x)).join(', ') })}
          </p>
        )}
      </Abschnitt>

      <Hinweis ton="info" titel={t('crm.werbung.zielgruppen.wohnenTitel', 'Sonderkategorie Wohnen')}>
        {t('crm.werbung.zielgruppen.web.wohnen', 'Website-Zielgruppen sind unter Wohnen erlaubt (Retargeting und Ausschluss). Meta prüft die Eignung nach dem Anlegen, die Spalte „Wohnen“ zeigt das Ergebnis.')}
      </Hinweis>
    </AssistentRahmen>
  )
}
