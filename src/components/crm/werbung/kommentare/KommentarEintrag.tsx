import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import Spinner from '../../../ui/Spinner'
import { useConfirm } from '../../../ui/ConfirmDialog'
import { useToast } from '../../../ui/Toast'
import { lintText } from '../../../../lib/metaLint'
import { KOMMENTAR_LINT_BLOCKER, KOMMENTAR_PLATTFORM_LABEL, KOMMENTAR_TEXT_MAX, type Kommentar } from '../../../../lib/werbeKonto'
import { useWerbeFormat } from '../format'
import { ladeVerboteneNamen } from '../vorrat/vorratDaten'
import { messFehlerText, relativeZeit } from '../messung/messungApi'
import { antworten, ausblenden, istOffen } from './kommentareApi'

// ── Ein Kommentar mit Antworten, Antwort-Feld und Ausblenden ─────────────────
// Antworten gehen öffentlich unter die Anzeige (als Seite bzw. Instagram-Konto).
// Live-Prüfung mit metaLint: alles, was metaLint als Blocker einstuft, blockiert
// (Gedankenstrich, ae/oe/ue-Ersatz, Projekt- oder Bauträgername wie der Server,
// dazu Renditezahl, Garantie, Finanzierung, persönliche Merkmale). Nur Hinweise
// (severity warn) lassen sich trotzdem senden.
// Jede Antwort und jedes Aus-/Einblenden erst nach Bestätigung. Nie löschen.
// Vom Verfasser zeigen wir nur den Namen.

export default function KommentarEintrag({ k, schreibSperre, onAenderung }: {
  k: Kommentar
  schreibSperre: string | null
  onAenderung: (neu: Kommentar) => void
}) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const toast = useToast()
  const confirm = useConfirm()
  const [offen, setOffen] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'antworten' | 'ausblenden' | null>(null)
  const [namen, setNamen] = useState<string[]>([])

  // Projekt-/Bauträgernamen erst laden, wenn das Antwortfeld offen ist (eine Abfrage je Sitzung)
  useEffect(() => {
    if (!offen) return
    let lebt = true
    void ladeVerboteneNamen().then(n => { if (lebt) setNamen(n) })
    return () => { lebt = false }
  }, [offen])

  const treffer = useMemo(() => lintText(text, 'kommentar.antwort', { forbiddenNames: namen }), [text, namen])
  const istBlocker = (i: (typeof treffer)[number]) => i.severity === 'blocker' || KOMMENTAR_LINT_BLOCKER.includes(i.rule)
  const blocker = treffer.filter(istBlocker)
  const hinweise = treffer.filter(i => !istBlocker(i))
  const zuLang = text.length > KOMMENTAR_TEXT_MAX
  const antwortSperre = schreibSperre ?? (k.kann_antworten === false ? t('crm.werbung.kommentare.kannNichtAntworten', 'Meta erlaubt hier keine Antwort (z. B. Kommentar gelöscht oder Beitrag geschlossen).') : null)
  const ausblendSperre = schreibSperre ?? (k.kann_ausblenden === false ? t('crm.werbung.kommentare.kannNichtAusblenden', 'Meta erlaubt Ausblenden für diesen Kommentar nicht.') : null)
  const plattform = KOMMENTAR_PLATTFORM_LABEL[k.plattform]

  const senden = async () => {
    const s = text.trim()
    if (!s || blocker.length || zuLang || antwortSperre) return
    const ok = await confirm({
      title: t('crm.werbung.kommentare.bestaetigenTitel', 'Antwort öffentlich senden?'),
      message: (
        <span className="block space-y-2">
          <span className="block">{t('crm.werbung.kommentare.bestaetigenText', 'Die Antwort erscheint öffentlich unter der Anzeige bei {{plattform}}, im Namen von Happy Property.', { plattform })}</span>
          <span className="block whitespace-pre-wrap rounded-lg bg-gray-50 px-3 py-2 text-gray-800">{s}</span>
        </span>
      ),
      confirmLabel: t('crm.werbung.kommentare.sendenJetzt', 'Antwort senden'),
    })
    if (!ok) return
    setBusy('antworten')
    try {
      const r = await antworten(k, s)
      onAenderung({
        ...k, beantwortet: true, antworten_anzahl: k.antworten_anzahl + 1,
        antworten: [...k.antworten, { id: r.antwort_id, text: r.text || s, zeit: new Date().toISOString(), von_uns: true, autor: null }],
      })
      setText('')
      setOffen(false)
      toast.success(t('crm.werbung.kommentare.gesendet', 'Antwort gesendet.'))
      if (r.hinweise.length) {
        toast.info(t('crm.werbung.kommentare.hinweiseNachher', 'Hinweise zum Text: {{liste}}', { liste: r.hinweise.map(h => t(h.meldung_key, h.regel, { match: h.fundstelle ?? '' })).join(' · ') }))
      }
    } catch (err) {
      toast.error(messFehlerText(err, t, 'konto'))
    } finally {
      setBusy(null)
    }
  }

  const umschalten = async () => {
    if (ausblendSperre) return
    const hide = !k.ausgeblendet
    const ok = await confirm({
      title: hide ? t('crm.werbung.kommentare.ausblendenTitel', 'Kommentar ausblenden?') : t('crm.werbung.kommentare.einblendenTitel', 'Kommentar wieder einblenden?'),
      message: hide
        ? t('crm.werbung.kommentare.ausblendenText', 'Der Kommentar ist dann nur noch für die Person selbst (bei Facebook auch für ihre Freunde) sichtbar. Sie merkt davon nichts. Du kannst ihn jederzeit wieder einblenden.')
        : t('crm.werbung.kommentare.einblendenText', 'Der Kommentar ist danach wieder für alle sichtbar.'),
      confirmLabel: hide ? t('crm.werbung.kommentare.ausblenden', 'Ausblenden') : t('crm.werbung.kommentare.einblenden', 'Einblenden'),
    })
    if (!ok) return
    setBusy('ausblenden')
    try {
      const r = await ausblenden(k, hide)
      onAenderung({ ...k, ausgeblendet: r.ausgeblendet })
      toast.success(r.ausgeblendet ? t('crm.werbung.kommentare.ausgeblendet', 'Kommentar ausgeblendet.') : t('crm.werbung.kommentare.eingeblendet', 'Kommentar wieder sichtbar.'))
    } catch (err) {
      toast.error(messFehlerText(err, t, 'konto'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <li className={`py-3 ${k.ausgeblendet ? 'opacity-70' : ''}`}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-gray-800">{k.autor || t('crm.werbung.kommentare.unbekannt', 'Unbekannt')}</span>
        <span className="text-xs text-gray-500">{relativeZeit(k.zeit, fmt.locale)}</span>
        <Badge tone={k.plattform === 'instagram' ? 'info' : 'neutral'}>{plattform}</Badge>
        {istOffen(k) && <Badge tone="warning" dot>{t('crm.werbung.kommentare.unbeantwortet', 'Unbeantwortet')}</Badge>}
        {k.beantwortet && <Badge tone="success">{t('crm.werbung.kommentare.beantwortet', 'Beantwortet')}</Badge>}
        {k.ausgeblendet && <Badge tone="neutral">{t('crm.werbung.kommentare.istAusgeblendet', 'Ausgeblendet')}</Badge>}
        {k.likes != null && k.likes > 0 && <span className="text-xs text-gray-500">♥ {fmt.int(k.likes)}</span>}
      </div>
      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-gray-800">{k.text}</p>

      {k.antworten.length > 0 && (
        <ul className="mt-2 space-y-1.5 border-l-2 border-gray-100 pl-3">
          {k.antworten.map(a => (
            <li key={a.id} className="text-xs">
              <span className={`font-semibold ${a.von_uns ? 'text-hp-navy' : 'text-gray-700'}`}>
                {a.von_uns ? t('crm.werbung.kommentare.wir', 'Happy Property') : a.autor || t('crm.werbung.kommentare.unbekannt', 'Unbekannt')}
              </span>
              <span className="text-gray-400"> · {relativeZeit(a.zeit, fmt.locale)}</span>
              <span className="block whitespace-pre-wrap break-words text-gray-700">{a.text}</span>
            </li>
          ))}
          {k.antworten_anzahl > k.antworten.length && (
            <li className="text-[11px] text-gray-500">{t('crm.werbung.kommentare.mehrAntworten', '{{n}} weitere Antworten bei Meta', { n: k.antworten_anzahl - k.antworten.length })}</li>
          )}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOffen(o => !o)} disabled={!!antwortSperre || busy != null} title={antwortSperre ?? undefined}
          aria-expanded={offen} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
          {antwortSperre ? '🔒 ' : ''}{t('crm.werbung.kommentare.antworten', 'Antworten')}
        </button>
        <button type="button" onClick={() => void umschalten()} disabled={!!ausblendSperre || busy != null} title={ausblendSperre ?? undefined}
          className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
          {busy === 'ausblenden' && <Spinner size="sm" />}
          {ausblendSperre ? '🔒 ' : ''}{k.ausgeblendet ? t('crm.werbung.kommentare.einblenden', 'Einblenden') : t('crm.werbung.kommentare.ausblenden', 'Ausblenden')}
        </button>
        {k.link && (
          <a href={k.link} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-hp-navy underline-offset-2 hover:underline">
            {k.plattform === 'facebook' ? t('crm.werbung.kommentare.kommentarOeffnen', 'Bei Facebook öffnen') : t('crm.werbung.kommentare.beitragOeffnenIg', 'Bei Instagram öffnen')} ↗
          </a>
        )}
      </div>

      {offen && !antwortSperre && (
        <div className="mt-2 space-y-1.5 rounded-lg border border-gray-200 bg-white p-2">
          <label htmlFor={`antwort-${k.id}`} className="sr-only">{t('crm.werbung.kommentare.antwortLabel', 'Antwort')}</label>
          <textarea id={`antwort-${k.id}`} value={text} onChange={e => setText(e.target.value)} rows={3}
            placeholder={t('crm.werbung.kommentare.platzhalter', 'Freundlich und kurz antworten, z. B. auf ein Gespräch hinweisen. Keine Renditezahlen, keine Projektnamen.')}
            className="w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-200" />
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-gray-500">{t('crm.werbung.kommentare.oeffentlich', 'Öffentlich sichtbar, im Namen von Happy Property.')}</span>
            <span className={`tabular-nums ${zuLang ? 'font-semibold text-red-600' : 'text-gray-400'}`}>{text.length}/{KOMMENTAR_TEXT_MAX}</span>
          </div>
          {treffer.length > 0 && (
            <ul className="space-y-1">
              {[...blocker, ...hinweise].map((i, n) => (
                <li key={`${i.rule}-${n}`} className="flex flex-wrap items-start gap-1.5 text-xs leading-snug">
                  <Badge tone={istBlocker(i) ? 'danger' : 'warning'}>
                    {istBlocker(i) ? t('crm.werbung.kommentare.blocker', 'Bitte ändern') : t('crm.werbung.kommentare.hinweis', 'Hinweis')}
                  </Badge>
                  <span className="min-w-0 flex-1 text-gray-600">{t(i.messageKey, i.rule, { match: i.match ?? '', ...(i.params ?? {}) })}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setOffen(false); setText('') }} disabled={busy != null} className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
              {t('crm.werbung.kommentare.abbrechen', 'Abbrechen')}
            </button>
            <button type="button" onClick={() => void senden()} disabled={!text.trim() || blocker.length > 0 || zuLang || busy != null}
              className="hp-btn hp-btn-primary min-h-0 px-3 py-1 text-xs">
              {busy === 'antworten' && <Spinner size="sm" />}
              {t('crm.werbung.kommentare.senden', 'Antwort senden')}
            </button>
          </div>
        </div>
      )}
    </li>
  )
}
