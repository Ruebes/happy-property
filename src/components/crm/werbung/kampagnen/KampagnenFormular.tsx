import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { CustomSelect, type SelectOption } from '../../../CustomSelect'
import {
  BID_OPTIONS, OBJECTIVE_OPTIONS, SAC_OPTIONS,
  type BidStrategy, type DraftSpec, type EnumOption, type Objective, type SpecialCat,
} from '../../../../lib/metaSpec'
import { Field, INPUT_CLS, LockedField, UsdEurHinweis, parseDollar, toLocalInput } from '../felder'
import { useWerbeFormat } from '../format'
import { FeldHinweise } from './PruefPanel'
import { passeAnZiel, useAssistent } from './useEntwurf'

// ── Kampagnen-Ebene des Assistenten (Reihenfolge und Begriffe wie bei Meta) ──
// Name, Kampagnenziel, Spezielle Anzeigenkategorien (Wohnen gesperrt),
// Advantage+ Kampagnenbudget, Gebotsstrategie, Ausgabenlimit, Laufzeit.
// Dazu die gemeinsamen Formularbausteine des Assistenten (Abschnitt,
// TextFeld, AuswahlFeld, GeldFeld in USD mit EUR-Hinweis, ZeitFeld, Schalter).

/** DOM-Id eines Formularfelds (Sprungziel aus der Prüfliste) */
export const feldId = (feld: string): string => `kf-${feld.replace(/[^a-zA-Z0-9]+/g, '-')}`

/** Beschriftung eines Feldes aus metaSpec (crm.werbung.meta.field.*) */
export const feldLabel = (t: TFunction, feld: string, ersatz: string): string =>
  t(`crm.werbung.meta.field.${feld.replace(/\./g, '_')}`, ersatz)

export function optionenFuer<V extends string>(t: TFunction, liste: readonly EnumOption<V>[]): SelectOption[] {
  return liste.map(o => ({
    value: o.value,
    label: t(o.labelKey, o.value),
    disabled: !!o.unsupported,
    hint: o.unsupported
      ? t('crm.werbung.builder.form.nichtImAssistenten', 'Im Assistenten nicht verfügbar')
      : o.deprecated
        ? t('crm.werbung.builder.form.abgekuendigt', 'Von Meta abgekündigt')
        : o.recommended ? t('crm.werbung.builder.form.empfohlen', 'Empfohlen') : undefined,
  }))
}

// ── Bausteine ────────────────────────────────────────────────────────────────

export function Abschnitt({ titel, hilfe, aktion, children, id }: { titel: string; hilfe?: ReactNode; aktion?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="hp-card scroll-mt-4 space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-start gap-2">
        <h3 className="mr-auto font-heading text-base text-hp-navy">{titel}</h3>
        {aktion}
      </div>
      {hilfe && <div className="-mt-1 text-[11px] leading-snug text-gray-500">{hilfe}</div>}
      {children}
    </section>
  )
}

interface Basis {
  node: string
  feld: string
  /** weitere FieldSpec-Keys, deren Meldungen hier erscheinen */
  auch?: readonly string[]
  label: string
  hilfe?: string
  disabled?: boolean
}

export function FeldRahmen({ node, feld, auch, label, hilfe, children }: Omit<Basis, 'disabled'> & { children: ReactNode }) {
  return (
    <div id={feldId(feld)} className="scroll-mt-24">
      <Field label={label} hint={hilfe}>{children}</Field>
      <FeldHinweise node={node} felder={[feld, ...(auch ?? [])]} />
    </div>
  )
}

export function TextFeld({ value, onChange, maxLen, zaehler, mehrzeilig, placeholder, ...b }: Basis & {
  value: string
  onChange: (v: string) => void
  maxLen?: number
  /** Zähler „n / zaehler" (HP-Grenze, z. B. Überschrift 40) */
  zaehler?: number
  mehrzeilig?: boolean
  placeholder?: string
}) {
  const zu = zaehler !== undefined && value.trim().length > zaehler
  return (
    <FeldRahmen {...b}>
      {mehrzeilig ? (
        <textarea value={value} disabled={b.disabled} maxLength={maxLen} placeholder={placeholder} rows={4}
          onChange={e => onChange(e.target.value)} className={`${INPUT_CLS} resize-y`} />
      ) : (
        <input value={value} disabled={b.disabled} maxLength={maxLen} placeholder={placeholder}
          onChange={e => onChange(e.target.value)} className={INPUT_CLS} />
      )}
      {zaehler !== undefined && (
        <span className={`mt-0.5 block text-right text-[10px] tabular-nums ${zu ? 'font-semibold text-red-600' : 'text-gray-400'}`}>
          {value.trim().length} / {zaehler}
        </span>
      )}
    </FeldRahmen>
  )
}

export function AuswahlFeld<V extends string>({ value, optionen, onChange, leer, ...b }: Basis & {
  value: V | undefined
  optionen: readonly EnumOption<V>[]
  onChange: (v: V | undefined) => void
  /** Text der Leer-Option (nur wenn das Feld leer bleiben darf) */
  leer?: string
}) {
  const { t } = useTranslation()
  const opts = optionenFuer(t, optionen)
  const alle = leer ? [{ value: '', label: leer }, ...opts] : opts
  return (
    <FeldRahmen {...b}>
      <div className="mt-0.5">
        <CustomSelect value={value ?? ''} disabled={b.disabled} options={alle}
          onChange={v => onChange(v ? optionen.find(o => o.value === v)?.value : undefined)} />
      </div>
    </FeldRahmen>
  )
}

/** Betrag in USD (Kontowährung, Cent auf dem Draht) mit EUR-Gegenwert daneben */
export function GeldFeld({ cents, onChange, kurs, ...b }: Basis & {
  cents: number | undefined
  onChange: (c: number | undefined) => void
  kurs: number
}) {
  const fmt = useWerbeFormat()
  const zeige = (c: number | undefined) => (c && c > 0 ? (c / 100).toLocaleString(fmt.locale, { maximumFractionDigits: 2, useGrouping: false }) : '')
  const [txt, setTxt] = useState(() => zeige(cents))
  // Von außen geändert (z. B. Budgets synchron): Anzeige nachziehen
  useEffect(() => {
    const p = parseDollar(txt)
    const lokal = p != null && p > 0 ? Math.round(p * 100) : undefined
    const aussen = cents && cents > 0 ? cents : undefined
    if (lokal !== aussen) setTxt(zeige(cents))
    // nur auf Änderungen von außen reagieren
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cents])
  return (
    <FeldRahmen {...b}>
      <div className="relative mt-0.5">
        <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-400">$</span>
        <input inputMode="decimal" value={txt} disabled={b.disabled}
          onChange={e => {
            setTxt(e.target.value)
            const p = parseDollar(e.target.value)
            onChange(p != null && p > 0 ? Math.round(p * 100) : undefined)
          }}
          className={`${INPUT_CLS} mt-0 pl-5 tabular-nums`} />
      </div>
      <UsdEurHinweis usd={txt} kurs={kurs} />
    </FeldRahmen>
  )
}

export function ZeitFeld({ value, onChange, ...b }: Basis & { value: string | undefined; onChange: (iso: string | undefined) => void }) {
  return (
    <FeldRahmen {...b}>
      <input type="datetime-local" value={toLocalInput(value)} disabled={b.disabled}
        onChange={e => {
          const v = e.target.value
          const d = v ? new Date(v) : null
          onChange(d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined)
        }}
        className={INPUT_CLS} />
    </FeldRahmen>
  )
}

export function Schalter({ checked, onChange, label, hilfe, disabled }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hilfe?: string; disabled?: boolean
}) {
  return (
    <label className={`flex items-start gap-2 text-xs text-gray-700 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-gray-300 text-hp-navy focus:ring-hp-navy/40" />
      <span>
        {label}
        {hilfe && <span className="block text-[10px] leading-snug text-gray-500">{hilfe}</span>}
      </span>
    </label>
  )
}

/** Sperr-Hinweis der Sonderkategorie Wohnen */
export function SperrBanner({ children }: { children: ReactNode }) {
  return (
    <div role="note" className="flex gap-2 rounded-lg border border-hp-navy/15 bg-hp-cream px-3 py-2 text-[11px] leading-snug text-hp-navy">
      <span aria-hidden="true">🔒</span>
      <div>{children}</div>
    </div>
  )
}

// ── Kampagnen-Formular ───────────────────────────────────────────────────────

export default function KampagnenFormular() {
  const { t } = useTranslation()
  const { e, kurs, vorgaben } = useAssistent()
  const { spec, nurLesen, housing } = e
  const c = spec.campaign
  const bestehend = !!c.existing_id
  // Von diesem Entwurf schon bei Meta angelegt: Fortsetzen übernimmt keine Änderungen mehr
  const angelegt = !bestehend && !!e.metaIds.campaign
  const gesperrt = nurLesen || angelegt
  const node = 'campaign'
  const set = (fn: (d: DraftSpec) => DraftSpec) => e.update(fn)
  const setC = (patch: Partial<DraftSpec['campaign']>) => set(d => ({ ...d, campaign: { ...d.campaign, ...patch } }))
  const wohnenGesperrt = housing.locks.some(l => l.field === 'campaign.special_ad_categories')
  const laenderSpec = (c.special_ad_category_country ?? []).join(', ')
  const [laender, setLaender] = useState(laenderSpec)
  useEffect(() => { setLaender(laenderSpec) }, [laenderSpec])

  const cbo = c.budget_level === 'campaign'
  const neueGruppen = spec.adsets.filter(a => !a.existing_id)

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

  return (
    <div className="space-y-4">
      {bestehend && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.kampagne.bestehend', 'Diese Kampagne besteht schon bei Meta (ID {{id}}). Der Assistent legt nur neue Anzeigengruppen und Anzeigen darin an, die Kampagne selbst bleibt unverändert.', { id: c.existing_id })}
        </div>
      )}
      {angelegt && (
        <div role="note" className="rounded-lg border border-hp-navy/15 bg-hp-navy/5 px-3 py-2 text-xs text-hp-navy">
          {t('crm.werbung.builder.kampagne.angelegt', 'Diese Kampagne ist schon bei Meta angelegt (ID {{id}}). Ihre Einstellungen lassen sich hier nicht mehr ändern.', { id: e.metaIds.campaign })}
        </div>
      )}

      <Abschnitt titel={t('crm.werbung.builder.kampagne.name', 'Kampagnenname')}>
        <TextFeld node={node} feld="campaign.name" label={feldLabel(t, 'campaign.name', 'Name der Kampagne')}
          value={c.name ?? ''} onChange={v => setC({ name: v })} maxLen={400} disabled={gesperrt || bestehend} />
      </Abschnitt>

      <Abschnitt titel={feldLabel(t, 'campaign.objective', 'Kampagnenziel')}>
        {bestehend ? (
          <LockedField label={feldLabel(t, 'campaign.objective', 'Kampagnenziel')} value={t(`crm.werbung.meta.objective.${c.objective}`, c.objective)} />
        ) : (
          <div id={feldId('campaign.objective')} role="radiogroup" aria-label={feldLabel(t, 'campaign.objective', 'Kampagnenziel')} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {OBJECTIVE_OPTIONS.map(o => {
              const aktiv = c.objective === o.value
              return (
                <button key={o.value} type="button" role="radio" aria-checked={aktiv} disabled={gesperrt || !!o.unsupported}
                  onClick={() => setzeZiel(o.value)}
                  className={`rounded-xl border px-3 py-2.5 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${aktiv ? 'border-hp-navy bg-hp-navy text-white' : 'border-gray-200 bg-white text-gray-700 hover:border-hp-navy/40'}`}>
                  <span className="block text-sm font-semibold">{t(o.labelKey, o.value)}</span>
                  {o.recommended && <span className={`text-[10px] ${aktiv ? 'text-white/80' : 'text-gray-500'}`}>{t('crm.werbung.builder.form.empfohlen', 'Empfohlen')}</span>}
                  {o.unsupported && <span className="text-[10px] text-gray-500">{t('crm.werbung.builder.form.nichtImAssistenten', 'Im Assistenten nicht verfügbar')}</span>}
                </button>
              )
            })}
          </div>
        )}
        <FeldHinweise node={node} felder={['campaign.objective', 'campaign.buying_type']} />
      </Abschnitt>

      <Abschnitt titel={feldLabel(t, 'campaign.special_ad_categories', 'Spezielle Anzeigenkategorien')}>
        {wohnenGesperrt && <SperrBanner>{t('crm.werbung.meta.housing.banner', 'Sonderkategorie Wohnen: Meta erlaubt nur breite Zielgruppen. Alter, Geschlecht, PLZ, Ortsausschlüsse und Lookalikes sind gesperrt.')}</SperrBanner>}
        <div id={feldId('campaign.special_ad_categories')} className="space-y-1.5">
          {SAC_OPTIONS.filter(o => o.value !== 'NONE').map(o => {
            const an = (c.special_ad_categories ?? []).indexOf(o.value) >= 0
            const fest = o.value === 'HOUSING' && wohnenGesperrt
            return (
              <Schalter key={o.value} checked={an} onChange={v => toggleKategorie(o.value, v)}
                disabled={gesperrt || bestehend || fest || !!o.unsupported}
                label={`${t(o.labelKey, o.value)}${fest ? ' 🔒' : ''}`}
                hilfe={fest ? t('crm.werbung.meta.housing.category', 'Jede Immobilienkampagne läuft in der Sonderkategorie Wohnen.') : o.unsupported ? t('crm.werbung.builder.form.nichtImAssistenten', 'Im Assistenten nicht verfügbar') : undefined} />
            )
          })}
        </div>
        <FeldHinweise node={node} felder="campaign.special_ad_categories" />
        {(c.special_ad_categories ?? []).some(x => x !== 'NONE') && (
          <FeldRahmen node={node} feld="campaign.special_ad_category_country"
            label={feldLabel(t, 'campaign.special_ad_category_country', 'Land der Sonderkategorie')}
            hilfe={t('crm.werbung.builder.kampagne.laenderHilfe', 'ISO-Ländercodes, durch Komma getrennt (Standard DE).')}>
            <input value={laender} disabled={gesperrt || bestehend} onChange={ev => setLaender(ev.target.value)} onBlur={laenderUebernehmen}
              className={INPUT_CLS} placeholder="DE" />
          </FeldRahmen>
        )}
      </Abschnitt>

      {!bestehend && (
        <Abschnitt titel={t('crm.werbung.builder.kampagne.budget', 'Budget')}
          hilfe={t('crm.werbung.meta.help.campaign_budget_level', 'An: Meta verteilt ein Kampagnenbudget selbst auf die Anzeigengruppen. Aus: jede Anzeigengruppe hat ihr eigenes Budget, wie bei Plan B.')}>
          <Schalter checked={cbo} onChange={setzeCbo} disabled={gesperrt}
            label={feldLabel(t, 'campaign.budget_level', 'Advantage+ Kampagnenbudget')} />
          <FeldHinweise node={node} felder="campaign.budget_level" />
          {cbo ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="sm:col-span-2 flex flex-wrap gap-3 text-xs" role="radiogroup" aria-label={t('crm.werbung.builder.form.budgetArt', 'Budgetart')}>
                {(['daily', 'lifetime'] as const).map(art => (
                  <label key={art} className="flex items-center gap-1.5">
                    <input type="radio" name="kampagne-budgetart" checked={budgetArt === art} disabled={gesperrt}
                      onChange={() => setC(art === 'daily'
                        ? { daily_budget_cents: c.lifetime_budget_cents ?? c.daily_budget_cents, lifetime_budget_cents: undefined }
                        : { lifetime_budget_cents: c.daily_budget_cents ?? c.lifetime_budget_cents, daily_budget_cents: undefined })} />
                    {art === 'daily' ? t('crm.werbung.builder.form.tagesbudget', 'Tagesbudget') : t('crm.werbung.builder.form.laufzeitbudget', 'Laufzeitbudget')}
                  </label>
                ))}
              </div>
              {budgetArt === 'daily' ? (
                <GeldFeld node={node} feld="campaign.daily_budget_cents" label={feldLabel(t, 'campaign.daily_budget_cents', 'Tagesbudget der Kampagne')}
                  cents={c.daily_budget_cents} onChange={v => setC({ daily_budget_cents: v })} kurs={kurs} disabled={gesperrt} />
              ) : (
                <GeldFeld node={node} feld="campaign.lifetime_budget_cents" label={feldLabel(t, 'campaign.lifetime_budget_cents', 'Laufzeitbudget der Kampagne')}
                  cents={c.lifetime_budget_cents} onChange={v => setC({ lifetime_budget_cents: v })} kurs={kurs} disabled={gesperrt} />
              )}
              <AuswahlFeld<BidStrategy> node={node} feld="campaign.bid_strategy" label={feldLabel(t, 'campaign.bid_strategy', 'Gebotsstrategie der Kampagne')}
                value={c.bid_strategy ?? 'LOWEST_COST_WITHOUT_CAP'} optionen={BID_OPTIONS}
                onChange={v => setC({ bid_strategy: v ?? 'LOWEST_COST_WITHOUT_CAP' })} disabled={gesperrt} />
            </div>
          ) : (
            <div className="space-y-2">
              <Schalter checked={c.is_adset_budget_sharing_enabled === true} disabled={gesperrt}
                onChange={v => setC({ is_adset_budget_sharing_enabled: v })}
                label={feldLabel(t, 'campaign.is_adset_budget_sharing_enabled', 'Budget mit anderen Anzeigengruppen teilen')}
                hilfe={t('crm.werbung.meta.help.campaign_budget_sharing', 'Erlaubt Meta, bis zu 20 % des Budgets zwischen Anzeigengruppen zu verschieben. Nur mit Tagesbudgets und gleicher Gebotsstrategie, später nur noch ausschaltbar.')} />
              <FeldHinweise node={node} felder="campaign.is_adset_budget_sharing_enabled" />
              {neueGruppen.length > 1 && (
                <Schalter checked={spec.hp?.budgets_synchron === true} disabled={gesperrt}
                  onChange={v => set(d => ({ ...d, hp: { ...(d.hp ?? {}), budgets_synchron: v } }))}
                  label={t('crm.werbung.builder.kampagne.synchron', 'Budgets der Anzeigengruppen synchron halten')}
                  hilfe={t('crm.werbung.builder.kampagne.synchronHilfe', 'Ändert sich das Budget einer Anzeigengruppe, bekommen alle neuen Anzeigengruppen denselben Betrag (wie bei Plan B Lang und Kurz).')} />
              )}
            </div>
          )}
        </Abschnitt>
      )}

      {!bestehend && (
        <Abschnitt titel={t('crm.werbung.builder.kampagne.limitUndZeit', 'Ausgabenlimit und Laufzeit')}>
          <div className="grid gap-3 sm:grid-cols-2">
            <GeldFeld node={node} feld="campaign.spend_cap_cents" label={feldLabel(t, 'campaign.spend_cap_cents', 'Ausgabenlimit der Kampagne')}
              hilfe={t('crm.werbung.builder.kampagne.limitHilfe', 'Optional. Meta stoppt die Kampagne, wenn insgesamt so viel ausgegeben ist (mindestens 100 $).')}
              cents={c.spend_cap_cents} onChange={v => setC({ spend_cap_cents: v })} kurs={kurs} disabled={gesperrt} />
            <div className="hidden sm:block" />
            <ZeitFeld node={node} feld="campaign.start_time" label={feldLabel(t, 'campaign.start_time', 'Startdatum')}
              value={c.start_time} onChange={v => setC({ start_time: v })} disabled={gesperrt} />
            <ZeitFeld node={node} feld="campaign.stop_time" label={feldLabel(t, 'campaign.stop_time', 'Enddatum')}
              value={c.stop_time} onChange={v => setC({ stop_time: v })} disabled={gesperrt} />
          </div>
        </Abschnitt>
      )}
    </div>
  )
}
