import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { CustomSelect } from '../../../CustomSelect'
import Badge, { type BadgeTone } from '../../../ui/Badge'
import type { DraftIssue, DraftSpec } from '../../../../lib/metaSpec'
import type { LintIssue } from '../../../../lib/metaLint'
import { anzeigeAngelegt, gruppeAngelegt, paarPartner, useAssistent } from './useEntwurf'

// ── Struktur des Entwurfs: Kampagne > Anzeigengruppen > Anzeigen ─────────────
// Links im Assistenten (ab lg), auf dem Telefon als Auswahlliste. Punkt je
// Knoten: rot = Fehler oder Compliance-Blocker, gelb = Hinweis oder
// Bestätigung offen, grün = in Ordnung. Hinzufügen, Duplizieren, Entfernen
// (bestehende Meta-Objekte werden nie gelöscht, nur aus dem Entwurf genommen).
// Was schon bei Meta liegt (bestehend oder von diesem Entwurf angelegt), lässt
// sich nicht entfernen. Bearbeiten-Modus: kein Hinzufügen oder Entfernen
// (Neues über „Bestehende Kampagne übernehmen“), Duplizieren öffnet den
// Dialog für Meta; „geändert“ markiert Knoten mit Änderungen gegenüber Meta.

export type Ampel = 'rot' | 'gelb' | 'gruen'

export function ampelFuer(node: string, issues: readonly DraftIssue[], lint: readonly LintIssue[]): Ampel {
  const own = issues.filter(i => i.node === node)
  const l = lint.filter(x => (x.node ?? 'campaign') === node)
  if (own.some(i => i.severity === 'error') || l.some(x => x.severity === 'blocker')) return 'rot'
  if (own.length || l.length) return 'gelb'
  return 'gruen'
}

// Status eines Entwurfs (meta_drafts.status); unbekannte Werte neutral mit Rohwert
const STATUS: Record<string, { k: string; d: string; tone: BadgeTone }> = {
  draft: { k: 'crm.werbung.builder.status.draft', d: 'Entwurf', tone: 'neutral' },
  validated: { k: 'crm.werbung.builder.status.validated', d: 'Geprüft', tone: 'info' },
  creating: { k: 'crm.werbung.builder.status.creating', d: 'Wird angelegt', tone: 'warning' },
  partial: { k: 'crm.werbung.builder.status.partial', d: 'Teilweise angelegt', tone: 'warning' },
  created: { k: 'crm.werbung.builder.status.created', d: 'Angelegt (pausiert)', tone: 'success' },
  failed: { k: 'crm.werbung.builder.status.failed', d: 'Fehlgeschlagen', tone: 'danger' },
  discarded: { k: 'crm.werbung.builder.status.discarded', d: 'Verworfen', tone: 'neutral' },
}

export function StatusBadge({ status }: { status: string | null | undefined }) {
  const { t } = useTranslation()
  const s = STATUS[status ?? '']
  if (!s) return <Badge tone="neutral">{status || '-'}</Badge>
  return <Badge tone={s.tone} dot>{t(s.k, s.d)}</Badge>
}

const PUNKT: Record<Ampel, string> = { rot: 'bg-red-500', gelb: 'bg-amber-400', gruen: 'bg-emerald-500' }

export interface Knoten { node: string; ebene: 0 | 1 | 2; name: string; bestehend: boolean; adsetKey?: string }

/** Knoten in Baum-Reihenfolge (auch für „Weiter") */
export function knotenListe(spec: DraftSpec, t: TFunction): Knoten[] {
  const out: Knoten[] = [{ node: 'campaign', ebene: 0, name: spec.campaign.name || t('crm.werbung.meta.level.campaign', 'Kampagne'), bestehend: !!spec.campaign.existing_id }]
  for (const a of spec.adsets) {
    out.push({ node: a.key, ebene: 1, name: a.name || a.key, bestehend: !!a.existing_id })
    for (const ad of spec.ads.filter(x => x.adset_key === a.key)) {
      out.push({ node: ad.key, ebene: 2, name: ad.name || t('crm.werbung.builder.baum.ohneName', 'Ohne Namen'), bestehend: !!ad.existing_id, adsetKey: a.key })
    }
  }
  return out
}

interface Props {
  sel: string
  onSelect: (node: string) => void
  onNeueGruppe: () => void
  onNeueAnzeige: (adsetKey: string) => void
  onNeuesPaar: () => void
  onDuplizieren: (node: string) => void
  onEntfernen: (node: string) => void
  /** Bearbeiten: Knoten mit Änderungen gegenüber dem Stand bei Meta */
  geaendert?: ReadonlySet<string>
}

export default function EntwurfBaum({ sel, onSelect, onNeueGruppe, onNeueAnzeige, onNeuesPaar, onDuplizieren, onEntfernen, geaendert }: Props) {
  const { t } = useTranslation()
  const { e, gepaart, bearbeiten } = useAssistent()
  const { spec, issues, lint, metaIds } = e
  // Bearbeiten: Aufbau fest (nichts hinzufügen oder entfernen)
  const nurLesen = e.nurLesen || bearbeiten
  const knoten = knotenListe(spec, t)
  const beiMeta = (k: Knoten): boolean =>
    k.bestehend || (k.ebene === 0 ? !!metaIds.campaign : k.ebene === 1 ? gruppeAngelegt(metaIds, k.node) : anzeigeAngelegt(metaIds, k.node))
  // Entfernen nimmt bei Gruppen die Anzeigen und bei Plan B den Partner mit
  const entfernbar = (k: Knoten): boolean => {
    if (beiMeta(k)) return false
    if (k.ebene === 1) return !spec.ads.some(x => x.adset_key === k.node && anzeigeAngelegt(metaIds, x.key))
    const partner = gepaart ? paarPartner(spec, k.node) : undefined
    return !partner || !anzeigeAngelegt(metaIds, partner.key)
  }

  const ebeneLabel = (k: Knoten) => (k.ebene === 0
    ? t('crm.werbung.meta.level.campaign', 'Kampagne')
    : k.ebene === 1 ? t('crm.werbung.meta.level.adset', 'Anzeigengruppe') : t('crm.werbung.meta.level.ad', 'Werbeanzeige'))

  const ampelText: Record<Ampel, string> = {
    rot: t('crm.werbung.builder.baum.rot', 'Fehler'),
    gelb: t('crm.werbung.builder.baum.gelb', 'Hinweise'),
    gruen: t('crm.werbung.builder.baum.gruen', 'In Ordnung'),
  }

  const knopf = 'rounded p-1 text-[11px] text-gray-400 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/50'

  return (
    <div>
      {/* Telefon und Tablet: Auswahlliste */}
      <div className="space-y-2 lg:hidden">
        <CustomSelect value={sel} onChange={onSelect}
          options={knoten.map(k => ({
            value: k.node,
            label: `${'  '.repeat(k.ebene)}${k.name}`,
            hint: `${ebeneLabel(k)} · ${ampelText[ampelFuer(k.node, issues, lint)]}${geaendert?.has(k.node) ? ` · ${t('crm.werbung.bearbeiten.geaendert', 'geändert')}` : ''}`,
          }))} />
        {!nurLesen && (
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={onNeueGruppe} className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs">+ {t('crm.werbung.builder.baum.gruppe', 'Anzeigengruppe')}</button>
            {gepaart
              ? <button type="button" onClick={onNeuesPaar} className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs">+ {t('crm.werbung.builder.baum.paar', 'Werbemittel-Paar')}</button>
              : spec.adsets.length > 0 && (
                <button type="button" onClick={() => onNeueAnzeige(spec.ads.find(a => a.key === sel)?.adset_key ?? (spec.adsets.find(a => a.key === sel)?.key ?? spec.adsets[0].key))}
                  className="hp-btn hp-btn-ghost min-h-0 px-2.5 py-1 text-xs">+ {t('crm.werbung.builder.baum.anzeige', 'Anzeige')}</button>
              )}
          </div>
        )}
      </div>

      {/* ab lg: Baum */}
      <nav aria-label={t('crm.werbung.builder.baum.titel', 'Aufbau der Kampagne')} className="hidden lg:block">
        <ul className="space-y-0.5">
          {knoten.map(k => {
            const ampel = ampelFuer(k.node, issues, lint)
            const aktiv = sel === k.node
            return (
              <li key={k.node} className={k.ebene === 1 ? 'pl-3' : k.ebene === 2 ? 'pl-6' : ''}>
                <div className={`group flex items-center gap-1 rounded-lg ${aktiv ? 'bg-hp-navy text-white' : 'hover:bg-gray-100'}`}>
                  <button type="button" onClick={() => onSelect(k.node)} aria-current={aktiv ? 'true' : undefined}
                    className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/50">
                    <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${PUNKT[ampel]}`} />
                    <span className="sr-only">{ampelText[ampel]}:</span>
                    <span className="min-w-0">
                      <span className={`block text-[9px] uppercase tracking-wide ${aktiv ? 'text-white/70' : 'text-gray-400'}`}>{ebeneLabel(k)}</span>
                      <span className={`block truncate ${k.ebene === 0 ? 'font-semibold' : ''}`}>{k.name}</span>
                    </span>
                    {geaendert?.has(k.node) ? (
                      <span className={`ml-auto shrink-0 rounded px-1 text-[9px] ${aktiv ? 'bg-white/20' : 'bg-amber-50 text-amber-800'}`}>
                        {t('crm.werbung.bearbeiten.geaendert', 'geändert')}
                      </span>
                    ) : beiMeta(k) && (
                      <span className={`ml-auto shrink-0 rounded px-1 text-[9px] ${aktiv ? 'bg-white/20' : 'bg-emerald-50 text-emerald-800'}`}>
                        {t('crm.werbung.builder.baum.beiMeta', 'bei Meta')}
                      </span>
                    )}
                  </button>
                  {bearbeiten && !e.nurLesen && k.ebene > 0 && k.bestehend && (
                    <span className={`flex shrink-0 pr-1 ${aktiv ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
                      <button type="button" onClick={() => onDuplizieren(k.node)} className={`${knopf} ${aktiv ? 'text-white/80 hover:bg-white/10 hover:text-white' : ''}`}
                        aria-label={t('crm.werbung.bearbeiten.baumDuplizieren', '{{name}} bei Meta duplizieren', { name: k.name })} title={t('crm.werbung.builder.baum.duplizierenKurz', 'Duplizieren')}>⧉</button>
                    </span>
                  )}
                  {!nurLesen && k.ebene > 0 && (
                    <span className={`flex shrink-0 pr-1 ${aktiv ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}>
                      <button type="button" onClick={() => onDuplizieren(k.node)} className={`${knopf} ${aktiv ? 'text-white/80 hover:bg-white/10 hover:text-white' : ''}`}
                        aria-label={t('crm.werbung.builder.baum.duplizieren', '{{name}} duplizieren', { name: k.name })} title={t('crm.werbung.builder.baum.duplizierenKurz', 'Duplizieren')}>⧉</button>
                      {entfernbar(k) && (
                        <button type="button" onClick={() => onEntfernen(k.node)} className={`${knopf} ${aktiv ? 'text-white/80 hover:bg-white/10 hover:text-white' : ''}`}
                          aria-label={t('crm.werbung.builder.baum.entfernen', '{{name}} entfernen', { name: k.name })} title={t('crm.werbung.builder.baum.entfernenKurz', 'Entfernen')}>✕</button>
                      )}
                    </span>
                  )}
                </div>
                {!nurLesen && !gepaart && k.ebene === 1 && (
                  <button type="button" onClick={() => onNeueAnzeige(k.node)}
                    className="ml-6 mt-0.5 rounded px-2 py-0.5 text-[11px] font-semibold text-hp-navy hover:bg-gray-100">
                    + {t('crm.werbung.builder.baum.anzeige', 'Anzeige')}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
        {bearbeiten && (
          <p className="mt-3 border-t border-gray-100 pt-3 text-[10px] leading-snug text-gray-500">
            {t('crm.werbung.bearbeiten.baumHinweis', 'Beim Bearbeiten entsteht nichts Neues. Neue Anzeigengruppen oder Anzeigen über „Bestehende Kampagne ergänzen“ im Reiter Kampagnen.')}
          </p>
        )}
        {!nurLesen && (
          <div className="mt-3 flex flex-col gap-1.5 border-t border-gray-100 pt-3">
            <button type="button" onClick={onNeueGruppe} className="rounded px-2 py-1 text-left text-xs font-semibold text-hp-navy hover:bg-gray-100">
              + {t('crm.werbung.builder.baum.gruppe', 'Anzeigengruppe')}
            </button>
            {gepaart && (
              <button type="button" onClick={onNeuesPaar} className="rounded px-2 py-1 text-left text-xs font-semibold text-hp-navy hover:bg-gray-100">
                + {t('crm.werbung.builder.baum.paar', 'Werbemittel-Paar')}
                <span className="block text-[10px] font-normal text-gray-500">{t('crm.werbung.builder.baum.paarHilfe', 'Eine Anzeige in Lang und eine in Kurz')}</span>
              </button>
            )}
          </div>
        )}
      </nav>
    </div>
  )
}
