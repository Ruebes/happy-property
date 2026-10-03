import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../../../lib/supabase'
import type { WerbeAutopilotEinstellungen, WerbeVorratFreigabeStufe } from '../../../../lib/werbungTypes'
import Badge from '../../../ui/Badge'
import { useConfirm } from '../../../ui/ConfirmDialog'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { EINSTELLUNG_FELDER } from './abfragen'
import StufenWahl, { type Stufe } from './StufenWahl'
import type { WerbeRechte } from './useWerbeRechte'
import { datumKurz, dbFehlerText, zahl } from './werbeTexte'

// ── Leitplanken, Schalter und Vorrats-Automatik ─────────────────────────────
// Leitplanken bearbeitet nur ein Admin (Hochstellen prüft zusätzlich der
// Trigger werbe_settings_guard). Assistent (builder_enabled) und Echtzeit-CAPI
// (capi_echtzeit) sind hier nur sichtbar: die schaltet Sven frei.
// Vorrats-Automatik: Admin stellt hoch, jeder im Werbemanager darf senken.

type Form = { budget: string; monat: string; ziel: string; aktionen: string }

const zuText = (v: number | null | undefined) => (v == null ? '' : String(v))
const formAus = (e: WerbeAutopilotEinstellungen): Form => ({
  budget: zuText(zahl(e.max_account_daily_budget)),
  monat: zuText(zahl(e.monthly_cap_eur)),
  ziel: zuText(zahl(e.target_cpte_eur)),
  aktionen: zuText(zahl(e.max_auto_actions_per_day)),
})
const parse = (v: string): number | null => {
  const n = parseFloat(v.replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export default function LeitplankenKarte({ einstellungen, rechte, onGeaendert }: {
  einstellungen: WerbeAutopilotEinstellungen
  rechte: WerbeRechte
  onGeaendert: (neu: WerbeAutopilotEinstellungen) => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const confirm = useConfirm()
  const [bearbeiten, setBearbeiten] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Form>(() => formAus(einstellungen))
  useEffect(() => { if (!bearbeiten) setForm(formAus(einstellungen)) }, [einstellungen, bearbeiten])

  const speichern = async () => {
    const budget = parse(form.budget)
    const monat = parse(form.monat)
    const ziel = parse(form.ziel)
    const aktionen = parse(form.aktionen)
    if (budget == null || budget <= 0 || monat == null || monat <= 0 || ziel == null || ziel <= 0
        || aktionen == null || aktionen < 0 || aktionen > 50 || !Number.isInteger(aktionen)) {
      toast.error(t('crm.werbung.autopilot.leitplanken.ungueltig', 'Bitte gültige Werte eingeben (Beträge über 0, Aktionen 0 bis 50).'))
      return
    }
    setBusy(true)
    try {
      const { data, error } = await supabase.from('ad_settings').update({
        max_account_daily_budget: budget,
        monthly_cap_eur: monat,
        target_cpte_eur: ziel,
        max_auto_actions_per_day: aktionen,
        updated_at: new Date().toISOString(),
      }).eq('id', 'default').select(EINSTELLUNG_FELDER).single()
      if (error) throw error
      onGeaendert(data as unknown as WerbeAutopilotEinstellungen)
      setBearbeiten(false)
      toast.success(t('crm.werbung.autopilot.leitplanken.gespeichert', 'Leitplanken gespeichert'))
    } catch (err) {
      console.error('[Autopilot] Leitplanken:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setBusy(false)
    }
  }

  // ── Vorrats-Automatik ─────────────────────────────────────────────────────
  const poolStufe = (zahl(einstellungen.pool_auto_release_level) ?? 0) as WerbeVorratFreigabeStufe
  const schwelle = zahl(einstellungen.pool_auto_release_threshold) ?? 0.9
  const poolText = (s: number) => {
    switch (s) {
      case 0: return t('crm.werbung.autopilot.vorrat.text0', 'Jedes neue Werbemittel gibt ein Mensch frei (Sven oder Giona).')
      case 1: return t('crm.werbung.autopilot.vorrat.text1', 'Wie 0, zusätzlich steht an jedem Entwurf die Prognose, ob Sven ihn freigeben würde.')
      case 2: return t('crm.werbung.autopilot.vorrat.text2', 'Gibt automatisch frei, wenn die Prognose mindestens {{schwelle}} ist, es schon 30 menschliche Entscheidungen gibt und die Prognose zu mindestens 90 % richtig lag.', { schwelle: fmt.pct(schwelle) })
      case 3: return t('crm.werbung.autopilot.vorrat.text3', 'Gibt alles automatisch frei, was die Prüfung besteht.')
      default: return ''
    }
  }
  const poolStufen: Stufe<WerbeVorratFreigabeStufe>[] = ([0, 1, 2, 3] as const).map(s => ({
    wert: s,
    label: String(s),
    sperre: s > poolStufe && !rechte.istAdmin
      ? t('crm.werbung.autopilot.modusSperre.nurAdmin', 'Hochstellen darf nur ein Admin.')
      : s < poolStufe && !rechte.darfEntscheiden
        ? t('crm.werbung.autopilot.modusSperre.keinRecht', 'Dafür fehlt dir das Recht Werbemanager.')
        : null,
  }))
  const poolWechseln = async (s: WerbeVorratFreigabeStufe) => {
    const ok = await confirm({
      title: t('crm.werbung.autopilot.vorrat.frage', 'Vorrats-Freigabe auf Stufe {{n}} stellen?', { n: s }),
      message: poolText(s),
      tone: s >= 2 ? 'danger' : 'default',
    })
    if (!ok) return
    setBusy(true)
    try {
      const { data, error } = await supabase.from('ad_settings')
        .update({ pool_auto_release_level: s, updated_at: new Date().toISOString() })
        .eq('id', 'default').select(EINSTELLUNG_FELDER).single()
      if (error) throw error
      onGeaendert(data as unknown as WerbeAutopilotEinstellungen)
      toast.success(t('crm.werbung.autopilot.vorrat.gespeichert', 'Vorrats-Freigabe steht auf Stufe {{n}}', { n: s }))
    } catch (err) {
      console.error('[Autopilot] Vorrats-Freigabe:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setBusy(false)
    }
  }

  const feld = (key: keyof Form, label: string, einheit: string, hinweis?: string) => (
    <label className="block">
      <span className="text-xs font-medium text-gray-600">{label}</span>
      <div className="mt-1 flex items-center gap-2">
        <input
          className="hp-input"
          inputMode="decimal"
          value={form[key]}
          disabled={!bearbeiten || busy}
          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
        />
        <span className="shrink-0 text-xs text-gray-500">{einheit}</span>
      </div>
      {hinweis && <span className="mt-0.5 block text-[11px] text-gray-500">{hinweis}</span>}
    </label>
  )

  const schalter = (an: boolean | null, label: string) => (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-100 px-3 py-2">
      <span className="text-sm text-gray-700">{label}</span>
      <span className="flex items-center gap-2">
        <Badge tone={an ? 'success' : 'neutral'} dot>{an ? t('crm.werbung.autopilot.an', 'An') : t('crm.werbung.autopilot.aus', 'Aus')}</Badge>
        <span className="text-[11px] text-gray-500">{t('crm.werbung.autopilot.schaltetSven', 'schaltet Sven frei')}</span>
      </span>
    </div>
  )

  const budgetFrei = einstellungen.budget_autonomie_freigegeben_at

  return (
    <section className="hp-card p-4 sm:p-5 space-y-4" aria-labelledby="ap-leitplanken-titel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="ap-leitplanken-titel" className="font-heading text-lg text-hp-navy">{t('crm.werbung.autopilot.leitplanken.titel', 'Leitplanken')}</h2>
        {rechte.istAdmin && (bearbeiten ? (
          <div className="flex gap-2">
            <button type="button" className="hp-btn hp-btn-ghost" disabled={busy} onClick={() => setBearbeiten(false)}>
              {t('crm.werbung.autopilot.abbrechen', 'Abbrechen')}
            </button>
            <button type="button" className="hp-btn hp-btn-primary" disabled={busy} onClick={() => void speichern()}>
              {t('crm.werbung.autopilot.speichern', 'Speichern')}
            </button>
          </div>
        ) : (
          <button type="button" className="hp-btn hp-btn-ghost" onClick={() => setBearbeiten(true)}>
            {t('crm.werbung.autopilot.bearbeiten', 'Bearbeiten')}
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {feld('budget', t('crm.werbung.autopilot.leitplanken.budget', 'Tagesbudget gesamt höchstens'), t('crm.werbung.autopilot.leitplanken.eurTag', '€/Tag'),
          t('crm.werbung.autopilot.leitplanken.budgetHinweis', 'Summe aller aktiven Tagesbudgets'))}
        {feld('monat', t('crm.werbung.autopilot.leitplanken.monat', 'Monatsdeckel'), t('crm.werbung.autopilot.leitplanken.eurMonat', '€/Monat'),
          t('crm.werbung.autopilot.leitplanken.monatHinweis', 'Ausgaben bisher plus Prognose bis Monatsende'))}
        {feld('ziel', t('crm.werbung.autopilot.leitplanken.ziel', 'Ziel-Kosten pro TE'), '€',
          t('crm.werbung.autopilot.leitplanken.zielHinweis', 'Grundlage für Kill- und Budget-Regeln'))}
        {feld('aktionen', t('crm.werbung.autopilot.leitplanken.aktionen', 'Automatische Aktionen je Tag'), t('crm.werbung.autopilot.leitplanken.stueck', 'höchstens'))}
      </div>
      {!rechte.istAdmin && (
        <p className="text-xs text-gray-500">{t('crm.werbung.autopilot.leitplanken.nurAdmin', 'Leitplanken ändert nur ein Admin.')}</p>
      )}

      <div className="grid gap-2 sm:grid-cols-2">
        {schalter(einstellungen.builder_enabled, t('crm.werbung.autopilot.builder', 'Kampagnen-Assistent darf bei Meta anlegen'))}
        {schalter(einstellungen.capi_echtzeit, t('crm.werbung.autopilot.capi', 'Signale an Meta in Echtzeit (CAPI)'))}
      </div>
      <p className="text-xs text-gray-600">
        {budgetFrei
          ? t('crm.werbung.autopilot.budgetAutonomieAn', 'Budget-Regeln dürfen auf Stufe 3 (autonom) laufen, freigegeben am {{datum}}.', { datum: datumKurz(budgetFrei, fmt.locale) })
          : t('crm.werbung.autopilot.budgetAutonomieAus', 'Budget-Regeln bleiben höchstens auf Stufe 2 (Ein-Klick), bis Sven die Budget-Autonomie freigibt.')}
      </p>

      <div className="space-y-2 border-t border-gray-100 pt-4">
        <h3 className="text-sm font-semibold text-hp-navy">{t('crm.werbung.autopilot.vorrat.titel', 'Neue Werbemittel automatisch freigeben')}</h3>
        <StufenWahl
          stufen={poolStufen}
          wert={poolStufe}
          onWahl={s => void poolWechseln(s)}
          ariaLabel={t('crm.werbung.autopilot.vorrat.titel', 'Neue Werbemittel automatisch freigeben')}
          busy={busy}
        />
        <p className="text-sm text-gray-600">{t('crm.werbung.autopilot.vorrat.stufe', 'Stufe {{n}}:', { n: poolStufe })} {poolText(poolStufe)}</p>
        <p className="text-xs text-gray-500">{t('crm.werbung.autopilot.vorrat.fakten', 'Werbemittel mit Fakten, Preisen oder Fotos gibt immer ein Mensch frei, auf jeder Stufe.')}</p>
      </div>
    </section>
  )
}
