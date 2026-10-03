import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail } from '../../../../lib/fnError'
import type { WerbeAktion, WerbeAusfuehrAntwort, WerbeEntscheidAntwort, WerbeRegel } from '../../../../lib/werbungTypes'
import Badge from '../../../ui/Badge'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import { EvidenzLeiste, VorherNachher } from './Evidenz'
import GrundDialog from './GrundDialog'
import type { WerbeRechte } from './useWerbeRechte'
import { aktionLabel, dbFehlerText, ebeneLabel, freigabeLabel, freigabeTon, statusLabel, stufeLabel, zahl, zeitKurz } from './werbeTexte'

// ── Eine Vorschlagsgruppe (gleiche gruppe_id) mit Begründung und Knöpfen ────
// Freigeben: RPC werbe_vorschlag_entscheiden (setzt die ganze Gruppe auf
// bestätigt), danach werbe-ausfuehren {modus:'freigabe', gruppe_id}. Der
// Ausführer prüft Leitplanken und Änderungsfenster selbst; was heute nicht
// laufen darf, bleibt bestätigt und läuft im nächsten Fenster.
// Ablehnen: dieselbe RPC mit 'verwerfen' und optionalem Grund.
// Gemeinsam für den Reiter Autopilot und die Freigabe-Seite (Morgenmail-Link).

export interface VorschlagKarteProps {
  gruppe: WerbeAktion[]
  regeln: ReadonlyMap<string, WerbeRegel>
  rechte: WerbeRechte
  /** Autopilot aus oder pausiert: Freigeben gesperrt (Ablehnen geht) */
  gesperrt: boolean
  onEntschieden: () => void
  /** Link auf die Einzelseite /admin/crm/werbung/freigabe/:gruppeId zeigen */
  mitLink?: boolean
}

const istOffen = (a: WerbeAktion) => a.status == null && a.freigabe === 'vorgeschlagen'

export default function VorschlagKarte({ gruppe, regeln, rechte, gesperrt, onEntschieden, mitLink = false }: VorschlagKarteProps) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const [busy, setBusy] = useState<'ja' | 'nein' | null>(null)
  const [ablehnenOffen, setAblehnenOffen] = useState(false)

  const erste = gruppe[0]
  if (!erste) return null
  const gruppeId = erste.gruppe_id
  const regel = erste.rule_key ? regeln.get(erste.rule_key) : undefined
  const offen = gruppe.some(istOffen)
  const ablauf = gruppe.map(a => a.expires_at).filter((x): x is string => !!x).sort()[0] ?? null
  const abgelaufen = !!ablauf && new Date(ablauf).getTime() < Date.now()
  const nurAdmin = gruppe.some(a => a.rule_key && regeln.get(a.rule_key)?.freigabe_rolle === 'admin')
  const stufe = zahl(erste.approval_level)
  const fx = zahl(erste.evidence?.fx)

  const sperrGrund = !rechte.darfEntscheiden
    ? t('crm.werbung.autopilot.vorschlag.keinRecht', 'Freigeben dürfen Admins und Mitarbeiter mit dem Recht Werbemanager.')
    : !gruppeId
      ? t('crm.werbung.autopilot.vorschlag.ohneGruppe', 'Dieser Vorschlag hat keine Gruppe und kann hier nicht entschieden werden.')
      : null
  const freigabeSperre = sperrGrund
    ?? (gesperrt ? t('crm.werbung.autopilot.vorschlag.gesperrt', 'Der Autopilot ist gestoppt, Freigaben sind gesperrt.') : null)
    ?? (abgelaufen ? t('crm.werbung.autopilot.vorschlag.abgelaufen', 'Abgelaufen. Der nächste Lauf rechnet neu.') : null)
    ?? (nurAdmin && !rechte.istAdmin ? t('crm.werbung.autopilot.vorschlag.nurAdmin', 'Diese Regel darf nur ein Admin freigeben.') : null)

  const entscheiden = async (ja: boolean, grund: string | null) => {
    if (!gruppeId || busy) return
    setBusy(ja ? 'ja' : 'nein')
    try {
      const { data, error } = await supabase.rpc('werbe_vorschlag_entscheiden', {
        p_gruppe: gruppeId,
        p_entscheidung: ja ? 'freigeben' : 'verwerfen',
        p_grund: grund || null,
      })
      if (error) throw error
      const res = (data ?? { success: false }) as WerbeEntscheidAntwort
      if (!res.success) {
        toast.info(res.grund === 'abgelaufen'
          ? t('crm.werbung.autopilot.vorschlag.toastAbgelaufen', 'Der Vorschlag war abgelaufen und ist jetzt geschlossen.')
          : t('crm.werbung.autopilot.vorschlag.toastSchonEntschieden', 'Dieser Vorschlag ist schon entschieden.'))
        return
      }
      if (!ja) {
        toast.success(t('crm.werbung.autopilot.vorschlag.toastAbgelehnt', 'Vorschlag abgelehnt'))
        return
      }
      // Ausführen (Leitplanken, Fenster und Rücklesen macht der Ausführer)
      const { data: aus, error: e2 } = await supabase.functions.invoke('werbe-ausfuehren', {
        body: { modus: 'freigabe', gruppe_id: gruppeId },
      })
      if (e2) {
        const d = await fnErrorDetail(e2)
        toast.error(t('crm.werbung.autopilot.vorschlag.toastAusfuehrFehler', 'Freigegeben, die Ausführung ist aber nicht gestartet: {{msg}}. Sie läuft im nächsten Änderungsfenster.', { msg: d.message }))
        return
      }
      const r = (aus ?? {}) as WerbeAusfuehrAntwort
      const n = zahl(r.ausgefuehrt) ?? 0
      const f = zahl(r.fehlgeschlagen) ?? 0
      const uebersprungen = Array.isArray(r.uebersprungen) ? r.uebersprungen : []
      if (r.error) toast.error(t('crm.werbung.autopilot.vorschlag.toastAusfuehrFehler', 'Freigegeben, die Ausführung ist aber nicht gestartet: {{msg}}. Sie läuft im nächsten Änderungsfenster.', { msg: r.error }))
      else if (r.gestoppt) toast.error(t('crm.werbung.autopilot.vorschlag.toastGestoppt', 'Freigegeben, aber der Autopilot hat gestoppt: {{grund}}', { grund: r.gestoppt }))
      else if (f > 0) toast.error(t('crm.werbung.autopilot.vorschlag.toastFehlgeschlagen', 'Freigegeben. {{n}} ausgeführt, {{f}} fehlgeschlagen (siehe Verlauf).', { n, f }))
      else if (n > 0) toast.success(t('crm.werbung.autopilot.vorschlag.toastAusgefuehrt', 'Freigegeben und bei Meta ausgeführt ({{n}})', { n }))
      else if (uebersprungen.length) toast.info(t('crm.werbung.autopilot.vorschlag.toastWartet', 'Freigegeben. Noch nicht ausgeführt: {{grund}}', { grund: uebersprungen[0].grund }))
      else toast.success(t('crm.werbung.autopilot.vorschlag.toastFreigegeben', 'Freigegeben'))
    } catch (err) {
      console.error('[Autopilot] entscheiden:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setBusy(null)
      setAblehnenOffen(false)
      onEntschieden()
    }
  }

  const name = (a: WerbeAktion) => {
    const p = a.payload ?? {}
    const pn = typeof p.entity_name === 'string' ? p.entity_name : null
    return a.ad_name || pn || a.entity_id || a.ad_id || '-'
  }

  return (
    <article className="hp-card p-4 space-y-3">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            {erste.rule_key && <Badge tone="info">{erste.rule_key}</Badge>}
            <Badge>{aktionLabel(t, erste.action)}</Badge>
            {stufe != null && <Badge>{t('crm.werbung.autopilot.vorschlag.stufe', 'Stufe {{n}}: {{name}}', { n: stufe, name: stufeLabel(t, stufe) })}</Badge>}
            {!offen && <Badge tone={freigabeTon(erste.freigabe)}>{freigabeLabel(t, erste.freigabe)}</Badge>}
          </div>
          <h3 className="mt-1.5 font-heading text-base text-hp-navy">{regel?.titel ?? erste.reason ?? aktionLabel(t, erste.action)}</h3>
        </div>
        <div className="text-right text-xs text-gray-500 tabular-nums">
          <p>{t('crm.werbung.autopilot.vorschlag.erstellt', 'Erstellt {{zeit}}', { zeit: zeitKurz(erste.created_at, fmt.locale) })}</p>
          {ablauf && (
            <p className={abgelaufen ? 'font-semibold text-amber-700' : undefined}>
              {abgelaufen
                ? t('crm.werbung.autopilot.vorschlag.istAbgelaufen', 'Abgelaufen {{zeit}}', { zeit: zeitKurz(ablauf, fmt.locale) })
                : t('crm.werbung.autopilot.vorschlag.giltBis', 'Gilt bis {{zeit}}', { zeit: zeitKurz(ablauf, fmt.locale) })}
            </p>
          )}
        </div>
      </header>

      <ul className="divide-y divide-gray-100 rounded-xl border border-gray-100">
        {gruppe.map(a => (
          <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-3 py-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-gray-800" title={a.entity_id ?? undefined}>
                <span className="text-gray-500">{ebeneLabel(t, a.entity_level)}: </span>{name(a)}
              </p>
              {a.campaign_name && <p className="truncate text-xs text-gray-500">{a.campaign_name}</p>}
              {!offen && a.status && (
                <p className="text-xs text-gray-500">{statusLabel(t, a.status)}{a.result ? `: ${a.result}` : ''}</p>
              )}
            </div>
            <VorherNachher before={a.before} after={a.after} fx={fx} />
          </li>
        ))}
      </ul>

      {erste.reason && regel?.titel && <p className="text-sm text-gray-700">{erste.reason}</p>}
      <EvidenzLeiste evidence={erste.evidence} />

      {offen && (
        <footer className="flex flex-wrap items-center gap-2 border-t border-gray-100 pt-3">
          {!sperrGrund && (
            <>
              <button
                type="button"
                className="hp-btn hp-btn-primary"
                disabled={!!freigabeSperre || busy !== null}
                title={freigabeSperre ?? undefined}
                onClick={() => void entscheiden(true, null)}
              >
                {busy === 'ja' ? t('crm.werbung.autopilot.vorschlag.laeuft', 'Läuft …') : t('crm.werbung.autopilot.vorschlag.freigeben', 'Freigeben')}
              </button>
              <button
                type="button"
                className="hp-btn hp-btn-ghost"
                disabled={busy !== null}
                onClick={() => setAblehnenOffen(true)}
              >
                {t('crm.werbung.autopilot.vorschlag.ablehnen', 'Ablehnen')}
              </button>
            </>
          )}
          {(sperrGrund ?? freigabeSperre) && <p className="text-xs text-gray-500">{sperrGrund ?? freigabeSperre}</p>}
          {mitLink && gruppeId && (
            <Link to={`/admin/crm/werbung/freigabe/${gruppeId}`} className="ml-auto text-xs font-medium text-hp-navy underline-offset-2 hover:underline">
              {t('crm.werbung.autopilot.vorschlag.einzelseite', 'Einzeln öffnen')}
            </Link>
          )}
        </footer>
      )}

      <GrundDialog
        open={ablehnenOffen}
        title={t('crm.werbung.autopilot.vorschlag.ablehnenTitel', 'Vorschlag ablehnen')}
        text={t('crm.werbung.autopilot.vorschlag.ablehnenText', 'Der Grund hilft, die Regel besser einzustellen.')}
        label={t('crm.werbung.autopilot.vorschlag.grund', 'Grund (freiwillig)')}
        confirmLabel={t('crm.werbung.autopilot.vorschlag.ablehnen', 'Ablehnen')}
        busy={busy !== null}
        onCancel={() => setAblehnenOffen(false)}
        onConfirm={grund => void entscheiden(false, grund || null)}
      />
    </article>
  )
}
