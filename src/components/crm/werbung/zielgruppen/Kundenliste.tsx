import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useToast } from '../../../ui/Toast'
import {
  KUNDENLISTE_DSGVO_HINWEIS,
  type AudienceCreateCustomerListRequest, type AudienceCreateCustomerListResponse, type KundenlisteFilter, type KundenlisteLabel,
} from '../../../../lib/werbeWerkzeuge'
import { SALE_PHASES } from '../useWerbeDaten'
import AssistentRahmen, { type VorschauErgebnis } from './AssistentRahmen'
import { Abschnitt, EINGABE_KLEIN, Einstellung, Haken, Hinweis, Kacheln } from './Bausteine'
import { werkzeugCall } from './werkzeugeApi'
import type { ZielgruppenAssistentProps } from './WebsiteBesucher'

// ── Assistent „Kundenliste" (nur Admin) ──────────────────────────────────────
// Kontakte aus dem CRM als Custom Audience. Der Server hasht E-Mail und
// Telefon (SHA-256) und schreibt keine Klardaten ins Protokoll. Gesperrt, bis
// Sven ad_settings.kundenliste_freigegeben einschaltet (nur Admin, prüft der
// Schutz-Trigger). Der Schalter liegt bewusst NICHT hier im Upload-Ablauf,
// sondern getrennt im Reiter Zielgruppen (KundenlisteFreigabe.tsx); hier stehen
// nur Sperre und Grund. Interne Kontakte gehen nie mit.

export function dsgvoText(t: TFunction): string {
  return t('crm.werbung.zielgruppen.kl.dsgvo', KUNDENLISTE_DSGVO_HINWEIS)
}

type Gruppe = 'kunden' | 'gute' | 'schlechte' | 'meta' | 'alle'
type Zeitraum = '365' | '730' | '1825' | 'alle'

/** CRM-Auswahl -> Filter und Metas Etikett der Liste */
const GRUPPEN: Record<Gruppe, { filter: KundenlisteFilter; label?: KundenlisteLabel }> = {
  kunden: { filter: { deal_phasen: [...SALE_PHASES] }, label: 'CUSTOMERS' },
  gute: { filter: { qualitaet: ['gut'] }, label: 'QUALIFIED_LEADS' },
  schlechte: { filter: { qualitaet: ['schlecht'] }, label: 'DISQUALIFIED_LEADS' },
  meta: { filter: { nur_meta: true } },
  alle: { filter: {} },
}

const seitDatum = (tage: number): string => new Date(Date.now() - tage * 86_400_000).toISOString().slice(0, 10)

function gruppeText(t: TFunction, g: Gruppe): string {
  switch (g) {
    case 'kunden': return t('crm.werbung.zielgruppen.kl.gruppe.kunden', 'Käufer')
    case 'gute': return t('crm.werbung.zielgruppen.kl.gruppe.gute', 'Gute Leads (Svens Bewertung)')
    case 'schlechte': return t('crm.werbung.zielgruppen.kl.gruppe.schlechte', 'Schlechte Leads')
    case 'meta': return t('crm.werbung.zielgruppen.kl.gruppe.meta', 'Leads aus Meta-Werbung')
    default: return t('crm.werbung.zielgruppen.kl.gruppe.alle', 'Alle Leads')
  }
}

export default function Kundenliste({ offen, onClose, onZurueck, onFertig, status }: ZielgruppenAssistentProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const e = status.einstellungen
  const freigegeben = e?.kundenlisteFreigegeben === true
  const nichtLesbar = e?.fehler === true
  const spalteFehlt = e != null && !nichtLesbar && e.kundenlisteFreigegeben === null
  const istAdmin = status.rechte.istAdmin

  const [gruppe, setGruppe] = useState<Gruppe>('kunden')
  const [zeitraum, setZeitraum] = useState<Zeitraum>('alle')
  const [mitArchivierten, setMitArchivierten] = useState(false)
  const [name, setName] = useState('')
  const [nameEigen, setNameEigen] = useState(false)
  const [bestaetigt, setBestaetigt] = useState(false)

  useEffect(() => {
    if (!nameEigen) setName(t('crm.werbung.zielgruppen.kl.nameVorschlag', 'CRM: {{gruppe}}', { gruppe: gruppeText(t, gruppe) }).slice(0, 200))
  }, [gruppe, nameEigen, t])

  const fehler = useMemo(() => {
    const f: string[] = []
    if (!name.trim()) f.push(t('crm.werbung.zielgruppen.pflicht.name', 'Name der Zielgruppe'))
    if (!bestaetigt) f.push(t('crm.werbung.zielgruppen.kl.pflicht.bestaetigt', 'Bestätigung der Datenschutz-Grundlage'))
    return f
  }, [name, bestaetigt, t])

  const zusatzSperre = !istAdmin
    ? t('crm.werbung.zielgruppen.kl.nurAdmin', 'Kundenlisten legt nur ein Admin an (Sven).')
    : !freigegeben
      ? t('crm.werbung.zielgruppen.kl.gesperrt', 'Kundenlisten sind gesperrt, bis Sven sie freigibt.')
      : null

  const zeitraumText = zeitraum === 'alle'
    ? t('crm.werbung.zielgruppen.kl.zeitraum.alle', 'alle Zeiträume')
    : t('crm.werbung.zielgruppen.kl.zeitraum.seit', 'seit {{datum}}', { datum: seitDatum(Number(zeitraum)) })

  const aenderung = () => ({
    punkte: [
      { art: 'neu' as const, text: t('crm.werbung.zielgruppen.kl.aenderung.neu', 'Neue Kundenliste „{{name}}“ im Werbekonto', { name: name.trim() }) },
      { art: 'neu' as const, text: t('crm.werbung.zielgruppen.kl.aenderung.inhalt', '{{gruppe}} ({{zeitraum}}), nur gehashte E-Mail und Telefonnummer', { gruppe: gruppeText(t, gruppe), zeitraum: zeitraumText }) },
      { art: 'gleich' as const, text: t('crm.werbung.zielgruppen.aenderung.nichtsSonst', 'Keine Kampagne, Anzeigengruppe oder Anzeige ändert sich.') },
    ],
    lernphase: t('crm.werbung.zielgruppen.aenderung.lernphaseZielgruppe', 'Startet nicht neu. Erst wenn du die Zielgruppe in einer laufenden Anzeigengruppe einsetzt, beginnt dort die Lernphase neu.'),
    warnungen: [dsgvoText(t)],
  })

  const auftrag = (): AudienceCreateCustomerListRequest => {
    const g = GRUPPEN[gruppe]
    return {
      name: name.trim(),
      quelle: 'crm',
      filter: {
        ...g.filter,
        ...(zeitraum !== 'alle' ? { seit: seitDatum(Number(zeitraum)) } : {}),
        ...(mitArchivierten ? { mit_archivierten: true } : {}),
      },
      confirm: true,
      ...(g.label ? { label: g.label } : {}),
    }
  }
  const ausfuehren = () => werkzeugCall('audience_create_customer_list', auftrag())
  // Vorschau zählt nur (Admin), nichts geht an Meta
  const vorschau = async (): Promise<VorschauErgebnis> => {
    const r = await werkzeugCall('audience_create_customer_list', { ...auftrag(), vorschau: true })
    const aus = r.ausgeschlossen
    return {
      hinweise: r.hinweise ?? [],
      punkte: [
        { art: 'neu', text: t('crm.werbung.zielgruppen.kl.vorschau.kontakte', '{{n}} Kontakte gehen mit ({{email}} mit E-Mail, {{tel}} mit Telefon)', { n: r.kontakte, email: r.mit_email, tel: r.mit_telefon }) },
        ...(aus ? [{ art: 'gleich' as const, text: t('crm.werbung.zielgruppen.kl.vorschau.aus', 'Nicht dabei: {{intern}} intern, {{wider}} mit Widerspruch, {{ohne}} ohne Kontaktdaten, {{doppelt}} doppelt', { intern: aus.intern, wider: aus.widerspruch, ohne: aus.ohne_kontakt, doppelt: aus.doppelt }) }] : []),
      ],
    }
  }
  const erfolg = (data: unknown): string => {
    const r = data as Partial<AudienceCreateCustomerListResponse> | null
    return t('crm.werbung.zielgruppen.kl.erfolg', 'Kundenliste „{{name}}“ angelegt: {{n}} Kontakte von Meta angenommen', { name: name.trim(), n: r?.hochgeladen ?? 0 })
  }
  const fertig = (data: unknown) => {
    const r = data as Partial<AudienceCreateCustomerListResponse> | null
    if (r?.fehler) toast.error(t('crm.werbung.zielgruppen.kl.uploadFehler', 'Liste angelegt, Hochladen gescheitert: {{fehler}}', { fehler: r.fehler }))
    onFertig()
  }

  return (
    <AssistentRahmen offen={offen} onClose={onClose} onZurueck={onZurueck} onFertig={fertig} vorschau={vorschau}
      titel={t('crm.werbung.zielgruppen.kl.titel', 'Neue Zielgruppe: Kundenliste')}
      untertitel={t('crm.werbung.zielgruppen.kl.untertitel', 'Kontakte aus dem CRM, z. B. um Käufer aus Neukunden-Werbung auszuschließen.')}
      fehler={fehler} schreibSperre={status.schreibSperre} pruefSperre={status.pruefSperre} zusatzSperre={zusatzSperre} aenderung={aenderung} ausfuehren={ausfuehren}
      anlegenText={t('crm.werbung.zielgruppen.kl.anlegen', 'Gehasht an Meta übertragen')}
      erfolgText={erfolg}>

      <Hinweis ton="warnung" titel={t('crm.werbung.zielgruppen.kl.dsgvoTitel', 'Datenschutz (DSGVO)')}>{dsgvoText(t)}</Hinweis>

      {!freigegeben && (
        <Hinweis ton="sperre" titel={t('crm.werbung.zielgruppen.kl.gesperrtTitel', 'Kundenlisten sind gesperrt')}>
          <p>{nichtLesbar
            ? t('crm.werbung.zielgruppen.kl.einstellungFehler', 'Die Werbe-Einstellungen konnten gerade nicht gelesen werden. Bitte später nochmal öffnen.')
            : spalteFehlt
              ? t('crm.werbung.zielgruppen.kl.spalteFehlt', 'Die Freigabe-Einstellung gibt es in der Datenbank noch nicht (Migration ausstehend).')
              : t('crm.werbung.zielgruppen.kl.gesperrtText', 'Kundenlisten gehen erst nach Svens Freigabe. Die Freigabe gilt für das ganze Werbekonto und lässt sich jederzeit zurücknehmen.')}</p>
          {!nichtLesbar && !spalteFehlt && (
            <p className="mt-1">{t('crm.werbung.zielgruppen.kl.freigabeWo', 'Freigeben kann ein Admin im Reiter Zielgruppen unter „Kundenlisten an Meta erlaubt“, getrennt von diesem Assistenten.')}</p>
          )}
        </Hinweis>
      )}

      <fieldset disabled={!freigegeben || !istAdmin} className={`space-y-4 ${!freigegeben || !istAdmin ? 'opacity-60' : ''}`}>
        <Abschnitt nummer={1} titel={t('crm.werbung.zielgruppen.kl.werTitel', 'Wer kommt in die Liste?')}
          alle={(
            <>
              <Einstellung label={t('crm.werbung.zielgruppen.kl.archiviert', 'Archivierte Leads')}
                erklaerung={t('crm.werbung.zielgruppen.kl.archiviertHilfe', 'Standard: archivierte Leads bleiben draußen.')}>
                <Haken checked={mitArchivierten} onChange={setMitArchivierten} label={t('crm.werbung.zielgruppen.kl.archiviertHaken', 'Auch archivierte Leads mitnehmen')} />
              </Einstellung>
              <Einstellung fuer="kl-name" label={t('crm.werbung.zielgruppen.feld.name', 'Name')}
                erklaerung={t('crm.werbung.zielgruppen.feld.nameHilfe', 'So heißt die Zielgruppe im Werbemanager und im Kampagnen-Assistenten.')}>
                <input id="kl-name" value={name} maxLength={200} onChange={ev => { setName(ev.target.value); setNameEigen(true) }} className={EINGABE_KLEIN} />
              </Einstellung>
            </>
          )}>
          <Kacheln name="kl-gruppe" wert={gruppe} onChange={setGruppe} spalten={1} optionen={[
            { wert: 'kunden', empfohlen: true, titel: gruppeText(t, 'kunden'), text: t('crm.werbung.zielgruppen.kl.gruppe.kundenText', 'Deals in Anzahlung oder Provision erhalten. Typisch zum Ausschließen aus Neukunden-Werbung.') },
            { wert: 'gute', titel: gruppeText(t, 'gute'), text: t('crm.werbung.zielgruppen.kl.gruppe.guteText', 'Leads mit Daumen hoch. Gute Quelle für Lookalikes außerhalb von Wohnen.') },
            { wert: 'schlechte', titel: gruppeText(t, 'schlechte'), text: t('crm.werbung.zielgruppen.kl.gruppe.schlechteText', 'Leads mit Daumen runter, zum Ausschließen.') },
            { wert: 'meta', titel: gruppeText(t, 'meta'), text: t('crm.werbung.zielgruppen.kl.gruppe.metaText', 'Alle Leads, die über Facebook oder Instagram kamen.') },
            { wert: 'alle', titel: gruppeText(t, 'alle'), text: t('crm.werbung.zielgruppen.kl.gruppe.alleText', 'Alle Leads mit E-Mail oder Telefonnummer, ohne interne Kontakte.') },
          ]} />
          <Einstellung fuer="kl-zeitraum" label={t('crm.werbung.zielgruppen.kl.zeitraum.label', 'Zeitraum')} empfohlen={zeitraum === 'alle'}
            erklaerung={t('crm.werbung.zielgruppen.kl.zeitraum.hilfe', 'Nur Kontakte, die in diesem Zeitraum ins CRM kamen. Für Ausschlüsse am besten alle.')}>
            <select id="kl-zeitraum" value={zeitraum} onChange={ev => setZeitraum(ev.target.value as Zeitraum)} className={EINGABE_KLEIN}>
              <option value="alle">{t('crm.werbung.zielgruppen.kl.zeitraum.alleOpt', 'Alle')}</option>
              <option value="365">{t('crm.werbung.zielgruppen.kl.zeitraum.j1', 'Letzte 12 Monate')}</option>
              <option value="730">{t('crm.werbung.zielgruppen.kl.zeitraum.j2', 'Letzte 2 Jahre')}</option>
              <option value="1825">{t('crm.werbung.zielgruppen.kl.zeitraum.j5', 'Letzte 5 Jahre')}</option>
            </select>
          </Einstellung>
        </Abschnitt>

        <Hinweis>{t('crm.werbung.zielgruppen.kl.einsetzen', 'Einsetzen im Kampagnen-Assistenten unter Anzeigengruppe, Zielgruppe: zum Ausschließen (z. B. Käufer) oder Einschließen (z. B. neue Projekte für Bestandskunden).')}</Hinweis>

        <Haken checked={bestaetigt} onChange={setBestaetigt}
          label={t('crm.werbung.zielgruppen.kl.bestaetigung', 'Ich bestätige: Für diese Kontakte gibt es eine Rechtsgrundlage, und die Datenschutzerklärung nennt Meta Custom Audiences.')} />
      </fieldset>

      <Hinweis ton="info" titel={t('crm.werbung.zielgruppen.wohnenTitel', 'Sonderkategorie Wohnen')}>
        {t('crm.werbung.zielgruppen.kl.wohnen', 'Kundenlisten sind unter Wohnen erlaubt. Die Auswahl hier filtert nur nach CRM-Status, nie nach Alter, Geschlecht oder Herkunft.')}
      </Hinweis>
    </AssistentRahmen>
  )
}
