import { useTranslation } from 'react-i18next'
import { HP_PIXEL_ID, LIMITS, URL_TAGS_STANDARD, isFormKind, isWebsiteKind, registrableDomain, type AdDraft, type AdTrackingSpec } from '../../../../lib/metaSpec'
import { Abschnitt, Schalter, TextFeld, feldId, feldLabel } from './Bausteine'
import { FeldHinweise } from './PruefPanel'
import { EmpfohlenBadge } from './bearbeitenHelfer'
import { useAssistent } from './useEntwurf'

// ── Tracking ─────────────────────────────────────────────────────────────────
// Website-Ereignisse: das Pixel der Anzeigengruppe misst immer mit (fest).
// Zusätzlich weitere Pixel (tracking_specs offsite_conversion) und bei
// Sofortformularen die CRM-Ereignisse (leadgen_quality_conversion: Lead-Stufen
// aus dem CRM über die Conversions API). Conversion-Domain setzt das System
// aus der Website-URL, hier überschreibbar. URL-Parameter: fester
// UTM-Standard, nicht änderbar. Gespeichert in ad.tracking (metaSpec).

export default function TrackingAbschnitt({ ad, node, setze, disabled, adsetPixel }: {
  ad: AdDraft
  node: string
  setze: (p: Partial<AdDraft>) => void
  disabled: boolean
  /** Pixel aus promoted_object der Anzeigengruppe (misst automatisch) */
  adsetPixel: string | undefined
}) {
  const { t } = useTranslation()
  const { katalog } = useAssistent()
  const tr: AdTrackingSpec = ad.tracking ?? {}
  const weitere = tr.weitere_pixel ?? []
  const hauptPixel = adsetPixel || HP_PIXEL_ID
  const kind = ad.destination?.kind
  const formular = isFormKind(kind)
  const url = ad.destination && (ad.destination.kind === 'website' || ad.destination.kind === 'website_lead_form') ? ad.destination.url : ''
  const autoDomain = isWebsiteKind(kind) && url ? registrableDomain(url) : null

  const setzeTr = (p: Partial<AdTrackingSpec>) => {
    const n: AdTrackingSpec = { ...tr, ...p }
    if (!n.weitere_pixel?.length) delete n.weitere_pixel
    if (!n.lead_qualitaet) delete n.lead_qualitaet
    if (!n.conversion_domain) delete n.conversion_domain
    setze({ tracking: Object.keys(n).length ? n : undefined })
  }
  const togglePixel = (id: string, an: boolean) => setzeTr({ weitere_pixel: an ? [...weitere.filter(x => x !== id), id] : weitere.filter(x => x !== id) })

  const pixelListe: Array<{ id: string; name: string }> = (katalog?.pixels ?? []).filter(p => p.id !== hauptPixel).map(p => ({ id: p.id, name: p.name }))
  for (const id of weitere) if (!pixelListe.some(p => p.id === id)) pixelListe.push({ id, name: id })
  const voll = weitere.length >= LIMITS.trackingPixelMax

  return (
    <Abschnitt id={feldId('ad.tracking_specs')} titel={t('crm.werbung.builder.tracking.titel', 'Tracking')}
      hilfe={t('crm.werbung.builder.tracking.hilfe', 'Welche Ereignisse Meta dieser Anzeige zurechnet. Das Pixel der Anzeigengruppe misst immer mit.')}
      alleOffen={weitere.length > 0 || !!tr.lead_qualitaet || !!tr.conversion_domain}
      alle={(
        <div className="space-y-3">
          <div id={feldId('ad.tracking.pixel')} data-einstellung={t('crm.werbung.builder.tracking.weitere', 'Weitere Pixel erfassen')} className="scroll-mt-24 space-y-1.5">
            <p className="text-[11px] text-gray-500">{t('crm.werbung.builder.tracking.weitere', 'Weitere Pixel erfassen')}</p>
            <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.tracking.weitereHilfe', 'Nur zum Mitzählen in Berichten, Meta optimiert weiter auf das Pixel der Anzeigengruppe. Für HP meist nicht nötig (höchstens 5).')}</p>
            {pixelListe.length ? pixelListe.map(p => (
              <Schalter key={p.id} checked={weitere.indexOf(p.id) >= 0} disabled={disabled || (voll && weitere.indexOf(p.id) < 0)}
                onChange={v => togglePixel(p.id, v)} label={`${p.name} (${p.id})`} />
            )) : <p className="text-[11px] text-gray-500">{t('crm.werbung.builder.tracking.keinePixel', 'Keine weiteren Pixel im Werbekonto.')}</p>}
          </div>
          <TextFeld node={node} feld="ad.tracking.conversion_domain" label={t('crm.werbung.builder.tracking.domain', 'Conversion-Domain')}
            hilfe={autoDomain
              ? t('crm.werbung.builder.tracking.domainAuto', 'Leer lassen: das System nimmt {{domain}} aus der Website-URL.', { domain: autoDomain })
              : t('crm.werbung.builder.tracking.domainHilfe', 'Die Domain, auf der die Website-Ereignisse passieren, z. B. happy-property.com.')}
            value={tr.conversion_domain ?? ''} disabled={disabled} maxLen={253} placeholder={autoDomain ?? ''}
            onChange={v => setzeTr({ conversion_domain: v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || undefined })} />
        </div>
      )}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div data-einstellung={t('crm.werbung.builder.tracking.website', 'Website-Ereignisse')}>
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">🔒 {t('crm.werbung.builder.tracking.website', 'Website-Ereignisse')}{hauptPixel === HP_PIXEL_ID && <EmpfohlenBadge />}</p>
          <p className="mt-0.5 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-700">
            {hauptPixel === HP_PIXEL_ID ? t('crm.werbung.builder.tracking.hpPixel', 'HP-Pixel {{id}}', { id: hauptPixel }) : hauptPixel}
          </p>
          <p className="mt-0.5 text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.tracking.websiteHilfe', 'Kommt aus dem Datensatz der Anzeigengruppe und misst Termine auf Landingpages und /termin.')}</p>
        </div>
        <div id={feldId('ad.url_tags')} data-einstellung={feldLabel(t, 'ad.url_tags', 'URL-Parameter')}>
          <p className="text-[11px] text-gray-500">🔒 {feldLabel(t, 'ad.url_tags', 'URL-Parameter')}</p>
          <code className="mt-0.5 block break-all rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 text-[10px] text-gray-600">{URL_TAGS_STANDARD}</code>
          <p className="mt-0.5 text-[10px] text-gray-500">{t('crm.werbung.meta.help.ad_url_tags', 'Fester UTM-Standard, wird an jeden Link angehängt: Kampagne, Anzeigengruppe und Werbeanzeige als ID. Nicht änderbar.')}</p>
        </div>
        {formular && (
          <div id={feldId('ad.tracking.lead_qualitaet')} className="scroll-mt-24 sm:col-span-2">
            <Schalter checked={tr.lead_qualitaet === true} disabled={disabled} empfohlen={tr.lead_qualitaet === true}
              onChange={v => setzeTr({ lead_qualitaet: v || undefined })}
              label={t('crm.werbung.builder.tracking.crm', 'CRM-Ereignisse erfassen (Conversion-Leads)')}
              hilfe={t('crm.werbung.builder.tracking.crmHilfe', 'Die Lead-Stufen aus dem CRM (Termin gebucht, stattgefunden, qualifiziert, Kunde) zählen bei dieser Anzeige mit. Grundlage für „Anzahl qualifizierter Leads maximieren“.')} />
          </div>
        )}
      </div>
      <FeldHinweise node={node} felder={['ad.tracking_specs', 'ad.tracking.pixel', 'ad.tracking.lead_qualitaet', 'ad.tracking.conversion_domain']} />
    </Abschnitt>
  )
}
