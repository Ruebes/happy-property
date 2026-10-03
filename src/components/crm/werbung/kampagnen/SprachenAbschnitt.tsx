import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LIMITS, isWebsiteKind, type AdDraft, type SprachVariante, type SprachenSpec } from '../../../../lib/metaSpec'
import { DESCRIPTION_MAX, HEADLINE_MAX, PRIMARY_VISIBLE } from '../../../../lib/metaLint'
import { INPUT_CLS } from '../felder'
import { FeldHinweise } from './PruefPanel'
import { Abschnitt, GesperrteEinstellung, RadioReihe, Schalter, TextFeld, feldId } from './Bausteine'
import { EmpfohlenBadge } from './bearbeitenHelfer'

// ── Sprachen (Deutsch Standard + Englisch) ───────────────────────────────────
// Meta zeigt jeder Person die passende Sprachversion (asset_feed_spec mit
// optimization_type LANGUAGE, Deutsch = Standard). Englische Texte selbst
// schreiben (HP-Empfehlung) oder Meta übersetzen lassen (autotranslate,
// Label „Automatisch übersetzt"). Nur Einzelbild/-video mit Website-Ziel und
// je Sprache ein Text. Ob Meta das bei Lead-Kampagnen annimmt, zeigt
// „Bei Meta prüfen" (validate_only).

const leerEn = (): SprachVariante => ({ sprache: 'en', primary_text: '', headline: '' })
const zaehlerKlasse = (len: number, max: number) => `block text-right text-[10px] tabular-nums ${len > max ? 'font-semibold text-red-600' : 'text-gray-400'}`

export default function SprachenAbschnitt({ ad, node, setze, disabled }: {
  ad: AdDraft
  node: string
  setze: (p: Partial<AdDraft>) => void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const sp: SprachenSpec | undefined = ad.sprachen
  const an = !!sp && ((sp.varianten ?? []).length > 0 || (sp.automatisch_uebersetzen ?? []).length > 0)
  const auto = (sp?.automatisch_uebersetzen ?? []).indexOf('en') >= 0
  const en: SprachVariante = (sp?.varianten ?? []).find(v => v.sprache === 'en') ?? leerEn()
  // Englische Texte beim Wechsel auf „automatisch" merken (Meta erlaubt nicht beides)
  const [gemerkt, setGemerkt] = useState<SprachVariante | null>(null)
  const titel = t('crm.werbung.builder.sprachen.titel', 'Sprachen')
  const schalterLabel = t('crm.werbung.builder.sprachen.mehrere', 'Mehrere Sprachen (Deutsch und Englisch)')

  const grund = ad.beitrag
    ? t('crm.werbung.builder.sprachen.nichtBeitrag', 'Vorhandene Beiträge laufen in ihrer eigenen Sprache.')
    : ad.format !== 'single_image' && ad.format !== 'single_video'
      ? t('crm.werbung.builder.sprachen.nurEinzel', 'Nur bei Einzelbild und Einzelvideo. Ein Karussell läuft in einer Sprache.')
      : !isWebsiteKind(ad.destination?.kind)
        ? t('crm.werbung.builder.sprachen.nurWebsite', 'Nur mit Ziel Website. Formulare, WhatsApp und Anrufe laufen in einer Sprache.')
        : null
  if (grund && !an) {
    return (
      <Abschnitt id={feldId('ad.sprachen')} titel={titel}>
        <GesperrteEinstellung label={schalterLabel} grund={grund} />
      </Abschnitt>
    )
  }

  const setzeEn = (p: Partial<SprachVariante>) => setze({ sprachen: { ...(sp ?? { varianten: [] }), varianten: [...(sp?.varianten ?? []).filter(v => v.sprache !== 'en'), { ...en, ...p }] } })
  const schalten = (v: boolean) => setze({ sprachen: v ? { varianten: [gemerkt ?? leerEn()] } : undefined })
  const modus = (m: 'selbst' | 'auto') => {
    if (m === 'auto') {
      setGemerkt(en)
      setze({ sprachen: { varianten: (sp?.varianten ?? []).filter(x => x.sprache !== 'en'), automatisch_uebersetzen: ['en'] } })
    } else {
      setze({ sprachen: { varianten: [...(sp?.varianten ?? []).filter(x => x.sprache !== 'en'), gemerkt ?? leerEn()] } })
    }
  }
  const mehrereDe = (ad.primary_texts ?? []).filter(x => (x ?? '').trim()).length > 1 || (ad.headlines ?? []).filter(x => (x ?? '').trim()).length > 1
    || (ad.descriptions ?? []).filter(x => (x ?? '').trim()).length > 1

  return (
    <Abschnitt id={feldId('ad.sprachen')} titel={titel}
      hilfe={t('crm.werbung.builder.sprachen.hilfe', 'Meta zeigt jeder Person die Sprachversion, die zu ihren Facebook-Einstellungen passt. Deutsch bleibt der Standard.')}
      aktion={an ? <span className="text-[11px] font-semibold text-hp-navy">{t('crm.werbung.builder.sprachen.aktiv', 'Deutsch + Englisch')}</span> : undefined}>
      <Schalter checked={an} disabled={disabled} empfohlen={!an} onChange={schalten} label={schalterLabel}
        hilfe={t('crm.werbung.builder.sprachen.mehrereHilfe', 'Für deutschsprachige Anleger im Ausland, die Facebook auf Englisch nutzen. Standard: nur Deutsch.')} />
      {grund && an && <p role="alert" className="text-[11px] text-red-700">{grund}</p>}
      {an && (
        <div className="space-y-3">
          <RadioReihe<'selbst' | 'auto'> name={`sprache-modus-${node}`} value={auto ? 'auto' : 'selbst'} disabled={disabled}
            label={t('crm.werbung.builder.sprachen.modus', 'Englische Texte')}
            optionen={[
              ['selbst', t('crm.werbung.builder.sprachen.selbst', 'Selbst schreiben')],
              ['auto', t('crm.werbung.builder.sprachen.auto', 'Meta übersetzt automatisch')],
            ]} onChange={modus} />
          {auto ? (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
              {t('crm.werbung.builder.sprachen.autoHilfe', 'Meta übersetzt die deutschen Texte selbst und kennzeichnet sie als „Automatisch übersetzt“. Niemand prüft die Übersetzung vorher. Für HP besser selbst schreiben.')}
            </p>
          ) : (
            <div className="space-y-3 rounded-lg border border-gray-200 p-3">
              <p className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-gray-700">
                {t('crm.werbung.builder.sprachen.englisch', 'Englische Version')}<EmpfohlenBadge />
              </p>
              <label className="block text-[11px] text-gray-500">{t('crm.werbung.builder.sprachen.primaer', 'Primärer Text (Englisch)')}
                <textarea value={en.primary_text} rows={4} disabled={disabled} onChange={ev => setzeEn({ primary_text: ev.target.value })}
                  maxLength={LIMITS.primaryTextMax} className={`${INPUT_CLS} resize-y`} />
                <span className={zaehlerKlasse(0, 1)}>{t('crm.werbung.builder.anzeige.sichtbar', '{{len}} Zeichen, sichtbar bis {{max}}', { len: en.primary_text.trim().length, max: PRIMARY_VISIBLE })}</span>
              </label>
              <label className="block text-[11px] text-gray-500">{t('crm.werbung.builder.sprachen.ueberschrift', 'Überschrift (Englisch)')}
                <input value={en.headline} disabled={disabled} onChange={ev => setzeEn({ headline: ev.target.value })} maxLength={LIMITS.headlineApiMax}
                  className={INPUT_CLS} />
                <span className={zaehlerKlasse(en.headline.trim().length, HEADLINE_MAX)}>{en.headline.trim().length} / {HEADLINE_MAX}</span>
              </label>
              <label className="block text-[11px] text-gray-500">{t('crm.werbung.builder.sprachen.beschreibung', 'Beschreibung (Englisch, optional)')}
                <input value={en.description ?? ''} disabled={disabled} onChange={ev => setzeEn({ description: ev.target.value || undefined })} maxLength={LIMITS.descriptionApiMax}
                  className={INPUT_CLS} />
                <span className={zaehlerKlasse((en.description ?? '').trim().length, DESCRIPTION_MAX)}>{(en.description ?? '').trim().length} / {DESCRIPTION_MAX}</span>
              </label>
              <TextFeld node={node} feld="ad.sprachen.url" label={t('crm.werbung.builder.sprachen.url', 'Englische Landingpage (optional)')}
                hilfe={t('crm.werbung.builder.sprachen.urlHilfe', 'Leer lassen: der Klick führt auf dieselbe Seite wie die deutsche Version.')}
                value={en.url ?? ''} disabled={disabled} maxLen={LIMITS.urlMax}
                onChange={v => setzeEn({ url: v.trim() || undefined })} />
            </div>
          )}
          {mehrereDe && (
            <p className="text-[11px] text-amber-800">{t('crm.werbung.builder.sprachen.einText', 'Mit mehreren Sprachen gilt je Sprache ein Text: bitte bei den deutschen Texten nur eine Variante je Feld behalten.')}</p>
          )}
          <p className="text-[10px] leading-snug text-gray-500">{t('crm.werbung.builder.sprachen.pruefen', 'Ob Meta Sprachversionen bei Lead-Kampagnen annimmt, zeigt „Bei Meta prüfen“ vor dem Anlegen.')}</p>
        </div>
      )}
      <FeldHinweise node={node} felder="ad.sprachen" />
    </Abschnitt>
  )
}
