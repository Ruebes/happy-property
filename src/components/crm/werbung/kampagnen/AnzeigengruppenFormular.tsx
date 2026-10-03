import { useTranslation } from 'react-i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import {
  ATTRIBUTION_OPTIONS, BID_NEEDS_AMOUNT, BID_OPTIONS, BILLING_OPTIONS, BRAND_SAFETY_OPTIONS, CUSTOM_EVENT_OPTIONS,
  DESTINATION_OPTIONS, DEVICE_OPTIONS, GOAL_OPTIONS, HP_PIXEL_ID, PLATFORM_OPTIONS, POSITION_FIELD_BY_PLATFORM,
  POSITION_OPTIONS, PUBLISHER_CATEGORY_OPTIONS, PUBLISHER_PLATFORMS,
  attributionFor, billingFor, destinationsFor, draftIsHec, effectiveBidStrategy, goalsFor, promotedAllowed, promotedRuleFor, targetsEu,
  type AdsetDraft, type AttributionPreset, type Billing, type BidStrategy, type BrandSafety, type CustomEvent,
  type Destination, type DevicePlatform, type EnumOption, type ManualPlacements, type OptGoal, type PositionField,
  type PublisherCategory, type PublisherPlatform,
} from '../../../../lib/metaSpec'
import { INPUT_CLS, LockedField } from '../felder'
import { FeldHinweise } from './PruefPanel'
import {
  Abschnitt, AuswahlFeld, FeldRahmen, GeldFeld, GesperrteEinstellung, RadioReihe, Schalter, StatusFeld, TextFeld, ZeitFeld,
  feldId, feldLabel, optionenFuer,
} from './Bausteine'
import { BudgetPlanungFeld, ZeitplanFeld } from './BudgetFelder'
import ZielgruppeHousing, { OrtTypen, WohnenSperren } from './ZielgruppeHousing'
import { ohneUnbegrenzt } from './KampagnenFormular'
import { EmpfohlenBadge } from './bearbeitenHelfer'
import { hpVon } from './bearbeitenTypen'
import { gruppeAngelegt, passeAnzeigengruppeAn, setzeAnzeigengruppe, useAssistent } from './useEntwurf'

// ── Anzeigengruppe (Reihenfolge wie im Meta-Werbeanzeigenmanager) ────────────
// Name (+ Status), Conversion (Conversion-Ort -> Performance-Ziel -> Datensatz
// + Conversion-Event; unter „Alle Einstellungen": Abrechnung, eigene
// Conversion, Seite, Attribution inkl. Engage-Through und Modell), Budget und
// Zeitplan (Budget, Start/Ende; Gebot, ROAS, Ausgabenlimits je Gruppe beim
// Kampagnenbudget, Zeitplan nach Uhrzeit, Budgetplanung), Zielgruppe (Wohnen-
// Modus, Gesperrtes grau mit Grund), Platzierungen (Advantage+ oder manuell;
// Geräte, Betriebssysteme, WLAN, 5-%-Ausnahme), Markensicherheit (Inventar-
// filter, Themen, Blockierlisten), Begünstigte und zahlende Person (DSA).
// Bestehende Anzeigengruppen: beim Ergänzen nur Ansicht, im Bearbeiten-Modus
// änderbar (gesperrte Felder mit Grund).

const nurWerte = <V extends string>(alle: readonly EnumOption<V>[], werte: readonly V[]): EnumOption<V>[] => {
  const out: EnumOption<V>[] = []
  for (const v of werte) out.push(alle.find(o => o.value === v) ?? { value: v, labelKey: `crm.werbung.meta.unknown` })
  return out
}

const idListe = (txt: string): string[] => txt.split(/[\s,;]+/).map(x => x.trim()).filter(x => /^\d{5,25}$/.test(x))
  .filter((x, i, arr) => arr.indexOf(x) === i)

export default function AnzeigengruppenFormular({ adsetKey }: { adsetKey: string }) {
  const { t } = useTranslation()
  const { e, kurs, katalog, vorgaben, bearbeiten, sperre } = useAssistent()
  const { spec, nurLesen } = e
  const a0 = spec.adsets.find(x => x.key === adsetKey)
  if (!a0) return null
  const a = a0
  const c = spec.campaign
  const node = a.key
  const bestehend = !!a.existing_id
  const nurAnsicht = bestehend && !bearbeiten
  // Von diesem Entwurf schon bei Meta angelegt: Fortsetzen übernimmt keine Änderungen mehr
  const angelegt = !bestehend && gruppeAngelegt(e.metaIds, node)
  const gesperrt = nurLesen || angelegt
  const sp = (feld: string): string | undefined => (bearbeiten && bestehend ? sperre(node, feld) : undefined)
  const lern = bearbeiten && bestehend ? ` ${t('crm.werbung.bearbeiten.lernHinweis', 'Eine Änderung startet die Lernphase neu.')}` : ''
  // Ausgabenlimits je Gruppe, Zeitplan nach Uhrzeit und Budgetplanung sendet meta-builder beim
  // Anlegen nicht mit (nur edit_apply): bei neuen Gruppen grau statt still verwerfen
  const nurNachAnlegen = !(bearbeiten && bestehend)
  const grundNachAnlegen = t('crm.werbung.bearbeiten.grund.nachAnlegenGruppe', 'Erst nach dem Anlegen einstellbar: Anzeigengruppe bei Meta anlegen, dann über „Bearbeiten“.')
  const set = (patch: Partial<AdsetDraft>) => e.update(d => setzeAnzeigengruppe(d, node, patch, e.metaIds))
  // Weitere targeting-Felder (Betriebssystem, WLAN, Blockierlisten): leere Werte entfernen
  const setTargeting = (patch: Record<string, unknown>) => {
    const tg: Record<string, unknown> = { ...a.targeting }
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || (Array.isArray(v) && !v.length)) delete tg[k]
      else tg[k] = v
    }
    set({ targeting: tg as AdsetDraft['targeting'] })
  }
  const setAngepasst = (patch: Partial<AdsetDraft>) => e.update(d => {
    if (gruppeAngelegt(e.metaIds, node)) return d
    const basis = setzeAnzeigengruppe(d, node, patch, e.metaIds)
    return { ...basis, adsets: basis.adsets.map(x => (x.key === node ? passeAnzeigengruppeAn(x, basis.campaign.objective, vorgaben.pixelId ?? '', false, bearbeiten) : x)) }
  })
  const hatMeldung = (felder: readonly string[]) =>
    e.issues.some(i => i.node === node && felder.some(f => i.field === f || i.field.indexOf(`${f}.`) === 0))
    || e.lint.some(l => l.node === node && felder.some(f => l.field === f))

  if (nurAnsicht) {
    return (
      <div className="space-y-3">
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.gruppe.bestehend', 'Diese Anzeigengruppe besteht schon bei Meta (ID {{id}}). Hier kommen nur neue Anzeigen dazu, ihre Einstellungen bleiben unverändert.', { id: a.existing_id })}
        </div>
        <div className="hp-card grid gap-3 p-4 sm:grid-cols-2">
          <LockedField label={feldLabel(t, 'adset.name', 'Name der Anzeigengruppe')} value={a.name} />
          <LockedField label={t('crm.werbung.bearbeiten.label.performanceZiel', 'Performance-Ziel')} value={t(`crm.werbung.meta.goal.${a.optimization_goal}`, a.optimization_goal)} />
          <LockedField label={feldLabel(t, 'adset.destination', 'Conversion-Ort')} value={t(`crm.werbung.meta.destination.${a.destination}`, a.destination)} />
          {(a.daily_budget_cents ?? 0) > 0 && <LockedField label={feldLabel(t, 'adset.daily_budget_cents', 'Tagesbudget')} value={`$ ${((a.daily_budget_cents ?? 0) / 100).toFixed(2)}`} />}
        </div>
      </div>
    )
  }

  const cbo = c.budget_level === 'campaign'
  const kampagneLaufzeit = cbo && (c.lifetime_budget_cents ?? 0) > 0
  const orte = destinationsFor(c.objective)
  if (orte.indexOf(a.destination) < 0) orte.push(a.destination)
  const ziele = goalsFor(c.objective, a.destination).slice()
  if (ziele.indexOf(a.optimization_goal) < 0) ziele.push(a.optimization_goal)
  const billings = billingFor(a.optimization_goal).slice()
  if (billings.indexOf(a.billing_event) < 0) billings.push(a.billing_event)
  const attrs = attributionFor(a.optimization_goal)
  const rule = promotedRuleFor(c.objective, a.destination, a.optimization_goal)
  const poKeys = rule ? promotedAllowed(rule) : []
  const po = a.promoted_object ?? {}
  const setPo = (patch: Partial<AdsetDraft['promoted_object']>) => set({ promoted_object: { ...po, ...patch } })
  const strat = effectiveBidStrategy(c, a)
  const budgetArt: 'daily' | 'lifetime' = (a.lifetime_budget_cents ?? 0) > 0 ? 'lifetime' : 'daily'
  const eu = targetsEu(a.targeting)
  const synchron = hpVon(spec).budgets_synchron === true && spec.adsets.filter(x => !x.existing_id).length > 1
  const hec = draftIsHec(spec)

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

  // Betriebssystem (targeting.user_os): alle, nur iOS, nur Android (versionierte Werte bleiben wählbar)
  const textListe = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const os = textListe(a.targeting?.user_os)[0] ?? ''
  const wlan = textListe(a.targeting?.wireless_carrier).indexOf('Wifi') >= 0
  const osOptionen: SelectOption[] = [
    { value: '', label: t('crm.werbung.bearbeiten.os.alle', 'Alle Betriebssysteme') },
    { value: 'iOS', label: t('crm.werbung.bearbeiten.os.ios', 'Nur iOS') },
    { value: 'Android', label: t('crm.werbung.bearbeiten.os.android', 'Nur Android') },
  ]
  if (os && !osOptionen.some(o => o.value === os)) osOptionen.push({ value: os, label: os })

  const blocklisten = textListe(a.targeting?.excluded_publisher_list_ids).join(', ')

  return (
    <div className="space-y-4">
      {angelegt && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.gruppe.angelegt', 'Diese Anzeigengruppe ist schon bei Meta angelegt (ID {{id}}). Ihre Einstellungen lassen sich hier nicht mehr ändern.', { id: e.metaIds.adsets?.[node] })}
        </div>
      )}
      {bearbeiten && bestehend && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.bearbeiten.gruppeHinweis', 'Laufende Anzeigengruppe (ID {{id}}). Änderungen an Zielgruppe, Platzierungen, Performance-Ziel, Conversion-Event oder Gebot starten die Lernphase neu.', { id: a.existing_id })}
        </div>
      )}

      {/* 1. Name (+ Status) */}
      <Abschnitt titel={t('crm.werbung.builder.gruppe.name', 'Name der Anzeigengruppe')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextFeld node={node} feld="adset.name" label={feldLabel(t, 'adset.name', 'Name der Anzeigengruppe')}
              hilfe={t('crm.werbung.bearbeiten.hilfe.gruppeName', 'Nur intern sichtbar. Gut: Zielgruppe und Landingpage, z. B. „Kalt · Lang“.')}
              value={a.name ?? ''} onChange={v => set({ name: v })} maxLen={400} disabled={gesperrt} />
          </div>
          {bearbeiten && bestehend && (
            <StatusFeld node={node} feld="adset.status" value={a.status} disabled={gesperrt} onChange={v => set({ status: v })} />
          )}
        </div>
      </Abschnitt>

      {/* 2. Conversion */}
      <Abschnitt titel={t('crm.werbung.builder.gruppe.conversion', 'Conversion')}
        hilfe={t('crm.werbung.bearbeiten.hilfe.conversion', 'Wo die Conversion passiert und worauf Meta optimiert. Für HP: Website und das Ereignis „Schedule“ (Termin gebucht) im HP-Pixel.')}
        alleOffen={hatMeldung(['adset.billing_event', 'adset.attribution', 'adset.promoted_object.custom_conversion_id', 'adset.promoted_object.page_id'])}
        alle={(
          <div className="grid gap-3 sm:grid-cols-2">
            {billings.length > 1 ? (
              <AuswahlFeld<Billing> node={node} feld="adset.billing_event" label={t('crm.werbung.bearbeiten.label.abrechnung', 'Abrechnung')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.abrechnung', 'Wofür Meta abrechnet. Impressionen ist der Standard.')}
                value={a.billing_event} optionen={nurWerte(BILLING_OPTIONS, billings)} disabled={gesperrt} sperre={sp('adset.billing_event')}
                onChange={v => v && set({ billing_event: v })} />
            ) : (
              <FeldRahmen node={node} feld="adset.billing_event" label={t('crm.werbung.bearbeiten.label.abrechnung', 'Abrechnung')}
                sperre={sp('adset.billing_event')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.abrechnungFest', 'Bei diesem Performance-Ziel rechnet Meta immer nach Impressionen ab.')}>
                <p className="mt-0.5 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-700">{t(`crm.werbung.meta.billing.${a.billing_event}`, a.billing_event)}</p>
              </FeldRahmen>
            )}
            {poKeys.indexOf('custom_conversion_id') >= 0 ? (
              <FeldRahmen node={node} feld="adset.promoted_object.custom_conversion_id" label={feldLabel(t, 'adset.promoted_object.custom_conversion_id', 'Benutzerdefinierte Conversion')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.customConversion', 'Statt eines Standard-Ereignisses eine eigene Conversion (z. B. bestimmte Danke-Seite).') + lern}
                sperre={sp('adset.promoted_object.custom_conversion_id')}>
                <div className="mt-0.5">
                  <CustomSelect value={po.custom_conversion_id ?? ''} options={conversions} disabled={gesperrt || !!sp('adset.promoted_object.custom_conversion_id')}
                    onChange={v => setPo({ custom_conversion_id: v || undefined })} />
                </div>
              </FeldRahmen>
            ) : null}
            {poKeys.indexOf('page_id') >= 0 && (
              <FeldRahmen node={node} feld="adset.promoted_object.page_id" label={feldLabel(t, 'adset.promoted_object.page_id', 'Facebook-Seite')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.seite', 'Die Facebook-Seite, über die Sofortformular oder Nachrichten laufen.')}
                sperre={sp('adset.promoted_object.page_id')}>
                {seiten.length ? (
                  <div className="mt-0.5">
                    <CustomSelect value={po.page_id ?? ''} options={seiten} disabled={gesperrt || !!sp('adset.promoted_object.page_id')} onChange={v => setPo({ page_id: v || undefined })} />
                  </div>
                ) : (
                  <input value={po.page_id ?? ''} disabled={gesperrt || !!sp('adset.promoted_object.page_id')} onChange={ev => setPo({ page_id: ev.target.value.trim() || undefined })} className={INPUT_CLS}
                    aria-label={feldLabel(t, 'adset.promoted_object.page_id', 'Facebook-Seite')} placeholder={vorgaben.pageId ?? ''} />
                )}
              </FeldRahmen>
            )}
            {attrs.length > 1 ? (
              <AuswahlFeld<AttributionPreset> node={node} feld="adset.attribution" label={feldLabel(t, 'adset.attribution', 'Attributionseinstellung')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.attribution', 'Wie lange nach Klick, Interaktion (Engage-Through) oder Ansehen eine Conversion der Anzeige zählt. Seit März 2026 zählt Klick nur noch Link-Klicks.')}
                empfehlung={{ aktiv: a.attribution === 'click_7d_view_1d', text: t('crm.werbung.meta.attribution.click_7d_view_1d', '7 Tage nach Klick oder 1 Tag nach Ansehen'), uebernehmen: () => set({ attribution: 'click_7d_view_1d' }) }}
                value={a.attribution} optionen={nurWerte(ATTRIBUTION_OPTIONS, attrs)} disabled={gesperrt} sperre={sp('adset.attribution')}
                onChange={v => v && set({ attribution: v })} />
            ) : (
              <FeldRahmen node={node} feld="adset.attribution" label={feldLabel(t, 'adset.attribution', 'Attributionseinstellung')}
                hilfe={t('crm.werbung.meta.help.adset_attribution', 'Zeitraum, in dem eine Conversion der Werbeanzeige zugerechnet wird. Nur bei Website-Conversions wählbar, sonst fest 1 Tag nach Klick.')}>
                <p className="mt-0.5 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-700">{t(`crm.werbung.meta.attribution.${attrs[0]}`, attrs[0])}</p>
              </FeldRahmen>
            )}
            <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.attributionsmodell', 'Attributionsmodell')}
              wert={t('crm.werbung.bearbeiten.modell.standard', 'Standard')}
              grund={t('crm.werbung.bearbeiten.grund.attributionsmodell', 'Inkrementelle Attribution lässt sich nur im Meta-Werbeanzeigenmanager einstellen (über die Schnittstelle nicht dokumentiert). Standard zählt alle Conversions im Zeitfenster (empfohlen).')} />
          </div>
        )}>
        <div className="grid gap-3 sm:grid-cols-2">
          <AuswahlFeld<Destination> node={node} feld="adset.destination" label={feldLabel(t, 'adset.destination', 'Conversion-Ort')}
            hilfe={t('crm.werbung.bearbeiten.hilfe.destination', 'Website: Termin über die Landingpage. Sofortformular: Kontaktdaten direkt in Facebook oder Instagram.')}
            empfehlung={{ aktiv: a.destination === 'WEBSITE', text: t('crm.werbung.meta.destination.WEBSITE', 'Website') }}
            value={a.destination} optionen={nurWerte(DESTINATION_OPTIONS, orte)} disabled={gesperrt} sperre={sp('adset.destination')}
            onChange={v => v && setAngepasst({ destination: v })} />
          <AuswahlFeld<OptGoal> node={node} feld="adset.optimization_goal" label={t('crm.werbung.bearbeiten.label.performanceZiel', 'Performance-Ziel')}
            hilfe={t('crm.werbung.bearbeiten.hilfe.goal', 'Worauf Meta die Auslieferung ausrichtet. Für Website-Termine: Anzahl der Conversions maximieren.') + lern}
            empfehlung={{ aktiv: a.optimization_goal === 'OFFSITE_CONVERSIONS' || a.destination !== 'WEBSITE', text: t('crm.werbung.meta.goal.OFFSITE_CONVERSIONS', 'Conversions') }}
            value={a.optimization_goal} optionen={nurWerte(GOAL_OPTIONS, ziele)} disabled={gesperrt} sperre={sp('adset.optimization_goal')}
            onChange={v => v && setAngepasst({ optimization_goal: v })} />
          {poKeys.indexOf('pixel_id') >= 0 && (
            <FeldRahmen node={node} feld="adset.promoted_object.pixel_id" label={t('crm.werbung.bearbeiten.label.datensatz', 'Datensatz')}
              hilfe={t('crm.werbung.meta.help.adset_pixel', 'Auf das Ereignis dieses Pixels optimiert Meta. Landingpages und /termin feuern nur das HP-Pixel 1083578343946189.') + lern}
              empfehlung={{ aktiv: po.pixel_id === HP_PIXEL_ID, text: `HP-Pixel ${HP_PIXEL_ID}`, uebernehmen: () => setPo({ pixel_id: HP_PIXEL_ID }) }}
              sperre={sp('adset.promoted_object.pixel_id')}>
              <div className="mt-0.5">
                <CustomSelect value={po.pixel_id ?? ''} options={pixel} disabled={gesperrt || !!sp('adset.promoted_object.pixel_id')} onChange={v => setPo({ pixel_id: v || undefined })} />
              </div>
              {po.pixel_id && po.pixel_id !== HP_PIXEL_ID && (
                <p className="mt-1 text-[11px] text-amber-700">{t('crm.werbung.builder.gruppe.pixelWarnung', 'Achtung: Landingpages und /termin feuern nur das HP-Pixel. Mit diesem Pixel lernt Meta womöglich nichts.')}</p>
              )}
            </FeldRahmen>
          )}
          {poKeys.indexOf('custom_event_type') >= 0 && (
            <AuswahlFeld<CustomEvent> node={node} feld="adset.promoted_object.custom_event_type"
              label={t('crm.werbung.bearbeiten.label.conversionEvent', 'Conversion-Event')}
              hilfe={t('crm.werbung.bearbeiten.hilfe.event', '„Schedule“ heißt: Termin gebucht. Darauf optimiert Meta die Auslieferung.') + lern}
              empfehlung={{ aktiv: po.custom_event_type === 'SCHEDULE', text: t('crm.werbung.meta.event.SCHEDULE', 'Termin vereinbaren'), uebernehmen: () => setPo({ custom_event_type: 'SCHEDULE' }) }}
              value={po.custom_event_type} optionen={CUSTOM_EVENT_OPTIONS} disabled={gesperrt} sperre={sp('adset.promoted_object.custom_event_type')}
              leer={t('crm.werbung.builder.gruppe.keinEreignis', 'Kein Ereignis')}
              onChange={v => setPo({ custom_event_type: v })} />
          )}
        </div>
      </Abschnitt>

      {/* 3. Budget und Zeitplan */}
      <Abschnitt titel={t('crm.werbung.builder.gruppe.budget', 'Budget und Zeitplan')}
        hilfe={synchron ? t('crm.werbung.builder.gruppe.synchronAn', 'Budgets synchron: eine Änderung gilt für alle neuen Anzeigengruppen.') : undefined}
        alleOffen={hatMeldung(['adset.bid_strategy', 'adset.bid_amount_cents', 'adset.roas_average_floor', 'adset.adset_schedule', 'adset.budget_schedule_specs', 'adset.daily_spend_cap_cents', 'adset.lifetime_spend_cap_cents'])}
        alle={(
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {!cbo && (
                <FeldRahmen node={node} feld="adset.budget_art" label={t('crm.werbung.builder.form.budgetArt', 'Budgetart')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.budgetArt', 'Tagesbudget: Durchschnitt pro Tag, an guten Tagen bis 75 % mehr. Laufzeitbudget: feste Summe bis zum Enddatum.')}
                  empfehlung={{ aktiv: budgetArt === 'daily', text: t('crm.werbung.builder.form.tagesbudget', 'Tagesbudget') }}
                  sperre={sp('adset.budget_art')}>
                  <RadioReihe name={`budgetart-${node}`} value={budgetArt} disabled={gesperrt || !!sp('adset.budget_art')}
                    label={t('crm.werbung.builder.form.budgetArt', 'Budgetart')}
                    optionen={[['daily', t('crm.werbung.builder.form.tagesbudget', 'Tagesbudget')], ['lifetime', t('crm.werbung.builder.form.laufzeitbudget', 'Laufzeitbudget')]]}
                    onChange={art => set(art === 'daily'
                      ? { daily_budget_cents: a.lifetime_budget_cents ?? a.daily_budget_cents, lifetime_budget_cents: undefined, adset_schedule: undefined }
                      : { lifetime_budget_cents: a.daily_budget_cents ?? a.lifetime_budget_cents, daily_budget_cents: undefined, budget_schedule_specs: undefined })} />
                </FeldRahmen>
              )}
              {!cbo && (
                <AuswahlFeld<BidStrategy> node={node} feld="adset.bid_strategy" label={feldLabel(t, 'adset.bid_strategy', 'Gebotsstrategie')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.bid', 'Größtes Volumen holt so viele Ergebnisse wie möglich aus dem Budget. Kostenziel und Gebotsbegrenzung brauchen viele Conversions pro Woche.') + lern}
                  empfehlung={{ aktiv: (a.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP') === 'LOWEST_COST_WITHOUT_CAP', text: t('crm.werbung.meta.bid.LOWEST_COST_WITHOUT_CAP', 'Größtes Volumen'), uebernehmen: () => set({ bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }) }}
                  value={a.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'} optionen={BID_OPTIONS} disabled={gesperrt} sperre={sp('adset.bid_strategy')}
                  onChange={v => set({ bid_strategy: v ?? 'LOWEST_COST_WITHOUT_CAP' })} />
              )}
              {BID_NEEDS_AMOUNT.indexOf(strat) >= 0 && (
                <GeldFeld node={node} feld="adset.bid_amount_cents" label={feldLabel(t, 'adset.bid_amount_cents', 'Gebotsbetrag bzw. Kostenziel')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.bidAmount', 'Kostenziel: angestrebte durchschnittliche Kosten pro Ergebnis. Gebotsbegrenzung: Höchstgebot je Auktion.') + lern}
                  cents={a.bid_amount_cents} onChange={v => set({ bid_amount_cents: v })} kurs={kurs} disabled={gesperrt} sperre={sp('adset.bid_amount_cents')} />
              )}
              {strat === 'LOWEST_COST_WITH_MIN_ROAS' && (
                <FeldRahmen node={node} feld="adset.roas_average_floor" label={feldLabel(t, 'adset.roas_average_floor', 'ROAS-Ziel')}
                  hilfe={t('crm.werbung.builder.gruppe.roasHilfe', 'Als Faktor, z. B. 1,5')} sperre={sp('adset.roas_average_floor')}>
                  <input inputMode="decimal" disabled={gesperrt || !!sp('adset.roas_average_floor')} className={INPUT_CLS}
                    aria-label={feldLabel(t, 'adset.roas_average_floor', 'ROAS-Ziel')}
                    defaultValue={a.roas_average_floor ? String(a.roas_average_floor / 10000).replace('.', ',') : ''}
                    onBlur={ev => {
                      const v = parseFloat(ev.target.value.replace(',', '.'))
                      set({ roas_average_floor: Number.isFinite(v) && v > 0 ? Math.round(v * 10000) : undefined })
                    }} />
                </FeldRahmen>
              )}
            </div>

            {/* Ausgabenlimits für Anzeigengruppen (nur mit Kampagnenbudget) */}
            {cbo && nurNachAnlegen ? (
              <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.ausgabenlimits', 'Ausgabenlimits für Anzeigengruppen')} grund={grundNachAnlegen} />
            ) : cbo ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <GeldFeld node={node} feld={kampagneLaufzeit ? 'adset.lifetime_min_spend_target_cents' : 'adset.daily_min_spend_target_cents'}
                  label={t('crm.werbung.bearbeiten.label.mindestAusgaben', 'Mindestausgaben der Anzeigengruppe')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.ausgabenlimits', 'Ausgabenlimits für Anzeigengruppen: Meta gibt hier mindestens bzw. höchstens so viel aus (seit 2025 als Durchschnitt, keine harte Grenze).')}
                  entfernbar={t('crm.werbung.bearbeiten.entfernen', 'Entfernen')}
                  cents={kampagneLaufzeit ? a.lifetime_min_spend_target_cents : a.daily_min_spend_target_cents} kurs={kurs} disabled={gesperrt}
                  onChange={v => set(kampagneLaufzeit ? { lifetime_min_spend_target_cents: v } : { daily_min_spend_target_cents: v })} />
                <GeldFeld node={node} feld={kampagneLaufzeit ? 'adset.lifetime_spend_cap_cents' : 'adset.daily_spend_cap_cents'}
                  label={t('crm.werbung.bearbeiten.label.hoechstAusgaben', 'Maximales Ausgabenlimit der Anzeigengruppe')}
                  entfernbar={t('crm.werbung.bearbeiten.entfernen', 'Entfernen')}
                  cents={ohneUnbegrenzt(kampagneLaufzeit ? a.lifetime_spend_cap_cents : a.daily_spend_cap_cents)} kurs={kurs} disabled={gesperrt}
                  onChange={v => set(kampagneLaufzeit ? { lifetime_spend_cap_cents: v } : { daily_spend_cap_cents: v })} />
              </div>
            ) : (
              <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.ausgabenlimits', 'Ausgabenlimits für Anzeigengruppen')}
                grund={t('crm.werbung.bearbeiten.grund.ausgabenlimits', 'Nur mit Advantage+ Kampagnenbudget. Hier hat die Anzeigengruppe ihr eigenes Budget.')} />
            )}

            {/* Zeitplan nach Uhrzeit (nur Laufzeitbudget) */}
            {(budgetArt === 'lifetime' || kampagneLaufzeit) && nurNachAnlegen ? (
              <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.zeitplan', 'Anzeigen nach einem Zeitplan schalten')} grund={grundNachAnlegen} />
            ) : budgetArt === 'lifetime' || kampagneLaufzeit ? (
              <ZeitplanFeld node={node} feld="adset.adset_schedule" label={t('crm.werbung.bearbeiten.label.zeitplan', 'Anzeigen nach einem Zeitplan schalten')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.zeitplan', 'Nur zu bestimmten Tagen und Uhrzeiten ausliefern, volle Stunden, mindestens eine Stunde. Für Termin-Leads meist nicht nötig.')}
                werte={a.adset_schedule} onChange={w => set({ adset_schedule: w })} disabled={gesperrt} sperre={sp('adset.adset_schedule')} />
            ) : (
              <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.zeitplan', 'Anzeigen nach einem Zeitplan schalten')}
                grund={t('crm.werbung.bearbeiten.grund.zeitplan', 'Nur mit Laufzeitbudget möglich.')} />
            )}

            {/* Budgetplanung (nur Tagesbudget der Anzeigengruppe) */}
            {!cbo && budgetArt === 'daily' && nurNachAnlegen ? (
              <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.budgetplanung', 'Budgetplanung')} grund={grundNachAnlegen} />
            ) : !cbo && budgetArt === 'daily' ? (
              <BudgetPlanungFeld node={node} feld="adset.budget_schedule_specs" label={t('crm.werbung.bearbeiten.label.budgetplanung', 'Budgetplanung')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.budgetplanung', 'Für Tage mit hoher Nachfrage das Tagesbudget zeitweise erhöhen (mindestens 3 Stunden, höchstens 8-fach). Danach gilt wieder das normale Budget.')}
                werte={a.budget_schedule_specs} onChange={w => set({ budget_schedule_specs: w })} kurs={kurs}
                tagesbudgetCents={a.daily_budget_cents ?? null} disabled={gesperrt} sperre={sp('adset.budget_schedule_specs')} />
            ) : (
              <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.budgetplanung', 'Budgetplanung')}
                grund={cbo
                  ? t('crm.werbung.bearbeiten.grund.budgetplanungCbo', 'Mit Kampagnenbudget wird die Budgetplanung in der Kampagne eingestellt.')
                  : t('crm.werbung.bearbeiten.grund.budgetplanungTag', 'Nur mit Tagesbudget möglich.')} />
            )}
          </div>
        )}>
        {cbo ? (
          <p className="text-xs text-gray-600">{t('crm.werbung.builder.gruppe.cboBudget', 'Das Budget kommt aus der Kampagne (Advantage+ Kampagnenbudget).')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {budgetArt === 'daily' ? (
              <GeldFeld node={node} feld="adset.daily_budget_cents" label={feldLabel(t, 'adset.daily_budget_cents', 'Tagesbudget')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.tagesbudget', 'Durchschnitt pro Tag. Erhöhungen über 20 % können die Lernphase neu starten.')}
                cents={a.daily_budget_cents} onChange={v => set({ daily_budget_cents: v })} kurs={kurs} disabled={gesperrt} sperre={sp('adset.daily_budget_cents')} />
            ) : (
              <GeldFeld node={node} feld="adset.lifetime_budget_cents" label={feldLabel(t, 'adset.lifetime_budget_cents', 'Laufzeitbudget')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.laufzeitbudget', 'Feste Summe bis zum Enddatum der Kampagne.')}
                cents={a.lifetime_budget_cents} onChange={v => set({ lifetime_budget_cents: v })} kurs={kurs} disabled={gesperrt} sperre={sp('adset.lifetime_budget_cents')} />
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <ZeitFeld node={node} feld="adset.start_time" label={feldLabel(t, 'adset.start_time', 'Startdatum')}
            hilfe={t('crm.werbung.bearbeiten.hilfe.start', 'Leer: ab Aktivierung.')}
            value={a.start_time} onChange={v => set({ start_time: v })} disabled={gesperrt} sperre={sp('adset.start_time')} />
          <ZeitFeld node={node} feld="adset.end_time" label={feldLabel(t, 'adset.end_time', 'Enddatum')}
            hilfe={budgetArt === 'lifetime'
              ? t('crm.werbung.bearbeiten.hilfe.endePflicht', 'Pflicht beim Laufzeitbudget.')
              : t('crm.werbung.bearbeiten.hilfe.ende', 'Leer (empfohlen): läuft ohne Enddatum.')}
            value={a.end_time} onChange={v => set({ end_time: v })} disabled={gesperrt} sperre={sp('adset.end_time')} />
        </div>
      </Abschnitt>

      {/* 4. Zielgruppe */}
      <Abschnitt titel={feldLabel(t, 'adset.targeting', 'Zielgruppe')}
        hilfe={t('crm.werbung.bearbeiten.hilfe.zielgruppe', 'Wo die Anzeigen laufen und für wen. Unter Wohnen nur Standorte, Sprachen, Interessen und eigene Zielgruppen.') + lern}
        alleOffen={hatMeldung(['adset.targeting.location_types'])}
        alle={(
          <div className="space-y-3">
            <OrtTypen adset={a} disabled={gesperrt || !!sp('adset.targeting')} />
            {hec && (
              <div>
                <p className="mb-1 text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.wohnenTitel', 'Unter Wohnen gesperrt')}</p>
                <WohnenSperren />
              </div>
            )}
          </div>
        )}>
        <ZielgruppeHousing adset={a} disabled={gesperrt || !!sp('adset.targeting')} />
      </Abschnitt>

      {/* 5. Platzierungen */}
      <Abschnitt titel={feldLabel(t, 'adset.placements', 'Platzierungen')}
        hilfe={t('crm.werbung.meta.help.adset_placements', 'Advantage+ Platzierungen lassen Meta alle Platzierungen nutzen (empfohlen). Manuell nur, wenn bestimmte Platzierungen ausgeschlossen werden sollen.') + lern}
        aktion={(a.placements?.mode ?? 'advantage') === 'advantage' ? <EmpfohlenBadge /> : undefined}
        alleOffen={hatMeldung(['adset.placements.device_platforms'])}
        alle={(
          <div className="space-y-3">
            {manuell ? (
              <div id={feldId('adset.placements.device_platforms')} data-einstellung={t('crm.werbung.bearbeiten.label.geraete', 'Geräte und Betriebssysteme')}>
                <p className="mb-1 text-[11px] text-gray-500">{t('crm.werbung.bearbeiten.label.geraete', 'Geräte und Betriebssysteme')}</p>
                <div className="flex flex-wrap gap-4">
                  {DEVICE_OPTIONS.map(o => (
                    <Schalter key={o.value} checked={(manuell.device_platforms ?? []).indexOf(o.value) >= 0} disabled={gesperrt}
                      onChange={v => toggleGeraet(o.value, v)} label={t(o.labelKey, o.value)} />
                  ))}
                </div>
                <p className="mt-0.5 text-[10px] text-gray-500">{t('crm.werbung.bearbeiten.hilfe.geraete', 'Nichts angehakt heißt: alle Geräte. Bei Sofortformularen kein Desktop zusammen mit Instagram.')}</p>
              </div>
            ) : (
              <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.geraete', 'Geräte und Betriebssysteme')}
                grund={t('crm.werbung.bearbeiten.grund.geraete', 'Geräte lassen sich nur bei manuellen Platzierungen eingrenzen.')} />
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <FeldRahmen node={node} feld="adset.targeting.user_os" label={t('crm.werbung.bearbeiten.label.os', 'Betriebssystem (Mobil)')}
                hilfe={t('crm.werbung.bearbeiten.hilfe.os', 'Nur Personen mit diesem Handy-Betriebssystem. Für HP nicht nötig (empfohlen: alle).')}
                empfehlung={{ aktiv: !os, text: t('crm.werbung.bearbeiten.os.alle', 'Alle Betriebssysteme'), uebernehmen: () => setTargeting({ user_os: undefined }) }}
                sperre={sp('adset.targeting')}>
                <div className="mt-0.5">
                  <CustomSelect value={os} options={osOptionen} disabled={gesperrt || !!sp('adset.targeting')}
                    onChange={v => setTargeting({ user_os: v ? [v] : undefined })} />
                </div>
              </FeldRahmen>
              <div className="space-y-2">
                <Schalter checked={wlan} disabled={gesperrt} sperre={sp('adset.targeting')} empfohlen={!wlan}
                  onChange={v => setTargeting({ wireless_carrier: v ? ['Wifi'] : undefined })}
                  label={t('crm.werbung.bearbeiten.label.wlan', 'Nur bei WLAN-Verbindung')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.wlan', 'Vor allem für große Videos. Schränkt die Reichweite stark ein.')} />
                <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.softOptOut', 'Eingeschränkte Ausgaben für ausgeschlossene Platzierungen zulassen')}
                  grund={t('crm.werbung.bearbeiten.grund.softOptOut', 'Bis zu 5 % je ausgeschlossener Platzierung. Nur im Meta-Werbeanzeigenmanager einstellbar (Schnittstelle nicht dokumentiert).')} />
              </div>
            </div>
          </div>
        )}>
        <div id={feldId('adset.placements')} data-einstellung={feldLabel(t, 'adset.placements', 'Platzierungen')}
          className="flex flex-wrap gap-4 text-xs" role="radiogroup" aria-label={feldLabel(t, 'adset.placements', 'Platzierungen')}>
          {(['advantage', 'manual'] as const).map(m => (
            <label key={m} className="flex items-center gap-1.5">
              <input type="radio" name={`platz-${node}`} checked={(a.placements?.mode ?? 'advantage') === m} disabled={gesperrt || !!sp('adset.placements')} onChange={() => setzePlatzModus(m)} />
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
          </div>
        )}
        <FeldHinweise node={node} felder={[
          'adset.placements', 'adset.placements.publisher_platforms', 'adset.placements.facebook_positions',
          'adset.placements.instagram_positions', 'adset.placements.threads_positions', 'adset.placements.messenger_positions',
          'adset.placements.audience_network_positions',
        ]} />
      </Abschnitt>

      {/* 6. Markensicherheit */}
      <Abschnitt titel={t('crm.werbung.builder.gruppe.markensicherheit', 'Markensicherheit')}
        hilfe={t('crm.werbung.bearbeiten.hilfe.markensicherheit', 'Wo Anzeigen neben fremden Inhalten (Reels, Audience Network) nicht erscheinen sollen. Strengere Konto-Einstellungen gelten immer.')}
        alleOffen={hatMeldung(['adset.excluded_publisher_categories'])}
        alle={(
          <div className="space-y-3">
            <div id={feldId('adset.excluded_publisher_categories')} data-einstellung={feldLabel(t, 'adset.excluded_publisher_categories', 'Ausgeschlossene Themen')}>
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
            <FeldRahmen node={node} feld="adset.targeting.excluded_publisher_list_ids" label={t('crm.werbung.bearbeiten.label.blocklisten', 'Blockierlisten')}
              hilfe={t('crm.werbung.bearbeiten.hilfe.blocklisten', 'IDs von Blockierlisten aus dem Business Manager, durch Komma getrennt. Auf diesen Seiten und Apps erscheinen keine Anzeigen.')}
              sperre={sp('adset.targeting')}>
              <input key={blocklisten} defaultValue={blocklisten} disabled={gesperrt || !!sp('adset.targeting')} inputMode="numeric"
                aria-label={t('crm.werbung.bearbeiten.label.blocklisten', 'Blockierlisten')} placeholder="1234567890, …" className={INPUT_CLS}
                onBlur={ev => { const ids = idListe(ev.target.value); setTargeting({ excluded_publisher_list_ids: ids.length ? ids : undefined }) }} />
            </FeldRahmen>
          </div>
        )}>
        <div className="grid gap-3 sm:grid-cols-2">
          <AuswahlFeld<BrandSafety> node={node} feld="adset.brand_safety" label={feldLabel(t, 'adset.brand_safety', 'Inventarfilter')}
            hilfe={t('crm.werbung.bearbeiten.hilfe.inventar', 'Erweitert zeigt am meisten Reichweite, Eingeschränkt meidet sensible Inhalte am stärksten.')}
            value={a.brand_safety} optionen={BRAND_SAFETY_OPTIONS} disabled={gesperrt} sperre={sp('adset.brand_safety')}
            leer={t('crm.werbung.builder.gruppe.metaStandard', 'Standard von Meta')}
            onChange={v => set({ brand_safety: v })} />
        </div>
      </Abschnitt>

      {/* 7. Begünstigte und zahlende Person (DSA) */}
      <Abschnitt titel={t('crm.werbung.builder.gruppe.dsa', 'Begünstigte und zahlende Person')}
        hilfe={t('crm.werbung.meta.help.adset_dsa', 'EU-Pflichtangabe (Digital Services Act): wer von der Werbung profitiert und wer sie bezahlt. Standard aus dem Werbekonto.')}>
        {eu && <p className="text-[11px] text-hp-navy">{t('crm.werbung.builder.gruppe.dsaPflicht', 'Pflicht, weil die Zielgruppe in der EU liegt.')}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextFeld node={node} feld="adset.dsa_beneficiary" label={feldLabel(t, 'adset.dsa_beneficiary', 'Begünstigte Person')}
            value={a.dsa_beneficiary ?? ''} onChange={v => set({ dsa_beneficiary: v })} maxLen={512} disabled={gesperrt} sperre={sp('adset.dsa_beneficiary')} />
          <TextFeld node={node} feld="adset.dsa_payor" label={feldLabel(t, 'adset.dsa_payor', 'Zahlende Person')}
            value={a.dsa_payor ?? ''} onChange={v => set({ dsa_payor: v })} maxLen={512} disabled={gesperrt} sperre={sp('adset.dsa_payor')} />
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
    </div>
  )
}
