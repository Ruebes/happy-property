import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LEADFORM_FRAGE_LABEL, type LeadFormFrageTyp } from '../../../../lib/werbeWerkzeuge'
import { istEigene, type FormularEntwurf } from './formularModell'

// ── Live-Vorschau eines Sofortformulars im Telefon-Rahmen ────────────────────
// Nachbau von Metas Ablauf: Intro, Fragen (vorausgefüllte Kontaktfelder +
// eigene Fragen, Einwilligungen, Datenschutz), bei „Höhere Absicht“ der
// Prüfschritt, dann die Abschluss-Seite. Texte im Telefon folgen der Sprache
// des Formulars (nicht der Sprache des CRM). Annäherung, kein Pixel-Abbild.

type Schritt = 'intro' | 'fragen' | 'pruefen' | 'danke'

// Beispielwerte für vorausgefüllte Felder (Meta füllt aus dem Profil)
const BEISPIEL: Partial<Record<LeadFormFrageTyp, string>> = {
  FULL_NAME: 'Max Mustermann', FIRST_NAME: 'Max', LAST_NAME: 'Mustermann', EMAIL: 'max@beispiel.de',
  PHONE: '+49 170 1234567', WHATSAPP_NUMBER: '+49 170 1234567', WORK_EMAIL: 'max@firma.de', WORK_PHONE_NUMBER: '+49 30 123456',
  COMPANY_NAME: 'Muster GmbH', JOB_TITLE: 'Ingenieur',
}

export default function TelefonVorschau({ e, seitenName }: { e: FormularEntwurf; seitenName?: string | null }) {
  const { t } = useTranslation()
  const lng = e.locale.startsWith('en') ? 'en' : 'de'
  // Texte im Telefon in der Sprache des Formulars
  const tf = (key: string, fallback: string, opt?: Record<string, unknown>) => t(key, fallback, { ...(opt ?? {}), lng })

  const schritte: Schritt[] = [
    ...(e.intro_aktiv ? ['intro' as const] : []),
    'fragen',
    ...(e.typ === 'HIGHER_INTENT' ? ['pruefen' as const] : []),
    'danke',
  ]
  const [gewaehlt, setSchritt] = useState<Schritt>(schritte[0])
  const [antworten, setAntworten] = useState<Record<number, string>>({})
  // Fällt ein Schritt weg (Intro aus, Höheres Volumen), zum ersten springen
  const schritt: Schritt = schritte.includes(gewaehlt) ? gewaehlt : schritte[0]
  const idx = schritte.indexOf(schritt)
  const weiter = () => setSchritt(schritte[Math.min(idx + 1, schritte.length - 1)])

  const frageLabel = (type: LeadFormFrageTyp, label: string) => (type === 'CUSTOM' || type === 'DATE_TIME'
    ? label || tf('crm.werbung.formulare.vorschau.ohneText', '(Fragetext fehlt)')
    : tf(`crm.werbung.formulare.frage.${type}`, LEADFORM_FRAGE_LABEL[type] ?? type))

  const knopf = (text: string, onClick?: () => void) => (
    <button type="button" onClick={onClick} className="w-full rounded-lg bg-hp-navy py-2 text-xs font-semibold text-white">{text}</button>
  )

  const schrittName = (s: Schritt) => {
    switch (s) {
      case 'intro': return t('crm.werbung.formulare.vorschau.intro', 'Intro')
      case 'fragen': return t('crm.werbung.formulare.vorschau.fragen', 'Fragen')
      case 'pruefen': return t('crm.werbung.formulare.vorschau.pruefen', 'Prüfen')
      default: return t('crm.werbung.formulare.vorschau.danke', 'Abschluss')
    }
  }

  return (
    <div className="flex flex-col items-center gap-3">
      <div role="tablist" aria-label={t('crm.werbung.formulare.vorschau.schritte', 'Schritte der Vorschau')} className="flex flex-wrap justify-center gap-1">
        {schritte.map((s, i) => (
          <button key={s} type="button" role="tab" aria-selected={s === schritt} onClick={() => setSchritt(s)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${s === schritt ? 'bg-hp-navy text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
            {i + 1}. {schrittName(s)}
          </button>
        ))}
      </div>

      <div className="w-[272px] max-w-full overflow-hidden rounded-[2rem] border-[9px] border-hp-navy bg-white shadow-xl" aria-label={t('crm.werbung.formulare.vorschau.aria', 'Vorschau des Formulars')}>
        <div className="flex h-[520px] flex-col bg-gray-100 text-[12px] text-gray-900">
          {/* Kopf wie bei Meta: Seite + Schließen */}
          <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
            <span aria-hidden="true" className="flex h-7 w-7 items-center justify-center rounded-full bg-hp-navy text-[10px] font-bold text-white">HP</span>
            <span className="min-w-0 flex-1 truncate font-semibold">{seitenName || 'Happy Property'}</span>
            <span aria-hidden="true" className="text-gray-400">✕</span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {schritt === 'intro' && (
              <div className="space-y-3 bg-white">
                <div className="flex h-28 items-end bg-gradient-to-br from-hp-navy to-hp-navy/70 p-3">
                  <span className="rounded bg-white/90 px-1.5 py-0.5 text-[10px] font-semibold text-hp-navy">{seitenName || 'Happy Property'}</span>
                </div>
                <div className="space-y-2 px-4 pb-4">
                  <p className="text-[15px] font-bold leading-snug">{e.intro_headline || e.name}</p>
                  {e.intro_stil === 'LIST'
                    ? <ul className="list-disc space-y-1 pl-4 text-gray-700">{e.intro_punkte.filter(p => p.trim()).map((p, i) => <li key={i}>{p}</li>)}</ul>
                    : e.intro_text && <p className="whitespace-pre-line text-gray-700">{e.intro_text}</p>}
                </div>
              </div>
            )}

            {schritt === 'fragen' && (
              <div className="space-y-2 p-3">
                <div className="rounded-lg bg-white p-3">
                  <p className="font-bold">{e.fragen_ueberschrift || tf('crm.werbung.formulare.vorschau.kontaktTitel', 'Kontaktinformationen')}</p>
                  <p className="mt-0.5 text-[10px] text-gray-500">{tf('crm.werbung.formulare.vorschau.vorausgefuellt', 'Felder sind mit Infos aus dem Profil vorausgefüllt.')}</p>
                </div>
                {e.fragen.map(q => (
                  <div key={q.id} className="rounded-lg bg-white p-3">
                    <p className="font-semibold leading-snug">{frageLabel(q.type, q.label)}</p>
                    {q.inline_context && <p className="mt-0.5 text-[10px] text-gray-500">{q.inline_context}</p>}
                    {!istEigene(q) && (
                      <p className="mt-1.5 border-b border-gray-300 pb-1 text-gray-600">{BEISPIEL[q.type] ?? '…'}</p>
                    )}
                    {q.type === 'DATE_TIME' && (
                      <p className="mt-1.5 rounded border border-gray-300 px-2 py-1 text-gray-500">📅 {tf('crm.werbung.formulare.vorschau.termin', 'Datum und Uhrzeit wählen')}</p>
                    )}
                    {q.type === 'CUSTOM' && q.custom_art === 'SHORT_ANSWER' && (
                      <input value={antworten[q.id] ?? ''} onChange={ev => setAntworten({ ...antworten, [q.id]: ev.target.value })}
                        placeholder={tf('crm.werbung.formulare.vorschau.antwort', 'Antwort eingeben')}
                        aria-label={frageLabel(q.type, q.label)}
                        className="mt-1.5 w-full border-0 border-b border-gray-300 bg-transparent px-0 py-1 text-[12px] focus:outline-none focus:ring-0" />
                    )}
                    {q.type === 'CUSTOM' && q.custom_art === 'MULTIPLE_CHOICE' && (
                      <div className="mt-1.5 space-y-1">
                        {q.optionen.filter(o => o.value.trim()).map(o => {
                          const an = antworten[q.id] === o.key
                          return (
                            <button key={o.id} type="button" onClick={() => setAntworten({ ...antworten, [q.id]: o.key })}
                              className={`flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left ${an ? 'border-hp-navy bg-hp-cream' : 'border-gray-300'}`}>
                              <span aria-hidden="true" className={`h-3 w-3 shrink-0 rounded-full border ${an ? 'border-hp-navy bg-hp-navy' : 'border-gray-400'}`} />
                              {o.value}
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ))}
                {e.einwilligung_aktiv && e.einwilligungen.some(c => c.text.trim()) && (
                  <div className="space-y-1.5 rounded-lg bg-white p-3">
                    {e.einwilligung_titel && <p className="font-semibold">{e.einwilligung_titel}</p>}
                    {e.einwilligung_text && <p className="text-[10px] text-gray-600">{e.einwilligung_text}</p>}
                    {e.einwilligungen.filter(c => c.text.trim()).map(c => (
                      <label key={c.id} className="flex items-start gap-2 text-[11px] text-gray-700">
                        <input type="checkbox" className="mt-0.5 h-3 w-3" aria-label={c.text} />
                        <span>{c.text}{c.pflicht ? '' : ` (${tf('crm.werbung.formulare.vorschau.optional', 'optional')})`}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="px-1 text-[10px] text-gray-500">
                  {tf('crm.werbung.formulare.vorschau.datenschutzSatz', 'Mit dem Absenden gibst du deine Infos an {{seite}} weiter.', { seite: seitenName || 'Happy Property' })}{' '}
                  <span className="text-hp-navy underline">{e.privacy_text || tf('crm.werbung.formulare.std.datenschutz', 'Datenschutzerklärung')}</span>
                </p>
              </div>
            )}

            {schritt === 'pruefen' && (
              <div className="space-y-2 p-3">
                <div className="rounded-lg bg-white p-3">
                  <p className="font-bold">{tf('crm.werbung.formulare.vorschau.pruefenTitel', 'Prüfe deine Angaben')}</p>
                  <p className="mt-0.5 text-[10px] text-gray-500">{tf('crm.werbung.formulare.vorschau.pruefenText', 'Stimmen deine Angaben? Erst dann absenden.')}</p>
                </div>
                {e.fragen.filter(q => !istEigene(q)).map(q => (
                  <div key={q.id} className="rounded-lg bg-white px-3 py-2">
                    <p className="text-[10px] text-gray-500">{frageLabel(q.type, q.label)}</p>
                    <p>{BEISPIEL[q.type] ?? '…'}</p>
                  </div>
                ))}
              </div>
            )}

            {schritt === 'danke' && (
              <div className="flex h-full flex-col items-center justify-center gap-2 bg-white p-5 text-center">
                <span aria-hidden="true" className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-100 text-lg text-emerald-700">✓</span>
                <p className="text-[15px] font-bold">{e.danke_titel || tf('crm.werbung.formulare.std.dankeTitel', 'Danke!')}</p>
                {e.danke_text && <p className="whitespace-pre-line text-gray-700">{e.danke_text}</p>}
              </div>
            )}
          </div>

          {/* Fußzeile mit dem Knopf des Schritts */}
          <div className="border-t border-gray-200 bg-white p-3">
            {schritt === 'intro' && knopf(tf('crm.werbung.formulare.vorschau.weiter', 'Weiter'), weiter)}
            {schritt === 'fragen' && knopf(e.typ === 'HIGHER_INTENT' ? tf('crm.werbung.formulare.vorschau.weiter', 'Weiter') : tf('crm.werbung.formulare.vorschau.absenden', 'Absenden'), weiter)}
            {schritt === 'pruefen' && knopf(tf('crm.werbung.formulare.vorschau.absenden', 'Absenden'), weiter)}
            {schritt === 'danke' && (e.danke_button === 'VIEW_WEBSITE'
              ? knopf(e.danke_button_text || tf('crm.werbung.formulare.vorschau.website', 'Website ansehen'))
              : <p className="text-center text-[10px] text-gray-400">{tf('crm.werbung.formulare.vorschau.keinKnopf', 'Ohne Knopf')}</p>)}
          </div>
        </div>
      </div>
      {schritt === 'danke' && e.danke_button === 'VIEW_WEBSITE' && e.danke_url && (
        <p className="max-w-[272px] break-all text-center text-[10px] text-gray-500">{t('crm.werbung.formulare.vorschau.ziel', 'Knopf öffnet: {{url}}', { url: e.danke_url })}</p>
      )}
      <p className="max-w-[272px] text-center text-[10px] text-gray-400">{t('crm.werbung.formulare.vorschau.annaeherung', 'Annäherung an Metas Darstellung. Die echte Vorschau zeigt Meta nach dem Anlegen.')}</p>
    </div>
  )
}
