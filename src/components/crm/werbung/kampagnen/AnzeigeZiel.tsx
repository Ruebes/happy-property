import { useTranslation } from 'react-i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import {
  CTA_TYPES, LIMITS, TELEFON_RE, ctaFor, isFormKind, isWebsiteKind, normalizeTelefon,
  type AdDestination, type AdDestinationKind, type AdDraft, type Destination,
} from '../../../../lib/metaSpec'
import { DASH_CHARS } from '../../../../lib/metaLint'
import { INPUT_CLS } from '../felder'
import { FeldHinweise } from './PruefPanel'
import { Abschnitt, FeldRahmen, RadioReihe, TextFeld, feldId, feldLabel } from './Bausteine'
import { EmpfohlenBadge } from './bearbeitenHelfer'
import { CTA_STANDARD, zielArtenFuer, zielUmstellen } from './r23Typen'

type ZielArt = AdDestinationKind
const istTelefon = (s: string | undefined): boolean => TELEFON_RE.test(normalizeTelefon(s))

// ── Ziel und Call-to-Action ──────────────────────────────────────────────────
// Das Ziel folgt aus dem Conversion-Ort der Anzeigengruppe: Website,
// Sofortformular, Website und Sofortformular, WhatsApp, Anruf, Messenger.
// Je Ziel die nötigen Angaben (URL, Formular, Telefonnummer, WhatsApp-Texte;
// die WhatsApp-Nummer gehört zur Anzeigengruppe). Der Button zeigt alle CTAs;
// was nicht zum Ziel passt, steht grau mit Grund darin. Facebook-Beiträge
// bringen Link und Button selbst mit.

const ZIEL_TEXT: Readonly<Record<ZielArt, [string, string]>> = {
  website: ['crm.werbung.builder.zielart.website', 'Website'],
  lead_form: ['crm.werbung.builder.zielart.lead_form', 'Sofortformular'],
  website_lead_form: ['crm.werbung.builder.zielart.website_lead_form', 'Website und Sofortformular'],
  whatsapp: ['crm.werbung.builder.zielart.whatsapp', 'WhatsApp'],
  phone_call: ['crm.werbung.builder.zielart.phone_call', 'Anruf'],
  messenger: ['crm.werbung.builder.zielart.messenger', 'Messenger'],
}
const ARTEN: readonly ZielArt[] = ['website', 'lead_form', 'website_lead_form', 'whatsapp', 'phone_call', 'messenger']

export default function AnzeigeZiel({ ad, node, adsetDestination, adsetWhatsapp, setze, disabled, formulare, standardUrl }: {
  ad: AdDraft
  node: string
  adsetDestination: Destination | undefined
  /** WhatsApp-Nummer der Anzeigengruppe (promoted_object.whatsapp_phone_number) */
  adsetWhatsapp: string | undefined
  setze: (p: Partial<AdDraft>) => void
  disabled: boolean
  formulare: SelectOption[]
  standardUrl: string
}) {
  const { t } = useTranslation()
  const zt = (a: ZielArt) => t(ZIEL_TEXT[a][0], ZIEL_TEXT[a][1])
  const fbBeitrag = ad.beitrag?.quelle === 'facebook'
  const igBeitrag = ad.beitrag?.quelle === 'instagram'
  // Beiträge: Facebook nur Website (Link aus dem Beitrag), Instagram Website oder WhatsApp
  const erlaubt = zielArtenFuer(adsetDestination).filter(a => !ad.beitrag || a === 'website' || (igBeitrag && a === 'whatsapp'))
  const z: AdDestination = ad.destination ?? { kind: 'website', url: standardUrl }
  const art: ZielArt = z.kind
  const passt = erlaubt.indexOf(art) >= 0
  const ctas = ctaFor(art)

  const setzeZiel = (n: AdDestination) => setze({ destination: n })
  const setzeArt = (a: ZielArt) => {
    const moeglich = ctaFor(a)
    setze({ destination: zielUmstellen(z, a, standardUrl), cta_type: moeglich.indexOf(ad.cta_type) >= 0 ? ad.cta_type : CTA_STANDARD[a] })
  }

  // CTA-Auswahl: alle, nicht passende grau mit Grund
  const ctaOptionen: SelectOption[] = CTA_TYPES.map(c => {
    const ok = ctas.indexOf(c) >= 0
    const wo = ARTEN.filter(a => ctaFor(a).indexOf(c) >= 0).map(zt)
    return {
      value: c,
      label: t(`crm.werbung.meta.cta.${c}`, c === 'SEE_DETAILS' ? 'Details ansehen' : c),
      disabled: !ok,
      hint: ok
        ? (c === CTA_STANDARD[art] ? t('crm.werbung.bearbeiten.empfohlen', 'Empfohlen für Happy Property') : undefined)
        : wo.length
          ? t('crm.werbung.builder.zielart.ctaNurMit', 'Nur mit Ziel: {{orte}}', { orte: wo.join(', ') })
          : t('crm.werbung.builder.zielart.ctaNie', 'Für Lead-Anzeigen von Happy Property nicht vorgesehen'),
    }
  })

  const telefon = z.kind === 'phone_call' ? z.telefon : ''
  const telefonFalsch = z.kind === 'phone_call' && telefon.trim() !== '' && !istTelefon(telefon)
  const waTexte: Array<['begruessung' | 'nachricht', string, string, string]> = [
    ['begruessung', 'ad.destination.whatsapp_begruessung', t('crm.werbung.builder.zielart.waBegruessung', 'Begrüßung im Chat'), t('crm.werbung.builder.zielart.waBegruessungHilfe', 'Die erste Nachricht von Happy Property, wenn der Chat aufgeht. Optional.')],
    ['nachricht', 'ad.destination.whatsapp_nachricht', t('crm.werbung.builder.zielart.waNachricht', 'Vorgeschlagene Nachricht'), t('crm.werbung.builder.zielart.waNachrichtHilfe', 'Text, den die Person mit einem Tipp senden kann, z. B. „Ich möchte mehr über Zypern wissen“. Optional.')],
  ]

  return (
    <Abschnitt titel={t('crm.werbung.builder.anzeige.ziel', 'Ziel und Call-to-Action')}
      hilfe={t('crm.werbung.bearbeiten.hilfe.ziel', 'Wohin der Klick führt und was auf dem Button steht. HP: Landingpage oder /termin mit „Jetzt buchen“.')}
      alleOffen={'display_link' in z && !!z.display_link}
      alle={isWebsiteKind(art) && !fbBeitrag ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextFeld node={node} feld="ad.destination.display_link" label={feldLabel(t, 'ad.destination.display_link', 'Angezeigter Link')}
            hilfe={t('crm.werbung.bearbeiten.hilfe.angezeigterLink', 'Kurze Adresse, die statt der vollen URL in der Anzeige steht. Optional.')}
            value={'display_link' in z ? z.display_link ?? '' : ''} disabled={disabled}
            onChange={v => (z.kind === 'website' || z.kind === 'website_lead_form') && setzeZiel({ ...z, display_link: v.trim() || undefined })} />
        </div>
      ) : undefined}>
      <div id={feldId('ad.destination.kind')} data-einstellung={feldLabel(t, 'ad.destination.kind', 'Ziel')} className="space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-gray-500">{feldLabel(t, 'ad.destination.kind', 'Ziel')}</span>
          {passt && art === erlaubt[0] && <EmpfohlenBadge />}
        </div>
        {erlaubt.length > 1 ? (
          <RadioReihe<ZielArt> name={`ziel-${node}`} value={art} disabled={disabled} label={feldLabel(t, 'ad.destination.kind', 'Ziel')}
            optionen={erlaubt.map(a => [a, zt(a)] as [ZielArt, string])} onChange={setzeArt} />
        ) : erlaubt.length === 1 ? (
          <p className="text-xs font-semibold text-gray-800">{zt(erlaubt[0])}</p>
        ) : (
          <p className="text-xs text-red-700">{t('crm.werbung.builder.zielart.keins', 'Für diesen Conversion-Ort kann der Assistent keine Anzeige bauen.')}</p>
        )}
        <p className="text-[10px] leading-snug text-gray-500">
          {ad.beitrag
            ? t('crm.werbung.builder.zielart.beitragHilfe', 'Bei Beiträgen: Facebook nur Website (Link aus dem Beitrag), Instagram Website oder WhatsApp.')
            : t('crm.werbung.builder.zielart.hilfe', 'Folgt aus dem Conversion-Ort der Anzeigengruppe.')}
        </p>
        {!passt && erlaubt.length > 0 && (
          <p className="text-[11px] text-red-700">
            {t('crm.werbung.builder.anzeige.zielPasstNicht', 'Das Ziel passt nicht zum Conversion-Ort der Anzeigengruppe.')}
            {' '}{t('crm.werbung.builder.zielart.ist', 'Jetzt: {{ist}}.', { ist: zt(art) })}
            {!disabled && (
              <button type="button" onClick={() => setzeArt(erlaubt[0])} className="ml-1 font-semibold underline">
                {t('crm.werbung.builder.anzeige.zielAnpassen', 'Anpassen')}
              </button>
            )}
          </p>
        )}
        <FeldHinweise node={node} felder={['ad.destination.kind', 'ad.beitrag']} />
      </div>

      {fbBeitrag ? (
        <p className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-[11px] text-gray-600">
          {t('crm.werbung.builder.zielart.fbBeitrag', 'Link und Button kommen aus dem Facebook-Beitrag und lassen sich hier nicht ändern.')}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {(z.kind === 'website' || z.kind === 'website_lead_form') && (
            <TextFeld node={node} feld="ad.destination.url" label={feldLabel(t, 'ad.destination.url', 'Website-URL')}
              hilfe={t('crm.werbung.bearbeiten.hilfe.url', 'Die Seite, auf der der Termin gebucht wird. UTM-Parameter hängt das System selbst an.')}
              value={z.url ?? ''} disabled={disabled} maxLen={LIMITS.urlMax}
              onChange={v => setzeZiel({ ...z, url: v.trim() })} />
          )}
          {(z.kind === 'lead_form' || z.kind === 'website_lead_form') && (
            <FeldRahmen node={node} feld="ad.destination.form_id" label={feldLabel(t, 'ad.destination.form_id', 'Sofortformular')}
              hilfe={t('crm.werbung.builder.zielart.formularHilfe', 'Das Formular, in das die Person ihre Daten einträgt. Neue Formulare im Reiter „Sofortformulare“.')}>
              {formulare.length ? (
                <div className="mt-0.5"><CustomSelect value={z.form_id ?? ''} options={formulare} disabled={disabled}
                  onChange={v => setzeZiel({ ...z, form_id: v })} /></div>
              ) : (
                <input value={z.form_id ?? ''} disabled={disabled} className={INPUT_CLS}
                  placeholder={t('crm.werbung.builder.anzeige.formularId', 'Formular-ID')}
                  onChange={ev => setzeZiel({ ...z, form_id: ev.target.value.trim() })} />
              )}
            </FeldRahmen>
          )}
          {z.kind === 'phone_call' && (
            <TextFeld node={node} feld="ad.destination.telefon" label={feldLabel(t, 'ad.destination.telefon', 'Telefonnummer')}
              hilfe={t('crm.werbung.builder.zielart.telefonHilfe', 'Mit Ländervorwahl, z. B. +357 26 123456. Diese Nummer wählt das Telefon beim Klick.')}
              value={telefon} disabled={disabled} maxLen={30} placeholder="+357 …"
              onChange={v => setzeZiel({ kind: 'phone_call', telefon: v })} />
          )}
          {z.kind === 'whatsapp' && (
            <div className="space-y-0.5 sm:col-span-2">
              <p className="text-[11px] text-gray-500">🔒 {t('crm.werbung.builder.zielart.waNummer', 'WhatsApp-Nummer')}</p>
              <p className="text-xs text-gray-800">{adsetWhatsapp?.trim()
                ? adsetWhatsapp
                : t('crm.werbung.builder.zielart.waNummerSeite', 'Nummer, die mit der Facebook-Seite verknüpft ist')}</p>
              <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.zielart.waNummerHilfe', 'Die Nummer gehört zur Anzeigengruppe (Abschnitt Conversion).')}</p>
            </div>
          )}
          {z.kind === 'whatsapp' && waTexte.map(([schluessel, feld, label, hilfe]) => {
            const wert = z[schluessel] ?? ''
            return (
              <div key={schluessel} className="sm:col-span-2">
                <TextFeld node={node} feld={feld} label={label} hilfe={hilfe} value={wert} disabled={disabled} maxLen={LIMITS.whatsappTextMax} zaehler={LIMITS.whatsappTextMax}
                  onChange={v => setzeZiel(schluessel === 'begruessung' ? { ...z, begruessung: v || undefined } : { ...z, nachricht: v || undefined })} />
                {DASH_CHARS.test(wert) && <p role="alert" className="text-[10px] font-semibold text-red-600">{t('crm.werbung.builder.anzeige.strich', 'Gedankenstrich gefunden: bitte normalen Bindestrich nehmen.')}</p>}
              </div>
            )
          })}
          {z.kind === 'messenger' && (
            <p className="text-[11px] text-gray-600 sm:col-span-2">{t('crm.werbung.builder.zielart.messengerHilfe', 'Der Klick öffnet einen Messenger-Chat mit der Facebook-Seite.')}</p>
          )}
          <FeldRahmen node={node} feld="ad.cta_type" label={feldLabel(t, 'ad.cta_type', 'Call-to-Action')}
            hilfe={ad.cta_type === 'CALL_NOW'
              ? t('crm.werbung.builder.zielart.ctaAnruf', 'Der Button ruft die Telefonnummer an.')
              : ad.cta_type === 'WHATSAPP_MESSAGE'
                ? t('crm.werbung.builder.zielart.ctaWhatsapp', 'Der Button öffnet einen WhatsApp-Chat.')
                : ad.cta_type === 'MESSAGE_PAGE'
                  ? t('crm.werbung.builder.zielart.ctaMessenger2', 'Der Button öffnet einen Messenger-Chat.')
                  : t('crm.werbung.bearbeiten.hilfe.cta', 'Der Button unter der Anzeige.')}
            empfehlung={{ aktiv: ad.cta_type === CTA_STANDARD[art], text: t(`crm.werbung.meta.cta.${CTA_STANDARD[art]}`, CTA_STANDARD[art]), uebernehmen: () => setze({ cta_type: CTA_STANDARD[art] }) }}
            disabled={disabled}>
            <div className="mt-0.5">
              <CustomSelect value={ad.cta_type} options={ctaOptionen} disabled={disabled}
                onChange={v => { const c = CTA_TYPES.find(x => x === v); if (c) setze({ cta_type: c }) }} />
            </div>
          </FeldRahmen>
        </div>
      )}
      {telefonFalsch && (
        <p role="alert" className="text-[11px] text-red-700">
          {t('crm.werbung.builder.zielart.telefonFalsch', 'Die Telefonnummer braucht die Ländervorwahl mit +, z. B. +49 30 1234567.')}
          {' '}{t('crm.werbung.builder.zielart.telefonGelesen', 'Gelesen als {{nummer}}.', { nummer: normalizeTelefon(telefon) || '-' })}
        </p>
      )}
      {z.kind === 'phone_call' && !telefon.trim() && (
        <p className="text-[11px] text-amber-800">{t('crm.werbung.builder.zielart.telefonFehlt', 'Ohne Telefonnummer kann Meta die Anzeige nicht anlegen.')}</p>
      )}
      {isFormKind(art) && ad.partnerschaft && (
        <p className="text-[11px] text-amber-800">{t('crm.werbung.builder.zielart.partnerFormular', 'Partnerschaftswerbung mit Sofortformular: das Formular muss zur Seite der Anzeigengruppe gehören und das Format „Grußkarte“ haben.')}</p>
      )}
    </Abschnitt>
  )
}
