import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import {
  CUSTOM_EVENT_TYPE_LABEL, CUSTOM_EVENT_TYPES, PIXEL_EREIGNISSE,
  type CustomConversionCreateRequest, type CustomConversionCreateResponse, type CustomConversionVorschlag, type CustomEventType,
} from '../../../../lib/werbeWerkzeuge'
import { EINGABE_KLEIN, Einstellung, Hinweis, MetaAenderungDialog, type AenderungPunkt } from '../zielgruppen/Bausteine'
import { werkzeugCall } from '../zielgruppen/werkzeugeApi'
import { ereignisLabel, messFehlerText } from './messungApi'

// ── Neue benutzerdefinierte Conversion ───────────────────────────────────────
// „Das Wichtigste": Name, Pixel-Ereignis, Kategorie (mit HP-Vorschlag
// vorbelegbar). „Alle Einstellungen": Website-Adresse als Regel, Standardwert,
// Beschreibung, anderer Datensatz. Ablauf: Prüfen beim Server (vorschau: true,
// nichts geht an Meta) -> „Das ändert sich bei Meta" -> Anlegen. Eine neue
// Conversion ändert keine laufende Anzeige.

interface Form {
  name: string
  ereignis: string
  eigenesEreignis: string
  kategorie: CustomEventType
  urlArt: 'url_enthaelt' | 'url_gleich'
  url: string
  standardwert: string
  beschreibung: string
  pixelId: string
}

const LEER: Form = {
  name: '', ereignis: 'Schedule', eigenesEreignis: '', kategorie: 'SCHEDULE', urlArt: 'url_enthaelt', url: '', standardwert: '', beschreibung: '', pixelId: '',
}
const EIGENES = '__eigenes__'

/** Passende Meta-Kategorie je Ereignis (wie die HP-Vorschläge), solange niemand sie von Hand wählt */
const KATEGORIE_ZUM_EREIGNIS: Readonly<Record<string, CustomEventType>> = {
  Lead: 'LEAD', QualifiedLead: 'LEAD', Schedule: 'SCHEDULE', AppointmentHeld: 'OTHER', Purchase: 'PURCHASE',
  CompleteRegistration: 'COMPLETE_REGISTRATION', Contact: 'CONTACT', SubmitApplication: 'SUBMIT_APPLICATION',
  ViewContent: 'CONTENT_VIEW', PageView: 'OTHER',
}

export default function NeueConversionDialog({ offen, vorschlag, schreibSperre, pruefSperre, anzahlAktiv, max, onClose, onFertig }: {
  offen: boolean
  /** vorbelegen mit einem HP-Vorschlag */
  vorschlag: CustomConversionVorschlag | null
  /** Grund, warum Anlegen gesperrt ist (Prüfen geht trotzdem) */
  schreibSperre: string | null
  /** Grund, warum auch Prüfen nicht geht (fehlendes Recht) */
  pruefSperre: string | null
  anzahlAktiv: number | null
  max: number
  onClose: () => void
  onFertig: () => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const [f, setF] = useState<Form>(LEER)
  const [alleOffen, setAlleOffen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [vorschau, setVorschau] = useState<CustomConversionCreateResponse | null>(null)
  /** Kategorie von Hand gewählt: dann folgt sie dem Ereignis nicht mehr */
  const [kategorieHand, setKategorieHand] = useState(false)

  useEffect(() => {
    if (!offen) return
    setFehler(null)
    setVorschau(null)
    setAlleOffen(false)
    setKategorieHand(false)
    setF(vorschlag
      ? { ...LEER, name: vorschlag.name, ereignis: (PIXEL_EREIGNISSE as readonly string[]).includes(vorschlag.ereignis) ? vorschlag.ereignis : EIGENES,
        eigenesEreignis: (PIXEL_EREIGNISSE as readonly string[]).includes(vorschlag.ereignis) ? '' : vorschlag.ereignis, kategorie: vorschlag.kategorie }
      : LEER)
  }, [offen, vorschlag])

  const setze = <K extends keyof Form>(k: K, v: Form[K]) => { setF(p => ({ ...p, [k]: v })); setVorschau(null) }
  const setzeEreignis = (v: string) => {
    const passend = kategorieHand ? undefined : KATEGORIE_ZUM_EREIGNIS[v]
    setF(p => ({ ...p, ereignis: v, ...(passend ? { kategorie: passend } : {}) }))
    setVorschau(null)
  }

  const ereignisOptionen: SelectOption[] = useMemo(() => [
    ...PIXEL_EREIGNISSE.map(e => ({ value: e, label: ereignisLabel(t, e) })),
    { value: EIGENES, label: t('crm.werbung.messung.conv.eigenesEreignis', 'Anderes Ereignis (Name eingeben)') },
    { value: '', label: t('crm.werbung.messung.conv.keinEreignis', 'Kein Ereignis, nur Website-Adresse') },
  ], [t])
  const kategorieOptionen: SelectOption[] = useMemo(() => CUSTOM_EVENT_TYPES.map(k => ({
    value: k, label: t(`crm.werbung.messung.conv.kategorie.${k}`, CUSTOM_EVENT_TYPE_LABEL[k]),
  })), [t])

  const ereignis = f.ereignis === EIGENES ? f.eigenesEreignis.trim() : f.ereignis
  const url = f.url.trim()
  const wert = f.standardwert.trim() ? Number(f.standardwert.replace(',', '.')) : null
  const pixel = f.pixelId.trim()

  const probleme: string[] = []
  if (!f.name.trim()) probleme.push(t('crm.werbung.messung.conv.problem.name', 'Name fehlt.'))
  if (f.name.trim().length > 100) probleme.push(t('crm.werbung.messung.conv.problem.nameLang', 'Name ist zu lang (höchstens 100 Zeichen).'))
  if (!ereignis && !url) probleme.push(t('crm.werbung.messung.conv.problem.quelle', 'Ereignis oder Website-Adresse angeben.'))
  if (f.ereignis === EIGENES && ereignis && !/^[A-Za-z][A-Za-z0-9_]{1,49}$/.test(ereignis)) probleme.push(t('crm.werbung.messung.conv.problem.ereignis', 'Ereignisname nur mit Buchstaben, Ziffern und Unterstrich.'))
  if (wert != null && (!Number.isFinite(wert) || wert < 0)) probleme.push(t('crm.werbung.messung.conv.problem.wert', 'Standardwert muss eine Zahl ab 0 sein.'))
  if (pixel && !/^\d{6,20}$/.test(pixel)) probleme.push(t('crm.werbung.messung.conv.problem.pixel', 'Datensatz-ID besteht nur aus Ziffern.'))
  const amLimit = anzahlAktiv != null && anzahlAktiv >= max

  const anfrage = (vorschauModus: boolean): CustomConversionCreateRequest => ({
    name: f.name.trim(),
    kategorie: f.kategorie,
    ...(ereignis ? { ereignis } : {}),
    ...(url ? { url_regeln: [{ art: f.urlArt, wert: url }] } : {}),
    ...(wert != null ? { standardwert: wert } : {}),
    ...(f.beschreibung.trim() ? { beschreibung: f.beschreibung.trim() } : {}),
    ...(pixel ? { pixel_id: pixel } : {}),
    vorschau: vorschauModus,
  })

  const pruefen = async () => {
    if (probleme.length || pruefSperre) return
    setBusy(true)
    setFehler(null)
    try {
      setVorschau(await werkzeugCall('custom_conversion_create', anfrage(true)))
    } catch (err) {
      setFehler(messFehlerText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const anlegen = async () => {
    if (schreibSperre || amLimit) return
    setBusy(true)
    setFehler(null)
    try {
      const r = await werkzeugCall('custom_conversion_create', anfrage(false))
      toast.success(t('crm.werbung.messung.conv.angelegt', 'Conversion „{{name}}" angelegt.', { name: f.name.trim() }))
      if (r.hinweise.length) toast.info(r.hinweise.join(' '))
      setVorschau(null)
      onFertig()
      onClose()
    } catch (err) {
      setFehler(messFehlerText(err, t))
    } finally {
      setBusy(false)
    }
  }

  const punkte: AenderungPunkt[] = [
    { text: t('crm.werbung.messung.conv.punktNeu', 'Neue benutzerdefinierte Conversion „{{name}}" ({{kategorie}})', { name: f.name.trim(), kategorie: t(`crm.werbung.messung.conv.kategorie.${f.kategorie}`, CUSTOM_EVENT_TYPE_LABEL[f.kategorie]) }), art: 'neu' },
    ...(ereignis ? [{ text: t('crm.werbung.messung.conv.punktEreignis', 'Zählt das Ereignis: {{name}}', { name: ereignisLabel(t, ereignis) }), art: 'neu' as const }] : []),
    ...(url ? [{ text: t('crm.werbung.messung.conv.punktUrl', 'Website-Adresse {{art}}: {{url}}', { art: f.urlArt === 'url_gleich' ? t('crm.werbung.messung.conv.urlGleich', 'ist gleich') : t('crm.werbung.messung.conv.urlEnthaelt', 'enthält'), url }), art: 'neu' as const }] : []),
    { text: t('crm.werbung.messung.conv.punktAnzeigen', 'Laufende Kampagnen bleiben unverändert.'), art: 'gleich' },
    { text: t('crm.werbung.messung.conv.punktLoeschen', 'Meta erlaubt kein Ändern der Regel und höchstens {{max}} Conversions je Konto. Wir löschen nie.', { max }), art: 'achtung' },
  ]

  return (
    <>
      <Modal open={offen && !vorschau} onClose={busy ? () => undefined : onClose} size="lg" closeOnBackdrop={!busy}
        title={t('crm.werbung.messung.conv.neuTitel', 'Neue benutzerdefinierte Conversion')}
        footer={(
          <>
            <button type="button" onClick={onClose} disabled={busy} className="hp-btn hp-btn-ghost">{t('crm.werbung.messung.abbrechen', 'Abbrechen')}</button>
            <button type="button" onClick={() => void pruefen()} disabled={busy || probleme.length > 0 || !!pruefSperre} className="hp-btn hp-btn-primary">
              {busy && <Spinner size="sm" />}
              {t('crm.werbung.messung.conv.pruefen', 'Prüfen')}
            </button>
          </>
        )}>
        <div className="space-y-4">
          <p className="text-xs leading-snug text-gray-600">
            {t('crm.werbung.messung.conv.intro', 'Eine eigene Conversion zählt ein bestimmtes Ereignis (z. B. „Termin stattgefunden" aus dem CRM). In der Anzeigengruppe kann Meta dann genau darauf optimieren.')}
          </p>
          {pruefSperre && <Hinweis ton="sperre">{pruefSperre}</Hinweis>}
          {amLimit && <Hinweis ton="warnung">{t('crm.werbung.messung.conv.limit', 'Das Konto hat schon {{n}} von {{max}} Conversions. Meta lässt keine weitere zu.', { n: anzahlAktiv ?? 0, max })}</Hinweis>}
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{t('crm.werbung.messung.dasWichtigste', 'Das Wichtigste')}</p>
          <Einstellung label={t('crm.werbung.messung.conv.name', 'Name')} fuer="conv-name"
            erklaerung={t('crm.werbung.messung.conv.nameHilfe', 'So heißt die Conversion bei Meta, z. B. „HP Termin stattgefunden".')}>
            <input id="conv-name" value={f.name} onChange={e => setze('name', e.target.value)} maxLength={120} className={EINGABE_KLEIN} />
          </Einstellung>
          <Einstellung label={t('crm.werbung.messung.conv.ereignis', 'Ereignis')} empfohlen={f.ereignis === 'Schedule' || f.ereignis === 'QualifiedLead'}
            erklaerung={t('crm.werbung.messung.conv.ereignisHilfe', 'Welches Ereignis des Pixels bzw. aus dem CRM gezählt wird. Termin gebucht und guter Lead passen am besten zu Happy Property.')}>
            <CustomSelect value={f.ereignis} onChange={setzeEreignis} options={ereignisOptionen} className="w-full" />
            {f.ereignis === EIGENES && (
              <input value={f.eigenesEreignis} onChange={e => setze('eigenesEreignis', e.target.value.replace(/\s/g, ''))}
                placeholder={t('crm.werbung.messung.conv.eigenesPlatzhalter', 'z. B. KapitalJa')}
                aria-label={t('crm.werbung.messung.conv.eigenesEreignis', 'Anderes Ereignis (Name eingeben)')} className={`${EINGABE_KLEIN} mt-1.5`} />
            )}
          </Einstellung>
          <Einstellung label={t('crm.werbung.messung.conv.kategorieLabel', 'Kategorie')}
            erklaerung={t('crm.werbung.messung.conv.kategorieHilfe', 'Metas Einordnung (Conversion-Kategorie). Sie bestimmt, unter welchem Namen die Ergebnisse im Bericht stehen.')}>
            <CustomSelect value={f.kategorie} onChange={v => { setKategorieHand(true); setze('kategorie', v as CustomEventType) }} options={kategorieOptionen} className="w-full" />
          </Einstellung>

          <div className="rounded-lg border border-gray-100">
            <button type="button" onClick={() => setAlleOffen(o => !o)} aria-expanded={alleOffen}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs font-semibold text-hp-navy hover:bg-hp-cream/60">
              <span>{t('crm.werbung.messung.alleEinstellungen', 'Alle Einstellungen')}</span>
              <span aria-hidden="true" className={`transition-transform ${alleOffen ? 'rotate-180' : ''}`}>▾</span>
            </button>
            {alleOffen && (
              <div className="space-y-4 px-3 pb-3 pt-1">
                <Einstellung label={t('crm.werbung.messung.conv.url', 'Website-Adresse')}
                  erklaerung={t('crm.werbung.messung.conv.urlHilfe', 'Zählt nur, wenn das Ereignis auf dieser Seite passiert (oder allein: jeder Aufruf der Seite). Beispiel: /termin/danke.')}>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <CustomSelect value={f.urlArt} onChange={v => setze('urlArt', v as Form['urlArt'])} className="sm:w-44"
                      options={[
                        { value: 'url_enthaelt', label: t('crm.werbung.messung.conv.urlEnthaelt', 'enthält') },
                        { value: 'url_gleich', label: t('crm.werbung.messung.conv.urlGleich', 'ist gleich') },
                      ]} />
                    <input value={f.url} onChange={e => setze('url', e.target.value)} placeholder="/termin/danke"
                      aria-label={t('crm.werbung.messung.conv.url', 'Website-Adresse')} className={EINGABE_KLEIN} />
                  </div>
                </Einstellung>
                <Einstellung label={t('crm.werbung.messung.conv.wert', 'Standardwert je Conversion')} fuer="conv-wert"
                  erklaerung={t('crm.werbung.messung.conv.wertHilfe', 'Optional, in der Kontowährung (USD). Leer lassen, wenn das Ereignis selbst einen Wert mitbringt.')}>
                  <input id="conv-wert" value={f.standardwert} onChange={e => setze('standardwert', e.target.value)} inputMode="decimal" className={`${EINGABE_KLEIN} sm:max-w-[10rem]`} />
                </Einstellung>
                <Einstellung label={t('crm.werbung.messung.conv.beschreibung', 'Beschreibung')} fuer="conv-beschreibung"
                  erklaerung={t('crm.werbung.messung.conv.beschreibungHilfe', 'Nur für euch: wofür die Conversion gedacht ist.')}>
                  <textarea id="conv-beschreibung" value={f.beschreibung} onChange={e => setze('beschreibung', e.target.value)} rows={2} maxLength={500} className={EINGABE_KLEIN} />
                </Einstellung>
                <Einstellung label={t('crm.werbung.messung.conv.pixel', 'Datensatz (Pixel)')} fuer="conv-pixel"
                  erklaerung={t('crm.werbung.messung.conv.pixelHilfe', 'Leer lassen für den Standard-Datensatz aus den Werbe-Einstellungen.')}>
                  <input id="conv-pixel" value={f.pixelId} onChange={e => setze('pixelId', e.target.value.replace(/\D/g, ''))} inputMode="numeric" className={`${EINGABE_KLEIN} sm:max-w-xs`} />
                </Einstellung>
              </div>
            )}
          </div>

          {probleme.length > 0 && (
            <ul className="space-y-0.5 text-xs text-amber-800">
              {probleme.map((p, i) => <li key={i}>• {p}</li>)}
            </ul>
          )}
          {fehler && <Hinweis ton="fehler">{fehler}</Hinweis>}
        </div>
      </Modal>

      <MetaAenderungDialog offen={offen && !!vorschau} busy={busy}
        punkte={punkte}
        lernphase={t('crm.werbung.messung.conv.lernphase', 'Keine Lernphase startet neu: die Conversion wirkt erst, wenn du sie in einer Anzeigengruppe als Ziel wählst.')}
        warnungen={[...(vorschau?.hinweise ?? []), ...(fehler ? [fehler] : [])]}
        gesperrt={schreibSperre ?? (amLimit ? t('crm.werbung.messung.conv.limitKurz', 'Höchstzahl an Conversions erreicht.') : null)}
        bestaetigen={t('crm.werbung.messung.conv.anlegen', 'Bei Meta anlegen')}
        onBestaetigen={() => void anlegen()}
        onClose={() => setVorschau(null)} />
    </>
  )
}
