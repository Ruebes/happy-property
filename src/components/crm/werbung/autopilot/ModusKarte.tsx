import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../../../lib/supabase'
import { WERBE_AUTOPILOT_MODI, type WerbeAutopilotEinstellungen, type WerbeAutopilotModus, type WerbeStoppAntwort } from '../../../../lib/werbungTypes'
import Badge from '../../../ui/Badge'
import { useConfirm } from '../../../ui/ConfirmDialog'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { EINSTELLUNG_FELDER } from './abfragen'
import GrundDialog from './GrundDialog'
import StufenWahl, { type Stufe } from './StufenWahl'
import type { WerbeRechte } from './useWerbeRechte'
import { dbFehlerText, modusLabel, modusStufe, modusText, zeitKurz } from './werbeTexte'

// ── Betriebsart des Autopiloten + roter Stopp-Knopf ──────────────────────────
// Hochstellen nur Admin, Senken jeder mit Recht werbung, Stoppen auch mit
// werbung_meta (Datenbank prüft: werbe_settings_guard, werbe_autopilot_stopp).
// „Aus“ läuft immer über die Stopp-Funktion: die storniert zusätzlich alle
// offenen Autopilot-Aktionen und schreibt den Grund ins Log.

const GEFAHR: ReadonlySet<WerbeAutopilotModus> = new Set<WerbeAutopilotModus>(['aus'])

export default function ModusKarte({ einstellungen, rechte, onGeaendert }: {
  einstellungen: WerbeAutopilotEinstellungen
  rechte: WerbeRechte
  onGeaendert: (neu: WerbeAutopilotEinstellungen) => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)
  const [stoppOffen, setStoppOffen] = useState(false)

  const modus = einstellungen.autopilot_mode
  const stufeJetzt = modusStufe(modus)
  const pausiertBis = einstellungen.autopilot_paused_until && new Date(einstellungen.autopilot_paused_until).getTime() > Date.now()
    ? einstellungen.autopilot_paused_until : null

  const stufen: Stufe<WerbeAutopilotModus>[] = WERBE_AUTOPILOT_MODI.map(m => {
    const hoch = modusStufe(m) > stufeJetzt
    let sperre: string | null = null
    if (m === 'aus') {
      if (!rechte.darfStoppen) sperre = t('crm.werbung.autopilot.modusSperre.keinRecht', 'Dafür fehlt dir das Recht Werbemanager.')
    } else if (hoch && !rechte.istAdmin) {
      sperre = t('crm.werbung.autopilot.modusSperre.nurAdmin', 'Hochstellen darf nur ein Admin.')
    } else if (!hoch && !rechte.darfEntscheiden) {
      sperre = t('crm.werbung.autopilot.modusSperre.keinRecht', 'Dafür fehlt dir das Recht Werbemanager.')
    }
    return { wert: m, label: modusLabel(t, m), sperre }
  })

  const wechseln = async (neu: WerbeAutopilotModus) => {
    if (neu === 'aus') { setStoppOffen(true); return }
    const hoch = modusStufe(neu) > stufeJetzt
    const ok = await confirm({
      title: t('crm.werbung.autopilot.modusFrage', 'Autopilot auf „{{modus}}“ stellen?', { modus: modusLabel(t, neu) }),
      message: modusText(t, neu),
      confirmLabel: hoch
        ? t('crm.werbung.autopilot.modusHoch', 'Hochstellen')
        : t('crm.werbung.autopilot.modusRunter', 'Zurückstellen'),
      tone: neu === 'autonom' ? 'danger' : 'default',
    })
    if (!ok) return
    setBusy(true)
    try {
      const patch: Record<string, unknown> = { autopilot_mode: neu, updated_at: new Date().toISOString() }
      // Wer aus dem Stopp wieder einschaltet, räumt den alten Grund weg
      if (modus === 'aus') patch.autopilot_stop_grund = null
      const { data, error } = await supabase.from('ad_settings').update(patch).eq('id', 'default')
        .select(EINSTELLUNG_FELDER).single()
      if (error) throw error
      onGeaendert(data as unknown as WerbeAutopilotEinstellungen)
      toast.success(t('crm.werbung.autopilot.modusGespeichert', 'Autopilot steht jetzt auf „{{modus}}“', { modus: modusLabel(t, neu) }))
    } catch (err) {
      console.error('[Autopilot] Modus:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setBusy(false)
    }
  }

  const stoppen = async (grund: string) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('werbe_autopilot_stopp', { p_grund: grund })
      if (error) throw error
      const r = (data ?? {}) as WerbeStoppAntwort
      onGeaendert({ ...einstellungen, autopilot_mode: 'aus', autopilot_stop_grund: grund })
      toast.success(t('crm.werbung.autopilot.gestopptToast', 'Autopilot gestoppt. {{n}} offene Aktionen storniert.', { n: r.storniert ?? 0 }))
      setStoppOffen(false)
    } catch (err) {
      console.error('[Autopilot] Stopp:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setBusy(false)
    }
  }

  const fenster = (einstellungen.change_window_dows ?? []).map(d => {
    // ISO-Wochentag 1 = Montag; Name in der UI-Sprache über ein festes Datum (5.1.2026 = Montag)
    const tag = new Date(Date.UTC(2026, 0, 4 + Number(d)))
    return tag.toLocaleDateString(fmt.locale, { weekday: 'short', timeZone: 'UTC' })
  })

  return (
    <section className="hp-card p-4 sm:p-5 space-y-3" aria-labelledby="ap-modus-titel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="ap-modus-titel" className="font-heading text-lg text-hp-navy">{t('crm.werbung.autopilot.modusTitel', 'Betriebsart')}</h2>
          <p className="text-sm text-gray-600">{modusText(t, modus) || modusLabel(t, modus)}</p>
        </div>
        {modus !== 'aus' && rechte.darfStoppen && (
          <button type="button" className="hp-btn hp-btn-danger" disabled={busy} onClick={() => setStoppOffen(true)}>
            {t('crm.werbung.autopilot.stoppen', 'Autopilot stoppen')}
          </button>
        )}
      </div>

      <StufenWahl
        stufen={stufen}
        wert={stufeJetzt >= 0 ? modus as WerbeAutopilotModus : null}
        onWahl={m => void wechseln(m)}
        ariaLabel={t('crm.werbung.autopilot.modusTitel', 'Betriebsart')}
        busy={busy}
        gefahr={GEFAHR}
      />
      {stufeJetzt < 0 && <Badge>{modus || '-'}</Badge>}

      {modus === 'aus' && einstellungen.autopilot_stop_grund && (
        <p className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-800">
          {t('crm.werbung.autopilot.gestopptGrund', 'Gestoppt: {{grund}}', { grund: einstellungen.autopilot_stop_grund })}
        </p>
      )}
      {pausiertBis && (
        <p className="rounded-xl border border-amber-100 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {t('crm.werbung.autopilot.pausiertBis', 'Pausiert bis {{zeit}}. Freigaben sind bis dahin gesperrt.', { zeit: zeitKurz(pausiertBis, fmt.locale) })}
        </p>
      )}
      <p className="text-xs text-gray-500">
        {fenster.length
          ? t('crm.werbung.autopilot.fensterHinweis', 'Budget und Aktivieren nur im Änderungsfenster: {{tage}} (Europe/Berlin). Pausieren geht jeden Tag.', { tage: fenster.join(', ') })
          : t('crm.werbung.autopilot.keinFenster', 'Kein Änderungsfenster eingestellt: Budget und Aktivieren laufen nicht automatisch.')}
        {!rechte.istAdmin && ` ${t('crm.werbung.autopilot.nurAdminHoch', 'Hochstellen darf nur ein Admin, Zurückstellen und Stoppen jeder im Werbemanager.')}`}
      </p>

      <GrundDialog
        open={stoppOffen}
        title={t('crm.werbung.autopilot.stoppTitel', 'Autopilot stoppen?')}
        text={t('crm.werbung.autopilot.stoppText', 'Der Autopilot geht auf „Aus“, offene Vorschläge und wartende Aktionen werden storniert. Wieder einschalten kann nur ein Admin.')}
        label={t('crm.werbung.autopilot.stoppGrund', 'Grund')}
        placeholder={t('crm.werbung.autopilot.stoppPlatzhalter', 'z.B. Zahlen sehen falsch aus')}
        confirmLabel={t('crm.werbung.autopilot.stoppen', 'Autopilot stoppen')}
        tone="danger"
        pflicht
        busy={busy}
        onCancel={() => setStoppOffen(false)}
        onConfirm={grund => void stoppen(grund)}
      />
    </section>
  )
}
