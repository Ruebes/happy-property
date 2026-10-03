import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { LOOKALIKE_RATIO_MAX, LOOKALIKE_RATIO_MIN, type AudienceCreateLookalikeRequest } from '../../../../lib/werbeWerkzeuge'
import AssistentRahmen, { zielgruppeErfolg } from './AssistentRahmen'
import { Abschnitt, EINGABE_KLEIN, Einstellung, Haken, Hinweis } from './Bausteine'
import { artLabel } from './useWerkzeugStatus'
import { werkzeugCall, type ZielgruppeZeile } from './werkzeugeApi'
import type { ZielgruppenAssistentProps } from './WebsiteBesucher'

// ── Assistent „Lookalike" ────────────────────────────────────────────────────
// Unter der Sonderkategorie Wohnen gesperrt (Meta-Regel). Alle Immobilien-
// Kampagnen von Happy Property laufen unter Wohnen, darum ist der Assistent
// erst nach der Bestätigung „nicht für Wohnen“ bedienbar. Der Server lehnt
// den Einsatz in Wohnen-Kampagnen zusätzlich ab.

const LAENDER = ['DE', 'AT', 'CH', 'CY', 'ES', 'NL', 'BE', 'LU', 'IT', 'FR'] as const

export default function Lookalike({ offen, onClose, onZurueck, onFertig, status, zielgruppen, vorauswahl }: ZielgruppenAssistentProps & {
  zielgruppen: ZielgruppeZeile[]
  vorauswahl?: string | null
}) {
  const { t } = useTranslation()
  const quellen = useMemo(() => zielgruppen.filter(z => z.art !== 'lookalike'), [zielgruppen])
  const [nichtWohnen, setNichtWohnen] = useState(false)
  const [quelleId, setQuelleId] = useState(vorauswahl ?? '')
  const [land, setLand] = useState<string>('DE')
  const [prozent, setProzent] = useState(1)
  const [name, setName] = useState('')
  const [nameEigen, setNameEigen] = useState(false)

  useEffect(() => { if (vorauswahl) setQuelleId(vorauswahl) }, [vorauswahl])
  const quelle = quellen.find(q => q.id === quelleId) ?? null
  useEffect(() => {
    if (!nameEigen) {
      setName(t('crm.werbung.zielgruppen.lal.nameVorschlag', 'Lookalike {{prozent}} % {{land}} aus {{quelle}}', {
        prozent, land, quelle: quelle?.name ?? '…',
      }).slice(0, 200))
    }
  }, [prozent, land, quelle, nameEigen, t])

  const fehler = useMemo(() => {
    const f: string[] = []
    if (!name.trim()) f.push(t('crm.werbung.zielgruppen.pflicht.name', 'Name der Zielgruppe'))
    if (!quelleId) f.push(t('crm.werbung.zielgruppen.lal.pflicht.quelle', 'Ursprungs-Zielgruppe'))
    if (!(prozent >= LOOKALIKE_RATIO_MIN * 100 && prozent <= LOOKALIKE_RATIO_MAX * 100)) f.push(t('crm.werbung.zielgruppen.lal.pflicht.groesse', 'Größe zwischen 1 und 10 %'))
    return f
  }, [name, quelleId, prozent, t])

  const zusatzSperre = nichtWohnen ? null
    : t('crm.werbung.zielgruppen.lal.sperre', 'Erst bestätigen, dass diese Lookalike nicht in Wohnen-Kampagnen läuft.')

  const aenderung = () => ({
    punkte: [
      { art: 'neu' as const, text: t('crm.werbung.zielgruppen.lal.aenderung.neu', 'Neue Lookalike „{{name}}“ im Werbekonto', { name: name.trim() }) },
      { art: 'neu' as const, text: t('crm.werbung.zielgruppen.lal.aenderung.regel', 'Ähnlich wie „{{quelle}}“, {{prozent}} % der Bevölkerung ({{land}})', { quelle: quelle?.name ?? quelleId, prozent, land }) },
      { art: 'achtung' as const, text: t('crm.werbung.zielgruppen.lal.aenderung.wohnen', 'Nicht in Kampagnen mit der Sonderkategorie Wohnen einsetzbar. Meta lehnt das ab.') },
      { art: 'gleich' as const, text: t('crm.werbung.zielgruppen.aenderung.nichtsSonst', 'Keine Kampagne, Anzeigengruppe oder Anzeige ändert sich.') },
    ],
    lernphase: t('crm.werbung.zielgruppen.aenderung.lernphaseZielgruppe', 'Startet nicht neu. Erst wenn du die Zielgruppe in einer laufenden Anzeigengruppe einsetzt, beginnt dort die Lernphase neu.'),
    warnungen: [t('crm.werbung.zielgruppen.lal.aenderung.dauer', 'Meta baut Lookalikes in 6 bis 24 Stunden auf. Die Ursprungs-Zielgruppe braucht mindestens 100 Personen.')],
  })

  // kontext 'standard': ausdrücklich nicht für Wohnen (sonst lehnt der Server ab)
  const auftrag = (): AudienceCreateLookalikeRequest => ({
    name: name.trim(), source_id: quelleId, land, ratio: Math.round(prozent) / 100, kontext: 'standard',
  })
  const ausfuehren = () => werkzeugCall('audience_create_lookalike', auftrag())
  const vorschau = async () => ({ hinweise: (await werkzeugCall('audience_create_lookalike', { ...auftrag(), vorschau: true })).hinweise ?? [] })

  const gesperrt = !nichtWohnen

  return (
    <AssistentRahmen offen={offen} onClose={onClose} onZurueck={onZurueck} onFertig={onFertig}
      titel={t('crm.werbung.zielgruppen.lal.titel', 'Neue Zielgruppe: Lookalike')}
      untertitel={t('crm.werbung.zielgruppen.lal.untertitel', 'Meta sucht Personen, die einer vorhandenen Zielgruppe ähneln.')}
      fehler={fehler} schreibSperre={status.schreibSperre} pruefSperre={status.pruefSperre} zusatzSperre={zusatzSperre} aenderung={aenderung} ausfuehren={ausfuehren} vorschau={vorschau}
      anlegenText={t('crm.werbung.zielgruppen.anlegen', 'Bei Meta anlegen')}
      erfolgText={zielgruppeErfolg(t, name.trim())}>

      <Hinweis ton="sperre" titel={t('crm.werbung.zielgruppen.lal.wohnenTitel', 'Unter Wohnen gesperrt')}>
        {t('crm.werbung.zielgruppen.lal.wohnenText', 'Lookalikes sind in Kampagnen mit der Sonderkategorie Wohnen nicht erlaubt (Meta-Regel, auch nicht zum Ausschließen). Alle Immobilien-Kampagnen von Happy Property laufen unter Wohnen. Eine Lookalike taugt nur für andere Kampagnen, z. B. Recruiting, Veranstaltungen ohne Immobilienbezug oder Reichweite für die Seite.')}
      </Hinweis>
      <Haken checked={nichtWohnen} onChange={setNichtWohnen}
        label={t('crm.werbung.zielgruppen.lal.bestaetigen', 'Ich nutze diese Lookalike nicht für Immobilien-Kampagnen (Wohnen).')} />

      <fieldset disabled={gesperrt} className={`space-y-4 ${gesperrt ? 'opacity-60' : ''}`}>
        <Abschnitt nummer={1} titel={t('crm.werbung.zielgruppen.lal.quelleTitel', 'Ursprung')}
          alle={(
            <Einstellung fuer="lal-name" label={t('crm.werbung.zielgruppen.feld.name', 'Name')}
              erklaerung={t('crm.werbung.zielgruppen.feld.nameHilfe', 'So heißt die Zielgruppe im Werbemanager und im Kampagnen-Assistenten.')}>
              <input id="lal-name" value={name} maxLength={200} onChange={e => { setName(e.target.value); setNameEigen(true) }} className={EINGABE_KLEIN} />
            </Einstellung>
          )}>
          <Einstellung fuer="lal-quelle" label={t('crm.werbung.zielgruppen.lal.quelle', 'Ursprungs-Zielgruppe')}
            erklaerung={t('crm.werbung.zielgruppen.lal.quelleHilfe', 'Gute Quellen sind Käufer (Kundenliste) oder Personen mit Termin. Mindestens 100 Personen.')}>
            <select id="lal-quelle" value={quelleId} onChange={e => setQuelleId(e.target.value)} className={EINGABE_KLEIN}>
              <option value="">{t('crm.werbung.zielgruppen.lal.quelleWaehlen', 'Bitte wählen …')}</option>
              {quellen.map(q => <option key={q.id} value={q.id}>{q.name} ({artLabel(t, q.art)})</option>)}
            </select>
          </Einstellung>
        </Abschnitt>

        <Abschnitt nummer={2} titel={t('crm.werbung.zielgruppen.lal.zielTitel', 'Größe und Land')}>
          <Einstellung fuer="lal-groesse" label={t('crm.werbung.zielgruppen.lal.groesse', 'Größe: {{n}} %', { n: prozent })}
            erklaerung={t('crm.werbung.zielgruppen.lal.groesseHilfe', '1 % = am ähnlichsten, 10 % = viel größer, aber weniger ähnlich.')}>
            <input id="lal-groesse" type="range" min={LOOKALIKE_RATIO_MIN * 100} max={LOOKALIKE_RATIO_MAX * 100} step={1} value={prozent} onChange={e => setProzent(Number(e.target.value))}
              className="w-full accent-hp-navy" />
          </Einstellung>
          <Einstellung fuer="lal-land" label={t('crm.werbung.zielgruppen.lal.land', 'Land')}
            erklaerung={t('crm.werbung.zielgruppen.lal.landHilfe', 'Seit 1. September 2026 ignoriert Meta das Land bei Lookalikes (sie gelten länderübergreifend). Ausgeliefert wird nur dort, wohin die Anzeigengruppe zielt.')}>
            <select id="lal-land" value={land} onChange={e => setLand(e.target.value)} className={`${EINGABE_KLEIN} w-32`}>
              {LAENDER.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </Einstellung>
        </Abschnitt>
      </fieldset>
    </AssistentRahmen>
  )
}
