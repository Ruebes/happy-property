import { useTranslation } from 'react-i18next'
import { FeldHinweise } from './PruefPanel'
import { Abschnitt, Schalter, TextFeld, feldId } from './Bausteine'
import type { AdDraft, PartnerschaftSpec } from '../../../../lib/metaSpec'

// ── Partnerschaftswerbung (Branded Content) ──────────────────────────────────
// Die Anzeige erscheint unter Happy Property UND einem Partner (z. B. einem
// Creator). Meta-Felder: facebook_branded_content / instagram_branded_content
// / branded_content (metaSpec ad.partnerschaft). Der Partner muss die
// Partnerschaft vorher in Instagram freigeben. Standard aus.

const META_ID = /^\d{6,25}$/

export default function PartnerAbschnitt({ ad, node, setze, disabled }: {
  ad: AdDraft
  node: string
  setze: (p: Partial<AdDraft>) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const p: PartnerschaftSpec | undefined = ad.partnerschaft
  const an = !!p
  const setzeP = (x: Partial<PartnerschaftSpec>) => setze({ partnerschaft: { ...(p ?? {}), ...x } })
  const ig = (p?.partner_ig_user_id ?? '').trim()
  const seite = (p?.partner_page_id ?? '').trim()
  const falsch = (!!ig && !META_ID.test(ig)) || (!!seite && !META_ID.test(seite))

  return (
    <Abschnitt id={feldId('ad.partnerschaft')} titel={t('crm.werbung.builder.partner.titel', 'Partnerschaftswerbung')}
      hilfe={t('crm.werbung.builder.partner.hilfe', 'Die Anzeige erscheint unter Happy Property und dem Namen eines Partners, z. B. eines Creators. Der Partner muss die Partnerschaft vorher freigeben.')}
      alleOffen={!!p?.partner_ist_absender}
      alle={an ? (
        <Schalter checked={p?.partner_ist_absender === true} disabled={disabled} empfohlen={p?.partner_ist_absender !== true}
          onChange={v => setzeP({ partner_ist_absender: v || undefined })}
          label={t('crm.werbung.builder.partner.absender', 'Partner ist der Absender')}
          hilfe={t('crm.werbung.builder.partner.absenderHilfe', 'Die Anzeige läuft über die Seite des Partners, Happy Property steht an zweiter Stelle. Braucht die Facebook-Seite des Partners.')} />
      ) : undefined}>
      <Schalter checked={an} disabled={disabled} empfohlen={!an}
        onChange={v => setze({ partnerschaft: v ? {} : undefined })}
        label={t('crm.werbung.builder.partner.schalter', 'Als Partnerschaftswerbung schalten')}
        hilfe={t('crm.werbung.builder.partner.schalterHilfe', 'Standard aus. Sinnvoll mit Creators oder Kunden, die Happy Property empfehlen.')} />
      {an && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextFeld node={node} feld="ad.partnerschaft.partner_ig_user_id" label={t('crm.werbung.builder.partner.ig', 'Instagram-Konto des Partners (ID)')}
              hilfe={t('crm.werbung.builder.partner.igHilfe', 'Die Konto-ID des Partners (nur Ziffern). Er sieht die Anfrage in seiner App.')}
              value={p?.partner_ig_user_id ?? ''} disabled={disabled} maxLen={30}
              onChange={v => setzeP({ partner_ig_user_id: v.trim() || undefined })} />
            <TextFeld node={node} feld="ad.partnerschaft.partner_page_id" label={t('crm.werbung.builder.partner.seite', 'Facebook-Seite des Partners (ID)')}
              hilfe={t('crm.werbung.builder.partner.seiteHilfe', 'Nötig, wenn die Anzeige auch auf Facebook unter dem Partner erscheinen soll.')}
              value={p?.partner_page_id ?? ''} disabled={disabled} maxLen={30}
              onChange={v => setzeP({ partner_page_id: v.trim() || undefined })} />
          </div>
          {falsch && <p role="alert" className="text-[11px] text-red-700">{t('crm.werbung.builder.partner.idFalsch', 'Konto- und Seiten-IDs bestehen nur aus Ziffern.')}</p>}
          {!ig && !seite && <p className="text-[11px] text-amber-800">{t('crm.werbung.builder.partner.fehlt', 'Ohne Instagram-Konto oder Facebook-Seite des Partners legt Meta keine Partnerschaftswerbung an.')}</p>}
          <p className="text-[11px] leading-snug text-gray-600">{t('crm.werbung.builder.partner.regel', 'Keine Projekt- oder Bauträgernamen als Partner sichtbar machen.')}</p>
        </>
      )}
      <FeldHinweise node={node} felder="ad.partnerschaft" />
    </Abschnitt>
  )
}
