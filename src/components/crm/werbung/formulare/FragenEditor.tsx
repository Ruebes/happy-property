import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  LEADFORM_BEDINGTE_LOGIK_PER_API, LEADFORM_FRAGE_LABEL, LEADFORM_MAX_EIGENE_FRAGEN, LEADFORM_VORDEFINIERT, LEADFORM_WOHNEN_GRUND,
  type LeadFormFrageTyp, type LeadFormVordefiniert,
} from '../../../../lib/werbeWerkzeuge'
import { EINGABE_KLEIN, Hinweis, Zaehler } from '../zielgruppen/Bausteine'
import {
  GRENZE, eigeneFrage, eigeneZahl, istEigene, istWohnenVerboten, neueId, schluessel, vordefiniert,
  type FormularEntwurf, type FrageEntwurf,
} from './formularModell'

// ── Fragen eines Sofortformulars ─────────────────────────────────────────────
// Vordefinierte Fragen (Meta füllt sie aus dem Profil vor) und eigene Fragen:
// Mehrfachauswahl, Kurze Antwort, Terminanfrage. Was Wohnen verbietet (Alter,
// Geschlecht, Familienstand, Standort), steht grau mit Grund in der Auswahl.
// Bedingte Logik zeigt der Editor gesperrt: Meta legt sie per API nicht an.

const KNOPF = 'rounded-md border border-gray-200 px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40'

export default function FragenEditor({ e, setze, nurLesen }: {
  e: FormularEntwurf
  setze: (patch: Partial<FormularEntwurf>) => void
  nurLesen: boolean
}) {
  const { t } = useTranslation()
  const [neuTyp, setNeuTyp] = useState<string>('')
  const fragen = e.fragen
  const label = (type: LeadFormFrageTyp) => t(`crm.werbung.formulare.frage.${type}`, LEADFORM_FRAGE_LABEL[type] ?? type)
  const wohnenGrund = t('crm.werbung.formulare.wohnenGrund', LEADFORM_WOHNEN_GRUND)
  const vorhanden = new Set(fragen.filter(q => !istEigene(q)).map(q => q.type))
  const eigene = eigeneZahl(e)

  const setzeFrage = (id: number, patch: Partial<FrageEntwurf>) => setze({ fragen: fragen.map(q => (q.id === id ? { ...q, ...patch } : q)) })
  const schiebe = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= fragen.length) return
    const neu = fragen.slice()
    ;[neu[i], neu[j]] = [neu[j], neu[i]]
    setze({ fragen: neu })
  }
  const entferne = (id: number) => setze({ fragen: fragen.filter(q => q.id !== id) })
  const dazu = (q: FrageEntwurf) => setze({ fragen: [...fragen, q] })

  const erlaubt = LEADFORM_VORDEFINIERT.filter(v => !istWohnenVerboten(v))
  const verboten = LEADFORM_VORDEFINIERT.filter(v => istWohnenVerboten(v))

  return (
    <div className="space-y-3">
      <Hinweis ton="sperre" titel={t('crm.werbung.zielgruppen.wohnenTitel', 'Sonderkategorie Wohnen')}>{wohnenGrund}</Hinweis>

      <ol className="space-y-2">
        {fragen.map((q, i) => {
          const verbotenFrage = istWohnenVerboten(q.type)
          return (
            <li key={q.id} className={`rounded-lg border p-3 ${verbotenFrage ? 'border-red-200 bg-red-50/50' : 'border-gray-200 bg-white'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-gray-100 text-[11px] font-semibold text-gray-600">{i + 1}</span>
                <span className="min-w-0 flex-1 text-sm font-semibold text-gray-800">
                  {istEigene(q)
                    ? (q.type === 'DATE_TIME' ? t('crm.werbung.formulare.art.termin', 'Terminanfrage')
                      : q.custom_art === 'MULTIPLE_CHOICE' ? t('crm.werbung.formulare.art.mehrfach', 'Mehrfachauswahl') : t('crm.werbung.formulare.art.kurz', 'Kurze Antwort'))
                    : label(q.type)}
                  {!istEigene(q) && <span className="ml-1 text-xs font-normal text-gray-500">({t('crm.werbung.formulare.vorausgefuellt', 'vorausgefüllt')})</span>}
                </span>
                {!nurLesen && (
                  <span className="flex gap-1">
                    <button type="button" onClick={() => schiebe(i, -1)} disabled={i === 0} className={KNOPF} aria-label={t('crm.werbung.formulare.hoch', 'Nach oben')}>↑</button>
                    <button type="button" onClick={() => schiebe(i, 1)} disabled={i === fragen.length - 1} className={KNOPF} aria-label={t('crm.werbung.formulare.runter', 'Nach unten')}>↓</button>
                    <button type="button" onClick={() => entferne(q.id)} className={KNOPF} aria-label={t('crm.werbung.formulare.entfernen', 'Frage entfernen')}>✕</button>
                  </span>
                )}
              </div>
              {verbotenFrage && <p className="mt-1 text-xs text-red-700">🔒 {wohnenGrund}</p>}

              {istEigene(q) && (
                <div className="mt-2 space-y-2">
                  <div>
                    <input value={q.label} disabled={nurLesen} maxLength={GRENZE.frage + 20}
                      onChange={ev => setzeFrage(q.id, { label: ev.target.value })}
                      placeholder={t('crm.werbung.formulare.frageText', 'Fragetext')}
                      aria-label={t('crm.werbung.formulare.frageText', 'Fragetext')} className={EINGABE_KLEIN} />
                    <Zaehler wert={q.label} max={GRENZE.frage} />
                  </div>
                  {q.type === 'CUSTOM' && (
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="text-xs text-gray-500" htmlFor={`art-${q.id}`}>{t('crm.werbung.formulare.antwortArt', 'Antwort')}</label>
                      <select id={`art-${q.id}`} value={q.custom_art} disabled={nurLesen}
                        onChange={ev => {
                          const art = ev.target.value === 'MULTIPLE_CHOICE' ? 'MULTIPLE_CHOICE' : 'SHORT_ANSWER'
                          setzeFrage(q.id, {
                            custom_art: art,
                            optionen: art === 'MULTIPLE_CHOICE' && !q.optionen.length
                              ? [{ id: neueId(), value: '', key: '' }, { id: neueId(), value: '', key: '' }]
                              : q.optionen,
                          })
                        }}
                        className={`${EINGABE_KLEIN} max-w-[12rem]`}>
                        <option value="MULTIPLE_CHOICE">{t('crm.werbung.formulare.art.mehrfach', 'Mehrfachauswahl')}</option>
                        <option value="SHORT_ANSWER">{t('crm.werbung.formulare.art.kurz', 'Kurze Antwort')}</option>
                      </select>
                    </div>
                  )}
                  {q.type === 'CUSTOM' && q.custom_art === 'MULTIPLE_CHOICE' && (
                    <div className="space-y-1.5 border-l-2 border-gray-100 pl-3">
                      {q.optionen.map((o, j) => (
                        <div key={o.id} className="flex items-center gap-2">
                          <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full border border-gray-400" />
                          <input value={o.value} disabled={nurLesen} maxLength={GRENZE.option + 20}
                            onChange={ev => setzeFrage(q.id, { optionen: q.optionen.map(x => (x.id === o.id ? { ...x, value: ev.target.value, key: x.key && x.key !== schluessel(x.value) ? x.key : schluessel(ev.target.value) } : x)) })}
                            placeholder={t('crm.werbung.formulare.antwortNr', 'Antwort {{n}}', { n: j + 1 })}
                            aria-label={t('crm.werbung.formulare.antwortNr', 'Antwort {{n}}', { n: j + 1 })} className={EINGABE_KLEIN} />
                          {!nurLesen && (
                            <button type="button" onClick={() => setzeFrage(q.id, { optionen: q.optionen.filter(x => x.id !== o.id) })} className={KNOPF}
                              aria-label={t('crm.werbung.formulare.antwortEntfernen', 'Antwort entfernen')}>✕</button>
                          )}
                        </div>
                      ))}
                      {!nurLesen && (
                        <button type="button" onClick={() => setzeFrage(q.id, { optionen: [...q.optionen, { id: neueId(), value: '', key: '' }] })}
                          className="text-xs font-semibold text-hp-navy hover:underline">+ {t('crm.werbung.formulare.antwortNeu', 'Antwort hinzufügen')}</button>
                      )}
                    </div>
                  )}
                  <details className="text-xs">
                    <summary className="cursor-pointer text-gray-500">{t('crm.werbung.formulare.mehrZurFrage', 'Erklärtext, Feldname, Bedingung')}</summary>
                    <div className="mt-2 space-y-2">
                      <label className="block">
                        <span className="text-gray-500">{t('crm.werbung.formulare.erklaerText', 'Erklärtext unter der Frage (optional)')}</span>
                        <input value={q.inline_context} disabled={nurLesen} onChange={ev => setzeFrage(q.id, { inline_context: ev.target.value })} className={EINGABE_KLEIN} />
                      </label>
                      <label className="block">
                        <span className="text-gray-500">{t('crm.werbung.formulare.feldname', 'Feldname im CRM (a-z, 0-9, _)')}</span>
                        <input value={q.key} disabled={nurLesen} placeholder={schluessel(q.label) || 'frage'}
                          onChange={ev => setzeFrage(q.id, { key: ev.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40) })} className={`${EINGABE_KLEIN} font-mono`} />
                      </label>
                      <div className="rounded-md bg-gray-50 px-2 py-1.5 text-gray-600 opacity-80">
                        <p className="font-semibold">🔒 {t('crm.werbung.formulare.bedingung', 'Bedingung: nur zeigen, wenn eine frühere Antwort passt')}</p>
                        <p>{LEADFORM_BEDINGTE_LOGIK_PER_API
                          ? t('crm.werbung.formulare.bedingungBald', 'Folgt im nächsten Schritt.')
                          : t('crm.werbung.formulare.bedingungGesperrt', 'Bedingte Logik legt Meta per API nicht an. Nach dem Anlegen im Werbeanzeigenmanager unter Fragen ergänzen.')}</p>
                      </div>
                    </div>
                  </details>
                </div>
              )}
            </li>
          )
        })}
      </ol>

      {!nurLesen && (
        <div className="flex flex-col gap-2 rounded-lg border border-dashed border-gray-300 p-3 sm:flex-row sm:flex-wrap sm:items-center">
          <select value={neuTyp} onChange={ev => {
            const v = ev.target.value as LeadFormVordefiniert
            setNeuTyp('')
            if (v && !istWohnenVerboten(v) && !vorhanden.has(v)) dazu(vordefiniert(v))
          }} aria-label={t('crm.werbung.formulare.vordefNeu', 'Vordefinierte Frage hinzufügen')} className={`${EINGABE_KLEIN} sm:w-64`}>
            <option value="">{t('crm.werbung.formulare.vordefNeu', 'Vordefinierte Frage hinzufügen')} …</option>
            <optgroup label={t('crm.werbung.formulare.vordefErlaubt', 'Erlaubt')}>
              {erlaubt.map(v => <option key={v} value={v} disabled={vorhanden.has(v)}>{label(v)}{vorhanden.has(v) ? ` (${t('crm.werbung.formulare.schonDrin', 'schon drin')})` : ''}</option>)}
            </optgroup>
            <optgroup label={t('crm.werbung.formulare.vordefGesperrt', 'Unter Wohnen gesperrt')}>
              {verboten.map(v => <option key={v} value={v} disabled>🔒 {label(v)}</option>)}
            </optgroup>
          </select>
          <span className="text-xs text-gray-400">{t('crm.werbung.formulare.oderEigene', 'oder eigene Frage:')}</span>
          {([
            ['MULTIPLE_CHOICE', t('crm.werbung.formulare.art.mehrfach', 'Mehrfachauswahl')],
            ['SHORT_ANSWER', t('crm.werbung.formulare.art.kurz', 'Kurze Antwort')],
            ['DATE_TIME', t('crm.werbung.formulare.art.termin', 'Terminanfrage')],
          ] as const).map(([art, text]) => (
            <button key={art} type="button" disabled={eigene >= LEADFORM_MAX_EIGENE_FRAGEN}
              onClick={() => dazu(art === 'MULTIPLE_CHOICE' ? eigeneFrage('MULTIPLE_CHOICE', '', ['', '']) : eigeneFrage(art))}
              className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
              + {text}
            </button>
          ))}
          <span className="text-[11px] text-gray-400 sm:ml-auto">{t('crm.werbung.formulare.eigeneZaehler', '{{n}} von {{max}} eigenen Fragen', { n: eigene, max: LEADFORM_MAX_EIGENE_FRAGEN })}</span>
        </div>
      )}
    </div>
  )
}
