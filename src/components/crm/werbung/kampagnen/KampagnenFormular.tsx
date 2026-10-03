import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  BID_OPTIONS, META_UNBEGRENZT_AB, OBJECTIVE_OPTIONS, SAC_OPTIONS,
  type BidStrategy, type CampaignDraft, type DraftSpec, type Objective, type SpecialCat,
} from '../../../../lib/metaSpec'
import { INPUT_CLS } from '../felder'
import { FeldHinweise } from './PruefPanel'
import {
  Abschnitt, AuswahlFeld, FeldRahmen, GeldFeld, GesperrteEinstellung, RadioReihe, Schalter, SperrBanner, StatusFeld,
  TextFeld, ZeitFeld, feldId, feldLabel,
} from './Bausteine'
import { BudgetPlanungFeld } from './BudgetFelder'
import { EmpfohlenBadge } from './bearbeitenHelfer'
import { hpVon, mitHp } from './bearbeitenTypen'
import { passeAnZiel, useAssistent } from './useEntwurf'

// ── Kampagnen-Ebene des Assistenten (Reihenfolge und Begriffe wie bei Meta) ──
// Kampagnenziel (+ Buchungsart), Kampagnenname (+ Status beim Bearbeiten),
// Spezielle Anzeigenkategorien (Wohnen gesperrt), Budget (Advantage+
// Kampagnenbudget, Budgetart, Gebotsstrategie, Budget teilen, Budgetplanung,
// Ausgabenlimit), Zeitplan. Jeder Abschnitt: oben „Das Wichtigste" mit
// HP-Empfehlung, darunter „Alle Einstellungen". Im Bearbeiten-Modus sind
// bestehende Kampagnen änderbar; was Meta sperrt, steht grau mit Grund da.
// Die Formularbausteine liegen in ./Bausteine (hier weiter exportiert).

export {
  Abschnitt, AuswahlFeld, FeldRahmen, GeldFeld, Schalter, SperrBanner, TextFeld, ZeitFeld, feldId, feldLabel, optionenFuer,
} from './Bausteine'

/** Metas „kein Limit“ (922337203685478) als leeres Feld zeigen */
export const ohneUnbegrenzt = (c: number | undefined): number | undefined => (c !== undefined && c >= META_UNBEGRENZT_AB ? undefined : c)

export default function KampagnenFormular() {
  const { t } = useTranslation()
  const { e, kurs, vorgaben, bearbeiten, sperre } = useAssistent()
  const { spec, nurLesen, housing } = e
  const c = spec.campaign
  const bestehend = !!c.existing_id
  // Bestehende Kampagne ohne Bearbeiten-Modus (Übernahme zum Ergänzen): nur ansehen
  const nurAnsicht = bestehend && !bearbeiten
  // Von diesem Entwurf schon bei Meta angelegt: Fortsetzen übernimmt keine Änderungen mehr
  const angelegt = !bestehend && !!e.metaIds.campaign
  const gesperrt = nurLesen || angelegt || nurAnsicht
  const node = 'campaign'
  const sp = (feld: string): string | undefined => (bearbeiten && bestehend ? sperre(node, feld) : undefined)
  const set = (fn: (d: DraftSpec) => DraftSpec) => e.update(fn)
  const setC = (patch: Partial<CampaignDraft>) => set(d => ({ ...d, campaign: { ...d.campaign, ...patch } }))
  const wohnenGesperrt = housing.locks.some(l => l.field === 'campaign.special_ad_categories')
  const laenderSpec = (c.special_ad_category_country ?? []).join(', ')
  const [laender, setLaender] = useState(laenderSpec)
  useEffect(() => { setLaender(laenderSpec) }, [laenderSpec])

  const cbo = c.budget_level === 'campaign'
  const neueGruppen = spec.adsets.filter(a => !a.existing_id)
  const hatMeldung = (felder: readonly string[]) =>
    e.issues.some(i => i.node === node && felder.indexOf(i.field) >= 0)
    || e.lint.some(l => (l.node ?? 'campaign') === node && felder.indexOf(l.field) >= 0)

  const setzeZiel = (o: Objective) => set(d => passeAnZiel({ ...d, campaign: { ...d.campaign, objective: o } }, vorgaben.pixelId ?? ''))

  // Advantage+ Kampagnenbudget umschalten: Budgets mitnehmen statt verlieren
  const setzeCbo = (an: boolean) => set(d => {
    const neu = d.adsets.filter(a => !a.existing_id)
    if (an) {
      const summe = neu.reduce((s, a) => s + (a.daily_budget_cents ?? 0), 0)
      return {
        ...d,
        campaign: { ...d.campaign, budget_level: 'campaign', daily_budget_cents: summe > 0 ? summe : d.campaign.daily_budget_cents, lifetime_budget_cents: undefined, is_adset_budget_sharing_enabled: undefined, bid_strategy: d.campaign.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP' },
        adsets: d.adsets.map(a => (a.existing_id ? a : { ...a, daily_budget_cents: undefined, lifetime_budget_cents: undefined })),
      }
    }
    const je = neu.length && (d.campaign.daily_budget_cents ?? 0) > 0 ? Math.round((d.campaign.daily_budget_cents ?? 0) / neu.length) : 3500
    return {
      ...d,
      campaign: { ...d.campaign, budget_level: 'adset', daily_budget_cents: undefined, lifetime_budget_cents: undefined, is_adset_budget_sharing_enabled: false },
      adsets: d.adsets.map(a => (a.existing_id ? a : { ...a, daily_budget_cents: a.daily_budget_cents ?? je, bid_strategy: a.bid_strategy ?? d.campaign.bid_strategy })),
    }
  })

  const toggleKategorie = (cat: SpecialCat, an: boolean) => setC({
    special_ad_categories: an
      ? [...(c.special_ad_categories ?? []).filter(x => x !== 'NONE' && x !== cat), cat]
      : (c.special_ad_categories ?? []).filter(x => x !== cat),
  })

  const laenderUebernehmen = () => {
    const codes = laender.toUpperCase().split(/[\s,;]+/).filter(x => /^[A-Z]{2}$/.test(x))
    const uniq = codes.filter((x, i) => codes.indexOf(x) === i)
    setC({ special_ad_category_country: uniq.length ? uniq : ['DE'] })
  }

  const budgetArt: 'daily' | 'lifetime' = (c.lifetime_budget_cents ?? 0) > 0 ? 'lifetime' : 'daily'
  const zielSperre = sp('campaign.objective') ?? (nurAnsicht ? t('crm.werbung.bearbeiten.sperre.objective', 'Das Kampagnenziel legt Meta beim Anlegen fest.') : undefined)
  const kategorieSperre = sp('campaign.special_ad_categories')
  const budgetSichtbar = !nurAnsicht

  return (
    <div className="space-y-4">
      {nurAnsicht && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.kampagne.bestehend', 'Diese Kampagne besteht schon bei Meta (ID {{id}}). Der Assistent legt nur neue Anzeigengruppen und Anzeigen darin an, die Kampagne selbst bleibt unverändert.', { id: c.existing_id })}
        </div>
      )}
      {bearbeiten && bestehend && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.bearbeiten.kampagneHinweis', 'Laufende Kampagne (ID {{id}}). Änderungen gehen erst nach „Änderungen prüfen“ und deiner Bestätigung an Meta.', { id: c.existing_id })}
        </div>
      )}
      {angelegt && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.kampagne.angelegt', 'Diese Kampagne ist schon bei Meta angelegt (ID {{id}}). Ihre Einstellungen lassen sich hier nicht mehr ändern.', { id: e.metaIds.campaign })}
        </div>
      )}

      {/* 1. Kampagnenziel (+ Buchungsart) */}
      <Abschnitt titel={feldLabel(t, 'campaign.objective', 'Kampagnenziel')}
        hilfe={t('crm.werbung.bearbeiten.hilfe.objective', 'Das Ziel bestimmt, worauf Meta optimiert. Für Terminanfragen über Website oder Sofortformular ist es „Leads“.')}
        aktion={c.objective === 'OUTCOME_LEADS' ? <EmpfohlenBadge /> : undefined}
        alle={(
          <div className="grid gap-3 sm:grid-cols-2">
            <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.buchungsart', 'Buchungsart')}
              wert={t('crm.werbung.meta.buying_type.AUCTION', 'Auktion')}
              grund={t('crm.werbung.bearbeiten.grund.buchungsart', 'Reservierung gibt es nur für Bekanntheit und Interaktionen. Für Leads immer Auktion.')} />
            <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.abTest', 'A/B-Test')}
              grund={t('crm.werbung.bearbeiten.grund.abTest', 'A/B-Tests kommen in einem späteren Ausbau. Bis dahin im Meta-Werbeanzeigenmanager.')} />
          </div>
        )}>
        {zielSperre ? (
          <FeldRahmen node={node} feld="campaign.objective" label={feldLabel(t, 'campaign.objective', 'Kampagnenziel')} sperre={zielSperre}>
            <p className="mt-0.5 rounded-lg border border-gray-100 bg-gray-50 px-2 py-1 text-xs text-gray-700">{t(`crm.werbung.meta.objective.${c.objective}`, c.objective)}</p>
          </FeldRahmen>
        ) : (
          <div id={feldId('campaign.objective')} data-einstellung={feldLabel(t, 'campaign.objective', 'Kampagnenziel')} role="radiogroup"
            aria-label={feldLabel(t, 'campaign.objective', 'Kampagnenziel')} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {OBJECTIVE_OPTIONS.map(o => {
              const aktiv = c.objective === o.value
              return (
                <button key={o.value} type="button" role="radio" aria-checked={aktiv} disabled={gesperrt || !!o.unsupported}
                  onClick={() => setzeZiel(o.value)}
                  className={`rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${aktiv ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-hp-navy/40'}`}>
                  <span className="block text-sm font-semibold">{t(o.labelKey, o.value)}</span>
                  {o.recommended && <span className={`text-[10px] ${aktiv ? 'text-white/80' : 'text-gray-500'}`}>{t('crm.werbung.bearbeiten.empfohlen', 'Empfohlen für Happy Property')}</span>}
                  {o.unsupported && <span className="text-[10px] text-gray-500">{t('crm.werbung.builder.form.nichtImAssistenten', 'Im Assistenten nicht verfügbar')}</span>}
                </button>
              )
            })}
          </div>
        )}
        <FeldHinweise node={node} felder={['campaign.objective', 'campaign.buying_type']} />
      </Abschnitt>

      {/* 2. Kampagnenname (+ Status) */}
      <Abschnitt titel={t('crm.werbung.builder.kampagne.name', 'Kampagnenname')}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <TextFeld node={node} feld="campaign.name" label={feldLabel(t, 'campaign.name', 'Name der Kampagne')}
              hilfe={t('crm.werbung.bearbeiten.hilfe.name', 'Nur intern sichtbar, Kunden sehen ihn nicht. Gut: Ziel, Zielgruppe und Monat.')}
              value={c.name ?? ''} onChange={v => setC({ name: v })} maxLen={400} disabled={gesperrt} />
          </div>
          {bearbeiten && bestehend && (
            <StatusFeld node={node} feld="campaign.status" value={c.status} disabled={gesperrt}
              onChange={v => setC({ status: v })} />
          )}
        </div>
      </Abschnitt>

      {/* 3. Spezielle Anzeigenkategorien */}
      <Abschnitt titel={feldLabel(t, 'campaign.special_ad_categories', 'Spezielle Anzeigenkategorien')}
        hilfe={t('crm.werbung.bearbeiten.hilfe.kategorie', 'Immobilienwerbung muss bei Meta als Wohnen laufen. Dann sind nur breite Zielgruppen erlaubt.')}
        alleOffen={hatMeldung(['campaign.special_ad_category_country'])}
        alle={(
          <div className="space-y-3">
            <div className="space-y-1.5">
              {SAC_OPTIONS.filter(o => o.value !== 'NONE' && o.value !== 'HOUSING').map(o => {
                const an = (c.special_ad_categories ?? []).indexOf(o.value) >= 0
                return (
                  <Schalter key={o.value} checked={an} onChange={v => toggleKategorie(o.value, v)}
                    disabled={gesperrt || nurAnsicht || !!o.unsupported} sperre={kategorieSperre}
                    label={t(o.labelKey, o.value)}
                    hilfe={o.unsupported
                      ? t('crm.werbung.bearbeiten.grund.kategorieEu', 'In der EU nicht mehr erstellbar bzw. im Assistenten nicht verfügbar.')
                      : t('crm.werbung.bearbeiten.hilfe.andereKategorie', 'Nur nötig, wenn die Anzeige auch Kredite oder Jobs bewirbt.')} />
                )
              })}
            </div>
            {(c.special_ad_categories ?? []).some(x => x !== 'NONE') && (
              <FeldRahmen node={node} feld="campaign.special_ad_category_country"
                label={feldLabel(t, 'campaign.special_ad_category_country', 'Länder der speziellen Anzeigenkategorie')}
                hilfe={t('crm.werbung.builder.kampagne.laenderHilfe', 'ISO-Ländercodes, durch Komma getrennt (Standard DE).')}
                sperre={sp('campaign.special_ad_category_country')}>
                <input value={laender} disabled={gesperrt || nurAnsicht || !!sp('campaign.special_ad_category_country')}
                  onChange={ev => setLaender(ev.target.value)} onBlur={laenderUebernehmen}
                  aria-label={feldLabel(t, 'campaign.special_ad_category_country', 'Länder der speziellen Anzeigenkategorie')}
                  className={INPUT_CLS} placeholder="DE" />
              </FeldRahmen>
            )}
          </div>
        )}>
        {wohnenGesperrt && <SperrBanner>{t('crm.werbung.meta.housing.banner', 'Sonderkategorie Wohnen: Meta erlaubt nur breite Zielgruppen. Alter, Geschlecht, PLZ, Ortsausschlüsse und Lookalikes sind gesperrt.')}</SperrBanner>}
        <div id={feldId('campaign.special_ad_categories')}>
          {SAC_OPTIONS.filter(o => o.value === 'HOUSING').map(o => {
            const an = (c.special_ad_categories ?? []).indexOf(o.value) >= 0
            const fest = wohnenGesperrt
            return (
              <Schalter key={o.value} checked={an} onChange={v => toggleKategorie(o.value, v)}
                disabled={gesperrt || nurAnsicht || fest} sperre={!fest ? kategorieSperre : undefined} empfohlen={an}
                label={`${t(o.labelKey, o.value)}${fest ? ' 🔒' : ''}`}
                hilfe={fest ? t('crm.werbung.meta.housing.category', 'Jede Immobilienkampagne läuft in der Sonderkategorie Wohnen.') : undefined} />
            )
          })}
        </div>
        <FeldHinweise node={node} felder="campaign.special_ad_categories" />
      </Abschnitt>

      {/* 4. Budget */}
      {budgetSichtbar && (
        <Abschnitt titel={t('crm.werbung.builder.kampagne.budget', 'Budget')}
          hilfe={t('crm.werbung.meta.help.campaign_budget_level', 'An: Meta verteilt ein Kampagnenbudget selbst auf die Anzeigengruppen. Aus: jede Anzeigengruppe hat ihr eigenes Budget, wie bei Plan B.')}
          alleOffen={hatMeldung(['campaign.bid_strategy', 'campaign.spend_cap_cents', 'campaign.is_adset_budget_sharing_enabled', 'campaign.budget_schedule_specs'])}
          alle={(
            <div className="space-y-3">
              {cbo ? (
                <div className="grid gap-3 sm:grid-cols-2">
                  <FeldRahmen node={node} feld="campaign.budget_art" label={t('crm.werbung.builder.form.budgetArt', 'Budgetart')}
                    hilfe={t('crm.werbung.bearbeiten.hilfe.budgetArt', 'Tagesbudget: Durchschnitt pro Tag, an guten Tagen bis 75 % mehr. Laufzeitbudget: feste Summe bis zum Enddatum.')}
                    sperre={sp('campaign.budget_art')}>
                    <RadioReihe name="kampagne-budgetart" value={budgetArt} disabled={gesperrt || !!sp('campaign.budget_art')}
                      label={t('crm.werbung.builder.form.budgetArt', 'Budgetart')}
                      optionen={[['daily', t('crm.werbung.builder.form.tagesbudget', 'Tagesbudget')], ['lifetime', t('crm.werbung.builder.form.laufzeitbudget', 'Laufzeitbudget')]]}
                      onChange={art => setC(art === 'daily'
                        ? { daily_budget_cents: c.lifetime_budget_cents ?? c.daily_budget_cents, lifetime_budget_cents: undefined }
                        : { lifetime_budget_cents: c.daily_budget_cents ?? c.lifetime_budget_cents, daily_budget_cents: undefined })} />
                  </FeldRahmen>
                  <AuswahlFeld<BidStrategy> node={node} feld="campaign.bid_strategy" label={feldLabel(t, 'campaign.bid_strategy', 'Gebotsstrategie der Kampagne')}
                    hilfe={t('crm.werbung.bearbeiten.hilfe.bid', 'Größtes Volumen holt so viele Ergebnisse wie möglich aus dem Budget. Kostenziel und Gebotsbegrenzung brauchen viele Conversions pro Woche.')}
                    empfehlung={{ aktiv: (c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP') === 'LOWEST_COST_WITHOUT_CAP', text: t('crm.werbung.meta.bid.LOWEST_COST_WITHOUT_CAP', 'Größtes Volumen'), uebernehmen: () => setC({ bid_strategy: 'LOWEST_COST_WITHOUT_CAP' }) }}
                    value={c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'} optionen={BID_OPTIONS}
                    onChange={v => setC({ bid_strategy: v ?? 'LOWEST_COST_WITHOUT_CAP' })} disabled={gesperrt} sperre={sp('campaign.bid_strategy')} />
                  {!(bearbeiten && bestehend) ? (
                    // Beim Anlegen sendet meta-builder keine Budgetplanung: erst danach über „Bearbeiten“
                    <div className="sm:col-span-2">
                      <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.budgetplanung', 'Budgetplanung')}
                        grund={t('crm.werbung.bearbeiten.grund.nachAnlegen', 'Erst nach dem Anlegen einstellbar: Kampagne bei Meta anlegen, dann über „Bearbeiten“.')} />
                    </div>
                  ) : budgetArt === 'daily' ? (
                    <div className="sm:col-span-2">
                      <BudgetPlanungFeld node={node} feld="campaign.budget_schedule_specs" label={t('crm.werbung.bearbeiten.label.budgetplanung', 'Budgetplanung')}
                        hilfe={t('crm.werbung.bearbeiten.hilfe.budgetplanung', 'Für Tage mit hoher Nachfrage das Tagesbudget zeitweise erhöhen (mindestens 3 Stunden, höchstens 8-fach). Danach gilt wieder das normale Budget.')}
                        werte={c.budget_schedule_specs} onChange={w => setC({ budget_schedule_specs: w })} kurs={kurs}
                        tagesbudgetCents={c.daily_budget_cents ?? null} disabled={gesperrt} sperre={sp('campaign.budget_schedule_specs')} />
                    </div>
                  ) : (
                    <div className="sm:col-span-2">
                      <GesperrteEinstellung label={t('crm.werbung.bearbeiten.label.budgetplanung', 'Budgetplanung')}
                        grund={t('crm.werbung.bearbeiten.grund.budgetplanungTag', 'Nur mit Tagesbudget möglich.')} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <Schalter checked={c.is_adset_budget_sharing_enabled === true} disabled={gesperrt}
                    sperre={c.is_adset_budget_sharing_enabled === true ? undefined : sp('campaign.is_adset_budget_sharing_enabled')}
                    onChange={v => setC({ is_adset_budget_sharing_enabled: v })}
                    label={feldLabel(t, 'campaign.is_adset_budget_sharing_enabled', 'Budget mit anderen Anzeigengruppen teilen')}
                    hilfe={t('crm.werbung.meta.help.campaign_budget_sharing', 'Erlaubt Meta, bis zu 20 % des Budgets zwischen Anzeigengruppen zu verschieben. Nur mit Tagesbudgets und gleicher Gebotsstrategie, später nur noch ausschaltbar.')} />
                  <FeldHinweise node={node} felder="campaign.is_adset_budget_sharing_enabled" />
                  {neueGruppen.length > 1 && (
                    <Schalter checked={hpVon(spec).budgets_synchron === true} disabled={gesperrt}
                      onChange={v => set(d => mitHp(d, { budgets_synchron: v }))}
                      label={t('crm.werbung.builder.kampagne.synchron', 'Budgets der Anzeigengruppen synchron halten')}
                      hilfe={t('crm.werbung.builder.kampagne.synchronHilfe', 'Ändert sich das Budget einer Anzeigengruppe, bekommen alle neuen Anzeigengruppen denselben Betrag (wie bei Plan B Lang und Kurz).')} />
                  )}
                </div>
              )}
              <div className="grid gap-3 sm:grid-cols-2">
                <GeldFeld node={node} feld="campaign.spend_cap_cents" label={feldLabel(t, 'campaign.spend_cap_cents', 'Ausgabenlimit der Kampagne')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.spendCap', 'Optional. Meta pausiert die Kampagne, wenn insgesamt so viel ausgegeben ist (100 $ bis 100.000 $).')}
                  entfernbar={t('crm.werbung.bearbeiten.limitEntfernen', 'Limit entfernen')}
                  cents={ohneUnbegrenzt(c.spend_cap_cents)} onChange={v => setC({ spend_cap_cents: v })} kurs={kurs} disabled={gesperrt} sperre={sp('campaign.spend_cap_cents')} />
              </div>
            </div>
          )}>
          <Schalter checked={cbo} onChange={setzeCbo} disabled={gesperrt} sperre={sp('campaign.budget_level')} empfohlen={!cbo && !sp('campaign.budget_level')}
            label={feldLabel(t, 'campaign.budget_level', 'Advantage+ Kampagnenbudget')}
            hilfe={!cbo ? t('crm.werbung.bearbeiten.hilfe.cboAus', 'Aus (empfohlen): jede Anzeigengruppe hat ihr eigenes Budget, wie bei Plan B.') : undefined} />
          <FeldHinweise node={node} felder="campaign.budget_level" />
          {cbo && (
            <div className="grid gap-3 sm:grid-cols-2">
              {budgetArt === 'daily' ? (
                <GeldFeld node={node} feld="campaign.daily_budget_cents" label={feldLabel(t, 'campaign.daily_budget_cents', 'Tagesbudget der Kampagne')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.tagesbudget', 'Durchschnitt pro Tag. Erhöhungen über 20 % können die Lernphase neu starten.')}
                  cents={c.daily_budget_cents} onChange={v => setC({ daily_budget_cents: v })} kurs={kurs} disabled={gesperrt} sperre={sp('campaign.daily_budget_cents')} />
              ) : (
                <GeldFeld node={node} feld="campaign.lifetime_budget_cents" label={feldLabel(t, 'campaign.lifetime_budget_cents', 'Laufzeitbudget der Kampagne')}
                  hilfe={t('crm.werbung.bearbeiten.hilfe.laufzeitbudget', 'Feste Summe bis zum Enddatum der Kampagne.')}
                  cents={c.lifetime_budget_cents} onChange={v => setC({ lifetime_budget_cents: v })} kurs={kurs} disabled={gesperrt} sperre={sp('campaign.lifetime_budget_cents')} />
              )}
            </div>
          )}
        </Abschnitt>
      )}

      {/* 5. Zeitplan der Kampagne */}
      {budgetSichtbar && (
        <Abschnitt titel={t('crm.werbung.bearbeiten.zeitplanKampagne', 'Zeitplan der Kampagne')}
          hilfe={t('crm.werbung.bearbeiten.hilfe.zeitplanKampagne', 'Leer lassen (empfohlen): läuft ab Aktivierung ohne Enddatum, die Budgets steuern die Ausgaben.')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <ZeitFeld node={node} feld="campaign.start_time" label={feldLabel(t, 'campaign.start_time', 'Startdatum')}
              value={c.start_time} onChange={v => setC({ start_time: v })} disabled={gesperrt} sperre={sp('campaign.start_time')} />
            <ZeitFeld node={node} feld="campaign.stop_time" label={feldLabel(t, 'campaign.stop_time', 'Enddatum')}
              value={c.stop_time} onChange={v => setC({ stop_time: v })} disabled={gesperrt} sperre={sp('campaign.stop_time')} />
          </div>
        </Abschnitt>
      )}
    </div>
  )
}
