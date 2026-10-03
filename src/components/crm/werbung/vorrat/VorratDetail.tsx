import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Badge, { type BadgeTone } from '../../../ui/Badge'
import { useToast } from '../../../ui/Toast'
import { useConfirm } from '../../../ui/ConfirmDialog'
import { supabase } from '../../../../lib/supabase'
import { fnErrorDetail } from '../../../../lib/fnError'
import { useWerbeFormat } from '../format'
import LintListe from './LintListe'
import { qaAus, texteAus } from './vorratDaten'
import type { VorratEinstellungen, VorratEintrag } from './types'
import { StatusBadge } from './VorratStatus'

// ── Detailansicht eines Werbemittels ─────────────────────────────────────────
// Vorschau Feed 4:5 und Story 9:16 (mit Schutzzonen oben 14 %, unten 35 %),
// Texte, Ergebnis der automatischen Prüfung (qa), Note, Prognose, Entscheidung.
// Aktionen (Admin oder Recht werbung, also Sven und Giona):
//   Freigeben (nur aus geprüft)      RPC werbe_pool_entscheiden
//   Ablehnen (Grund Pflicht)         RPC werbe_pool_entscheiden
//   Freigabe zurücknehmen / wieder in den Entwurf   direktes Update, der Guard prüft
//   Hochladen zu Meta (pausiert)     werbe-ausfuehren {modus:'hochladen', pool_id}
// Die Prognose erscheint erst ab Stufe 1 der automatischen Freigabe: bei Stufe 0
// entscheiden Sven und Giona ohne sie, damit die Übereinstimmung ehrlich bleibt.

interface Props {
  eintrag: VorratEintrag | null
  einstellungen: VorratEinstellungen
  /** true = Meta-App im Entwicklungsmodus, null = unbekannt */
  devModus: boolean | null
  darfEntscheiden: boolean
  adsetName: (id: string) => string
  onClose: () => void
  onBearbeiten: (e: VorratEintrag) => void
  /** Liste neu laden (nach Entscheidung, Statuswechsel, Hochladen) */
  onGeaendert: () => void
  /** Hochladen meldete app_dev_mode */
  onDevModus: () => void
  /** Hochladen erfolgreich: Werbemanager-Daten neu laden (Vorbereitete Anzeigen) */
  onHochgeladen: () => void
}

const FEHLEND_FALLBACK: Record<string, string> = {
  texte_primaer: 'Primärtext fehlt',
  texte_ueberschrift: 'Überschrift fehlt',
  lint_blocker: 'Text-Prüfung hat Blocker',
  eu_band: 'EU-Band nicht bestätigt',
  ki_label: 'KI-Kennzeichnung nicht bestätigt',
  karussell_manuell: 'Karussell nur von Hand',
  feed_fehlt: 'Feed-Bild 4:5 fehlt',
  story_fehlt: 'Story-Bild 9:16 fehlt',
  feed_nicht_pruefbar: 'Feed-Bild nicht prüfbar',
  story_nicht_pruefbar: 'Story-Bild nicht prüfbar',
  feed_format: 'Feed-Bild hat falsche Maße',
  story_format: 'Story-Bild hat falsche Maße',
  review_score: 'Note unter der Mindestnote',
}

const notenTon = (n: number): BadgeTone => (n >= 80 ? 'success' : n >= 60 ? 'warning' : 'danger')
const istObjekt = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function Vorschau({ url, seiten, titel }: { url: string | null; seiten: '4:5' | '9:16'; titel: string }) {
  const { t } = useTranslation()
  const flaeche = seiten === '9:16' ? 'aspect-[9/16] w-32 sm:w-36' : 'aspect-[4/5] w-40 sm:w-48'
  return (
    <figure>
      <div className={`relative ${flaeche} overflow-hidden rounded-xl border border-gray-200 bg-gray-50`}>
        {url
          ? <img src={url} alt="" className="h-full w-full object-cover" />
          : <div className="flex h-full items-center justify-center text-xs text-gray-400">{t('crm.werbung.vorrat.detail.keinBild', 'kein Bild')}</div>}
        {url && seiten === '9:16' && (
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-[14%] border-b border-dashed border-white/80 bg-black/15" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[35%] border-t border-dashed border-white/80 bg-black/15" />
          </>
        )}
      </div>
      <figcaption className="mt-1 text-[11px] text-gray-500">{titel}</figcaption>
    </figure>
  )
}

export default function VorratDetail({
  eintrag, einstellungen, devModus, darfEntscheiden, adsetName, onClose, onBearbeiten, onGeaendert, onDevModus, onHochgeladen,
}: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const confirm = useConfirm()
  const { locale } = useWerbeFormat()
  const [grund, setGrund] = useState('')
  const [busy, setBusy] = useState<'frei' | 'ab' | 'status' | 'hoch' | null>(null)

  // Neuer Eintrag: Begründung leeren
  const id = eintrag?.id
  useEffect(() => { setGrund('') }, [id])

  if (!eintrag) return null

  const z = eintrag
  const tx = texteAus(z.texte)
  const qa = qaAus(z.qa)
  const note = z.review_score ?? (qa?.note ?? null)
  const datum = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : '-')
  const zielIds = (z.ziel_adset_ids ?? []).filter(Boolean)
  const metaAds = istObjekt(z.meta_ad_ids) ? Object.entries(z.meta_ad_ids) : []
  const prognoseBasis = qa && istObjekt(qa.prognose_basis) ? qa.prognose_basis : null

  const kannEntscheiden = darfEntscheiden && ['entwurf', 'geprueft', 'freigegeben'].includes(z.status)
  const kannFreigeben = darfEntscheiden && z.status === 'geprueft'

  // Gründe, warum Hochladen (noch) nicht geht
  const hochSperre: string | null = !einstellungen.builderEnabled
    ? t('crm.werbung.vorrat.hoch.builderAus', 'Der Kampagnen-Assistent ist ausgeschaltet (builder_enabled). Erst danach lassen sich Anzeigen bei Meta anlegen.')
    : devModus === true
      ? t('crm.werbung.vorrat.hoch.devModus', 'Die Meta-App steht noch im Entwicklungsmodus. Anzeigen lassen sich erst anlegen, wenn sie live ist.')
      : (z.format ?? 'bild') !== 'bild'
        ? t('crm.werbung.vorrat.hoch.nurBild', 'Automatisch hochladen geht bisher nur für Bild-Werbemittel.')
        : zielIds.length < 1 || zielIds.length > 2
          ? t('crm.werbung.vorrat.hoch.ziele', 'Erst 1 oder 2 Ziel-Anzeigengruppen festlegen (Freigabe zurücknehmen, dann bearbeiten).')
          : !z.asset_feed_url
            ? t('crm.werbung.vorrat.hoch.feed', 'Feed-Bild 4:5 fehlt.')
            : null

  const entscheiden = async (ja: boolean) => {
    if (busy) return
    const g = grund.trim()
    if (!ja && !g) return
    setBusy(ja ? 'frei' : 'ab')
    try {
      const { error } = await supabase.rpc('werbe_pool_entscheiden', {
        p_pool_id: z.id, p_entscheidung: ja ? 'freigeben' : 'ablehnen', p_grund: g || null,
      })
      if (error) throw error
      toast.success(ja
        ? t('crm.werbung.vorrat.detail.freigegeben', 'Freigegeben: {{kennung}}', { kennung: z.kennung })
        : t('crm.werbung.vorrat.detail.abgelehnt', 'Abgelehnt: {{kennung}}. Der Grund fließt ins Lernen ein.', { kennung: z.kennung }))
      setGrund('')
      onGeaendert()
    } catch (err) {
      console.error('[WerbeVorrat] entscheiden:', err)
      toast.error((err as { message?: string }).message ?? t('crm.werbung.vorrat.fehler', 'Das hat nicht geklappt'))
    } finally {
      setBusy(null)
    }
  }

  // Freigabe zurücknehmen (freigegeben -> geprueft) bzw. Verworfenes zurück in den Entwurf
  const statusSetzen = async (neu: 'geprueft' | 'entwurf') => {
    if (busy) return
    setBusy('status')
    try {
      const { error } = await supabase.from('ad_creative_pool').update({ status: neu }).eq('id', z.id).eq('status', z.status)
      if (error) throw error
      toast.success(neu === 'geprueft'
        ? t('crm.werbung.vorrat.detail.zurueckGeprueft', 'Freigabe zurückgenommen, wieder geprüft')
        : t('crm.werbung.vorrat.detail.zurueckEntwurf', 'Wieder im Entwurf'))
      onGeaendert()
    } catch (err) {
      console.error('[WerbeVorrat] status:', err)
      toast.error((err as { message?: string }).message ?? t('crm.werbung.vorrat.fehler', 'Das hat nicht geklappt'))
    } finally {
      setBusy(null)
    }
  }

  const hochladen = async () => {
    if (busy || hochSperre) return
    const ok = await confirm({
      title: t('crm.werbung.vorrat.hoch.frageTitel', 'Zu Meta hochladen?'),
      message: t('crm.werbung.vorrat.hoch.frage', '„{{kennung}}" wird als PAUSIERTE Anzeige in {{n}} Anzeigengruppe(n) angelegt. Aktiviert wird nichts.', { kennung: z.kennung, n: zielIds.length }),
      confirmLabel: t('crm.werbung.vorrat.hoch.knopf', 'Hochladen zu Meta (pausiert)'),
    })
    if (!ok) return
    setBusy('hoch')
    try {
      const { data, error } = await supabase.functions.invoke('werbe-ausfuehren', { body: { modus: 'hochladen', pool_id: z.id } })
      if (error) {
        const d = await fnErrorDetail(error)
        if (d.code === 'app_dev_mode' || d.message === 'app_dev_mode') onDevModus()
        throw new Error(d.code === 'app_dev_mode'
          ? t('crm.werbung.vorrat.hoch.devModus', 'Die Meta-App steht noch im Entwicklungsmodus. Anzeigen lassen sich erst anlegen, wenn sie live ist.')
          : d.hint ? `${d.message} (${d.hint})` : d.message)
      }
      const r = (data ?? {}) as { success?: boolean; error?: string; meta_ad_ids?: Record<string, string>; warnungen?: string[]; bereits_hochgeladen?: boolean }
      if (r.success === false || r.error) throw new Error(r.error ?? t('crm.werbung.vorrat.fehler', 'Das hat nicht geklappt'))
      const n = Object.keys(r.meta_ad_ids ?? {}).length
      toast.success(r.bereits_hochgeladen
        ? t('crm.werbung.vorrat.hoch.bereits', 'War schon hochgeladen ({{n}} Anzeige(n))', { n })
        : t('crm.werbung.vorrat.hoch.ok', 'Pausiert bei Meta angelegt: {{n}} Anzeige(n). Sie stehen unter „Vorbereitete Anzeigen".', { n }))
      for (const w of r.warnungen ?? []) toast.info(w)
      onGeaendert()
      onHochgeladen()
    } catch (err) {
      console.error('[WerbeVorrat] hochladen:', err)
      toast.error(err instanceof Error ? err.message : t('crm.werbung.vorrat.fehler', 'Das hat nicht geklappt'))
    } finally {
      setBusy(null)
    }
  }

  const abschnitt = 'rounded-lg border border-gray-200 p-3'
  const kopf = 'mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500'
  const zeigePrognose = einstellungen.autoStufe >= 1

  return (
    <Modal open onClose={() => { if (!busy) onClose() }} size="xl"
      title={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{z.kennung}</span><StatusBadge status={z.status} /></span>}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {darfEntscheiden && ['entwurf', 'geprueft'].includes(z.status) && (
            <button type="button" onClick={() => onBearbeiten(z)} disabled={!!busy} className="hp-btn hp-btn-ghost mr-auto">
              {t('crm.werbung.vorrat.detail.bearbeiten', 'Bearbeiten')}
            </button>
          )}
          {darfEntscheiden && z.status === 'freigegeben' && (
            <button type="button" onClick={() => void statusSetzen('geprueft')} disabled={!!busy} className="hp-btn hp-btn-ghost mr-auto">
              {t('crm.werbung.vorrat.detail.freigabeZurueck', 'Freigabe zurücknehmen')}
            </button>
          )}
          {darfEntscheiden && z.status === 'verworfen' && (
            <button type="button" onClick={() => void statusSetzen('entwurf')} disabled={!!busy} className="hp-btn hp-btn-ghost mr-auto">
              {t('crm.werbung.vorrat.detail.wiederEntwurf', 'Wieder in den Entwurf')}
            </button>
          )}
          {kannEntscheiden && (
            <button type="button" onClick={() => void entscheiden(false)} disabled={!!busy || !grund.trim()} className="hp-btn hp-btn-danger"
              title={!grund.trim() ? t('crm.werbung.vorrat.detail.grundPflicht', 'Zum Ablehnen bitte einen Grund angeben') : undefined}>
              {busy === 'ab' ? '…' : t('crm.werbung.vorrat.detail.ablehnen', 'Ablehnen')}
            </button>
          )}
          {kannFreigeben && (
            <button type="button" onClick={() => void entscheiden(true)} disabled={!!busy} className="hp-btn hp-btn-primary">
              {busy === 'frei' ? '…' : t('crm.werbung.vorrat.detail.freigeben', 'Freigeben')}
            </button>
          )}
          {darfEntscheiden && z.status === 'freigegeben' && (
            <button type="button" onClick={() => void hochladen()} disabled={!!busy || !!hochSperre} className="hp-btn hp-btn-primary"
              title={hochSperre ?? undefined}>
              {busy === 'hoch' ? t('crm.werbung.vorrat.hoch.laeuft', 'Lädt hoch …') : `⬆ ${t('crm.werbung.vorrat.hoch.knopf', 'Hochladen zu Meta (pausiert)')}`}
            </button>
          )}
          <button type="button" onClick={onClose} disabled={!!busy} className="hp-btn hp-btn-ghost">
            {t('crm.werbung.vorrat.schliessen', 'Schließen')}
          </button>
        </div>
      }>
      <div className="space-y-4">
        {darfEntscheiden && z.status === 'freigegeben' && hochSperre && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">{hochSperre}</p>
        )}
        {z.status === 'entwurf' && (
          <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-600">
            {t('crm.werbung.vorrat.detail.wartetPruefung', 'Entwurf: die automatische Prüfung läuft nachts. Freigeben geht erst danach (Status geprüft).')}
          </p>
        )}

        {/* Vorschau + Merkmale */}
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="flex shrink-0 items-end gap-3">
            <Vorschau url={z.asset_feed_url} seiten="4:5" titel={t('crm.werbung.vorrat.detail.feed', 'Feed 4:5')} />
            <Vorschau url={z.asset_story_url} seiten="9:16" titel={t('crm.werbung.vorrat.detail.story', 'Story 9:16 (Schutzzonen)')} />
          </div>
          <dl className="grid min-w-0 flex-1 grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-gray-500">{t('crm.werbung.vorrat.form.winkel', 'Winkel')}</dt><dd className="text-gray-800">{z.winkel ?? '-'}</dd>
            <dt className="text-gray-500">{t('crm.werbung.vorrat.form.hook', 'Hook-Typ')}</dt><dd className="text-gray-800">{z.hook_typ ?? '-'}</dd>
            <dt className="text-gray-500">{t('crm.werbung.vorrat.form.format', 'Format')}</dt>
            <dd className="text-gray-800">{z.format ? t(`crm.werbung.vorrat.format.${z.format}`, z.format) : '-'}</dd>
            <dt className="text-gray-500">{t('crm.werbung.vorrat.form.visual', 'Visual-Typ')}</dt><dd className="text-gray-800">{z.visual_typ ?? '-'}</dd>
            <dt className="text-gray-500">{t('crm.werbung.vorrat.detail.link', 'Ziel-Link')}</dt>
            <dd className="min-w-0 truncate">
              {z.lp_url
                ? <a href={z.lp_url} target="_blank" rel="noopener noreferrer" className="text-hp-navy underline">{z.lp_url}</a>
                : <span className="text-gray-500">{t('crm.werbung.vorrat.detail.standardLink', 'Standard-Link')}</span>}
            </dd>
            <dt className="text-gray-500">{t('crm.werbung.vorrat.detail.ziele', 'Ziel-Gruppen')}</dt>
            <dd className="text-gray-800">{zielIds.length ? zielIds.map(adsetName).join(', ') : '-'}</dd>
            <dt className="text-gray-500">{t('crm.werbung.vorrat.detail.quelle', 'Quelle')}</dt><dd className="text-gray-800">{z.quelle ?? '-'}</dd>
            <dt className="text-gray-500">{t('crm.werbung.vorrat.detail.haken', 'Bestätigt')}</dt>
            <dd className="flex flex-wrap gap-1">
              <Badge tone={z.eu_band ? 'success' : 'warning'}>{z.eu_band ? '✓' : '✕'} {t('crm.werbung.vorrat.detail.euBand', 'EU-Band')}</Badge>
              <Badge tone={!z.ki_generiert ? 'neutral' : z.ki_label ? 'success' : 'warning'}>
                {!z.ki_generiert ? t('crm.werbung.vorrat.detail.keineKi', 'ohne KI') : z.ki_label ? `✓ ${t('crm.werbung.vorrat.detail.kiLabel', 'KI gekennzeichnet')}` : `✕ ${t('crm.werbung.vorrat.detail.kiOhneLabel', 'KI ohne Kennzeichnung')}`}
              </Badge>
              {z.fakten_pruefung && <Badge tone="warning">{t('crm.werbung.vorrat.detail.fakten', 'Fakten: nur Mensch gibt frei')}</Badge>}
            </dd>
          </dl>
        </div>

        {/* Texte */}
        <div className={abschnitt}>
          <p className={kopf}>{t('crm.werbung.vorrat.detail.texte', 'Texte')}</p>
          {(['primaer', 'ueberschriften', 'beschreibungen'] as const).map(k => (
            tx[k].length > 0 && (
              <div key={k} className="mb-2 last:mb-0">
                <p className="text-[11px] text-gray-500">
                  {k === 'primaer' ? t('crm.werbung.vorrat.form.primaer', 'Primärtexte') : k === 'ueberschriften' ? t('crm.werbung.vorrat.form.ueberschriften', 'Überschriften') : t('crm.werbung.vorrat.form.beschreibungen', 'Beschreibungen')}
                </p>
                <ol className="mt-0.5 list-decimal space-y-1 pl-5 text-sm text-gray-800">
                  {tx[k].map((s, i) => <li key={i} className="whitespace-pre-line break-words">{s}</li>)}
                </ol>
              </div>
            )
          ))}
          {!tx.primaer.length && !tx.ueberschriften.length && (
            <p className="text-xs text-gray-400">{t('crm.werbung.vorrat.detail.keineTexte', 'Noch keine Texte')}</p>
          )}
        </div>

        {/* Prüfung, Note, Prognose */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={abschnitt}>
            <p className={kopf}>{t('crm.werbung.vorrat.detail.note', 'Note')}</p>
            {note != null ? (
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={notenTon(note)}>{note}/100</Badge>
                <span className="text-[11px] text-gray-500">
                  {z.review_score != null ? t('crm.werbung.vorrat.detail.noteStudio', 'Agentur-Prüfung im Studio') : t('crm.werbung.vorrat.detail.noteAuto', 'aus der automatischen Prüfung')}
                  {qa?.min_review_score != null ? ` · ${t('crm.werbung.vorrat.detail.mindestnote', 'Mindestnote {{n}}', { n: qa.min_review_score })}` : ''}
                </span>
              </p>
            ) : <p className="text-xs text-gray-400">{t('crm.werbung.vorrat.detail.keineNote', 'Noch keine Note')}</p>}
          </div>
          <div className={abschnitt}>
            <p className={kopf}>{t('crm.werbung.vorrat.detail.prognose', 'Prognose Freigabe')}</p>
            {zeigePrognose ? (
              z.prognose != null ? (
                <p className="text-sm text-gray-800">
                  <span className="font-semibold">{Math.round(Number(z.prognose) * 100)} %</span>
                  {prognoseBasis && (
                    <span className="block text-[11px] text-gray-500">
                      {t('crm.werbung.vorrat.detail.prognoseBasis', 'Grundlage: {{merkmal}}, {{n}} passende Entscheidungen', {
                        merkmal: String(prognoseBasis.merkmal ?? '-'), n: Number(prognoseBasis.n ?? 0),
                      })}
                    </span>
                  )}
                </p>
              ) : <p className="text-xs text-gray-400">{t('crm.werbung.vorrat.detail.keinePrognose', 'Noch keine Prognose (kommt mit der automatischen Prüfung)')}</p>
            ) : (
              <p className="text-xs text-gray-500">{t('crm.werbung.vorrat.detail.prognoseVerborgen', 'Bei Stufe 0 verborgen, damit eure Entscheidung unbeeinflusst bleibt und die Übereinstimmung ehrlich gemessen wird.')}</p>
            )}
          </div>
        </div>

        <div className={abschnitt}>
          <p className={kopf}>{t('crm.werbung.vorrat.detail.qa', 'Automatische Prüfung')}</p>
          {!qa ? (
            <p className="text-xs text-gray-400">{t('crm.werbung.vorrat.detail.nochNichtGeprueft', 'Noch nicht geprüft')}</p>
          ) : (
            <div className="space-y-2">
              <p className="text-xs">
                {qa.bestanden
                  ? <span className="text-emerald-700">✓ {t('crm.werbung.vorrat.detail.bestanden', 'Bestanden')}</span>
                  : <span className="text-amber-800">{t('crm.werbung.vorrat.detail.offen', 'Offen')}: {(qa.fehlend ?? []).map(c => t(`crm.werbung.vorrat.fehlend.${c}`, FEHLEND_FALLBACK[c] ?? c)).join(', ') || '-'}</span>}
                {qa.geprueft_at && <span className="text-gray-400"> · {datum(qa.geprueft_at)}</span>}
              </p>
              {(qa.lint ?? []).length > 0 && <LintListe issues={qa.lint ?? []} />}
              {(qa.fakten ?? []).length > 0 && (
                <p className="text-[11px] text-amber-800">{t('crm.werbung.vorrat.detail.faktenGefunden', 'Fakten erkannt')}: {(qa.fakten ?? []).join(', ')}</p>
              )}
              {qa.hochladen?.fehler && (
                <p className="text-[11px] text-red-600">
                  {t('crm.werbung.vorrat.detail.hochFehler', 'Letzter Fehler beim Hochladen ({{schritt}}): {{fehler}}', { schritt: qa.hochladen.schritt ?? '-', fehler: qa.hochladen.fehler })}
                </p>
              )}
              <details className="text-[11px]">
                <summary className="cursor-pointer text-gray-500">{t('crm.werbung.vorrat.detail.qaJson', 'Prüfdaten (JSON)')}</summary>
                <pre className="mt-1 max-h-64 overflow-auto rounded bg-gray-50 p-2 text-[10px] leading-snug text-gray-700">{JSON.stringify(z.qa, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>

        {/* Entscheidung + Meta */}
        {(z.entscheidung || metaAds.length > 0 || z.hochgeladen_at) && (
          <div className={abschnitt}>
            <p className={kopf}>{t('crm.werbung.vorrat.detail.verlauf', 'Entscheidung und Meta')}</p>
            {z.entscheidung && (
              <p className="text-xs text-gray-700">
                {z.entscheidung === 'freigegeben' ? t('crm.werbung.vorrat.detail.warFrei', 'Freigegeben') : t('crm.werbung.vorrat.detail.warAb', 'Abgelehnt')}
                {` · ${datum(z.entschieden_at)}`}
                {!z.entschieden_von && ` · ${t('crm.werbung.vorrat.detail.automatisch', 'automatisch')}`}
                {z.entscheidung_grund && <span className="block text-gray-500">„{z.entscheidung_grund}"</span>}
              </p>
            )}
            {z.hochgeladen_at && (
              <p className="mt-1 text-xs text-gray-700">{t('crm.werbung.vorrat.detail.hochgeladenAm', 'Hochgeladen')}: {datum(z.hochgeladen_at)}</p>
            )}
            {metaAds.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-[11px] text-gray-600">
                {metaAds.map(([adset, ad]) => <li key={adset}>{adsetName(adset)} → <span className="font-mono">{String(ad)}</span></li>)}
              </ul>
            )}
          </div>
        )}

        {kannEntscheiden && (
          <div>
            <label htmlFor="vorrat-grund" className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-500">
              {t('crm.werbung.vorrat.detail.grund', 'Begründung (Pflicht beim Ablehnen, beim Freigeben freiwillig)')}
            </label>
            <textarea id="vorrat-grund" value={grund} onChange={e => setGrund(e.target.value)} rows={2} maxLength={1000}
              placeholder={t('crm.werbung.vorrat.detail.grundPh', 'z.B. „Hook zu schwach", „passt nicht zur Marke", „starkes Motiv"')}
              className="w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-hp-navy/20" />
          </div>
        )}
      </div>
    </Modal>
  )
}
