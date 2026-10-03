import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Spinner from '../../../ui/Spinner'
import { useToast } from '../../../ui/Toast'
import { LEADFORM_TYP_LABEL, type LeadFormLocale, type LeadformCreateWerkzeugRequest } from '../../../../lib/werbeWerkzeuge'
import LintListe from '../vorrat/LintListe'
import { useServerVorschau } from '../zielgruppen/AssistentRahmen'
import {
  Abschnitt, EINGABE_KLEIN, Einstellung, Haken, Hinweis, Kacheln, MetaAenderungDialog, SchreibSperre, Zaehler,
} from '../zielgruppen/Bausteine'
import { useKatalog, type WerkzeugStatus } from '../zielgruppen/useWerkzeugStatus'
import { ladeFormular, werkzeugCall, werkzeugFehlerText } from '../zielgruppen/werkzeugeApi'
import FragenEditor from './FragenEditor'
import TelefonVorschau from './TelefonVorschau'
import {
  DATENSCHUTZ_LINK, GRENZE, TERMIN_LINK, ausSpec, eigeneZahl, neueId, pruefeFormular, spracheWechseln, zuSpec, type FormularEntwurf,
} from './formularModell'

// ── Editor für Sofortformulare ───────────────────────────────────────────────
// Abschnitte wie bei Meta (Formulartyp, Intro, Fragen, Datenschutz und
// Einwilligungen, Abschluss-Seite, Einstellungen), jeweils „Das Wichtigste“
// zuerst. Rechts (Telefon: eigener Reiter) die Live-Vorschau. Anlegen nur
// über „Das ändert sich bei Meta“ mit Server-Prüfung (vorschau: true).
// Bei Meta angelegte Formulare sind unveränderlich: sie öffnen nur lesend,
// „Als Kopie bearbeiten“ macht daraus ein neues Formular.

export type EditorStart =
  | { art: 'neu'; entwurf: FormularEntwurf }
  /** Bestehendes Formular lesend öffnen bzw. gleich als Kopie zum Bearbeiten */
  | { art: 'ansehen' | 'kopie'; id: string; name: string }

export default function FormularEditor({ start, status, onClose, onAngelegt, onKopieren, onEntwurf }: {
  start: EditorStart
  status: WerkzeugStatus
  onClose: () => void
  /** Nach dem Anlegen bei Meta (Liste neu laden, lokalen Entwurf löschen) */
  onAngelegt: () => void
  /** Direkt bei Meta kopieren (Formular unverändert) */
  onKopieren: (f: { id: string; name: string }) => void
  /** Jede Änderung an einem neuen Formular (lokal merken) */
  onEntwurf?: (e: FormularEntwurf) => void
}) {
  const { t } = useTranslation()
  const toast = useToast()
  const { katalog } = useKatalog(true)
  const [e, setE] = useState<FormularEntwurf | null>(start.art === 'neu' ? start.entwurf : null)
  const [nurLesen, setNurLesen] = useState(start.art === 'ansehen')
  const [ladeFehler, setLadeFehler] = useState<string | null>(null)
  const [ladeHinweise, setLadeHinweise] = useState<string[]>([])
  const [ansicht, setAnsicht] = useState<'bearbeiten' | 'vorschau'>('bearbeiten')
  const [zeigeFehler, setZeigeFehler] = useState(false)
  const [pruefen, setPruefen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serverFehler, setServerFehler] = useState<string | null>(null)
  const obenRef = useRef<HTMLDivElement>(null)

  // Bestehendes Formular laden (nur lesend)
  useEffect(() => {
    if (start.art === 'neu') return
    const kopie = start.art === 'kopie'
    let lebt = true
    ladeFormular(start.id)
      .then(r => {
        if (!lebt) return
        const geladen = ausSpec(r.spec, r.form?.page_id ?? null)
        if (kopie) geladen.name = `${geladen.name || start.name} - ${t('crm.werbung.formulare.kopie', 'Kopie')}`.slice(0, GRENZE.name)
        setE(geladen)
        setLadeHinweise([...(r.nicht_uebernommen ?? []).map(x => t('crm.werbung.formulare.nichtUebernommen', 'Nicht übernommen: {{x}}', { x })), ...(r.warnings ?? [])])
      })
      .catch(err => { if (lebt) setLadeFehler(werkzeugFehlerText(err, t)) })
    return () => { lebt = false }
  }, [start, t])

  const setze = (patch: Partial<FormularEntwurf>) => {
    if (!e) return
    const neu = { ...e, ...patch }
    setE(neu)
    if (!nurLesen && start.art === 'neu') onEntwurf?.(neu)
  }

  const verboteneNamen = useMemo(() => katalog?.lint_context?.forbidden_names ?? [], [katalog])
  const pruefung = useMemo(() => (e ? pruefeFormular(e, t, verboteneNamen) : null), [e, t, verboteneNamen])
  const blocker = pruefung ? pruefung.lint.filter(i => i.severity === 'blocker') : []
  const offen = (pruefung?.fehler.length ?? 0) + blocker.length

  const auftrag = (): LeadformCreateWerkzeugRequest | null => (e ? { ...(e.page_id ? { page_id: e.page_id } : {}), spec: zuSpec(e) } : null)
  const sv = useServerVorschau(async () => {
    const a = auftrag()
    if (!a) return { hinweise: [] }
    const r = await werkzeugCall('leadform_create', { ...a, vorschau: true })
    return { hinweise: r.hinweise ?? [] }
  })

  const weiter = () => {
    setServerFehler(null)
    if (offen > 0) {
      setZeigeFehler(true)
      obenRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      return
    }
    setPruefen(true)
    void sv.starten()
  }

  const anlegen = async () => {
    const a = auftrag()
    if (!a) return
    setBusy(true)
    try {
      await werkzeugCall('leadform_create', a)
      toast.success(t('crm.werbung.formulare.angelegt', 'Sofortformular „{{name}}“ bei Meta angelegt', { name: a.spec.name }))
      setPruefen(false)
      onAngelegt()
    } catch (err) {
      console.error('[Formulare] Anlegen:', err)
      const text = werkzeugFehlerText(err, t)
      setServerFehler(text)
      setPruefen(false)
      toast.error(text)
    } finally {
      setBusy(false)
    }
  }

  const alsKopie = () => {
    if (!e) return
    setE({ ...e, name: `${e.name} - ${t('crm.werbung.formulare.kopie', 'Kopie')}`.slice(0, GRENZE.name) })
    setNurLesen(false)
  }

  const seiten = katalog?.pages ?? []
  const seitenName = (e?.page_id ? seiten.find(p => p.id === e.page_id)?.name : null)
    ?? seiten.find(p => p.id === status.einstellungen?.pageId)?.name ?? null

  const titel = start.art !== 'neu' && nurLesen
    ? t('crm.werbung.formulare.ansehenTitel', 'Sofortformular: {{name}}', { name: start.name })
    : t('crm.werbung.formulare.neuTitel', 'Neues Sofortformular')

  const aenderung = e ? {
    punkte: [
      { art: 'neu' as const, text: t('crm.werbung.formulare.aenderung.neu', 'Neues Sofortformular „{{name}}“ auf der Facebook-Seite {{seite}}', { name: e.name.trim(), seite: seitenName ?? 'Happy Property' }) },
      { art: 'neu' as const, text: t('crm.werbung.formulare.aenderung.inhalt', '{{typ}}, {{n}} Fragen ({{eigene}} eigene), Sprache {{sprache}}', {
        typ: t(`crm.werbung.formulare.typ.${e.typ}`, LEADFORM_TYP_LABEL[e.typ]), n: e.fragen.length, eigene: eigeneZahl(e),
        sprache: e.locale === 'de_DE' ? t('crm.werbung.formulare.sprache.de', 'Deutsch') : t('crm.werbung.formulare.sprache.en', 'Englisch'),
      }) },
      { art: 'achtung' as const, text: t('crm.werbung.formulare.aenderung.fest', 'Bei Meta lässt sich ein Formular nach dem Anlegen nicht mehr ändern, nur kopieren.') },
      { art: 'gleich' as const, text: t('crm.werbung.formulare.aenderung.nichtsSonst', 'Keine Anzeige ändert sich. Leads aus dem Formular laufen wie bisher ins CRM.') },
    ],
    lernphase: t('crm.werbung.formulare.aenderung.lernphase', 'Startet nicht neu. Erst wenn du das Formular in einer Anzeige verwendest (neue Anzeige oder Tausch), beginnt die Lernphase der Anzeigengruppe neu.'),
  } : null

  const sprachen: Array<{ wert: LeadFormLocale; text: string }> = [
    { wert: 'de_DE', text: t('crm.werbung.formulare.sprache.de', 'Deutsch') },
    { wert: 'en_US', text: t('crm.werbung.formulare.sprache.enUs', 'Englisch (USA)') },
    { wert: 'en_GB', text: t('crm.werbung.formulare.sprache.enGb', 'Englisch (UK)') },
  ]

  const fuss = (
    <>
      {e && !nurLesen && offen > 0 && (
        <span className="text-xs text-amber-700 sm:mr-auto">{t('crm.werbung.formulare.offen', '{{n}} Punkte offen', { n: offen })}</span>
      )}
      <button type="button" onClick={onClose} className="hp-btn hp-btn-ghost">{t('crm.werbung.zielgruppen.schliessen', 'Schließen')}</button>
      {e && nurLesen && start.art !== 'neu' && (
        <>
          <button type="button" onClick={() => onKopieren({ id: start.id, name: start.name })} disabled={!!status.schreibSperre}
            title={status.schreibSperre ?? undefined} className="hp-btn hp-btn-ghost">
            {t('crm.werbung.formulare.direktKopieren', 'Bei Meta kopieren')}
          </button>
          <button type="button" onClick={alsKopie} className="hp-btn hp-btn-primary">{t('crm.werbung.formulare.alsKopie', 'Als Kopie bearbeiten')}</button>
        </>
      )}
      {e && !nurLesen && (
        <button type="button" onClick={weiter} disabled={!!status.pruefSperre} title={status.pruefSperre ?? undefined} className="hp-btn hp-btn-primary">
          {t('crm.werbung.formulare.pruefenAnlegen', 'Prüfen und bei Meta anlegen')}
        </button>
      )}
    </>
  )

  return (
    <>
      <Modal open onClose={onClose} size="full" title={titel} footer={fuss}>
        {!e ? (
          ladeFehler
            ? <Hinweis ton="fehler" titel={t('crm.werbung.formulare.ladeFehlerEinzel', 'Formular konnte nicht geladen werden')}>{ladeFehler}</Hinweis>
            : <div className="flex justify-center py-16"><Spinner size="lg" /></div>
        ) : (
          <div ref={obenRef} className="space-y-4">
            {/* Telefon: zwischen Bearbeiten und Vorschau wechseln */}
            <div className="flex rounded-lg border border-gray-200 lg:hidden">
              {(['bearbeiten', 'vorschau'] as const).map(a => (
                <button key={a} type="button" onClick={() => setAnsicht(a)} aria-pressed={ansicht === a}
                  className={`flex-1 py-2 text-sm font-semibold ${ansicht === a ? 'bg-hp-navy text-white' : 'bg-white text-gray-600'}`}>
                  {a === 'bearbeiten' ? t('crm.werbung.formulare.bearbeiten', 'Bearbeiten') : t('crm.werbung.formulare.vorschauReiter', 'Vorschau')}
                </button>
              ))}
            </div>

            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
              <div className={`min-w-0 space-y-4 ${ansicht === 'vorschau' ? 'max-lg:hidden' : ''}`}>
                {nurLesen && (
                  <Hinweis ton="sperre" titel={t('crm.werbung.formulare.festTitel', 'Bei Meta angelegt, nicht änderbar')}>
                    {t('crm.werbung.formulare.festText', 'Meta erlaubt keine Änderungen an bestehenden Sofortformularen. Mit „Als Kopie bearbeiten“ entsteht daraus ein neues Formular. Archivieren oder Löschen gibt es hier bewusst nicht.')}
                  </Hinweis>
                )}
                {!nurLesen && <SchreibSperre grund={status.schreibSperre} />}
                {ladeHinweise.map((h, i) => <Hinweis key={i} ton="warnung">{h}</Hinweis>)}
                {serverFehler && <Hinweis ton="fehler" titel={t('crm.werbung.zielgruppen.serverFehler', 'Meta hat abgelehnt')}>{serverFehler}</Hinweis>}
                {!nurLesen && zeigeFehler && pruefung && (pruefung.fehler.length > 0 || blocker.length > 0) && (
                  <Hinweis ton="warnung" titel={t('crm.werbung.zielgruppen.fehlt', 'Bitte noch ergänzen:')}>
                    <ul className="list-disc pl-4">{pruefung.fehler.map(f => <li key={f}>{f}</li>)}</ul>
                    {blocker.length > 0 && <div className="mt-2"><LintListe issues={blocker} /></div>}
                  </Hinweis>
                )}
                {!nurLesen && pruefung && pruefung.warnungen.length > 0 && (
                  <Hinweis ton="warnung">{pruefung.warnungen.map(w => <p key={w}>{w}</p>)}</Hinweis>
                )}

                <fieldset disabled={nurLesen} className="space-y-4">
                  {/* 1. Formular */}
                  <Abschnitt nummer={1} alleOffen={nurLesen} titel={t('crm.werbung.formulare.abschnitt.formular', 'Formulartyp und Sprache')}
                    alle={(
                      <Einstellung fuer="lf-seite" label={t('crm.werbung.formulare.seite', 'Facebook-Seite')}
                        erklaerung={t('crm.werbung.formulare.seiteHilfe', 'Das Formular gehört zu dieser Seite. Anzeigen mit dem Formular müssen dieselbe Seite nutzen.')}>
                        <select id="lf-seite" value={e.page_id} onChange={ev => setze({ page_id: ev.target.value })} className={EINGABE_KLEIN}>
                          <option value="">{t('crm.werbung.formulare.seiteStandard', 'Standard-Seite (Werbe-Einstellungen)')}</option>
                          {seiten.map(p => <option key={p.id} value={p.id}>{p.name} ({p.id})</option>)}
                          {e.page_id && !seiten.some(p => p.id === e.page_id) && <option value={e.page_id}>{e.page_id}</option>}
                        </select>
                      </Einstellung>
                    )}>
                    <Einstellung fuer="lf-name" label={t('crm.werbung.formulare.feld.name', 'Formularname')}
                      erklaerung={t('crm.werbung.formulare.nameHilfe', 'Nur intern sichtbar, z. B. im Assistenten bei der Formular-Auswahl.')}>
                      <input id="lf-name" value={e.name} onChange={ev => setze({ name: ev.target.value })} className={EINGABE_KLEIN} />
                      <Zaehler wert={e.name} max={GRENZE.name} />
                    </Einstellung>
                    <Einstellung label={t('crm.werbung.formulare.typLabel', 'Formulartyp')}
                      erklaerung={t('crm.werbung.formulare.typHilfe', 'Höhere Absicht fügt vor dem Absenden einen Prüfschritt ein: weniger, aber ernsthaftere Leads.')}>
                      <Kacheln name="lf-typ" wert={e.typ} onChange={typ => setze({ typ })} optionen={[
                        { wert: 'HIGHER_INTENT', empfohlen: true, titel: t('crm.werbung.formulare.typ.HIGHER_INTENT', LEADFORM_TYP_LABEL.HIGHER_INTENT), text: t('crm.werbung.formulare.typ.hoeherText', 'Mit Prüfschritt „Prüfe deine Angaben“.') },
                        { wert: 'MORE_VOLUME', titel: t('crm.werbung.formulare.typ.MORE_VOLUME', LEADFORM_TYP_LABEL.MORE_VOLUME), text: t('crm.werbung.formulare.typ.volumenText', 'Schnell abgeschickt, mehr Leads, mehr Streuverlust.') },
                      ]} />
                    </Einstellung>
                    <Einstellung fuer="lf-sprache" label={t('crm.werbung.formulare.spracheLabel', 'Sprache')} empfohlen={e.locale === 'de_DE'}
                      erklaerung={t('crm.werbung.formulare.spracheHilfe', 'In dieser Sprache zeigt Meta die vordefinierten Felder und Knöpfe.')}>
                      <select id="lf-sprache" value={e.locale} onChange={ev => setze(spracheWechseln(e, ev.target.value as LeadFormLocale))} className={`${EINGABE_KLEIN} sm:w-56`}>
                        {sprachen.map(s => <option key={s.wert} value={s.wert}>{s.text}</option>)}
                      </select>
                    </Einstellung>
                  </Abschnitt>

                  {/* 2. Intro */}
                  <Abschnitt nummer={2} alleOffen={nurLesen} titel={t('crm.werbung.formulare.abschnitt.intro', 'Intro')}
                    alle={(
                      <Einstellung label={t('crm.werbung.formulare.introStil', 'Darstellung')}
                        erklaerung={t('crm.werbung.formulare.introStilHilfe', 'Stichpunkte lesen sich am Telefon schneller als ein Absatz.')}>
                        <Kacheln name="lf-stil" wert={e.intro_stil} onChange={intro_stil => setze({ intro_stil })} optionen={[
                          { wert: 'LIST', empfohlen: true, titel: t('crm.werbung.formulare.stil.liste', 'Stichpunkte') },
                          { wert: 'PARAGRAPH', titel: t('crm.werbung.formulare.stil.absatz', 'Absatz') },
                        ]} />
                      </Einstellung>
                    )}>
                    <Haken checked={e.intro_aktiv} onChange={intro_aktiv => setze({ intro_aktiv })}
                      label={<>{t('crm.werbung.formulare.introAn', 'Intro zeigen')} <span className="text-xs text-emerald-700">({t('crm.werbung.zielgruppen.empfohlen', 'Empfohlen für Happy Property')})</span></>}
                      hilfe={t('crm.werbung.formulare.introHilfe', 'Erster Bildschirm: sagt, worum es geht und was danach passiert.')} />
                    {e.intro_aktiv && (
                      <>
                        <Einstellung fuer="lf-intro-titel" label={t('crm.werbung.formulare.feld.introTitel', 'Intro-Überschrift')}
                          erklaerung={t('crm.werbung.formulare.introTitelHilfe', 'Ab der ersten Sekunde klar: Immobilien auf Zypern, EU.')}>
                          <input id="lf-intro-titel" value={e.intro_headline} onChange={ev => setze({ intro_headline: ev.target.value })} className={EINGABE_KLEIN} />
                          <Zaehler wert={e.intro_headline} max={GRENZE.introTitel} />
                        </Einstellung>
                        {e.intro_stil === 'LIST' ? (
                          <Einstellung label={t('crm.werbung.formulare.introPunkte', 'Stichpunkte')}>
                            <div className="space-y-1.5">
                              {e.intro_punkte.map((p, i) => (
                                <div key={i} className="flex items-center gap-2">
                                  <span aria-hidden="true" className="text-gray-400">•</span>
                                  <input value={p} onChange={ev => setze({ intro_punkte: e.intro_punkte.map((x, j) => (j === i ? ev.target.value : x)) })}
                                    aria-label={t('crm.werbung.formulare.punktNr', 'Stichpunkt {{n}}', { n: i + 1 })} className={EINGABE_KLEIN} />
                                  <button type="button" onClick={() => setze({ intro_punkte: e.intro_punkte.filter((_, j) => j !== i) })}
                                    className="rounded-md border border-gray-200 px-1.5 py-0.5 text-xs text-gray-600" aria-label={t('crm.werbung.formulare.punktEntfernen', 'Stichpunkt entfernen')}>✕</button>
                                </div>
                              ))}
                              {e.intro_punkte.length < 5 && (
                                <button type="button" onClick={() => setze({ intro_punkte: [...e.intro_punkte, ''] })} className="text-xs font-semibold text-hp-navy hover:underline">
                                  + {t('crm.werbung.formulare.punktNeu', 'Stichpunkt hinzufügen')}
                                </button>
                              )}
                            </div>
                          </Einstellung>
                        ) : (
                          <Einstellung fuer="lf-intro-text" label={t('crm.werbung.formulare.feld.introText', 'Intro-Text')}>
                            <textarea id="lf-intro-text" rows={3} value={e.intro_text} onChange={ev => setze({ intro_text: ev.target.value })} className={EINGABE_KLEIN} />
                            <Zaehler wert={e.intro_text} max={GRENZE.introText} />
                          </Einstellung>
                        )}
                      </>
                    )}
                  </Abschnitt>

                  {/* 3. Fragen */}
                  <Abschnitt nummer={3} alleOffen={nurLesen} titel={t('crm.werbung.formulare.abschnitt.fragen', 'Fragen')}
                    untertitel={t('crm.werbung.formulare.fragenUntertitel', 'Kontaktfelder füllt Meta vor. Eigene Fragen trennen ernsthafte von neugierigen Leads.')}
                    alle={(
                      <>
                        <Einstellung fuer="lf-fragen-titel" label={t('crm.werbung.formulare.fragenTitel', 'Überschrift über den Fragen')}
                          erklaerung={t('crm.werbung.formulare.fragenTitelHilfe', 'Leer lassen für Metas Standard („Kontaktinformationen“).')}>
                          <input id="lf-fragen-titel" value={e.fragen_ueberschrift} onChange={ev => setze({ fragen_ueberschrift: ev.target.value })} className={EINGABE_KLEIN} />
                          <Zaehler wert={e.fragen_ueberschrift} max={GRENZE.fragenTitel} />
                        </Einstellung>
                        <Haken checked={e.sms_bestaetigung} onChange={sms_bestaetigung => setze({ sms_bestaetigung })}
                          label={t('crm.werbung.formulare.sms', 'Telefonnummer per SMS-Code bestätigen')}
                          hilfe={t('crm.werbung.formulare.smsHilfe', 'Weniger falsche Nummern, aber mehr Abbrüche. Braucht die Frage Telefonnummer.')} />
                      </>
                    )}>
                    <FragenEditor e={e} setze={setze} nurLesen={nurLesen} />
                  </Abschnitt>

                  {/* 4. Datenschutz und Einwilligungen */}
                  <Abschnitt nummer={4} alleOffen={nurLesen} titel={t('crm.werbung.formulare.abschnitt.datenschutz', 'Datenschutz und Einwilligungen')}
                    alle={(
                      <>
                        <Einstellung fuer="lf-ew-titel" label={t('crm.werbung.formulare.einwTitel', 'Überschrift des Haftungsausschlusses')}>
                          <input id="lf-ew-titel" value={e.einwilligung_titel} onChange={ev => setze({ einwilligung_titel: ev.target.value })} className={EINGABE_KLEIN} />
                          <Zaehler wert={e.einwilligung_titel} max={GRENZE.einwilligungTitel} />
                        </Einstellung>
                        <Einstellung fuer="lf-ew-text" label={t('crm.werbung.formulare.einwText', 'Text über den Kästchen (optional)')}>
                          <textarea id="lf-ew-text" rows={2} value={e.einwilligung_text} onChange={ev => setze({ einwilligung_text: ev.target.value })} className={EINGABE_KLEIN} />
                        </Einstellung>
                      </>
                    )}>
                    <Einstellung fuer="lf-ds-url" label={t('crm.werbung.formulare.datenschutzUrl', 'Link zur Datenschutzerklärung')} empfohlen={e.privacy_url === DATENSCHUTZ_LINK}
                      erklaerung={t('crm.werbung.formulare.datenschutzHilfe', 'Pflicht bei Meta. Steht unter den Fragen.')}>
                      <input id="lf-ds-url" value={e.privacy_url} onChange={ev => setze({ privacy_url: ev.target.value })} className={EINGABE_KLEIN} />
                    </Einstellung>
                    <Einstellung fuer="lf-ds-text" label={t('crm.werbung.formulare.feld.linkText', 'Link-Text')}>
                      <input id="lf-ds-text" value={e.privacy_text} onChange={ev => setze({ privacy_text: ev.target.value })} className={EINGABE_KLEIN} />
                      <Zaehler wert={e.privacy_text} max={GRENZE.linkText} />
                    </Einstellung>
                    <Haken checked={e.einwilligung_aktiv} onChange={einwilligung_aktiv => setze({ einwilligung_aktiv })}
                      label={<>{t('crm.werbung.formulare.einwAn', 'Einwilligung zur Kontaktaufnahme abfragen')} <span className="text-xs text-emerald-700">({t('crm.werbung.zielgruppen.empfohlen', 'Empfohlen für Happy Property')})</span></>}
                      hilfe={t('crm.werbung.formulare.einwHilfe', 'Kästchen sind nie vorausgewählt. Pflicht-Kästchen müssen angehakt werden.')} />
                    {e.einwilligung_aktiv && (
                      <div className="space-y-2">
                        {e.einwilligungen.map((c, i) => (
                          <div key={c.id} className="space-y-1 rounded-lg border border-gray-200 p-2">
                            <textarea rows={2} value={c.text} aria-label={t('crm.werbung.formulare.einwNr', 'Einwilligung {{n}}', { n: i + 1 })}
                              onChange={ev => setze({ einwilligungen: e.einwilligungen.map(x => (x.id === c.id ? { ...x, text: ev.target.value } : x)) })}
                              className={EINGABE_KLEIN} />
                            <div className="flex items-center justify-between gap-2">
                              <Haken checked={c.pflicht} onChange={pflicht => setze({ einwilligungen: e.einwilligungen.map(x => (x.id === c.id ? { ...x, pflicht } : x)) })}
                                label={t('crm.werbung.formulare.pflicht', 'Pflicht')} />
                              <button type="button" onClick={() => setze({ einwilligungen: e.einwilligungen.filter(x => x.id !== c.id) })}
                                className="text-xs text-gray-500 hover:text-red-700">{t('crm.werbung.formulare.einwEntfernen', 'Entfernen')}</button>
                            </div>
                          </div>
                        ))}
                        {e.einwilligungen.length < 5 && (
                          <button type="button" onClick={() => setze({ einwilligungen: [...e.einwilligungen, { id: neueId(), key: `einwilligung_${e.einwilligungen.length + 1}`, text: '', pflicht: false }] })}
                            className="text-xs font-semibold text-hp-navy hover:underline">+ {t('crm.werbung.formulare.einwNeu', 'Kästchen hinzufügen')}</button>
                        )}
                      </div>
                    )}
                  </Abschnitt>

                  {/* 5. Abschluss-Seite */}
                  <Abschnitt nummer={5} alleOffen={nurLesen} titel={t('crm.werbung.formulare.abschnitt.abschluss', 'Abschluss-Seite')}>
                    <Einstellung fuer="lf-danke-titel" label={t('crm.werbung.formulare.dankeTitel', 'Überschrift')}>
                      <input id="lf-danke-titel" value={e.danke_titel} onChange={ev => setze({ danke_titel: ev.target.value })} className={EINGABE_KLEIN} />
                      <Zaehler wert={e.danke_titel} max={GRENZE.dankeTitel} />
                    </Einstellung>
                    <Einstellung fuer="lf-danke-text" label={t('crm.werbung.formulare.dankeText', 'Beschreibung')}
                      erklaerung={t('crm.werbung.formulare.dankeTextHilfe', 'Sag, was als Nächstes passiert.')}>
                      <textarea id="lf-danke-text" rows={2} value={e.danke_text} onChange={ev => setze({ danke_text: ev.target.value })} className={EINGABE_KLEIN} />
                      <Zaehler wert={e.danke_text} max={GRENZE.dankeText} />
                    </Einstellung>
                    <Einstellung label={t('crm.werbung.formulare.button', 'Button')}
                      erklaerung={t('crm.werbung.formulare.buttonHilfe', 'Mit Button zur Terminbuchung bucht ein Teil der Leads sofort selbst.')}>
                      <Kacheln name="lf-button" wert={e.danke_button} onChange={danke_button => setze({ danke_button })} optionen={[
                        { wert: 'VIEW_WEBSITE', empfohlen: true, titel: t('crm.werbung.formulare.buttonWebsite', 'Website öffnen'), text: t('crm.werbung.formulare.buttonWebsiteText', 'z. B. direkt zu /termin') },
                        { wert: 'NONE', titel: t('crm.werbung.formulare.buttonKeiner', 'Kein Button') },
                      ]} />
                    </Einstellung>
                    {e.danke_button === 'VIEW_WEBSITE' && (
                      <>
                        <Einstellung fuer="lf-button-text" label={t('crm.werbung.formulare.buttonText', 'Button-Text')}>
                          <input id="lf-button-text" value={e.danke_button_text} onChange={ev => setze({ danke_button_text: ev.target.value })} className={EINGABE_KLEIN} />
                          <Zaehler wert={e.danke_button_text} max={GRENZE.buttonText} />
                        </Einstellung>
                        <Einstellung fuer="lf-button-url" label={t('crm.werbung.formulare.buttonLink', 'Button-Link')} empfohlen={e.danke_url === TERMIN_LINK}
                          erklaerung={t('crm.werbung.formulare.buttonLinkHilfe', 'Mit utm_source=meta zählt eine Buchung über den Button als Meta-Lead (META-Badge im CRM, Conversions API).')}>
                          <input id="lf-button-url" value={e.danke_url} onChange={ev => setze({ danke_url: ev.target.value })} className={EINGABE_KLEIN} />
                        </Einstellung>
                      </>
                    )}
                  </Abschnitt>

                  {/* 6. Einstellungen */}
                  <Abschnitt nummer={6} alleOffen={nurLesen} titel={t('crm.werbung.formulare.abschnitt.einstellungen', 'Einstellungen')}
                    alle={(
                      <Einstellung label={t('crm.werbung.formulare.tracking', 'Tracking-Parameter')}
                        erklaerung={t('crm.werbung.formulare.trackingHilfe', 'Kommen mit jedem Lead zurück, z. B. kampagne = planb.')}>
                        <div className="space-y-1.5">
                          {e.tracking.map(tp => (
                            <div key={tp.id} className="flex items-center gap-2">
                              <input value={tp.key} placeholder={t('crm.werbung.formulare.trackingName', 'Name')} aria-label={t('crm.werbung.formulare.trackingName', 'Name')}
                                onChange={ev => setze({ tracking: e.tracking.map(x => (x.id === tp.id ? { ...x, key: ev.target.value } : x)) })} className={`${EINGABE_KLEIN} font-mono`} />
                              <input value={tp.value} placeholder={t('crm.werbung.formulare.trackingWert', 'Wert')} aria-label={t('crm.werbung.formulare.trackingWert', 'Wert')}
                                onChange={ev => setze({ tracking: e.tracking.map(x => (x.id === tp.id ? { ...x, value: ev.target.value } : x)) })} className={EINGABE_KLEIN} />
                              <button type="button" onClick={() => setze({ tracking: e.tracking.filter(x => x.id !== tp.id) })}
                                className="rounded-md border border-gray-200 px-1.5 py-0.5 text-xs text-gray-600" aria-label={t('crm.werbung.formulare.trackingEntfernen', 'Parameter entfernen')}>✕</button>
                            </div>
                          ))}
                          {e.tracking.length < GRENZE.trackingAnzahl && (
                            <button type="button" onClick={() => setze({ tracking: [...e.tracking, { id: neueId(), key: '', value: '' }] })}
                              className="text-xs font-semibold text-hp-navy hover:underline">+ {t('crm.werbung.formulare.trackingNeu', 'Parameter hinzufügen')}</button>
                          )}
                        </div>
                      </Einstellung>
                    )}>
                    <Haken checked={e.nur_beworbene_leads} onChange={nur_beworbene_leads => setze({ nur_beworbene_leads })}
                      label={<>{t('crm.werbung.formulare.organisch', 'Nur Leads aus Werbeanzeigen')} <span className="text-xs text-emerald-700">({t('crm.werbung.zielgruppen.empfohlen', 'Empfohlen für Happy Property')})</span></>}
                      hilfe={t('crm.werbung.formulare.organischHilfe', 'Blendet das Formular für Personen ohne Anzeige aus (organische Leads, oft Spam).')} />
                    <Hinweis>{t('crm.werbung.formulare.leadsCrm', 'Leads aus Sofortformularen laufen wie bisher automatisch ins CRM (Abgleich alle 15 Minuten).')}</Hinweis>
                  </Abschnitt>
                </fieldset>
              </div>

              <div className={ansicht === 'bearbeiten' ? 'max-lg:hidden' : ''}>
                <div className="lg:sticky lg:top-0">
                  <TelefonVorschau e={e} seitenName={seitenName} />
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {aenderung && (
        <MetaAenderungDialog offen={pruefen} punkte={aenderung.punkte} lernphase={aenderung.lernphase}
          warnungen={pruefung?.warnungen} bestaetigen={t('crm.werbung.formulare.anlegen', 'Bei Meta anlegen')}
          busy={busy} gesperrt={status.schreibSperre ?? sv.sperre} zusatz={sv.box}
          onBestaetigen={() => void anlegen()} onClose={() => setPruefen(false)} />
      )}
    </>
  )
}
