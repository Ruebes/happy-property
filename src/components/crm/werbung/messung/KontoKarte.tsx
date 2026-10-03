import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import Badge from '../../../ui/Badge'
import { KONTO_ERKLAERUNG, type KontoResponse } from '../../../../lib/werbeKonto'
import { useWerbeFormat } from '../format'
import { Einstellung, Hinweis } from '../zielgruppen/Bausteine'
import AusgabenlimitDialog from './AusgabenlimitDialog'
import Karte, { AktualisierenKnopf, KartenFehler, Kennzahl } from './Karte'
import { geld, kontoStatus, messFehlerText, sperrgrund } from './messungApi'
import type { Lader } from './useLader'

// ── Karte „Konto" ────────────────────────────────────────────────────────────
// Werbekonto laut meta-konto: Status, bisher ausgegeben, Ausgabenlimit (mit
// Balken und Euro-Wert), offener Betrag, Zahlungsmethode (verkürzt), Sperrgrund,
// Unternehmen, DSA-Standard. Unter „Alle Einstellungen" die kontoweiten
// Platzierungs- und Zielgruppen-Einschränkungen (gelten laut Meta NICHT für
// Kampagnen der Sonderkategorie Wohnen: grau mit Grund), Markenschutz und
// Blocklisten, nur lesen. Ausgabenlimit ändern: nur Admin (der Server sagt mit
// darf_limit_aendern/limit_sperrgrund, ob und warum nicht).

export default function KontoKarte({ lader }: { lader: Lader<KontoResponse> }) {
  const { t } = useTranslation()
  const fmt = useWerbeFormat()
  const [dialog, setDialog] = useState(false)
  const k = lader.daten
  const erkl = (key: string, fallback: string) => t(`crm.werbung.messung.konto.erkl.${key}`, KONTO_ERKLAERUNG[key] ?? fallback)

  const status = k ? kontoStatus(t, k.status, k.status_text) : null
  const sperre = k ? sperrgrund(t, k.sperrgrund_code, k.sperrgrund_text) : null
  const anteil = k?.limit_auslastung_pct != null ? Math.max(0, Math.min(1, k.limit_auslastung_pct / 100)) : null
  const limitSperre = k && !k.darf_limit_aendern
    ? (k.limit_sperrgrund || t('crm.werbung.messung.konto.limitNurAdmin', 'Das Ausgabenlimit ändert nur ein Admin (Sven).'))
    : null
  const wohnenGrund = k?.wohnen_hinweis || erkl('wohnen', 'Kontoweite Einschränkungen gelten laut Meta nicht für Kampagnen der Sonderkategorie Wohnen.')
  const nichtLesbar = t('crm.werbung.messung.konto.nichtLesbar', 'Meta liefert diese Angabe gerade nicht (Rechte oder Auslastung).')
  const euro = (v: number | null) => (v == null ? '' : ` (≈ ${fmt.eur(v)})`)

  return (
    <Karte id="messung-konto"
      titel={t('crm.werbung.messung.konto.titel', 'Konto')}
      erklaerung={t('crm.werbung.messung.konto.erklaerung', 'Zustand des Werbekontos bei Meta: Status, bisherige Ausgaben, Ausgabenlimit und Zahlungsmethode.')}
      ampel={status ? { ampel: status.ton === 'success' ? 'gruen' : status.ton === 'warning' ? 'gelb' : status.ton === 'danger' ? 'rot' : 'grau', label: status.text } : null}
      laedt={lader.laedt}
      aktionen={<AktualisierenKnopf onClick={() => void lader.neu()} laedt={lader.laedt} />}
      alle={k ? (
        <div className="space-y-4">
          <Einstellung label={t('crm.werbung.messung.konto.platzierungen', 'Platzierungs-Einschränkungen (kontoweit)')}
            erklaerung={erkl('platzierungen', 'Platzierungen, die für das ganze Konto ausgeschlossen sind.')} gesperrt={wohnenGrund}>
            {k.einschraenkungen_lesbar
              ? <Liste werte={k.platzierungs_ausschluesse} leer={t('crm.werbung.messung.konto.keine', 'Keine')} />
              : <p className="text-xs text-gray-500">{nichtLesbar}</p>}
          </Einstellung>
          {k.zielgruppen_einschraenkungen.length > 0 && (
            <Einstellung label={t('crm.werbung.messung.konto.zielgruppen', 'Zielgruppen-Einschränkungen (kontoweit)')}
              erklaerung={t('crm.werbung.messung.konto.zielgruppenHilfe', 'Zum Beispiel Mindestalter oder erlaubte Länder für alle Anzeigen des Kontos.')} gesperrt={wohnenGrund}>
              <Liste werte={k.zielgruppen_einschraenkungen} leer="" />
            </Einstellung>
          )}
          <Einstellung label={t('crm.werbung.messung.konto.markenschutz', 'Markenschutz (Brand Safety)')}
            erklaerung={erkl('markenschutz', 'Filter, der Anzeigen von heiklen Inhalten in Videos und Reels fernhält.')}>
            {k.einschraenkungen_lesbar
              ? <Liste werte={k.markenschutz.map(m => m.text)} leer={t('crm.werbung.messung.konto.keineAngabe', 'Keine Angabe von Meta')} />
              : <p className="text-xs text-gray-500">{nichtLesbar}</p>}
          </Einstellung>
          <Einstellung label={t('crm.werbung.messung.konto.blocklisten', 'Blocklisten')}
            erklaerung={erkl('blocklisten', 'Listen von Apps und Websites, auf denen deine Anzeigen nie erscheinen.')}>
            {k.blocklisten_lesbar
              ? <Liste werte={k.blocklisten.map(b => b.name)} leer={t('crm.werbung.messung.konto.keine', 'Keine')} />
              : <p className="text-xs text-gray-500">{nichtLesbar}</p>}
          </Einstellung>
          <Einstellung label={t('crm.werbung.messung.konto.dsa', 'DSA-Angaben (Standard)')} erklaerung={erkl('dsa', 'Begünstigter und Zahler nach dem EU-Gesetz über digitale Dienste.')}>
            <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
              <dt className="text-gray-500">{t('crm.werbung.messung.konto.dsaBeguenstigter', 'Begünstigter')}</dt>
              <dd className="text-gray-800">{k.dsa_beguenstigter ?? '-'}</dd>
              <dt className="text-gray-500">{t('crm.werbung.messung.konto.dsaZahler', 'Zahler')}</dt>
              <dd className="text-gray-800">{k.dsa_zahler ?? '-'}</dd>
            </dl>
          </Einstellung>
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <dt className="text-gray-500">{t('crm.werbung.messung.konto.id', 'Konto-ID')}</dt>
            <dd className="tabular-nums text-gray-800">{k.id}</dd>
            <dt className="text-gray-500">{t('crm.werbung.messung.konto.zeitzone', 'Zeitzone')}</dt>
            <dd className="text-gray-800">{k.zeitzone ?? '-'}</dd>
            {k.mindest_tagesbudget_cents != null && (<>
              <dt className="text-gray-500">{t('crm.werbung.messung.konto.mindestbudget', 'Kleinstes Tagesbudget')}</dt>
              <dd className="tabular-nums text-gray-800">{geld(k.mindest_tagesbudget_cents, k.waehrung, fmt.locale)}</dd>
            </>)}
            <dt className="text-gray-500">{t('crm.werbung.messung.konto.kurs', 'Umrechnung')}</dt>
            <dd className="text-gray-800">{k.kurs_quelle === 'insights_7d'
              ? t('crm.werbung.messung.konto.kursGemessen', '1 € = {{kurs}} $ (Schnitt 7 Tage)', { kurs: k.usd_pro_eur.toLocaleString(fmt.locale, { maximumFractionDigits: 3 }) })
              : t('crm.werbung.messung.konto.kursErsatz', '1 € = {{kurs}} $ (Ersatzkurs)', { kurs: k.usd_pro_eur.toLocaleString(fmt.locale, { maximumFractionDigits: 3 }) })}</dd>
          </dl>
          <p className="text-[11px] leading-snug text-gray-500">{t('crm.werbung.messung.konto.nurLesen', 'Diese Einstellungen ändert ihr direkt bei Meta (Werbeeinstellungen). Hier nur zum Nachsehen.')}</p>
        </div>
      ) : undefined}>
      {lader.fehler != null && !k ? (
        <KartenFehler text={messFehlerText(lader.fehler, t, 'konto')} onNochmal={() => void lader.neu()} />
      ) : !k ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1].map(i => <div key={i} className="h-12 animate-pulse rounded-lg bg-gray-100" />)}
        </div>
      ) : (
        <>
          {lader.fehler != null && <KartenFehler text={messFehlerText(lader.fehler, t, 'konto')} />}
          {sperre && <Hinweis ton="fehler" titel={t('crm.werbung.messung.konto.gesperrt', 'Konto eingeschränkt')}>{sperre}</Hinweis>}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Kennzahl label={t('crm.werbung.messung.konto.name', 'Werbekonto')} wert={<span className="text-sm">{k.name ?? k.id}</span>}
              hilfe={erkl('status', 'Ob das Werbekonto Anzeigen ausliefern darf.')} />
            <Kennzahl label={t('crm.werbung.messung.konto.ausgegeben', 'Bisher ausgegeben')} wert={geld(k.ausgegeben_cents, k.waehrung, fmt.locale)}
              hilfe={k.ausgegeben_eur != null ? `≈ ${fmt.eur(k.ausgegeben_eur)}` : undefined} />
            <Kennzahl label={t('crm.werbung.messung.konto.saldo', 'Offener Betrag')} wert={geld(k.saldo_cents, k.waehrung, fmt.locale)}
              hilfe={erkl('saldo', 'Betrag, den Meta noch nicht abgebucht hat.')} />
            <Kennzahl label={t('crm.werbung.messung.konto.zahlung', 'Zahlungsmethode')}
              wert={<span className="text-sm">{k.zahlungsquelle?.anzeige ?? k.zahlungsquelle?.art_text ?? '-'}</span>}
              hilfe={k.vorauszahlung ? t('crm.werbung.messung.konto.vorauszahlung', 'Vorauszahlung') : k.zahlungsquelle?.art_text} />
          </div>

          <div className="rounded-lg border border-gray-100 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-gray-800">{t('crm.werbung.messung.konto.limit', 'Ausgabenlimit des Kontos')}</p>
              {k.limit_cents == null && <Badge tone="warning">{t('crm.werbung.messung.limit.keins', 'kein Limit')}</Badge>}
              <span className="ml-auto" />
              <button type="button" onClick={() => setDialog(true)} disabled={!!limitSperre} title={limitSperre ?? undefined}
                className="hp-btn hp-btn-ghost min-h-0 px-3 py-1 text-xs">
                {limitSperre ? '🔒 ' : ''}{t('crm.werbung.messung.konto.limitAendern', 'Ändern')}
              </button>
            </div>
            <p className="mt-0.5 text-xs leading-snug text-gray-500">{erkl('ausgabenlimit', 'Erreicht das Konto diesen Betrag, stoppt Meta alle Anzeigen, bis du das Limit erhöhst oder entfernst.')}</p>
            {k.limit_cents != null && (
              <div className="mt-2">
                <div className="h-2 overflow-hidden rounded-full bg-gray-100" aria-hidden="true">
                  <div className={`h-full ${anteil != null && anteil > 0.9 ? 'bg-red-500' : anteil != null && anteil > 0.75 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.round((anteil ?? 0) * 100)}%` }} />
                </div>
                <p className="mt-1 text-xs tabular-nums text-gray-600">
                  {t('crm.werbung.messung.konto.limitStand', '{{ausgegeben}} von {{limit}} ({{pct}})', {
                    ausgegeben: geld(k.ausgegeben_cents, k.waehrung, fmt.locale), limit: `${geld(k.limit_cents, k.waehrung, fmt.locale)}${euro(k.limit_eur)}`, pct: fmt.pct(anteil ?? 0),
                  })}
                </p>
                {k.rest_cents != null && (
                  <p className="text-xs tabular-nums text-gray-600">
                    {t('crm.werbung.messung.konto.rest', 'Noch {{wert}} bis zum Stopp', { wert: `${geld(k.rest_cents, k.waehrung, fmt.locale)}${euro(k.rest_eur)}` })}
                  </p>
                )}
              </div>
            )}
            {k.limit_aenderungen_24h != null && (
              <p className="mt-1 text-[11px] text-gray-500">
                {t('crm.werbung.messung.konto.aenderungen', 'Änderungen in 24 Stunden: {{n}} von {{max}}', { n: k.limit_aenderungen_24h, max: k.limit_aenderungen_max })}
              </p>
            )}
            {limitSperre && <p className="mt-1 text-[11px] text-gray-500">{limitSperre}</p>}
          </div>

          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <dt className="text-gray-500">{t('crm.werbung.messung.konto.unternehmen', 'Unternehmen (Business Manager)')}</dt>
            <dd className="text-gray-800">{k.unternehmen?.name ?? k.unternehmen?.id ?? '-'}</dd>
            <dt className="text-gray-500">{t('crm.werbung.messung.konto.waehrung', 'Währung')}</dt>
            <dd className="text-gray-800">{k.waehrung ?? '-'}</dd>
          </dl>
          {k.hinweise.map((w, i) => <Hinweis key={i} ton="info">{w}</Hinweis>)}
          <AusgabenlimitDialog offen={dialog} konto={k} onClose={() => setDialog(false)} onFertig={() => void lader.neu()} />
        </>
      )}
    </Karte>
  )
}

function Liste({ werte, leer }: { werte: string[]; leer: string }) {
  if (!werte.length) return leer ? <p className="text-xs text-gray-500">{leer}</p> : null
  return (
    <ul className="flex flex-wrap gap-1.5">
      {werte.map(w => <li key={w}><Badge tone="neutral">{w}</Badge></li>)}
    </ul>
  )
}
