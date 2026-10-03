import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  INTERAKTION_ARTEN, INTERAKTION_MAX_TAGE, type AudienceCreateEngagementRequest, type InteraktionsQuelle,
} from '../../../../lib/werbeWerkzeuge'
import AssistentRahmen, { zielgruppeErfolg } from './AssistentRahmen'
import { Abschnitt, EINGABE_KLEIN, Einstellung, Haken, Hinweis, Kacheln } from './Bausteine'
import { useKatalog } from './useWerkzeugStatus'
import { ladeFormulare, werkzeugCall, type FormularZeile } from './werkzeugeApi'
import type { ZielgruppenAssistentProps } from './WebsiteBesucher'

// ── Assistent „Interaktion" (Facebook-Seite, Instagram, Video, Sofortformular) ─
// Wer mit Happy Property interagiert hat. Unter Wohnen erlaubt. Anlegen:
// meta-werkzeuge audience_create_engagement {quelle, art, objekt_ids, tage}.

/** Pro Quelle empfohlen: breit genug für Retargeting; bei Formularen die Abbrecher */
const EMPFOHLEN: Record<InteraktionsQuelle, string> = {
  page: 'page_engaged',
  instagram: 'ig_business_profile_all',
  video: 'video_view_50_percent',
  leadform: 'lead_generation_dropoff',
}

const artenFuer = (q: InteraktionsQuelle) => INTERAKTION_ARTEN.filter(a => a.quelle === q)

function artText(t: TFunction, art: string): string {
  const a = INTERAKTION_ARTEN.find(x => x.wert === art)
  return a ? t(`crm.werbung.zielgruppen.ia.art.${a.wert}`, a.label) : art
}

function quelleKurz(t: TFunction, q: InteraktionsQuelle): string {
  switch (q) {
    case 'page': return t('crm.werbung.zielgruppen.ia.kurz.page', 'FB-Seite')
    case 'instagram': return t('crm.werbung.zielgruppen.ia.kurz.instagram', 'IG-Profil')
    case 'video': return t('crm.werbung.zielgruppen.ia.kurz.video', 'Video')
    default: return t('crm.werbung.zielgruppen.ia.kurz.leadform', 'Sofortformular')
  }
}

const IDS = /^\d{6,25}$/

/** HP-Vorgabe: ein Jahr (Formulare: Metas Höchstwert 90 Tage) */
const vorgabeTage = (q: InteraktionsQuelle): number => Math.min(365, INTERAKTION_MAX_TAGE[q])

export default function Interaktion({ offen, onClose, onZurueck, onFertig, status }: ZielgruppenAssistentProps) {
  const { t } = useTranslation()
  const { katalog } = useKatalog(offen)
  const [quelle, setQuelle] = useState<InteraktionsQuelle>('instagram')
  const [art, setArt] = useState(EMPFOHLEN.instagram)
  const [tage, setTage] = useState(String(vorgabeTage('instagram')))
  const [name, setName] = useState('')
  const [nameEigen, setNameEigen] = useState(false)
  const [objekt, setObjekt] = useState('')          // Seite oder IG-Konto
  const [videoIds, setVideoIds] = useState('')
  const [formIds, setFormIds] = useState<string[]>([])
  const [formulare, setFormulare] = useState<FormularZeile[] | null>(null)
  const [formFehler, setFormFehler] = useState(false)

  const tageZahl = Number(tage)
  const max = INTERAKTION_MAX_TAGE[quelle]

  useEffect(() => {
    if (!nameEigen) {
      setName(t('crm.werbung.zielgruppen.ia.nameVorschlag', '{{quelle}}: {{art}} {{tage}} T', {
        quelle: quelleKurz(t, quelle), art: artText(t, art), tage: Number.isFinite(tageZahl) && tageZahl > 0 ? tageZahl : vorgabeTage(quelle),
      }).slice(0, 200))
    }
  }, [quelle, art, tageZahl, nameEigen, max, t])

  // Vorbelegung: Seite / IG-Konto aus ad_settings bzw. Katalog
  const seiten = katalog?.pages ?? []
  const igKonten = katalog?.instagram_accounts ?? []
  const vorgabeObjekt = (q: InteraktionsQuelle): string => (q === 'page'
    ? status.einstellungen?.pageId ?? seiten[0]?.id ?? ''
    : q === 'instagram' ? status.einstellungen?.igUserId ?? igKonten[0]?.id ?? '' : '')
  useEffect(() => {
    if (!objekt) setObjekt(vorgabeObjekt(quelle))
    // nur wenn Vorgaben eintreffen und noch nichts gewählt ist
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.einstellungen, katalog])

  // Sofortformulare erst laden, wenn die Quelle gewählt ist
  useEffect(() => {
    if (!offen || quelle !== 'leadform' || formulare) return
    let lebt = true
    ladeFormulare()
      .then(r => { if (lebt) setFormulare(r.zeilen) })
      .catch(() => { if (lebt) { setFormFehler(true); setFormulare([]) } })
    return () => { lebt = false }
  }, [offen, quelle, formulare])

  const waehleQuelle = (q: InteraktionsQuelle) => {
    setQuelle(q)
    setObjekt(vorgabeObjekt(q))
    setArt(EMPFOHLEN[q])
    setTage(String(vorgabeTage(q)))
  }

  const objektIds = (): string[] => {
    if (quelle === 'page' || quelle === 'instagram') return objekt.trim() ? [objekt.trim()] : []
    if (quelle === 'video') return videoIds.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean)
    return formIds
  }

  const fehler = useMemo(() => {
    const f: string[] = []
    if (!name.trim()) f.push(t('crm.werbung.zielgruppen.pflicht.name', 'Name der Zielgruppe'))
    if (!Number.isInteger(tageZahl) || tageZahl < 1 || tageZahl > max) f.push(t('crm.werbung.zielgruppen.ia.pflicht.tage', 'Zeitraum zwischen 1 und {{max}} Tagen', { max }))
    const ids = objektIds()
    if (!ids.length) {
      f.push(quelle === 'video'
        ? t('crm.werbung.zielgruppen.ia.pflicht.video', 'Mindestens eine Video-ID')
        : quelle === 'leadform'
          ? t('crm.werbung.zielgruppen.ia.pflicht.formular', 'Mindestens ein Sofortformular')
          : t('crm.werbung.zielgruppen.ia.pflicht.objekt', 'Seite bzw. Instagram-Konto'))
    } else if (ids.some(id => !IDS.test(id))) {
      f.push(t('crm.werbung.zielgruppen.ia.pflicht.ids', 'IDs bestehen nur aus Ziffern'))
    }
    return f
    // objektIds liest nur die Zustände unten
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, tageZahl, max, quelle, objekt, videoIds, formIds, t])

  const aenderung = () => ({
    punkte: [
      { art: 'neu' as const, text: t('crm.werbung.zielgruppen.ia.aenderung.neu', 'Neue Interaktions-Zielgruppe „{{name}}“ im Werbekonto', { name: name.trim() }) },
      { art: 'neu' as const, text: t('crm.werbung.zielgruppen.ia.aenderung.regel', '{{quelle}}: {{art}}, letzte {{tage}} Tage ({{n}} Quelle(n))', { quelle: quelleKurz(t, quelle), art: artText(t, art), tage: tageZahl, n: objektIds().length }) },
      { art: 'gleich' as const, text: t('crm.werbung.zielgruppen.aenderung.nichtsSonst', 'Keine Kampagne, Anzeigengruppe oder Anzeige ändert sich.') },
    ],
    lernphase: t('crm.werbung.zielgruppen.aenderung.lernphaseZielgruppe', 'Startet nicht neu. Erst wenn du die Zielgruppe in einer laufenden Anzeigengruppe einsetzt, beginnt dort die Lernphase neu.'),
    warnungen: [t('crm.werbung.zielgruppen.aenderung.befuellen', 'Meta befüllt neue Zielgruppen nach und nach. Die Größe steht oft erst nach einigen Stunden da.')],
  })

  const auftrag = (): AudienceCreateEngagementRequest => ({ name: name.trim(), quelle, art, tage: tageZahl, objekt_ids: objektIds() })
  const ausfuehren = () => werkzeugCall('audience_create_engagement', auftrag())
  const vorschau = async () => ({ hinweise: (await werkzeugCall('audience_create_engagement', { ...auftrag(), vorschau: true })).hinweise ?? [] })

  const quelleOptionen = [
    { wert: 'instagram' as const, empfohlen: true, titel: t('crm.werbung.zielgruppen.ia.quelle.instagram', 'Instagram-Konto'), text: t('crm.werbung.zielgruppen.ia.quelle.instagramText', 'Profilbesuche, Likes, Kommentare, Nachrichten. Bei Happy Property die größte Quelle (Reels).') },
    { wert: 'page' as const, titel: t('crm.werbung.zielgruppen.ia.quelle.page', 'Facebook-Seite'), text: t('crm.werbung.zielgruppen.ia.quelle.pageText', 'Alle, die mit der Happy-Property-Seite oder ihren Beiträgen interagiert haben.') },
    { wert: 'video' as const, titel: t('crm.werbung.zielgruppen.ia.quelle.video', 'Video'), text: t('crm.werbung.zielgruppen.ia.quelle.videoText', 'Wer ein bestimmtes Video zu einem Anteil angesehen hat, z. B. ein Reel oder eine Video-Anzeige.') },
    { wert: 'leadform' as const, titel: t('crm.werbung.zielgruppen.ia.quelle.leadform', 'Sofortformular'), text: t('crm.werbung.zielgruppen.ia.quelle.leadformText', 'Wer ein Formular geöffnet oder abgeschickt hat.') },
  ]

  return (
    <AssistentRahmen offen={offen} onClose={onClose} onZurueck={onZurueck} onFertig={onFertig}
      titel={t('crm.werbung.zielgruppen.ia.titel', 'Neue Zielgruppe: Interaktion')}
      untertitel={t('crm.werbung.zielgruppen.ia.untertitel', 'Personen, die mit Happy Property auf Facebook oder Instagram interagiert haben. Gut für Retargeting mit warmem Publikum.')}
      fehler={fehler} schreibSperre={status.schreibSperre} pruefSperre={status.pruefSperre} aenderung={aenderung} ausfuehren={ausfuehren} vorschau={vorschau}
      anlegenText={t('crm.werbung.zielgruppen.anlegen', 'Bei Meta anlegen')}
      erfolgText={zielgruppeErfolg(t, name.trim())}>

      <Abschnitt nummer={1} titel={t('crm.werbung.zielgruppen.ia.quelleTitel', 'Quelle')}>
        <Kacheln name="ia-quelle" wert={quelle} onChange={waehleQuelle} optionen={quelleOptionen} />
      </Abschnitt>

      <Abschnitt nummer={2} titel={t('crm.werbung.zielgruppen.ia.wer', 'Wer gehört dazu?')}
        alle={(
          <Einstellung fuer="ia-name" label={t('crm.werbung.zielgruppen.feld.name', 'Name')}
            erklaerung={t('crm.werbung.zielgruppen.feld.nameHilfe', 'So heißt die Zielgruppe im Werbemanager und im Kampagnen-Assistenten.')}>
            <input id="ia-name" value={name} maxLength={200} onChange={e => { setName(e.target.value); setNameEigen(true) }} className={EINGABE_KLEIN} />
          </Einstellung>
        )}>
        <Einstellung fuer="ia-art" label={t('crm.werbung.zielgruppen.ia.artLabel', 'Art der Interaktion')} empfohlen={EMPFOHLEN[quelle] === art}
          erklaerung={t('crm.werbung.zielgruppen.ia.artHilfe', 'Je breiter die Art, desto größer die Zielgruppe. Für Retargeting reicht meist „Alle“.')}>
          <select id="ia-art" value={art} onChange={e => setArt(e.target.value)} className={EINGABE_KLEIN}>
            {artenFuer(quelle).map(a => <option key={a.wert} value={a.wert}>{artText(t, a.wert)}</option>)}
          </select>
        </Einstellung>

        {(quelle === 'page' || quelle === 'instagram') && (
          <Einstellung fuer="ia-objekt" label={quelle === 'page' ? t('crm.werbung.zielgruppen.ia.seite', 'Facebook-Seite') : t('crm.werbung.zielgruppen.ia.igKonto', 'Instagram-Konto')}
            erklaerung={t('crm.werbung.zielgruppen.ia.objektHilfe', 'Vorgabe aus den Werbe-Einstellungen (Happy Property).')}>
            {(quelle === 'page' ? seiten.length : igKonten.length) > 0 ? (
              <select id="ia-objekt" value={objekt} onChange={e => setObjekt(e.target.value)} className={EINGABE_KLEIN}>
                {objekt && !(quelle === 'page' ? seiten : igKonten).some(o => o.id === objekt) && <option value={objekt}>{objekt}</option>}
                {quelle === 'page'
                  ? seiten.map(s => <option key={s.id} value={s.id}>{s.name} ({s.id})</option>)
                  : igKonten.map(k => <option key={k.id} value={k.id}>{k.username ? `@${k.username}` : k.name ?? k.id} ({k.id})</option>)}
              </select>
            ) : (
              <input id="ia-objekt" value={objekt} inputMode="numeric" onChange={e => setObjekt(e.target.value)} className={EINGABE_KLEIN} />
            )}
          </Einstellung>
        )}

        {quelle === 'video' && (
          <Einstellung fuer="ia-video" label={t('crm.werbung.zielgruppen.ia.videoIds', 'Video-IDs')}
            erklaerung={t('crm.werbung.zielgruppen.ia.videoHilfe', 'Eine oder mehrere Video-IDs von Meta, getrennt durch Komma oder Zeilenumbruch. Die ID steht in der Vorschau einer Video-Anzeige.')}>
            <textarea id="ia-video" rows={2} value={videoIds} onChange={e => setVideoIds(e.target.value)} className={EINGABE_KLEIN} />
          </Einstellung>
        )}

        {quelle === 'leadform' && (
          <Einstellung label={t('crm.werbung.zielgruppen.ia.formulare', 'Sofortformulare')}
            erklaerung={t('crm.werbung.zielgruppen.ia.formulareHilfe', 'Wer eines dieser Formulare geöffnet oder abgeschickt hat.')}>
            {formulare === null ? (
              <p className="text-xs text-gray-500">{t('crm.werbung.zielgruppen.laedt', 'Lädt …')}</p>
            ) : formulare.length === 0 ? (
              <p className="text-xs text-gray-500">{formFehler
                ? t('crm.werbung.zielgruppen.ia.formulareFehler', 'Formulare konnten nicht geladen werden.')
                : t('crm.werbung.zielgruppen.ia.formulareLeer', 'Noch keine Sofortformulare vorhanden.')}</p>
            ) : (
              <div className="max-h-48 space-y-1.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {formulare.map(f => (
                  <Haken key={f.id} checked={formIds.includes(f.id)} label={f.name} hilfe={f.id}
                    onChange={an => setFormIds(an ? [...formIds, f.id] : formIds.filter(x => x !== f.id))} />
                ))}
              </div>
            )}
          </Einstellung>
        )}

        <Einstellung fuer="ia-tage" label={t('crm.werbung.zielgruppen.feld.tage', 'Zeitraum in Tagen')} empfohlen={tageZahl === vorgabeTage(quelle)}
          erklaerung={t('crm.werbung.zielgruppen.ia.tageHilfe', 'Wie weit zurück Interaktionen zählen (1 bis {{max}} Tage). Länger = größere Zielgruppe.', { max })}>
          <div className="flex flex-wrap items-center gap-2">
            <input id="ia-tage" type="number" min={1} max={max} value={tage} onChange={e => setTage(e.target.value)} className={`${EINGABE_KLEIN} w-24`} />
            {[30, 90, 180, 365, 730].filter(n => n <= max).map(n => (
              <button key={n} type="button" onClick={() => setTage(String(n))} aria-pressed={tageZahl === n}
                className={`rounded-full border px-2 py-0.5 text-xs ${tageZahl === n ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {n}
              </button>
            ))}
          </div>
        </Einstellung>
      </Abschnitt>

      <Hinweis ton="info" titel={t('crm.werbung.zielgruppen.wohnenTitel', 'Sonderkategorie Wohnen')}>
        {t('crm.werbung.zielgruppen.ia.wohnen', 'Interaktions-Zielgruppen sind unter Wohnen erlaubt. Meta prüft die Eignung nach dem Anlegen.')}
      </Hinweis>
    </AssistentRahmen>
  )
}
