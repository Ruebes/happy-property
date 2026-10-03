import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../../../lib/supabase'
import type { WerbeRegel } from '../../../../lib/werbungTypes'
import Badge from '../../../ui/Badge'
import { useConfirm } from '../../../ui/ConfirmDialog'
import DataTable, { type DataTableColumn } from '../../../ui/DataTable'
import EmptyState from '../../../ui/EmptyState'
import { useToast } from '../../../ui/Toast'
import { useWerbeFormat } from '../format'
import type { WerbeRechte } from './useWerbeRechte'
import { aktionLabel, datumKurz, dbFehlerText, stufeLabel, zahl } from './werbeTexte'

// ── Regeln mit Freigabestufe ────────────────────────────────────────────────
// Ändern darf nur ein Admin (RLS + werbe_rules_guard): ein/aus und die Stufe
// bis max_level. Budget-Regeln auf Stufe 3 erst nach Freigabe der
// Budget-Autonomie. Parameter nur lesend (Änderung per Migration).

const REGEL_FELDER = 'rule_key, titel, aktion, enabled, approval_level, max_level, freigabe_rolle, params, version, updated_by, updated_at'

export default function RegelnTabelle({ regeln, rechte, budgetAutonomie, onGeaendert }: {
  regeln: WerbeRegel[]
  rechte: WerbeRechte
  /** ad_settings.budget_autonomie_freigegeben_at gesetzt */
  budgetAutonomie: boolean
  onGeaendert: (r: WerbeRegel) => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const confirm = useConfirm()
  const [busy, setBusy] = useState<string | null>(null)

  const aendern = async (r: WerbeRegel, patch: Partial<Pick<WerbeRegel, 'enabled' | 'approval_level'>>) => {
    const neuStufe = patch.approval_level
    if (neuStufe != null && neuStufe > r.approval_level) {
      const ok = await confirm({
        title: t('crm.werbung.autopilot.regeln.hochFrage', '{{regel}} auf Stufe {{n}} stellen?', { regel: r.rule_key, n: neuStufe }),
        message: neuStufe === 3
          ? t('crm.werbung.autopilot.regeln.hochText3', 'Stufe 3 heißt: im Modus „Autonom“ führt der Autopilot diese Regel ohne Rückfrage aus, innerhalb der Leitplanken.')
          : t('crm.werbung.autopilot.regeln.hochText', 'Vorschläge dieser Regel brauchen dann: {{stufe}}.', { stufe: stufeLabel(t, neuStufe) }),
        tone: neuStufe === 3 ? 'danger' : 'default',
      })
      if (!ok) return
    }
    setBusy(r.rule_key)
    try {
      const { data, error } = await supabase.from('ad_autopilot_rules').update(patch).eq('rule_key', r.rule_key)
        .select(REGEL_FELDER).single()
      if (error) throw error
      onGeaendert(data as unknown as WerbeRegel)
      toast.success(t('crm.werbung.autopilot.regeln.gespeichert', 'Regel {{regel}} gespeichert', { regel: r.rule_key }))
    } catch (err) {
      console.error('[Autopilot] Regel:', err)
      toast.error(dbFehlerText(t, err))
    } finally {
      setBusy(null)
    }
  }

  const rolleText = (rolle: string) => rolle === 'admin'
    ? t('crm.werbung.autopilot.regeln.rolleAdmin', 'nur Admin')
    : rolle === 'werbung'
      ? t('crm.werbung.autopilot.regeln.rolleWerbung', 'Admin oder Werbemanager')
      : rolle

  const columns: DataTableColumn<WerbeRegel>[] = [
    {
      id: 'regel',
      header: t('crm.werbung.autopilot.regeln.regel', 'Regel'),
      primary: true,
      cell: r => (
        <span className="block min-w-[12rem]">
          <span className="font-semibold">{r.rule_key}</span>
          <span className="block text-xs font-normal text-gray-600">{r.titel}</span>
        </span>
      ),
    },
    { id: 'aktion', header: t('crm.werbung.autopilot.regeln.aktion', 'Aktion'), cell: r => aktionLabel(t, r.aktion) },
    {
      id: 'an',
      header: t('crm.werbung.autopilot.regeln.an', 'Aktiv'),
      cell: r => rechte.istAdmin ? (
        <label className="inline-flex min-h-[44px] items-center gap-2 sm:min-h-0">
          <input
            type="checkbox"
            className="h-4 w-4 accent-hp-navy"
            checked={r.enabled}
            disabled={busy !== null}
            onChange={e => void aendern(r, { enabled: e.target.checked })}
          />
          <span className="text-xs text-gray-600">{r.enabled ? t('crm.werbung.autopilot.an', 'An') : t('crm.werbung.autopilot.aus', 'Aus')}</span>
        </label>
      ) : (
        <Badge tone={r.enabled ? 'success' : 'neutral'} dot>{r.enabled ? t('crm.werbung.autopilot.an', 'An') : t('crm.werbung.autopilot.aus', 'Aus')}</Badge>
      ),
    },
    {
      id: 'stufe',
      header: t('crm.werbung.autopilot.regeln.stufe', 'Stufe'),
      cell: r => {
        const max = Math.max(0, Math.min(3, zahl(r.max_level) ?? 0))
        const jetzt = zahl(r.approval_level) ?? 0
        if (!rechte.istAdmin || max === 0) return <span className="whitespace-nowrap">{jetzt}: {stufeLabel(t, jetzt)}</span>
        return (
          <select
            className="hp-input min-w-[9rem] py-1"
            value={jetzt}
            disabled={busy !== null}
            aria-label={t('crm.werbung.autopilot.regeln.stufeVon', 'Stufe von {{regel}}', { regel: r.rule_key })}
            onChange={e => void aendern(r, { approval_level: Number(e.target.value) })}
          >
            {Array.from({ length: Math.max(max, jetzt) + 1 }, (_, s) => {
              const budgetSperre = r.aktion === 'budget_set' && s === 3 && !budgetAutonomie && jetzt < 3
              return (
                <option key={s} value={s} disabled={budgetSperre || s > max}>
                  {s}: {stufeLabel(t, s)}{budgetSperre ? ` (${t('crm.werbung.autopilot.regeln.budgetGesperrt', 'erst nach Budget-Freigabe')})` : ''}
                </option>
              )
            })}
          </select>
        )
      },
    },
    {
      id: 'max',
      header: t('crm.werbung.autopilot.regeln.max', 'Höchste Stufe'),
      hideBelow: 'lg',
      align: 'center',
      cell: r => zahl(r.max_level) ?? '-',
    },
    { id: 'rolle', header: t('crm.werbung.autopilot.regeln.freigabe', 'Freigabe durch'), hideBelow: 'md', cell: r => rolleText(r.freigabe_rolle) },
    {
      id: 'params',
      header: t('crm.werbung.autopilot.regeln.params', 'Parameter'),
      hideBelow: 'sm',
      cell: r => {
        const keys = Object.keys(r.params ?? {})
        if (!keys.length) return <span className="text-gray-400">-</span>
        return (
          <details className="max-w-[22rem]">
            <summary className="cursor-pointer text-xs text-hp-navy">
              {t('crm.werbung.autopilot.regeln.paramsAnzahl', '{{n}} Werte', { n: keys.length })}
            </summary>
            <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-gray-50 p-2 text-[11px] leading-snug text-gray-700">
              {JSON.stringify(r.params, null, 2)}
            </pre>
          </details>
        )
      },
    },
    {
      id: 'version',
      header: t('crm.werbung.autopilot.regeln.version', 'Stand'),
      hideBelow: 'lg',
      cell: r => <span className="whitespace-nowrap text-xs text-gray-500">v{r.version}, {datumKurz(r.updated_at, fmt.locale)}</span>,
    },
  ]

  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500">
        {t('crm.werbung.autopilot.regeln.erklaerung', 'Stufe 0 aus, 1 Vorschlag, 2 Ein-Klick, 3 autonom. Wirksam ist immer die kleinere Stufe aus Regel und Betriebsart.')}
        {!rechte.istAdmin && ` ${t('crm.werbung.autopilot.regeln.nurAdmin', 'Regeln ändert nur ein Admin.')}`}
      </p>
      <DataTable
        columns={columns}
        rows={regeln}
        rowKey={r => r.rule_key}
        empty={<EmptyState compact icon="rules" title={t('crm.werbung.autopilot.regeln.leer', 'Noch keine Regeln angelegt')} />}
      />
    </div>
  )
}
