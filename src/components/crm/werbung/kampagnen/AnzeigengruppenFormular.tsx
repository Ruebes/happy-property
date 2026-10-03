import { useTranslation } from 'react-i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import {
  ATTRIBUTION_OPTIONS, BID_NEEDS_AMOUNT, BID_OPTIONS, BILLING_OPTIONS, BRAND_SAFETY_OPTIONS, CUSTOM_EVENT_OPTIONS,
  DESTINATION_OPTIONS, DEVICE_OPTIONS, GOAL_OPTIONS, HP_PIXEL_ID, PLATFORM_OPTIONS, POSITION_FIELD_BY_PLATFORM,
  POSITION_OPTIONS, PUBLISHER_CATEGORY_OPTIONS, PUBLISHER_PLATFORMS,
  attributionFor, billingFor, destinationsFor, effectiveBidStrategy, goalsFor, promotedAllowed, promotedRuleFor, targetsEu,
  type AdsetDraft, type AttributionPreset, type Billing, type BidStrategy, type BrandSafety, type CustomEvent,
  type Destination, type DevicePlatform, type EnumOption, type ManualPlacements, type OptGoal, type PositionField,
  type PublisherCategory, type PublisherPlatform,
} from '../../../../lib/metaSpec'
import { INPUT_CLS, LockedField } from '../felder'
import { FeldHinweise } from './PruefPanel'
import {
  Abschnitt, AuswahlFeld, FeldRahmen, GeldFeld, Schalter, TextFeld, ZeitFeld, feldId, feldLabel, optionenFuer,
} from './KampagnenFormular'
import ZielgruppeHousing from './ZielgruppeHousing'
import { passeAnzeigengruppeAn, setzeAnzeigengruppe, useAssistent } from './useEntwurf'

// ── Anzeigengruppe (Reihenfolge wie im Meta-Werbeanzeigenmanager) ────────────
// Conversion: Conversion-Ort -> Leistungsziel -> Abrechnung -> Datensatz +
// Conversion-Ereignis -> Attributionseinstellung (jeweils nur erlaubte Werte).
// Budget und Zeitplan (USD mit EUR-Hinweis), Zielgruppe (Wohnen-Sperren),
// Platzierungen (Advantage+ oder manuell), Begünstigte/Zahlende Person (DSA),
// Markensicherheit. Bestehende Anzeigengruppen (Import) nur zur Ansicht.

const nurWerte = <V extends string>(alle: readonly EnumOption<V>[], werte: readonly V[]): EnumOption<V>[] => {
  const out: EnumOption<V>[] = []
  for (const v of werte) out.push(alle.find(o => o.value === v) ?? { value: v, labelKey: `crm.werbung.meta.unknown` })
  return out
}

export default function AnzeigengruppenFormular({ adsetKey }: { adsetKey: string }) {
  const { t } = useTranslation()
  const { e, kurs, katalog, vorgaben } = useAssistent()
  const { spec, nurLesen } = e
  const a = spec.adsets.find(x => x.key === adsetKey)
  if (!a) return null
  const c = spec.campaign
  const node = a.key
  const gesperrt = nurLesen
  const set = (patch: Partial<AdsetDraft>) => e.update(d => setzeAnzeigengruppe(d, node, patch))
  const setAngepasst = (patch: Partial<AdsetDraft>) => e.update(d => {
    const basis = setzeAnzeigengruppe(d, node, patch)
    return { ...basis, adsets: basis.adsets.map(x => (x.key === node ? passeAnzeigengruppeAn(x, basis.campaign.objective, vorgaben.pixelId ?? '') : x)) }
  })

  if (a.existing_id) {
    return (
      <div className="space-y-3">
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.gruppe.bestehend', 'Diese Anzeigengruppe besteht schon bei Meta (ID {{id}}). Hier kommen nur neue Anzeigen dazu, ihre Einstellungen bleiben unverändert.', { id: a.existing_id })}
        </div>
        <div className="hp-card grid gap-3 p-4 sm:grid-cols-2">
          <LockedField label={feldLabel(t, 'adset.name', 'Name der Anzeigengruppe')} value={a.name} />
          <LockedField label={feldLabel(t, 'adset.optimization_goal', 'Leistungsziel')} value={t(`crm.werbung.meta.goal.${a.optimization_goal}`, a.optimization_goal)} />
          <LockedField label={feldLabel(t, 'adset.destination', 'Conversion-Ort')} value={t(`crm.werbung.meta.destination.${a.destination}`, a.destination)} />
          {(a.daily_budget_cents ?? 0) > 0 && <LockedField label={feldLabel(t, 'adset.daily_budget_cents', 'Tagesbudget')} value={`$ ${((a.daily_budget_cents ?? 0) / 100).toFixed(2)}`} />}
        </div>
      </div>
    )
  }

  const cbo = c.budget_level === 'campaign'
  const orte = destinationsFor(c.objective)
  const ziele = goalsFor(c.objective, a.destination)
  const billings = billingFor(a.optimization_goal)
  const attrs = attributionFor(a.optimization_goal)
  const rule = promotedRuleFor(c.objective, a.destination, a.optimization_goal)
  const poKeys = rule ? promotedAllowed(rule) : []
  const po = a.promoted_object ?? {}
  const setPo = (patch: Partial<AdsetDraft['promoted_object']>) => set({ promoted_object: { ...po, ...patch } })
  const strat = effectiveBidStrategy(c, a)
  const budgetArt: 'daily' | 'lifetime' = (a.lifetime_budget_cents ?? 0) > 0 ? 'lifetime' : 'daily'
  const eu = targetsEu(a.targeting)
  const synchron = spec.hp?.budgets_synchron === true && spec.adsets.filter(x => !x.existing_id).length > 1

  // Pixel: Liste aus dem Katalog, HP-Pixel immer dabei
  const pixel: SelectOption[] = (katalog?.pixels ?? []).map(p => ({ value: p.id, label: `${p.name} (${p.id})`, hint: p.id === HP_PIXEL_ID ? t('crm.werbung.builder.gruppe.hpPixel', 'HP-Pixel (Landingpages und /termin)') : undefined }))
  if (!pixel.some(p => p.value === HP_PIXEL_ID)) pixel.unshift({ value: HP_PIXEL_ID, label: `HP Pixel (${HP_PIXEL_ID})` })
  if (po.pixel_id && !pixel.some(p => p.value === po.pixel_id)) pixel.push({ value: po.pixel_id, label: po.pixel_id })
  const seiten: SelectOption[] = (katalog?.pages ?? []).map(p => ({ value: p.id, label: p.name }))
  const conversions: SelectOption[] = [
    { value: '', label: t('crm.werbung.builder.gruppe.keineConversion', 'Keine (Standard-Ereignis)') },
    ...(katalog?.custom_conversions ?? []).map(x => ({ value: x.id, label: x.name })),
  ]

  const manuell: ManualPlacements | null = a.placements?.mode === 'manual' ? a.placements : null
  const setzePlatzModus = (m: 'advantage' | 'manual') => set({
    placements: m === 'advantage' ? { mode: 'advantage' } : { mode: 'manual', publisher_platforms: ['facebook', 'instagram'] },
  })
  const togglePlattform = (pl: PublisherPlatform, an: boolean) => {
    if (!manuell) return
    const plats = an ? [...manuell.publisher_platforms.filter(x => x !== pl), pl] : manuell.publisher_platforms.filter(x => x !== pl)
    const next: ManualPlacements = { ...manuell, publisher_platforms: PUBLISHER_PLATFORMS.filter(x => plats.indexOf(x) >= 0) }
    if (!an) delete next[POSITION_FIELD_BY_PLATFORM[pl]]
    set({ placements: next })
  }
  const togglePosition = (field: PositionField, pos: string, an: boolean) => {
    if (!manuell) return
    const alt = ((manuell[field] ?? []) as readonly string[])
    const neu = an ? [...alt.filter(x => x !== pos), pos] : alt.filter(x => x !== pos)
    const next = { ...manuell, [field]: neu } as ManualPlacements
    if (!neu.length) delete next[field]
    set({ placements: next })
  }
  const toggleGeraet = (d: DevicePlatform, an: boolean) => {
    if (!manuell) return
    const alt = manuell.device_platforms ?? []
    const neu = an ? [...alt.filter(x => x !== d), d] : alt.filter(x => x !== d)
    const next: ManualPlacements = { ...manuell, device_platforms: neu }
    if (!neu.length) delete next.device_platforms
    set({ placements: next })
  }

  const dsaVorschlaege = [vorgaben.dsaBeneficiary, ...(katalog?.dsa_recommendations ?? [])]
    .map(x => (x ?? '').trim()).filter((x, i, arr) => !!x && arr.indexOf(x) === i).slice(0, 4)

  return (
    <div className="space-y-4">
      <Abschnitt titel={t('crm.werbung.builder.gruppe.name', 'Name der Anzeigengruppe')}>
        <TextFeld node={node} feld="adset.name" label={feldLabel(t, 'adset.name', 'Name der Anzeigengruppe')}
          value={a.name ?? ''} onChange={v => set({ name: v })} maxLen={400} disabled={gesperrt} />
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.gruppe.conversion', 'Conversion')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <AuswahlFeld<Destination> node={node} feld="adset.destination" label={feldLabel(t, 'adset.destination', 'Conversion-Ort')}
            value={a.destination} optionen={nurWerte(DESTINATION_OPTIONS, orte)} disabled={gesperrt}
            onChange={v => v && setAngepasst({ destination: v })} />
          <AuswahlFeld<OptGoal> node={node} feld="adset.optimization_goal" label={feldLabel(t, 'adset.optimization_goal', 'Leistungsziel')}
            value={a.optimization_goal} optionen={nurWerte(GOAL_OPTIONS, ziele)} disabled={gesperrt}
            onChange={v => v && setAngepasst({ optimization_goal: v })} />
          {billings.length > 1 && (
            <AuswahlFeld<Billing> node={node} feld="adset.billing_event" label={feldLabel(t, 'adset.billing_event', 'Abrechnung')}
              value={a.billing_event} optionen={nurWerte(BILLING_OPTIONS, billings)} disabled={gesperrt}
              onChange={v => v && set({ billing_event: v })} />
          )}
          {poKeys.indexOf('pixel_id') >= 0 && (
            <FeldRahmen node={node} feld="adset.promoted_object.pixel_id" label={feldLabel(t, 'adset.promoted_object.pixel_id', 'Datensatz (Pixel)')}
              hilfe={t('crm.werbung.meta.help.adset_pixel', 'Auf das Ereignis dieses Pixels optimiert Meta. Landingpages und /termin feuern nur das HP-Pixel 1083578343946189.')}>
              <div className="mt-0.5">
                <CustomSelect value={po.pixel_id ?? ''} options={pixel} disabled={gesperrt} onChange={v => setPo({ pixel_id: v || undefined })} />
              </div>
              {po.pixel_id && po.pixel_id !== HP_PIXEL_ID && (
                <p className="mt-1 text-[11px] text-amber-700">{t('crm.werbung.builder.gruppe.pixelWarnung', 'Achtung: Landingpages und /termin feuern nur das HP-Pixel. Mit diesem Pixel lernt Meta womöglich nichts.')}</p>
              )}
            </FeldRahmen>
          )}
          {poKeys.indexOf('custom_event_type') >= 0 && (
            <AuswahlFeld<CustomEvent> node={node} feld="adset.promoted_object.custom_event_type"
              label={feldLabel(t, 'adset.promoted_object.custom_event_type', 'Conversion-Ereignis')}
              value={po.custom_event_type} optionen={CUSTOM_EVENT_OPTIONS} disabled={gesperrt}
              leer={t('crm.werbung.builder.gruppe.keinEreignis', 'Kein Ereignis')}
              onChange={v => setPo({ custom_event_type: v })} />
          )}
          {poKeys.indexOf('custom_conversion_id') >= 0 && (katalog?.custom_conversions ?? []).length > 0 && (
            <FeldRahmen node={node} feld="adset.promoted_object.custom_conversion_id" label={feldLabel(t, 'adset.promoted_object.custom_conversion_id', 'Benutzerdefinierte Conversion')}>
              <div className="mt-0.5">
                <CustomSelect value={po.custom_conversion_id ?? ''} options={conversions} disabled={gesperrt} onChange={v => setPo({ custom_conversion_id: v || undefined })} />
              </div>
            </FeldRahmen>
          )}
          {poKeys.indexOf('page_id') >= 0 && (
            <FeldRahmen node={node} feld="adset.promoted_object.page_id" label={feldLabel(t, 'adset.promoted_object.page_id', 'Facebook-Seite')}>
              {seiten.length ? (
                <div className="mt-0.5">
                  <CustomSelect value={po.page_id ?? ''} options={seiten} disabled={gesperrt} onChange={v => setPo({ page_id: v || undefined })} />
                </div>
              ) : (
                <input value={po.page_id ?? ''} disabled={gesperrt} onChange={ev => setPo({ page_id: ev.target.value.trim() || undefined })} className={INPUT_CLS}
                  placeholder={vorgaben.pageId ?? ''} />
              )}
            </FeldRahmen>
          )}
          {attrs.length > 1 ? (
            <AuswahlFeld<AttributionPreset> node={node} feld="adset.attribution" label={feldLabel(t, 'adset.attribution', 'Attributionseinstellung')}
              hilfe={t('crm.werbung.meta.help.adset_attribution', 'Zeitraum, in dem eine Conversion der Werbeanzeige zugerechnet wird. Nur bei Website-Conversions wählbar, sonst fest 1 Tag nach Klick.')}
              value={a.attribution} optionen={nurWerte(ATTRIBUTION_OPTIONS, attrs)} disabled={gesperrt}
              onChange={v => v && set({ attribution: v })} />
          ) : (
            <LockedField label={feldLabel(t, 'adset.attribution', 'Attributionseinstellung')} value={t(`crm.werbung.meta.attribution.${attrs[0]}`, attrs[0])} />
          )}
        </div>
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.gruppe.budget', 'Budget und Zeitplan')}
        hilfe={synchron ? t('crm.werbung.builder.gruppe.synchronAn', 'Budgets synchron: eine Änderung gilt für alle neuen Anzeigengruppen.') : undefined}>
        {cbo ? (
          <p className="text-xs text-gray-600">{t('crm.werbung.builder.gruppe.cboBudget', 'Das Budget kommt aus der Kampagne (Advantage+ Kampagnenbudget).')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-wrap gap-3 text-xs sm:col-span-2" role="radiogroup" aria-label={t('crm.werbung.builder.form.budgetArt', 'Budgetart')}>
              {(['daily', 'lifetime'] as const).map(art => (
                <label key={art} className="flex items-center gap-1.5">
                  <input type="radio" name={`budgetart-${node}`} checked={budgetArt === art} disabled={gesperrt}
                    onChange={() => set(art === 'daily'
                      ? { daily_budget_cents: a.lifetime_budget_cents ?? a.daily_budget_cents, lifetime_budget_cents: undefined }
                      : { lifetime_budget_cents: a.daily_budget_cents ?? a.lifetime_budget_cents, daily_budget_cents: undefined })} />
                  {art === 'daily' ? t('crm.werbung.builder.form.tagesbudget', 'Tagesbudget') : t('crm.werbung.builder.form.laufzeitbudget', 'Laufzeitbudget')}
                </label>
              ))}
            </div>
            {budgetArt === 'daily' ? (
              <GeldFeld node={node} feld="adset.daily_budget_cents" label={feldLabel(t, 'adset.daily_budget_cents', 'Tagesbudget')}
                cents={a.daily_budget_cents} onChange={v => set({ daily_budget_cents: v })} kurs={kurs} disabled={gesperrt} />
            ) : (
              <GeldFeld node={node} feld="adset.lifetime_budget_cents" label={feldLabel(t, 'adset.lifetime_budget_cents', 'Laufzeitbudget')}
                cents={a.lifetime_budget_cents} onChange={v => set({ lifetime_budget_cents: v })} kurs={kurs} disabled={gesperrt} />
            )}
            <AuswahlFeld<BidStrategy> node={node} feld="adset.bid_strategy" label={feldLabel(t, 'adset.bid_strategy', 'Gebotsstrategie')}
              value={a.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'} optionen={BID_OPTIONS} disabled={gesperrt}
              onChange={v => set({ bid_strategy: v ?? 'LOWEST_COST_WITHOUT_CAP' })} />
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          {BID_NEEDS_AMOUNT.indexOf(strat) >= 0 && (
            <GeldFeld node={node} feld="adset.bid_amount_cents" label={feldLabel(t, 'adset.bid_amount_cents', 'Gebotsbetrag bzw. Kostenziel')}
              cents={a.bid_amount_cents} onChange={v => set({ bid_amount_cents: v })} kurs={kurs} disabled={gesperrt} />
          )}
          {strat === 'LOWEST_COST_WITH_MIN_ROAS' && (
            <FeldRahmen node={node} feld="adset.roas_average_floor" label={feldLabel(t, 'adset.roas_average_floor', 'ROAS-Ziel')}
              hilfe={t('crm.werbung.builder.gruppe.roasHilfe', 'Als Faktor, z. B. 1,5')}>
              <input inputMode="decimal" disabled={gesperrt} className={INPUT_CLS}
                defaultValue={a.roas_average_floor ? String(a.roas_average_floor / 10000).replace('.', ',') : ''}
                onBlur={ev => {
                  const v = parseFloat(ev.target.value.replace(',', '.'))
                  set({ roas_average_floor: Number.isFinite(v) && v > 0 ? Math.round(v * 10000) : undefined })
                }} />
            </FeldRahmen>
          )}
          <ZeitFeld node={node} feld="adset.start_time" label={feldLabel(t, 'adset.start_time', 'Startdatum')}
            value={a.start_time} onChange={v => set({ start_time: v })} disabled={gesperrt} />
          <ZeitFeld node={node} feld="adset.end_time" label={feldLabel(t, 'adset.end_time', 'Enddatum')}
            value={a.end_time} onChange={v => set({ end_time: v })} disabled={gesperrt} />
        </div>
      </Abschnitt>

      <Abschnitt titel={feldLabel(t, 'adset.targeting', 'Zielgruppe')}>
        <ZielgruppeHousing adset={a} disabled={gesperrt} />
      </Abschnitt>

      <Abschnitt titel={feldLabel(t, 'adset.placements', 'Platzierungen')}
        hilfe={t('crm.werbung.meta.help.adset_placements', 'Advantage+ Platzierungen lassen Meta alle Platzierungen nutzen (empfohlen). Manuell nur, wenn bestimmte Platzierungen ausgeschlossen werden sollen.')}>
        <div id={feldId('adset.placements')} className="flex flex-wrap gap-4 text-xs" role="radiogroup" aria-label={feldLabel(t, 'adset.placements', 'Platzierungen')}>
          {(['advantage', 'manual'] as const).map(m => (
            <label key={m} className="flex items-center gap-1.5">
              <input type="radio" name={`platz-${node}`} checked={(a.placements?.mode ?? 'advantage') === m} disabled={gesperrt} onChange={() => setzePlatzModus(m)} />
              {t(`crm.werbung.meta.placement_mode.${m}`, m === 'advantage' ? 'Advantage+ Platzierungen' : 'Manuelle Platzierungen')}
            </label>
          ))}
        </div>
        {manuell && (
          <div className="space-y-3">
            <div id={feldId('adset.placements.publisher_platforms')}>
              <p className="mb-1 text-[11px] text-gray-500">{feldLabel(t, 'adset.placements.publisher_platforms', 'Plattformen')}</p>
              <div className="flex flex-wrap gap-4">
                {PLATFORM_OPTIONS.map(o => (
                  <Schalter key={o.value} checked={manuell.publisher_platforms.indexOf(o.value) >= 0} disabled={gesperrt}
                    onChange={v => togglePlattform(o.value, v)} label={t(o.labelKey, o.value)} />
                ))}
              </div>
            </div>
            {manuell.publisher_platforms.map(pl => {
              const field = POSITION_FIELD_BY_PLATFORM[pl]
              const gewaehlt = (manuell[field] ?? []) as readonly string[]
              return (
                <div key={pl} id={feldId(`adset.placements.${field}`)}>
                  <p className="mb-1 text-[11px] text-gray-500">
                    {feldLabel(t, `adset.placements.${field}`, field)}
                    <span className="ml-1 text-gray-400">{gewaehlt.length ? '' : t('crm.werbung.builder.gruppe.allePositionen', '(leer = alle)')}</span>
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {POSITION_OPTIONS[pl].map(o => (
                      <Schalter key={o.value} checked={gewaehlt.indexOf(o.value) >= 0} disabled={gesperrt}
                        onChange={v => togglePosition(field, o.value, v)} label={t(o.labelKey, o.value)} />
                    ))}
                  </div>
                </div>
              )
            })}
            <div id={feldId('adset.placements.device_platforms')}>
              <p className="mb-1 text-[11px] text-gray-500">{feldLabel(t, 'adset.placements.device_platforms', 'Geräte')}</p>
              <div className="flex flex-wrap gap-4">
                {DEVICE_OPTIONS.map(o => (
                  <Schalter key={o.value} checked={(manuell.device_platforms ?? []).indexOf(o.value) >= 0} disabled={gesperrt}
                    onChange={v => toggleGeraet(o.value, v)} label={t(o.labelKey, o.value)} />
                ))}
              </div>
            </div>
          </div>
        )}
        <FeldHinweise node={node} felder={[
          'adset.placements', 'adset.placements.publisher_platforms', 'adset.placements.facebook_positions',
          'adset.placements.instagram_positions', 'adset.placements.threads_positions', 'adset.placements.messenger_positions',
          'adset.placements.audience_network_positions', 'adset.placements.device_platforms',
        ]} />
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.gruppe.dsa', 'Begünstigte und zahlende Person')}
        hilfe={t('crm.werbung.meta.help.adset_dsa', 'EU-Pflichtangabe (Digital Services Act): wer von der Werbung profitiert und wer sie bezahlt. Standard aus dem Werbekonto.')}>
        {eu && <p className="text-[11px] text-hp-navy">{t('crm.werbung.builder.gruppe.dsaPflicht', 'Pflicht, weil die Zielgruppe in der EU liegt.')}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextFeld node={node} feld="adset.dsa_beneficiary" label={feldLabel(t, 'adset.dsa_beneficiary', 'Begünstigte Person')}
            value={a.dsa_beneficiary ?? ''} onChange={v => set({ dsa_beneficiary: v })} maxLen={512} disabled={gesperrt} />
          <TextFeld node={node} feld="adset.dsa_payor" label={feldLabel(t, 'adset.dsa_payor', 'Zahlende Person')}
            value={a.dsa_payor ?? ''} onChange={v => set({ dsa_payor: v })} maxLen={512} disabled={gesperrt} />
        </div>
        {dsaVorschlaege.length > 0 && !gesperrt && (
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <span className="text-gray-500">{t('crm.werbung.builder.gruppe.dsaVorschlag', 'Übernehmen:')}</span>
            {dsaVorschlaege.map(v => (
              <button key={v} type="button" onClick={() => set({ dsa_beneficiary: v, dsa_payor: a.dsa_payor || vorgaben.dsaPayor || v })}
                className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-gray-700 hover:border-hp-navy/40">{v}</button>
            ))}
          </div>
        )}
      </Abschnitt>

      <Abschnitt titel={t('crm.werbung.builder.gruppe.markensicherheit', 'Markensicherheit')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <AuswahlFeld<BrandSafety> node={node} feld="adset.brand_safety" label={feldLabel(t, 'adset.brand_safety', 'Inventarfilter')}
            value={a.brand_safety} optionen={BRAND_SAFETY_OPTIONS} disabled={gesperrt}
            leer={t('crm.werbung.builder.gruppe.metaStandard', 'Standard von Meta')}
            onChange={v => set({ brand_safety: v })} />
        </div>
        <div id={feldId('adset.excluded_publisher_categories')}>
          <p className="mb-1 text-[11px] text-gray-500">{feldLabel(t, 'adset.excluded_publisher_categories', 'Ausgeschlossene Themen')}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {optionenFuer(t, PUBLISHER_CATEGORY_OPTIONS).map(o => {
              const v = o.value as PublisherCategory
              const liste = a.excluded_publisher_categories ?? []
              return (
                <Schalter key={v} checked={liste.indexOf(v) >= 0} disabled={gesperrt} label={o.label}
                  onChange={an => set({ excluded_publisher_categories: an ? [...liste.filter(x => x !== v), v] : liste.filter(x => x !== v) })} />
              )
            })}
          </div>
          <FeldHinweise node={node} felder="adset.excluded_publisher_categories" />
        </div>
      </Abschnitt>
    </div>
  )
}
