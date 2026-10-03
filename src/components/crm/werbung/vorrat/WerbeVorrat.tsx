import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge, { type BadgeTone } from '../../../ui/Badge'
import EmptyState from '../../../ui/EmptyState'
import Spinner from '../../../ui/Spinner'
import { useWerbeKontext } from '../useWerbeDaten'
import VorratDetail from './VorratDetail'
import VorratFormular, { type VorratVorschlaege } from './VorratFormular'
import { statusName, statusTon } from './VorratStatus'
import {
  ladeEinstellungen, ladeEntwicklungsmodus, ladeVorrat, qaAus, statistik, useVorratRechte,
} from './vorratDaten'
import {
  VORRAT_ENDE, VORRAT_HAUPT, VORRAT_STATUS, type VorratAdset, type VorratEinstellungen, type VorratEintrag,
} from './types'

// ── Werbemittel-Vorrat (Reiter Werbemittel, über „Vorbereitete Anzeigen") ────
// Board nach Status: Entwurf -> Geprüft (automatische Prüfung, nachts) ->
// Freigegeben (Sven oder Giona) -> Hochgeladen (pausiert bei Meta) -> Aktiv,
// dazu die beendeten Status. Anlegen mit Live-Prüfung, Detail mit Freigabe,
// Ablehnung (Grund Pflicht) und Hochladen. Kopfzeile: Zahl der menschlichen
// Entscheidungen, Übereinstimmung der Prognose, aktuelle Stufe der
// automatischen Freigabe (geändert wird sie im Reiter Autopilot, nur Admin).
//
// Micro-Instanz: beim Öffnen drei kleine Abfragen nacheinander (Vorrat,
// Einstellungen, Meta-Schreibprotokoll), danach nur der Vorrat neu.

/** Startliste der Winkel (wie werbe-autopilot WINKEL_STANDARD), ergänzt um Werte aus dem Vorrat */
const WINKEL_STANDARD = [
  'Miete zuerst', 'Kosten und Nebenkosten', 'Transparenz und echte Preise', 'Sven persönlich',
  'Neubau statt Bestand', 'EU-Sicherheit Südzypern', 'Zahlungsplan',
]
const HOOK_STANDARD = ['Frage', 'Zahl', 'Gegensatz', 'Persönliche Geschichte', 'Aussage']
const VISUAL_STANDARD = ['Sven im Bild', 'Grafik mit Text', 'Zypern-Umgebung', 'Visualisierung', 'Baustelle']

const notenTon = (n: number): BadgeTone => (n >= 80 ? 'success' : n >= 60 ? 'warning' : 'danger')
const eindeutig = (l: Array<string | null | undefined>): string[] => {
  const out: string[] = []
  for (const v of l) { const s = (v ?? '').trim(); if (s && !out.includes(s)) out.push(s) }
  return out
}

function Karte({ z, zeigePrognose, onOpen }: { z: VorratEintrag; zeigePrognose: boolean; onOpen: () => void }) {
  const { t } = useTranslation()
  const qa = qaAus(z.qa)
  const note = z.review_score ?? qa?.note ?? null
  const offen = z.status === 'entwurf' && qa && !qa.bestanden ? (qa.fehlend ?? []).length : 0
  return (
    <button type="button" onClick={onOpen}
      className="w-full rounded-xl border border-gray-200 bg-white p-2.5 text-left transition hover:border-hp-navy/30 hover:shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/30">
      <div className="flex gap-2.5">
        <div className="aspect-[4/5] w-10 shrink-0 overflow-hidden rounded-md bg-gray-100">
          {z.asset_feed_url && <img src={z.asset_feed_url} alt="" loading="lazy" className="h-full w-full object-cover" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-xs font-semibold text-gray-800" title={z.kennung}>{z.kennung}</p>
          <p className="truncate text-[11px] text-gray-500">
            {z.winkel ?? t('crm.werbung.vorrat.board.ohneWinkel', 'ohne Winkel')}
            {z.format ? ` · ${t(`crm.werbung.vorrat.format.${z.format}`, z.format)}` : ''}
          </p>
          <div className="mt-1 flex flex-wrap gap-1">
            {note != null && <Badge tone={notenTon(note)}>{t('crm.werbung.vorrat.board.note', 'Note {{n}}', { n: note })}</Badge>}
            {zeigePrognose && z.prognose != null && (
              <Badge tone="info">{t('crm.werbung.vorrat.board.prognose', 'Prognose {{p}} %', { p: Math.round(Number(z.prognose) * 100) })}</Badge>
            )}
            {z.fakten_pruefung && <Badge tone="warning">{t('crm.werbung.vorrat.board.fakten', 'Fakten')}</Badge>}
            {offen > 0 && <Badge tone="neutral">{t('crm.werbung.vorrat.board.offen', '{{n}} offen', { n: offen })}</Badge>}
          </div>
        </div>
      </div>
    </button>
  )
}

export default function WerbeVorrat() {
  const { t } = useTranslation()
  const { catalog, fetchAll } = useWerbeKontext()
  const { darfEntscheiden, istAdmin } = useVorratRechte()

  const [zeilen, setZeilen] = useState<VorratEintrag[]>([])
  const [laedt, setLaedt] = useState(true)
  const [fehler, setFehler] = useState<{ text: string; fehlt: boolean } | null>(null)
  const [einst, setEinst] = useState<VorratEinstellungen>({ builderEnabled: false, autoStufe: 0, schwelle: 0.9 })
  const [devModus, setDevModus] = useState<boolean | null>(null)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [form, setForm] = useState<{ open: boolean; eintrag: VorratEintrag | null }>({ open: false, eintrag: null })
  const [endeZeigen, setEndeZeigen] = useState(false)
  const lfd = useRef(0)

  // Vorrat neu laden; beim ersten Mal danach Einstellungen und Entwicklungsmodus (seriell)
  const laden = useCallback(async (mitNebendaten: boolean) => {
    const nr = ++lfd.current
    setLaedt(true)
    const v = await ladeVorrat()
    if (nr !== lfd.current) return
    setZeilen(v.zeilen)
    setFehler(v.fehler ? { text: v.fehler, fehlt: v.fehlt } : null)
    setLaedt(false)
    if (!mitNebendaten || v.fehlt) return
    const e = await ladeEinstellungen()
    if (nr !== lfd.current) return
    setEinst(e)
    const d = await ladeEntwicklungsmodus()
    if (nr !== lfd.current) return
    setDevModus(prev => (prev === true ? true : d))
  }, [])

  useEffect(() => { void laden(true) }, [laden])

  const adsets: VorratAdset[] = useMemo(() => {
    const m = new Map<string, VorratAdset>()
    for (const r of catalog) {
      if (!r.adset_id) continue
      const aktiv = r.status === 'ACTIVE'
      const cur = m.get(r.adset_id)
      if (!cur) m.set(r.adset_id, { id: r.adset_id, name: r.adset_name ?? r.adset_id, kampagne: r.campaign_name ?? r.campaign_id, aktiv })
      else if (aktiv) cur.aktiv = true
    }
    return [...m.values()].sort((a, b) =>
      Number(b.aktiv) - Number(a.aktiv) || a.kampagne.localeCompare(b.kampagne) || a.name.localeCompare(b.name))
  }, [catalog])
  const adsetName = useCallback((id: string) => adsets.find(a => a.id === id)?.name ?? id, [adsets])

  const vorschlaege: VorratVorschlaege = useMemo(() => ({
    winkel: eindeutig([...WINKEL_STANDARD, ...zeilen.map(z => z.winkel)]),
    hook: eindeutig([...HOOK_STANDARD, ...zeilen.map(z => z.hook_typ)]),
    visual: eindeutig([...VISUAL_STANDARD, ...zeilen.map(z => z.visual_typ)]),
  }), [zeilen])

  const stat = useMemo(() => statistik(zeilen, einst.schwelle), [zeilen, einst.schwelle])

  const nachStatus = useMemo(() => {
    const m = new Map<string, VorratEintrag[]>()
    for (const z of zeilen) {
      const key = (VORRAT_STATUS as readonly string[]).includes(z.status) ? z.status : 'sonstige'
      const l = m.get(key) ?? []
      l.push(z)
      m.set(key, l)
    }
    return m
  }, [zeilen])
  const anzahlEnde = VORRAT_ENDE.reduce((s, k) => s + (nachStatus.get(k)?.length ?? 0), 0)
  const spalten: string[] = [
    ...VORRAT_HAUPT,
    ...(endeZeigen ? VORRAT_ENDE : []),
    ...(nachStatus.get('sonstige')?.length ? ['sonstige'] : []),
  ]

  const detail = detailId ? zeilen.find(z => z.id === detailId) ?? null : null
  const zeigePrognose = einst.autoStufe >= 1
  const stufeName = [
    t('crm.werbung.vorrat.stufe.0', 'manuell'),
    t('crm.werbung.vorrat.stufe.1', 'Prognose anzeigen'),
    t('crm.werbung.vorrat.stufe.2', 'automatisch ab Schwelle'),
    t('crm.werbung.vorrat.stufe.3', 'vollautomatisch'),
  ][Math.max(0, Math.min(3, Math.round(einst.autoStufe)))]

  return (
    <div className="mb-5 rounded-2xl border border-gray-200 bg-white p-4 sm:p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold text-gray-800 mb-1">🗃 {t('crm.werbung.vorrat.titel', 'Vorrat')}</h2>
          <p className="text-sm text-gray-400">
            {t('crm.werbung.vorrat.sub', 'Fertige Werbemittel, bevor sie zu Meta gehen: nachts automatisch geprüft, dann von Sven oder Giona freigegeben und pausiert hochgeladen. Jede Entscheidung mit Grund lernt das System mit.')}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => void laden(false)} disabled={laedt}
            className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            aria-label={t('crm.werbung.vorrat.neuLaden', 'Neu laden')}>↻</button>
          {darfEntscheiden && !fehler?.fehlt && (
            <button type="button" onClick={() => setForm({ open: true, eintrag: null })}
              className="hp-btn hp-btn-primary min-h-0 sm:min-h-0 px-4 py-1.5 text-xs font-semibold">
              + {t('crm.werbung.vorrat.neu', 'Neues Werbemittel')}
            </button>
          )}
        </div>
      </div>

      {/* Kennzahlen der Entscheidungen */}
      {!fehler && (
        <p className="mt-3 rounded-lg bg-hp-cream px-3 py-2 text-xs text-hp-navy ring-1 ring-hp-navy/10">
          {t('crm.werbung.vorrat.stat.entscheidungen', '{{n}} Entscheidungen ({{ja}} freigegeben, {{nein}} abgelehnt)', {
            n: stat.entscheidungen, ja: stat.freigaben, nein: stat.ablehnungen,
          })}
          {' · '}
          {stat.quote != null
            ? t('crm.werbung.vorrat.stat.uebereinstimmung', 'Übereinstimmung {{q}} % bei {{f}} Fällen mit Prognose ab {{s}} %', {
              q: Math.round(stat.quote * 100), f: stat.faelle, s: Math.round(einst.schwelle * 100),
            })
            : t('crm.werbung.vorrat.stat.keineUebereinstimmung', 'Übereinstimmung: noch keine Fälle mit Prognose ab {{s}} %', { s: Math.round(einst.schwelle * 100) })}
          {' · '}
          {t('crm.werbung.vorrat.stat.stufe', 'Automatische Freigabe: Stufe {{n}} ({{name}})', { n: einst.autoStufe, name: stufeName })}
          {devModus === true && (
            <span className="block text-amber-800">
              {t('crm.werbung.vorrat.stat.devModus', 'Meta-App im Entwicklungsmodus: Hochladen geht erst, wenn sie live ist.')}
            </span>
          )}
        </p>
      )}

      <div className="mt-4">
        {laedt && zeilen.length === 0 ? (
          <div className="flex justify-center py-8"><Spinner label={t('crm.werbung.vorrat.laedt', 'Vorrat wird geladen …')} /></div>
        ) : fehler ? (
          <EmptyState compact icon="alert"
            title={fehler.fehlt ? t('crm.werbung.vorrat.fehlt.titel', 'Vorrat noch nicht eingerichtet') : t('crm.werbung.vorrat.fehlerTitel', 'Vorrat konnte nicht geladen werden')}
            text={fehler.fehlt ? t('crm.werbung.vorrat.fehlt.text', 'Das Datenbank-Update für den Werbemittel-Vorrat ist noch nicht eingespielt.') : fehler.text}
            action={!fehler.fehlt ? (
              <button type="button" onClick={() => void laden(true)} className="hp-btn hp-btn-ghost">{t('crm.werbung.vorrat.nochmal', 'Erneut versuchen')}</button>
            ) : undefined} />
        ) : zeilen.length === 0 ? (
          <EmptyState compact icon="inbox"
            title={t('crm.werbung.vorrat.leer.titel', 'Noch keine Werbemittel im Vorrat')}
            text={t('crm.werbung.vorrat.leer.text', 'Lege das erste an: Kennung, Texte, Feed 4:5 und Story 9:16. Die Prüfung läuft danach automatisch.')}
            action={darfEntscheiden ? (
              <button type="button" onClick={() => setForm({ open: true, eintrag: null })} className="hp-btn hp-btn-primary">
                + {t('crm.werbung.vorrat.neu', 'Neues Werbemittel')}
              </button>
            ) : undefined} />
        ) : (
          <>
            <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:px-0">
              {spalten.map(s => {
                const liste = nachStatus.get(s) ?? []
                return (
                  <section key={s} aria-label={s === 'sonstige' ? t('crm.werbung.vorrat.status.sonstige', 'Sonstige') : statusName(t, s)}
                    className="w-64 shrink-0 snap-start rounded-xl bg-gray-50 p-2">
                    <header className="mb-2 flex items-center gap-2 px-1">
                      <Badge tone={s === 'sonstige' ? 'neutral' : statusTon(s)} dot>
                        {s === 'sonstige' ? t('crm.werbung.vorrat.status.sonstige', 'Sonstige') : statusName(t, s)}
                      </Badge>
                      <span className="text-[11px] text-gray-500">{liste.length}</span>
                    </header>
                    <div className="max-h-[28rem] space-y-2 overflow-y-auto">
                      {liste.length === 0
                        ? <p className="px-1 py-3 text-center text-[11px] text-gray-400">{t('crm.werbung.vorrat.board.leer', 'leer')}</p>
                        : liste.map(z => <Karte key={z.id} z={z} zeigePrognose={zeigePrognose} onOpen={() => setDetailId(z.id)} />)}
                    </div>
                  </section>
                )
              })}
            </div>
            {anzahlEnde > 0 || endeZeigen ? (
              <button type="button" onClick={() => setEndeZeigen(v => !v)}
                className="mt-2 text-xs text-gray-500 underline hover:text-gray-700">
                {endeZeigen
                  ? t('crm.werbung.vorrat.board.endeAus', 'Beendete ausblenden')
                  : t('crm.werbung.vorrat.board.endeAn', 'Beendete zeigen ({{n}})', { n: anzahlEnde })}
              </button>
            ) : null}
          </>
        )}
      </div>

      <VorratDetail
        eintrag={detail}
        einstellungen={einst}
        devModus={devModus}
        darfEntscheiden={darfEntscheiden}
        adsetName={adsetName}
        onClose={() => setDetailId(null)}
        onBearbeiten={e => { setDetailId(null); setForm({ open: true, eintrag: e }) }}
        onGeaendert={() => void laden(false)}
        onDevModus={() => setDevModus(true)}
        onHochgeladen={() => { void fetchAll() }}
      />

      <VorratFormular
        open={form.open}
        eintrag={form.eintrag}
        adsets={adsets}
        vorschlaege={vorschlaege}
        istAdmin={istAdmin}
        onClose={() => setForm({ open: false, eintrag: null })}
        onGespeichert={id => {
          setForm({ open: false, eintrag: null })
          void laden(false).then(() => setDetailId(id))
        }}
      />
    </div>
  )
}
