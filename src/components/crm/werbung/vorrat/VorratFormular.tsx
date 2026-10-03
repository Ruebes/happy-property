import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import { useToast } from '../../../ui/Toast'
import { CustomSelect } from '../../../CustomSelect'
import { supabase } from '../../../../lib/supabase'
import { DESCRIPTION_MAX, HEADLINE_MAX, PRIMARY_VISIBLE, lintAd, lintCounts, type LintIssue } from '../../../../lib/metaLint'
import { HP_DEFAULT_LINK, PLAN_B_LP_KURZ, PLAN_B_LP_LANG } from '../../../../lib/metaSpec'
import LintListe from './LintListe'
import {
  FEED_SOLL, STORY_SOLL, BILD_TYPEN, bildHochladen, inhaltAusWerten, kennungFehler, kennungNormalisieren,
  ladeVerboteneNamen, werteAusZeile,
} from './vorratDaten'
import {
  MAX_VARIANTEN, VORRAT_FORMATE, type VorratAdset, type VorratEintrag, type VorratFormWerte, type VorratFormat,
} from './types'

// ── Werbemittel anlegen oder bearbeiten ──────────────────────────────────────
// Kennung (ASCII-Slug, wird Anzeigenname <kennung>_lang / _kurz), Merkmale für
// das Lernen (Winkel, Hook, Format, Visual), Ziel-Link und Ziel-Anzeigengruppen,
// bis zu 5 Primärtexte / Überschriften (<= 40) / Beschreibungen (<= 30) mit
// Live-Prüfung (metaLint, gleiche Regeln wie der Server), Feed 4:5 und Story 9:16
// mit Maßprüfung, Pflicht-Haken EU-Band, KI, Fakten. Neue Einträge starten als
// Entwurf; geänderte Inhalte gehen zurück in die automatische Prüfung (Guard).

/** Preise, Beträge, Flächen, Prozente (wie werbe-autopilot FAKTEN_TEXT) */
const FAKTEN_TEXT = /\d[\d.,]*\s?(?:€|eur\b|euro\b|%|prozent\b|m²|qm\b|quadratmeter)|(?:€|\beur)\s?\d/i

export interface VorratVorschlaege { winkel: string[]; hook: string[]; visual: string[] }

interface Props {
  open: boolean
  /** null = neu anlegen */
  eintrag: VorratEintrag | null
  adsets: VorratAdset[]
  vorschlaege: VorratVorschlaege
  istAdmin: boolean
  onClose: () => void
  onGespeichert: (id: string) => void
}

const INPUT = 'w-full rounded-lg border border-gray-200 px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-hp-navy/20 disabled:bg-gray-50'
const LABEL = 'block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1'

// ── Textvarianten (bis zu 5) ─────────────────────────────────────────────────
function Varianten({ titel, werte, onChange, max, sichtbar, mehrzeilig, placeholder, pflicht }: {
  titel: string; werte: string[]; onChange: (w: string[]) => void
  max?: number; sichtbar?: number; mehrzeilig?: boolean; placeholder?: string; pflicht?: boolean
}) {
  const { t } = useTranslation()
  const setze = (i: number, v: string) => onChange(werte.map((x, n) => (n === i ? v : x)))
  return (
    <div>
      <p className={LABEL}>{titel}{pflicht ? ' *' : ''}</p>
      <div className="space-y-1.5">
        {werte.map((w, i) => {
          const len = w.trim().length
          const zuLang = max != null && len > max
          return (
            <div key={i} className="flex items-start gap-1.5">
              <span className="mt-1.5 w-4 shrink-0 text-right text-[11px] text-gray-400">{i + 1}</span>
              <div className="min-w-0 flex-1">
                {mehrzeilig ? (
                  <textarea value={w} rows={4} onChange={e => setze(i, e.target.value)} placeholder={placeholder}
                    className={`${INPUT} resize-y leading-relaxed`} />
                ) : (
                  <input value={w} onChange={e => setze(i, e.target.value)} placeholder={placeholder}
                    className={`${INPUT} ${zuLang ? 'border-red-300' : ''}`} />
                )}
                <p className={`mt-0.5 text-[10px] ${zuLang ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                  {max != null
                    ? t('crm.werbung.vorrat.form.zeichenMax', '{{len}} von höchstens {{max}} Zeichen', { len, max })
                    : sichtbar != null
                      ? t('crm.werbung.vorrat.form.zeichenSichtbar', '{{len}} Zeichen, die ersten {{max}} sind ohne „Mehr anzeigen“ sichtbar', { len, max: sichtbar })
                      : t('crm.werbung.vorrat.form.zeichen', '{{len}} Zeichen', { len })}
                </p>
              </div>
              {werte.length > 1 && (
                <button type="button" onClick={() => onChange(werte.filter((_, n) => n !== i))}
                  className="mt-1 h-7 w-7 shrink-0 rounded-full text-gray-400 hover:bg-red-50 hover:text-red-600"
                  aria-label={t('crm.werbung.vorrat.form.varianteEntfernen', 'Variante entfernen')}>✕</button>
              )}
            </div>
          )
        })}
      </div>
      {werte.length < MAX_VARIANTEN && (
        <button type="button" onClick={() => onChange([...werte, ''])}
          className="mt-1.5 rounded-lg border border-dashed border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
          + {t('crm.werbung.vorrat.form.variante', 'Variante')}
        </button>
      )}
    </div>
  )
}

// ── Bild-Upload je Platzierung ───────────────────────────────────────────────
function MedienFeld({ titel, soll, seiten, url, onUrl }: {
  titel: string; soll: { w: number; h: number }; seiten: string; url: string | null; onUrl: (u: string | null) => void
}) {
  const { t } = useTranslation()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [meldung, setMeldung] = useState<{ fehler: boolean; text: string } | null>(null)

  const waehlen = async (file: File) => {
    setBusy(true)
    setMeldung(null)
    try {
      const r = await bildHochladen(file, soll)
      if (r.ok) {
        onUrl(r.bild.url)
        setMeldung({
          fehler: false,
          text: r.bild.exakt
            ? t('crm.werbung.vorrat.medien.exakt', '{{w}} x {{h}} px, passt genau', { w: r.bild.w, h: r.bild.h })
            : t('crm.werbung.vorrat.medien.skaliert', '{{w}} x {{h}} px, Seitenverhältnis passt (Meta skaliert)', { w: r.bild.w, h: r.bild.h }),
        })
      } else {
        const text = r.fehler === 'typ'
          ? t('crm.werbung.vorrat.medien.typ', 'Nur JPG oder PNG')
          : r.fehler === 'gross'
            ? t('crm.werbung.vorrat.medien.gross', 'Datei ist größer als 30 MB')
            : r.fehler === 'masse'
              ? t('crm.werbung.vorrat.medien.masse', 'Falsches Format: {{w}} x {{h}} px. Erwartet {{seiten}} ({{sw}} x {{sh}} px).', { w: r.w, h: r.h, seiten, sw: soll.w, sh: soll.h })
              : r.fehler === 'unlesbar'
                ? t('crm.werbung.vorrat.medien.unlesbar', 'Bild lässt sich nicht lesen')
                : t('crm.werbung.vorrat.medien.upload', 'Hochladen fehlgeschlagen: {{detail}}', { detail: r.detail ?? '' })
        setMeldung({ fehler: true, text })
      }
    } finally {
      setBusy(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const flaeche = seiten === '9:16' ? 'aspect-[9/16] w-24' : 'aspect-[4/5] w-28'
  return (
    <div>
      <p className={LABEL}>{titel}</p>
      <div className="flex items-start gap-3">
        <div className={`${flaeche} shrink-0 overflow-hidden rounded-lg border border-gray-200 bg-gray-50`}>
          {url
            ? <img src={url} alt="" className="h-full w-full object-cover" />
            : <div className="flex h-full items-center justify-center text-[10px] text-gray-400">{seiten}</div>}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-[11px] text-gray-500">{t('crm.werbung.vorrat.medien.soll', 'Soll: {{sw}} x {{sh}} px, JPG oder PNG', { sw: soll.w, sh: soll.h })}</p>
          <input ref={fileRef} type="file" accept={BILD_TYPEN.join(',')} className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void waehlen(f) }} />
          <div className="flex flex-wrap gap-1.5">
            <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
              className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {busy ? `⏳ ${t('crm.werbung.vorrat.medien.laedt', 'Lädt hoch …')}` : url ? t('crm.werbung.vorrat.medien.ersetzen', 'Ersetzen') : t('crm.werbung.vorrat.medien.waehlen', 'Bild wählen')}
            </button>
            {url && !busy && (
              <button type="button" onClick={() => { onUrl(null); setMeldung(null) }}
                className="rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-red-50 hover:text-red-600">
                {t('crm.werbung.vorrat.medien.entfernen', 'Entfernen')}
              </button>
            )}
          </div>
          {meldung && (
            <p className={`text-[11px] ${meldung.fehler ? 'text-red-600' : 'text-emerald-700'}`} role={meldung.fehler ? 'alert' : 'status'}>
              {meldung.text}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Haken({ checked, onChange, disabled, titel, hinweis }: {
  checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; titel: string; hinweis?: string
}) {
  return (
    <label className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)}
        className="mt-0.5 rounded border-gray-300 text-hp-navy focus:ring-hp-navy/30" />
      <span>
        <span className="text-gray-800">{titel}</span>
        {hinweis && <span className="block text-[11px] text-gray-400">{hinweis}</span>}
      </span>
    </label>
  )
}

export default function VorratFormular({ open, eintrag, adsets, vorschlaege, istAdmin, onClose, onGespeichert }: Props) {
  const { t } = useTranslation()
  const toast = useToast()
  const [w, setW] = useState<VorratFormWerte>(() => werteAusZeile(eintrag))
  const [namen, setNamen] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)

  // Jedes Öffnen beginnt mit dem Stand des Eintrags (bzw. leer)
  useEffect(() => {
    if (!open) return
    setW(werteAusZeile(eintrag))
    setFehler(null)
    let weg = false
    void ladeVerboteneNamen().then(n => { if (!weg) setNamen(n) })
    return () => { weg = true }
  }, [open, eintrag])

  const setze = <K extends keyof VorratFormWerte>(k: K, v: VorratFormWerte[K]) => setW(prev => ({ ...prev, [k]: v }))

  const kFehler = kennungFehler(w.kennung, namen)
  const kFehlerText = kFehler === 'leer'
    ? t('crm.werbung.vorrat.kennung.leer', 'Kennung fehlt')
    : kFehler === 'format'
      ? t('crm.werbung.vorrat.kennung.format', '3 bis 80 Zeichen: a-z, 0-9, _ und -, beginnt mit Buchstabe oder Ziffer')
      : kFehler === 'endung'
        ? t('crm.werbung.vorrat.kennung.endung', 'Ohne _lang / _kurz: die Endung hängt das Hochladen je Anzeigengruppe an')
        : kFehler === 'projektname'
          ? t('crm.werbung.vorrat.kennung.projektname', 'Enthält einen Projekt- oder Bauträgernamen')
          : null

  // Live-Prüfung mit denselben Regeln wie Server und automatische Prüfung
  const issues: LintIssue[] = useMemo(() => {
    const kiOk = !w.ki_generiert || w.ki_label
    const media: Record<string, { name: string; public_url: string | null; eu_band_confirmed: boolean; ki_label_confirmed: boolean }> = {}
    const refs: { feed_4x5?: { media_id: string }; story_9x16?: { media_id: string } } = {}
    if (w.asset_feed_url) { media.feed = { name: w.kennung, public_url: w.asset_feed_url, eu_band_confirmed: w.eu_band, ki_label_confirmed: kiOk }; refs.feed_4x5 = { media_id: 'feed' } }
    if (w.asset_story_url) { media.story = { name: w.kennung, public_url: w.asset_story_url, eu_band_confirmed: w.eu_band, ki_label_confirmed: kiOk }; refs.story_9x16 = { media_id: 'story' } }
    return lintAd({
      key: w.kennung || 'vorrat', name: w.kennung,
      primary_texts: w.primaer, headlines: w.ueberschriften, descriptions: w.beschreibungen,
      destination: { kind: 'website', url: w.lp_url.trim() || HP_DEFAULT_LINK },
      media: refs,
    }, { forbiddenNames: namen, media })
  }, [w, namen])
  const zaehlung = lintCounts(issues)
  const faktenImText = [...w.primaer, ...w.ueberschriften, ...w.beschreibungen].some(s => FAKTEN_TEXT.test(s))

  const fehlt: string[] = []
  if (!w.primaer.some(x => x.trim())) fehlt.push(t('crm.werbung.vorrat.form.fehltPrimaer', 'Primärtext'))
  if (!w.ueberschriften.some(x => x.trim())) fehlt.push(t('crm.werbung.vorrat.form.fehltUeberschrift', 'Überschrift'))
  if (w.format === 'bild' && !w.asset_feed_url) fehlt.push(t('crm.werbung.vorrat.form.fehltFeed', 'Feed-Bild 4:5'))
  if (w.format === 'bild' && !w.asset_story_url) fehlt.push(t('crm.werbung.vorrat.form.fehltStory', 'Story-Bild 9:16'))

  const toggleAdset = (id: string) => {
    const cur = w.ziel_adset_ids
    if (cur.includes(id)) setze('ziel_adset_ids', cur.filter(x => x !== id))
    else if (cur.length < 2) setze('ziel_adset_ids', [...cur, id])
  }
  // Ziel-Gruppen, die nicht (mehr) im Katalog stehen, trotzdem zeigen
  const adsetListe: VorratAdset[] = useMemo(() => {
    const fremd = w.ziel_adset_ids.filter(id => !adsets.some(a => a.id === id))
      .map(id => ({ id, name: id, kampagne: t('crm.werbung.vorrat.form.unbekannteGruppe', 'nicht im Katalog'), aktiv: false }))
    return [...fremd, ...adsets]
  }, [adsets, w.ziel_adset_ids, t])

  const speichern = async () => {
    if (kFehler || busy) return
    setBusy(true)
    setFehler(null)
    try {
      const inhalt = inhaltAusWerten(w)
      if (eintrag) {
        const { error } = await supabase.from('ad_creative_pool').update(inhalt).eq('id', eintrag.id)
        if (error) throw error
        toast.success(eintrag.status === 'geprueft'
          ? t('crm.werbung.vorrat.form.gespeichertPruefung', 'Gespeichert. Der Eintrag geht zurück in die automatische Prüfung.')
          : t('crm.werbung.vorrat.form.gespeichert', 'Gespeichert'))
        onGespeichert(eintrag.id)
      } else {
        const { data, error } = await supabase.from('ad_creative_pool')
          .insert({ ...inhalt, status: 'entwurf', quelle: 'manuell', cta: 'BOOK_NOW' })
          .select('id').single()
        if (error) throw error
        toast.success(t('crm.werbung.vorrat.form.angelegt', 'Werbemittel angelegt. Die automatische Prüfung läuft in der Nacht.'))
        onGespeichert(String((data as { id: string }).id))
      }
    } catch (err) {
      const e = err as { code?: string; message?: string }
      console.error('[WerbeVorrat] speichern:', err)
      const text = e.code === '23505'
        ? t('crm.werbung.vorrat.form.doppelt', 'Diese Kennung gibt es schon im Vorrat')
        : e.message ?? t('crm.werbung.vorrat.form.fehler', 'Speichern fehlgeschlagen')
      setFehler(text)
      toast.error(text)
    } finally {
      setBusy(false)
    }
  }

  const titel = eintrag
    ? t('crm.werbung.vorrat.form.titelBearbeiten', 'Werbemittel bearbeiten')
    : t('crm.werbung.vorrat.form.titelNeu', 'Neues Werbemittel für den Vorrat')

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose() }} title={titel} size="xl" closeOnBackdrop={false}
      footer={
        <div className="flex w-full flex-wrap items-center justify-end gap-2">
          {fehler && <p className="mr-auto text-xs text-red-600" role="alert">{fehler}</p>}
          <button type="button" onClick={onClose} disabled={busy} className="hp-btn hp-btn-ghost">
            {t('crm.werbung.vorrat.abbrechen', 'Abbrechen')}
          </button>
          <button type="button" onClick={() => void speichern()} disabled={busy || !!kFehler} className="hp-btn hp-btn-primary">
            {busy ? t('crm.werbung.vorrat.form.speichert', 'Speichert …') : eintrag ? t('crm.werbung.vorrat.form.speichern', 'Speichern') : t('crm.werbung.vorrat.form.anlegen', 'Als Entwurf anlegen')}
          </button>
        </div>
      }>
      <div className="space-y-5">
        {eintrag?.status === 'geprueft' && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            {t('crm.werbung.vorrat.form.hinweisGeprueft', 'Geprüfter Eintrag: jede Änderung am Inhalt schickt ihn zurück in die automatische Prüfung.')}
          </p>
        )}

        {/* Kennung + Merkmale */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="vorrat-kennung">{t('crm.werbung.vorrat.form.kennung', 'Kennung')} *</label>
            <input id="vorrat-kennung" value={w.kennung} disabled={!!eintrag?.hochgeladen_at}
              onChange={e => setze('kennung', kennungNormalisieren(e.target.value))}
              placeholder="pb-miete-zuerst-v1" className={`${INPUT} font-mono ${kFehler && w.kennung ? 'border-red-300' : ''}`} />
            <p className={`mt-0.5 text-[11px] ${kFehler && w.kennung ? 'text-red-600' : 'text-gray-400'}`}>
              {kFehler && w.kennung ? kFehlerText : t('crm.werbung.vorrat.form.kennungHinweis', 'Wird der Anzeigenname: <kennung>_lang und <kennung>_kurz. Nur Kleinbuchstaben, Ziffern, _ und -.')}
            </p>
          </div>
          <div>
            <label className={LABEL} htmlFor="vorrat-winkel">{t('crm.werbung.vorrat.form.winkel', 'Winkel')}</label>
            <input id="vorrat-winkel" list="vorrat-winkel-liste" value={w.winkel} onChange={e => setze('winkel', e.target.value)} className={INPUT} />
            <datalist id="vorrat-winkel-liste">{vorschlaege.winkel.map(v => <option key={v} value={v} />)}</datalist>
          </div>
          <div>
            <label className={LABEL} htmlFor="vorrat-hook">{t('crm.werbung.vorrat.form.hook', 'Hook-Typ')}</label>
            <input id="vorrat-hook" list="vorrat-hook-liste" value={w.hook_typ} onChange={e => setze('hook_typ', e.target.value)} className={INPUT} />
            <datalist id="vorrat-hook-liste">{vorschlaege.hook.map(v => <option key={v} value={v} />)}</datalist>
          </div>
          <div>
            <p className={LABEL}>{t('crm.werbung.vorrat.form.format', 'Format')}</p>
            <CustomSelect value={w.format} onChange={v => setze('format', v as VorratFormat)}
              options={VORRAT_FORMATE.map(f => ({ value: f, label: t(`crm.werbung.vorrat.format.${f}`, f === 'bild' ? 'Bild' : f === 'video' ? 'Video' : 'Karussell') }))} />
            {w.format !== 'bild' && (
              <p className="mt-0.5 text-[11px] text-amber-700">{t('crm.werbung.vorrat.form.nurBild', 'Automatisch hochladen geht bisher nur für Bild-Werbemittel.')}</p>
            )}
          </div>
          <div>
            <label className={LABEL} htmlFor="vorrat-visual">{t('crm.werbung.vorrat.form.visual', 'Visual-Typ')}</label>
            <input id="vorrat-visual" list="vorrat-visual-liste" value={w.visual_typ} onChange={e => setze('visual_typ', e.target.value)} className={INPUT} />
            <datalist id="vorrat-visual-liste">{vorschlaege.visual.map(v => <option key={v} value={v} />)}</datalist>
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="vorrat-lp">{t('crm.werbung.vorrat.form.lpUrl', 'Ziel-Link (Landingpage)')}</label>
            <input id="vorrat-lp" list="vorrat-lp-liste" value={w.lp_url} onChange={e => setze('lp_url', e.target.value.trim())}
              placeholder={HP_DEFAULT_LINK} className={INPUT} inputMode="url" />
            <datalist id="vorrat-lp-liste">
              {[PLAN_B_LP_LANG, PLAN_B_LP_KURZ, HP_DEFAULT_LINK].map(v => <option key={v} value={v} />)}
            </datalist>
            <p className="mt-0.5 text-[11px] text-gray-400">
              {t('crm.werbung.vorrat.form.lpHinweis', 'Leer = Standard-Link aus den Einstellungen. Plan-B-Seite: _lang bekommt die lange, _kurz die kompakte Seite.')}
            </p>
          </div>
        </div>

        {/* Ziel-Anzeigengruppen */}
        <div>
          <p className={LABEL}>{t('crm.werbung.vorrat.form.ziele', 'Ziel-Anzeigengruppen (1 oder 2)')}</p>
          {adsetListe.length === 0 ? (
            <p className="text-xs text-gray-400">{t('crm.werbung.vorrat.form.keineGruppen', 'Keine Anzeigengruppen im Katalog. Erst „Aktualisieren", dann wählen.')}</p>
          ) : (
            <div className="max-h-44 overflow-y-auto rounded-lg border border-gray-200 divide-y divide-gray-100">
              {adsetListe.map(a => {
                const an = w.ziel_adset_ids.includes(a.id)
                const voll = !an && w.ziel_adset_ids.length >= 2
                return (
                  <label key={a.id} className={`flex items-center gap-2 px-2.5 py-1.5 text-xs ${voll ? 'opacity-50' : 'cursor-pointer hover:bg-gray-50'}`}>
                    <input type="checkbox" checked={an} disabled={voll} onChange={() => toggleAdset(a.id)}
                      className="rounded border-gray-300 text-hp-navy focus:ring-hp-navy/30" />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium text-gray-800">{a.name}</span>
                      <span className="text-gray-400"> · {a.kampagne}</span>
                    </span>
                    {a.aktiv && <span className="shrink-0 text-[10px] text-emerald-700">{t('crm.werbung.vorrat.form.gruppeAktiv', 'läuft')}</span>}
                  </label>
                )
              })}
            </div>
          )}
          <p className="mt-0.5 text-[11px] text-gray-400">
            {t('crm.werbung.vorrat.form.zieleHinweis', 'Plan B: beide Gruppen wählen (Lang und Kurz). Die Kampagne muss in der Sonderkategorie Wohnen laufen, das prüft der Server beim Hochladen.')}
          </p>
        </div>

        {/* Texte */}
        <div className="grid gap-4">
          <Varianten titel={t('crm.werbung.vorrat.form.primaer', 'Primärtexte')} pflicht mehrzeilig sichtbar={PRIMARY_VISIBLE}
            werte={w.primaer} onChange={v => setze('primaer', v)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Varianten titel={t('crm.werbung.vorrat.form.ueberschriften', 'Überschriften')} pflicht max={HEADLINE_MAX}
              werte={w.ueberschriften} onChange={v => setze('ueberschriften', v)} />
            <Varianten titel={t('crm.werbung.vorrat.form.beschreibungen', 'Beschreibungen')} max={DESCRIPTION_MAX}
              werte={w.beschreibungen} onChange={v => setze('beschreibungen', v)} />
          </div>
        </div>

        {/* Medien */}
        <div className="grid gap-4 sm:grid-cols-2">
          <MedienFeld titel={t('crm.werbung.vorrat.medien.feed', 'Feed 4:5 (Feeds, Suche)')} soll={FEED_SOLL} seiten="4:5"
            url={w.asset_feed_url} onUrl={u => setze('asset_feed_url', u)} />
          <MedienFeld titel={t('crm.werbung.vorrat.medien.story', 'Story 9:16 (Stories, Reels)')} soll={STORY_SOLL} seiten="9:16"
            url={w.asset_story_url} onUrl={u => setze('asset_story_url', u)} />
        </div>

        {/* Pflicht-Haken */}
        <div className="grid gap-2.5 rounded-lg border border-gray-200 p-3">
          <Haken checked={w.eu_band} onChange={v => setze('eu_band', v)}
            titel={t('crm.werbung.vorrat.haken.euBand', 'EU-Band ab Sekunde 1 sichtbar („Immobilien auf Zypern · EU“)')} />
          <Haken checked={w.ki_generiert} onChange={v => setze('ki_generiert', v)}
            titel={t('crm.werbung.vorrat.haken.ki', 'KI-generiert (Bild oder Video ganz oder teilweise mit KI erstellt)')} />
          <div className="pl-6">
            <Haken checked={w.ki_label} disabled={!w.ki_generiert} onChange={v => setze('ki_label', v)}
              titel={t('crm.werbung.vorrat.haken.kiLabel', 'KI-Kennzeichnung ist gesetzt')} />
          </div>
          <Haken checked={w.fakten_pruefung}
            disabled={!!eintrag?.fakten_pruefung && w.fakten_pruefung && !istAdmin}
            onChange={v => setze('fakten_pruefung', v)}
            titel={t('crm.werbung.vorrat.haken.fakten', 'Enthält Fakten, Preise oder Fotos')}
            hinweis={t('crm.werbung.vorrat.haken.faktenHinweis', 'Wird nie automatisch freigegeben, immer ein Mensch. Abschalten kann nur ein Admin.')} />
          {faktenImText && !w.fakten_pruefung && (
            <p className="text-[11px] text-amber-700">
              {t('crm.werbung.vorrat.haken.faktenErkannt', 'Im Text stehen Zahlen, Preise oder Prozente. Die automatische Prüfung setzt den Haken ohnehin.')}
            </p>
          )}
        </div>

        {/* Live-Prüfung */}
        <div className="rounded-lg border border-gray-200 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-gray-800">{t('crm.werbung.vorrat.form.pruefung', 'Prüfung')}</p>
            <span className="text-[11px] text-gray-500">
              {t('crm.werbung.vorrat.form.pruefungZahlen', '{{blocker}} Blocker, {{manual}} zu bestätigen, {{warn}} Hinweise', zaehlung)}
            </span>
          </div>
          <LintListe issues={issues} leerText={t('crm.werbung.vorrat.form.pruefungOk', 'Keine Beanstandungen')} />
          {fehlt.length > 0 && (
            <p className="mt-2 text-[11px] text-gray-500">
              {t('crm.werbung.vorrat.form.fehlt', 'Für die automatische Prüfung fehlt noch: {{liste}}', { liste: fehlt.join(', ') })}
            </p>
          )}
          {zaehlung.blocker > 0 && (
            <p className="mt-1 text-[11px] text-red-600">
              {t('crm.werbung.vorrat.form.blockerHinweis', 'Speichern geht, aber mit Blockern bleibt der Eintrag im Entwurf.')}
            </p>
          )}
        </div>
      </div>
    </Modal>
  )
}
