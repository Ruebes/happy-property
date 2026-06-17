import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'

// ── Postausgang ──────────────────────────────────────────────────────────────
// Erzeugte Begleit-Mails (mit Deck-Links) aus dem Deck-Wizard. Sven prüft und
// sendet manuell — KEIN automatischer Versand.

interface OutboxRow {
  id: string
  lead_id: string | null
  recipient_email: string | null
  subject: string | null
  body: string | null
  deck_tokens: string[] | null
  status: 'draft' | 'sent' | 'cancelled'
  error_message: string | null
  created_at: string | null
  sent_at: string | null
  email_sent_at: string | null
  whatsapp_sent_at: string | null
  lead?: { first_name: string; last_name: string; phone: string | null; whatsapp: string | null } | null
}

export default function Postausgang() {
  const { t } = useTranslation()
  const [rows, setRows]       = useState<OutboxRow[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId]   = useState<string | null>(null)
  const [busyId, setBusyId]   = useState<string | null>(null)
  const [toast, setToast]     = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('deck_outbox')
      .select('*, lead:leads(first_name,last_name,phone,whatsapp)')
      .order('created_at', { ascending: false }).limit(100)
    setRows((data ?? []) as OutboxRow[])
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  const send = async (row: OutboxRow) => {
    if (!row.recipient_email) { flash(t('crm.outbox.noEmail', 'Kein Empfänger — E-Mail am Lead fehlt.')); return }
    if (!window.confirm(t('crm.outbox.confirmSend', 'Mail jetzt an den Kunden senden?') + `\n\n${row.recipient_email}`)) return
    setBusyId(row.id)
    try {
      const { data, error } = await supabase.functions.invoke('send-email', {
        body: { to: row.recipient_email, subject: row.subject, html: row.body, lead_id: row.lead_id },
      })
      if (error) throw new Error(error.message)
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      const nowIso = new Date().toISOString()
      await supabase.from('deck_outbox').update({ status: 'sent', sent_at: row.sent_at ?? nowIso, email_sent_at: nowIso }).eq('id', row.id)
      flash(t('crm.outbox.sent', '✅ Gesendet'))
      void load()
    } catch (e) {
      await supabase.from('deck_outbox').update({ error_message: e instanceof Error ? e.message : 'Fehler' }).eq('id', row.id)
      flash(`${t('crm.outbox.sendFail', 'Senden fehlgeschlagen')}: ${e instanceof Error ? e.message : ''}`)
      void load()
    } finally { setBusyId(null) }
  }

  const sendWhatsApp = async (row: OutboxRow) => {
    const phone = row.lead?.whatsapp || row.lead?.phone
    if (!phone) { flash(t('crm.outbox.noPhone', 'Keine Telefonnummer am Lead.')); return }
    const fn = row.lead?.first_name ?? ''
    const base = window.location.origin
    const links = (row.deck_tokens ?? []).map(tok => `${base}/deck/${tok}`).join('\n')
    const text = `Hallo ${fn},\n\nschön, dass wir gesprochen haben! Hier sind deine persönlichen Angebote:\n\n${links}\n\nSchau sie dir in Ruhe an – bei Fragen bin ich jederzeit für dich da.\n\nViele Grüße\nSven · Happy Property`
    if (!window.confirm(t('crm.outbox.confirmWa', 'Diese WhatsApp jetzt senden?') + `\n\n→ ${phone}\n\n${text}`)) return
    setBusyId(row.id)
    try {
      const { data, error } = await supabase.functions.invoke('send-whatsapp', {
        body: { event_type: 'deck_angebot', override_text: text, lead_id: row.lead_id, lead_data: { lead_name: fn, lead_phone: phone } },
      })
      if (error) throw new Error(error.message)
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      const nowIso = new Date().toISOString()
      await supabase.from('deck_outbox').update({ status: 'sent', sent_at: row.sent_at ?? nowIso, whatsapp_sent_at: nowIso }).eq('id', row.id)
      flash(t('crm.outbox.waSent', '✅ WhatsApp gesendet'))
      void load()
    } catch (e) {
      flash(`${t('crm.outbox.waFail', 'WhatsApp fehlgeschlagen')}: ${e instanceof Error ? e.message : ''}`)
    } finally { setBusyId(null) }
  }

  const discard = async (row: OutboxRow) => {
    if (!window.confirm(t('crm.outbox.confirmDiscard', 'Entwurf verwerfen?'))) return
    await supabase.from('deck_outbox').update({ status: 'cancelled' }).eq('id', row.id)
    void load()
  }

  const badge = (s: string) => s === 'sent' ? 'bg-green-100 text-green-700' : s === 'cancelled' ? 'bg-gray-100 text-gray-500' : 'bg-orange-100 text-orange-700'
  const badgeLabel = (s: string) => s === 'sent' ? t('crm.outbox.statusSent', 'Gesendet') : s === 'cancelled' ? t('crm.outbox.statusCancelled', 'Verworfen') : t('crm.outbox.statusDraft', 'Entwurf')

  return (
    <DashboardLayout basePath="/admin/crm">
      <div className="max-w-4xl mx-auto px-4 py-6">
        <div className="flex items-center justify-between mb-4">
          <h1 className="text-2xl font-bold text-gray-900">📤 {t('crm.outbox.title', 'Postausgang')}</h1>
          <button onClick={() => void load()} className="text-sm text-gray-500 hover:text-orange-600">↻ {t('common.refresh', 'Aktualisieren')}</button>
        </div>
        <p className="text-sm text-gray-500 mb-5">{t('crm.outbox.intro', 'Vom Deck-Wizard erzeugte Begleit-Mails. Prüfen und manuell senden — es wird nichts automatisch verschickt.')}</p>

        {toast && <div className="mb-4 text-sm rounded-lg px-3 py-2 bg-gray-900 text-white">{toast}</div>}
        {loading && <p className="text-gray-400">{t('common.loading', 'Lädt…')}</p>}
        {!loading && rows.length === 0 && (
          <div className="text-center text-gray-400 py-16 border border-dashed border-gray-200 rounded-2xl">
            {t('crm.outbox.empty', 'Noch keine Mails. Erstelle Sales Decks aus einem Kunden heraus.')}
          </div>
        )}

        <div className="space-y-3">
          {rows.map(r => (
            <div key={r.id} className="border border-gray-200 rounded-xl bg-white">
              <div className="flex items-center gap-3 px-4 py-3">
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${badge(r.status)}`}>{badgeLabel(r.status)}</span>
                <button onClick={() => setOpenId(openId === r.id ? null : r.id)} className="flex-1 text-left min-w-0">
                  <p className="text-sm font-semibold text-gray-900 truncate">{r.subject ?? '—'}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {r.lead ? `${r.lead.first_name} ${r.lead.last_name}` : '—'} · {r.recipient_email ?? t('crm.outbox.noEmailShort', 'keine E-Mail')} · {r.deck_tokens?.length ?? 0} {t('crm.outbox.decks', 'Decks')}
                  </p>
                </button>
                {r.status !== 'cancelled' && (
                  <div className="flex gap-2 shrink-0 items-center">
                    {r.email_sent_at    && <span className="text-[11px] text-green-600 font-medium">✅ Mail</span>}
                    {r.whatsapp_sent_at && <span className="text-[11px] text-green-600 font-medium">✅ WA</span>}
                    {!r.email_sent_at && (
                      <button onClick={() => send(r)} disabled={busyId === r.id}
                        className="text-xs font-medium text-white rounded-lg px-3 py-1.5 disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
                        {busyId === r.id ? t('crm.outbox.sending', 'Sendet…') : `📧 ${t('crm.outbox.sendEmail', 'E-Mail')}`}
                      </button>
                    )}
                    {!r.whatsapp_sent_at && (
                      <button onClick={() => sendWhatsApp(r)} disabled={busyId === r.id}
                        className="text-xs font-medium text-white rounded-lg px-3 py-1.5 disabled:opacity-40" style={{ backgroundColor: '#25D366' }}>
                        {busyId === r.id ? t('crm.outbox.sending', 'Sendet…') : `💬 ${t('crm.outbox.sendWhatsapp', 'WhatsApp')}`}
                      </button>
                    )}
                    {r.status === 'draft' && (
                      <button onClick={() => discard(r)} className="text-xs text-gray-400 hover:text-red-500 px-2 py-1">{t('crm.outbox.discard', 'Verwerfen')}</button>
                    )}
                  </div>
                )}
              </div>
              {openId === r.id && (
                <div className="border-t border-gray-100 px-4 py-3">
                  <div className="flex flex-wrap gap-2 mb-3">
                    {(r.deck_tokens ?? []).map((tok, i) => (
                      <a key={tok} href={`/deck/${tok}`} target="_blank" rel="noreferrer"
                        className="text-xs font-medium px-2.5 py-1 rounded-lg bg-gray-900 text-white">🔗 Deck {i + 1}</a>
                    ))}
                  </div>
                  <div className="text-sm text-gray-700 border border-gray-100 rounded-lg p-3 bg-gray-50 max-h-72 overflow-y-auto"
                    dangerouslySetInnerHTML={{ __html: r.body ?? '' }} />
                  {r.error_message && <p className="text-xs text-red-500 mt-2">{r.error_message}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </DashboardLayout>
  )
}
