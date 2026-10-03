import { useTranslation } from 'react-i18next'
import Badge, { type BadgeTone } from '../../../ui/Badge'
import Modal from '../../../ui/Modal'
import Icon, { type IconId } from '../../../shell/Icon'
import Interaktion from './Interaktion'
import Kundenliste from './Kundenliste'
import Lookalike from './Lookalike'
import WebsiteBesucher from './WebsiteBesucher'
import type { WerkzeugStatus } from './useWerkzeugStatus'
import type { ZielgruppeZeile } from './werkzeugeApi'

// ── Neue Zielgruppe: Art wählen, dann der passende Assistent ─────────────────
// Was Wohnen verbietet (Lookalike, gespeicherte Zielgruppe), steht grau mit
// Grund da. Die Kundenliste sieht nur ein Admin.

export type ZielgruppenSchritt = 'wahl' | 'website' | 'interaktion' | 'lookalike' | 'kundenliste'

interface Karte {
  id: Exclude<ZielgruppenSchritt, 'wahl'> | 'gespeichert'
  icon: IconId
  titel: string
  text: string
  badge: { ton: BadgeTone; text: string }
  gesperrt?: string
  versteckt?: boolean
}

export default function NeueZielgruppe({ schritt, setSchritt, status, zielgruppen, lookalikeQuelle, onFertig }: {
  schritt: ZielgruppenSchritt | null
  setSchritt: (s: ZielgruppenSchritt | null) => void
  status: WerkzeugStatus
  zielgruppen: ZielgruppeZeile[]
  lookalikeQuelle: string | null
  onFertig: () => void
}) {
  const { t } = useTranslation()
  const erlaubt = { ton: 'success' as const, text: t('crm.werbung.zielgruppen.wahl.erlaubt', 'Unter Wohnen erlaubt') }
  const freigegeben = status.einstellungen?.kundenlisteFreigegeben === true

  const karten: Karte[] = [
    {
      id: 'website', icon: 'webAnalytics', badge: erlaubt,
      titel: t('crm.werbung.zielgruppen.wahl.website', 'Website-Besucher'),
      text: t('crm.werbung.zielgruppen.wahl.websiteText', 'Besucher von /termin, Plan-B- und Investoren-Seite über den Meta-Pixel. Für Retargeting oder zum Ausschließen von Gebuchten.'),
    },
    {
      id: 'interaktion', icon: 'social', badge: erlaubt,
      titel: t('crm.werbung.zielgruppen.wahl.interaktion', 'Interaktion'),
      text: t('crm.werbung.zielgruppen.wahl.interaktionText', 'Wer mit Instagram, der Facebook-Seite, einem Video oder einem Sofortformular interagiert hat.'),
    },
    {
      id: 'kundenliste', icon: 'customers',
      badge: freigegeben
        ? { ton: 'info', text: t('crm.werbung.zielgruppen.wahl.nurAdmin', 'Nur Admin') }
        : { ton: 'warning', text: t('crm.werbung.zielgruppen.wahl.wartetFreigabe', 'Wartet auf Svens Freigabe') },
      titel: t('crm.werbung.zielgruppen.wahl.kundenliste', 'Kundenliste'),
      text: t('crm.werbung.zielgruppen.wahl.kundenlisteText', 'Kontakte aus dem CRM, gehasht übertragen. Vor allem, um Käufer aus Neukunden-Werbung auszuschließen.'),
      versteckt: !status.rechte.istAdmin,
    },
    {
      id: 'lookalike', icon: 'users',
      badge: { ton: 'danger', text: t('crm.werbung.zielgruppen.wahl.wohnenGesperrt', 'Unter Wohnen gesperrt') },
      titel: t('crm.werbung.zielgruppen.wahl.lookalike', 'Lookalike'),
      text: t('crm.werbung.zielgruppen.wahl.lookalikeText', 'Personen, die einer Zielgruppe ähneln. Nur für Kampagnen ohne Sonderkategorie Wohnen.'),
    },
    {
      id: 'gespeichert', icon: 'lists',
      badge: { ton: 'danger', text: t('crm.werbung.zielgruppen.wahl.wohnenGesperrt', 'Unter Wohnen gesperrt') },
      titel: t('crm.werbung.zielgruppen.wahl.gespeichert', 'Gespeicherte Zielgruppe'),
      text: t('crm.werbung.zielgruppen.wahl.gespeichertText', 'Vorlage aus Standort, Alter und Interessen.'),
      gesperrt: t('crm.werbung.zielgruppen.wahl.gespeichertGrund', 'Unter Wohnen nicht verfügbar (Meta-Regel). Standort und Zielgruppe stellst du direkt in der Anzeigengruppe im Kampagnen-Assistenten ein.'),
    },
  ]

  const schliessen = () => setSchritt(null)
  const zurueck = () => setSchritt('wahl')
  const fertig = () => { setSchritt(null); onFertig() }
  const gemeinsam = { onClose: schliessen, onZurueck: zurueck, onFertig: fertig, status }

  return (
    <>
      <Modal open={schritt === 'wahl'} onClose={schliessen} size="lg" title={t('crm.werbung.zielgruppen.wahl.titel', 'Neue Zielgruppe')}>
        <p className="mb-3 text-sm text-gray-600">{t('crm.werbung.zielgruppen.wahl.text', 'Welche Art von Zielgruppe willst du anlegen? Alle Happy-Property-Kampagnen laufen unter der Sonderkategorie Wohnen.')}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          {karten.filter(k => !k.versteckt).map(k => {
            const aus = !!k.gesperrt
            return (
              <button key={k.id} type="button" disabled={aus}
                onClick={() => { if (k.id !== 'gespeichert') setSchritt(k.id) }}
                className={`flex h-full flex-col items-start gap-2 rounded-xl border p-4 text-left ${aus
                  ? 'cursor-not-allowed border-gray-200 bg-gray-50 opacity-70'
                  : 'border-gray-200 bg-white hover:border-hp-navy/40 hover:bg-hp-cream/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-hp-navy/60'}`}>
                <span className="flex w-full items-start justify-between gap-2">
                  <span className="flex items-center gap-2 font-semibold text-hp-navy">
                    <Icon name={k.icon} size={20} />
                    {aus ? '🔒 ' : ''}{k.titel}
                  </span>
                </span>
                <Badge tone={k.badge.ton}>{k.badge.text}</Badge>
                <span className="text-xs leading-snug text-gray-600">{k.text}</span>
                {k.gesperrt && <span className="text-xs leading-snug text-gray-500">{k.gesperrt}</span>}
              </button>
            )
          })}
        </div>
      </Modal>

      {schritt === 'website' && <WebsiteBesucher offen {...gemeinsam} />}
      {schritt === 'interaktion' && <Interaktion offen {...gemeinsam} />}
      {schritt === 'lookalike' && <Lookalike offen {...gemeinsam} zielgruppen={zielgruppen} vorauswahl={lookalikeQuelle} />}
      {schritt === 'kundenliste' && status.rechte.istAdmin && <Kundenliste offen {...gemeinsam} />}
    </>
  )
}
