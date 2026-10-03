import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Modal from '../../../ui/Modal'
import Badge from '../../../ui/Badge'
import EmptyState from '../../../ui/EmptyState'
import Spinner from '../../../ui/Spinner'
import type { BeitragQuelle, BeitragRef, PostsListItem, PostsListRequest } from '../../../../lib/metaSpec'
import { lintText } from '../../../../lib/metaLint'
import { builderCall, fehlerText } from './builderApi'

// ── Vorhandenen Beitrag verwenden ────────────────────────────────────────────
// Listet Beiträge der Facebook-Seite bzw. des Instagram-Kontos (meta-builder
// posts_list, nur lesen) mit Vorschaubild, Text und Datum. Ein Klick übernimmt
// den Beitrag als Werbemittel (object_story_id bzw. source_instagram_media_id):
// Texte, Medien und Reaktionen kommen dann aus dem Beitrag. Der Beitragstext
// wird geprüft (Projekt-/Bauträgernamen, Gedankenstriche usw.), Treffer als Hinweis.

const datum = (iso: string | null, locale: string): string => {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export default function BeitragWahl({ open, onClose, onPick, pageId, igUserId, verboteneNamen }: {
  open: boolean
  onClose: () => void
  onPick: (b: BeitragRef, medienTyp: string | null) => void
  pageId: string
  igUserId: string
  /** Projekt- und Bauträgernamen (Katalog lint_context) für die Textprüfung */
  verboteneNamen: string[]
}) {
  const { t, i18n } = useTranslation()
  const [plattform, setPlattform] = useState<BeitragQuelle>('instagram')
  const [daten, setDaten] = useState<Record<BeitragQuelle, PostsListItem[] | null>>({ facebook: null, instagram: null })
  const [weiter, setWeiter] = useState<Record<BeitragQuelle, string | null>>({ facebook: null, instagram: null })
  const [laedt, setLaedt] = useState(false)
  const [fehler, setFehler] = useState<string | null>(null)
  const [hinweise, setHinweise] = useState<string[]>([])

  const laden = async (pf: BeitragQuelle, after?: string) => {
    setLaedt(true)
    setFehler(null)
    try {
      const anfrage: PostsListRequest = { quelle: pf, limit: 24 }
      if (pageId) anfrage.page_id = pageId
      if (igUserId) anfrage.instagram_user_id = igUserId
      if (after) anfrage.after = after
      const res = await builderCall('posts_list', anfrage)
      const items = res.items ?? []
      setDaten(d => ({ ...d, [pf]: after ? [...(d[pf] ?? []), ...items] : items }))
      setWeiter(w => ({ ...w, [pf]: res.next ?? null }))
      setHinweise(res.warnings ?? [])
    } catch (err) {
      setFehler(fehlerText(err, t))
      setDaten(d => ({ ...d, [pf]: d[pf] ?? [] }))
    } finally {
      setLaedt(false)
    }
  }

  useEffect(() => {
    if (!open || daten[plattform] !== null) return
    void laden(plattform)
    // nur beim Öffnen bzw. Wechsel der Plattform
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, plattform])

  const liste = daten[plattform]
  const kontoFehlt = plattform === 'instagram' ? !igUserId : !pageId

  const waehle = (b: PostsListItem) => {
    if (b.bewerbbar === false) return
    onPick({
      quelle: b.quelle, id: b.id,
      ...(b.permalink ? { permalink: b.permalink } : {}),
      ...(b.bild_url ? { vorschau_url: b.bild_url } : {}),
      ...(b.text ? { text: b.text } : {}),
    }, b.typ)
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} size="xl" title={t('crm.werbung.builder.beitrag.titel', 'Vorhandenen Beitrag verwenden')}>
      <div className="space-y-3">
        <p className="text-xs text-gray-600">
          {t('crm.werbung.builder.beitrag.text', 'Der Beitrag läuft unverändert als Anzeige: Likes und Kommentare bleiben sichtbar (Social Proof). Texte und Medien kommen aus dem Beitrag und sind hier nicht änderbar.')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex overflow-hidden rounded-lg border border-gray-200 text-xs" role="group" aria-label={t('crm.werbung.builder.beitrag.plattform', 'Plattform')}>
            {(['instagram', 'facebook'] as const).map(pf => (
              <button key={pf} type="button" aria-pressed={plattform === pf} onClick={() => setPlattform(pf)}
                className={`px-3 py-1.5 font-medium ${plattform === pf ? 'bg-hp-navy text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {pf === 'instagram' ? t('crm.werbung.builder.beitrag.instagram', 'Instagram-Beiträge und Reels') : t('crm.werbung.builder.beitrag.facebook', 'Facebook-Beiträge')}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void laden(plattform)} disabled={laedt}
            className="hp-btn hp-btn-ghost min-h-0 px-3 py-1.5 text-xs">
            {t('crm.werbung.builder.beitrag.neuLaden', 'Neu laden')}
          </button>
        </div>
        {kontoFehlt && (
          <p className="text-[11px] text-amber-800">
            {plattform === 'instagram'
              ? t('crm.werbung.builder.beitrag.ohneIg', 'Bei der Identität ist kein Instagram-Konto gewählt. Es werden die Beiträge des Standard-Kontos geladen.')
              : t('crm.werbung.builder.beitrag.ohneSeite', 'Bei der Identität ist keine Facebook-Seite gewählt. Es werden die Beiträge der Standard-Seite geladen.')}
          </p>
        )}
        {fehler && <p role="alert" className="text-[11px] text-red-700">{fehler}</p>}
        {hinweise.length > 0 && <p className="text-[11px] text-amber-800">{hinweise.join(' ')}</p>}
        {liste === null || (laedt && !liste.length) ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : !liste.length ? (
          <EmptyState compact icon="ads" title={t('crm.werbung.builder.beitrag.leer', 'Keine Beiträge gefunden')} />
        ) : (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {liste.map(b => {
              const gesperrt = b.bewerbbar === false
              const pruefung = b.text ? lintText(b.text, 'ad.beitrag', { forbiddenNames: verboteneNamen }) : []
              return (
                <li key={`${b.quelle}:${b.id}`}>
                  <button type="button" onClick={() => waehle(b)} disabled={gesperrt}
                    title={gesperrt ? t('crm.werbung.builder.beitrag.nichtBewerbbar', 'Dieser Beitrag lässt sich nicht bewerben.') : undefined}
                    className={`flex w-full flex-col overflow-hidden rounded-lg border text-left transition-colors ${gesperrt ? 'cursor-not-allowed border-gray-100 opacity-50' : 'border-gray-200 hover:border-hp-navy/50'}`}>
                    <span className="aspect-square w-full bg-gray-100">
                      {b.bild_url && <img src={b.bild_url} alt="" loading="lazy" className="h-full w-full object-cover" />}
                    </span>
                    <span className="space-y-1 p-2">
                      <span className="flex flex-wrap items-center gap-1">
                        {b.typ && <Badge tone="neutral">{t(`crm.werbung.builder.beitrag.typ.${b.typ.toLowerCase()}`, b.typ)}</Badge>}
                        <span className="text-[10px] text-gray-500">{datum(b.erstellt, i18n.language)}</span>
                      </span>
                      <span className="line-clamp-3 block text-[11px] leading-snug text-gray-700">
                        {b.text || t('crm.werbung.builder.beitrag.ohneText', 'Ohne Text')}
                      </span>
                      {gesperrt && (
                        <span className="block text-[10px] text-red-700">{t('crm.werbung.builder.beitrag.nichtBewerbbar', 'Dieser Beitrag lässt sich nicht bewerben.')}</span>
                      )}
                      {pruefung.map((l, i) => (
                        <span key={`${l.rule}-${i}`} className="block text-[10px] leading-snug text-amber-800">⚠ {t(l.messageKey, l.rule, { ...(l.params ?? {}), match: l.match ?? '' })}</span>
                      ))}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {weiter[plattform] && liste && liste.length > 0 && (
          <div className="flex justify-center">
            <button type="button" onClick={() => void laden(plattform, weiter[plattform] ?? undefined)} disabled={laedt}
              className="hp-btn hp-btn-ghost min-h-0 px-3 py-1.5 text-xs">
              {laedt && <Spinner size="sm" />}
              {t('crm.werbung.builder.beitrag.mehr', 'Mehr laden')}
            </button>
          </div>
        )}
      </div>
    </Modal>
  )
}
