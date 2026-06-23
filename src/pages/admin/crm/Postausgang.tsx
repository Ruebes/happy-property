import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import DeckChat from '../../../components/crm/DeckChat'
import RechnerWizard from '../../../components/crm/RechnerWizard'
import type { CalcItem } from '../../../lib/rechner'

// ── Postausgang ──────────────────────────────────────────────────────────────
// Erzeugte Begleit-Mails (mit Deck-Links) aus dem Deck-Wizard. Sven prüft und
// sendet manuell — KEIN automatischer Versand.
//
// Abend-Workflow (minimale Klicks): Decks/Berechnungen tagsüber im Hintergrund
// erstellen lassen → abends hier alles an EINEM Ort prüfen: Deck per Chat anpassen
// (läuft im Hintergrund, Button-Farbe wechselt bei fertig), Berechnung ansehen,
// jeweils als „fertig" bestätigen, Mailtext anpassen, senden.

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
  lead?: { first_name: string; last_name: string; phone: string | null; whatsapp: string | null; email: string | null } | null
}
interface DeckMeta { revision: number; refining: boolean; refine_error: string | null; approved_at: string | null }
interface CalcRow { id: string; token: string; title: string | null; lead_id: string | null; approved_at: string | null }

// Basisfarbe (unbearbeitet) + Zyklus: nach jeder fertigen Bearbeitung die nächste Farbe.
const DECK_BASE = '#111827'
const DECK_CYCLE = ['#7c3aed', '#0ea5e9', '#e11d48', '#d97706', '#0d9488', '#9333ea']
const deckColor = (rev: number, approved: boolean) =>
  approved ? '#16a34a' : rev <= 0 ? DECK_BASE : DECK_CYCLE[(rev - 1) % DECK_CYCLE.length]

export default function Postausgang() {
  const { t } = useTranslation()
  const [rows, setRows]       = useState<OutboxRow[]>([])
  const [deckMeta, setDeckMeta] = useState<Record<string, DeckMeta>>({})
  const [calcs, setCalcs]     = useState<CalcRow[]>([])
  const [loading, setLoading] = useState(true)
  const [openId, setOpenId]   = useState<string | null>(null)
  const [busyId, setBusyId]   = useState<string | null>(null)
  const [toast, setToast]     = useState('')
  const [editId, setEditId]   = useState<string | null>(null)
  const [editSubject, setEditSubject] = useState('')
  const [chat, setChat]       = useState<{ token: string; label: string } | null>(null)
  const [editCalc, setEditCalc] = useState<{ token: string; content: { items: CalcItem[]; recipient_name?: string }; lead: { id: string; first_name: string; last_name: string } } | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const origin = window.location.origin

  const allTokens = useMemo(() => Array.from(new Set(rows.flatMap(r => r.deck_tokens ?? []))), [rows])

  const fetchDeckMeta = useCallback(async (tokens: string[]) => {
    if (!tokens.length) return
    const { data } = await supabase.from('sales_decks')
      .select('token, revision, refining, refine_error, approved_at').in('token', tokens)
    setDeckMeta(prev => {
      const next = { ...prev }
      for (const r of (data ?? []) as Array<{ token: string } & DeckMeta>) {
        next[r.token] = { revision: r.revision ?? 0, refining: !!r.refining, refine_error: r.refine_error ?? null, approved_at: r.approved_at ?? null }
      }
      return next
    })
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('deck_outbox')
      .select('*, lead:leads(first_name,last_name,phone,whatsapp,email)')
      .neq('status', 'cancelled')   // bereits verworfene Einträge nicht mehr anzeigen
      .order('created_at', { ascending: false }).limit(100)
    const list = (data ?? []) as OutboxRow[]
    setRows(list)
    const tokens = Array.from(new Set(list.flatMap(r => r.deck_tokens ?? [])))
    void fetchDeckMeta(tokens)
    const leadIds = Array.from(new Set(list.map(r => r.lead_id).filter(Boolean))) as string[]
    if (leadIds.length) {
      const { data: cs } = await supabase.from('property_calculations')
        .select('id, token, title, lead_id, approved_at').in('lead_id', leadIds).order('created_at', { ascending: false })
      setCalcs((cs ?? []) as CalcRow[])
    } else setCalcs([])
    setLoading(false)
  }, [fetchDeckMeta])
  useEffect(() => { void load() }, [load])

  // Polling, solange ein Deck im Hintergrund bearbeitet wird → Farbe/Status aktualisieren.
  const anyRefining = Object.values(deckMeta).some(m => m?.refining)
  useEffect(() => {
    if (!anyRefining) return
    const id = setInterval(() => { void fetchDeckMeta(allTokens) }, 4000)
    return () => clearInterval(id)
  }, [anyRefining, allTokens, fetchDeckMeta])

  const onRefineStarted = (token: string) => {
    setDeckMeta(prev => ({ ...prev, [token]: { revision: prev[token]?.revision ?? 0, refine_error: null, approved_at: prev[token]?.approved_at ?? null, refining: true } }))
  }
  const toggleDeckApprove = async (token: string) => {
    const cur = deckMeta[token]?.approved_at
    const val = cur ? null : new Date().toISOString()
    setDeckMeta(prev => ({ ...prev, [token]: { revision: prev[token]?.revision ?? 0, refining: prev[token]?.refining ?? false, refine_error: prev[token]?.refine_error ?? null, approved_at: val } }))
    await supabase.from('sales_decks').update({ approved_at: val }).eq('token', token)
  }
  const toggleCalcApprove = async (c: CalcRow) => {
    const val = c.approved_at ? null : new Date().toISOString()
    setCalcs(prev => prev.map(x => x.id === c.id ? { ...x, approved_at: val } : x))
    await supabase.from('property_calculations').update({ approved_at: val }).eq('id', c.id)
  }

  // Berechnung bearbeiten: vollen content laden + Rechner im Edit-Modus öffnen
  // (gleicher Token, gleiche Objekte — nur Werte ändern, z.B. Eingabefehler beim EK).
  const openCalcEdit = async (token: string, row: OutboxRow) => {
    const { data } = await supabase.from('property_calculations').select('content').eq('token', token).single()
    const content = (data as { content?: { items: CalcItem[]; recipient_name?: string } } | null)?.content
    if (!content?.items?.length) { flash('❌ Berechnung konnte nicht geladen werden'); return }
    setEditCalc({ token, content, lead: { id: row.lead_id ?? '', first_name: row.lead?.first_name ?? '', last_name: row.lead?.last_name ?? '' } })
  }

  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3500) }

  const send = async (row: OutboxRow, resend = false) => {
    // Immer die AKTUELLE Mailadresse aus dem Lead ziehen — Sven korrigiert sie im
    // Kunden; recipient_email auf dem Postausgang-Eintrag kann veraltet sein.
    let to = row.recipient_email
    if (row.lead_id) {
      const { data: l } = await supabase.from('leads').select('email').eq('id', row.lead_id).maybeSingle()
      const fresh = (l as { email?: string | null } | null)?.email
      if (fresh) to = fresh
    }
    if (!to) { flash(t('crm.outbox.noEmail', 'Kein Empfänger — E-Mail am Lead fehlt.')); return }
    if (!window.confirm((resend ? t('crm.outbox.confirmResend', 'Mail ERNEUT senden an:') : t('crm.outbox.confirmSend', 'Mail jetzt an den Kunden senden?')) + `\n\n${to}`)) return
    setBusyId(row.id)
    try {
      // Korrigierte Adresse auf dem Eintrag festhalten (Anzeige + nächster Versand)
      if (to !== row.recipient_email) await supabase.from('deck_outbox').update({ recipient_email: to }).eq('id', row.id)
      const { data, error } = await supabase.functions.invoke('send-email', {
        body: { to, subject: row.subject, html: row.body, lead_id: row.lead_id, open_token: (row.deck_tokens ?? [])[0] ?? null },
      })
      if (error) throw new Error(error.message)
      if ((data as { error?: string })?.error) throw new Error((data as { error: string }).error)
      const nowIso = new Date().toISOString()
      await supabase.from('deck_outbox').update({ status: 'sent', sent_at: row.sent_at ?? nowIso, email_sent_at: nowIso, error_message: null }).eq('id', row.id)
      flash(resend ? t('crm.outbox.resent', '✅ Erneut gesendet') : t('crm.outbox.sent', '✅ Gesendet'))
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

  const startEdit = (row: OutboxRow) => {
    setOpenId(row.id)
    setEditSubject(row.subject ?? '')
    setEditId(row.id)   // innerHTML wird per Callback-Ref gesetzt, sobald der Editor gerendert ist
  }

  const saveEdit = async (row: OutboxRow) => {
    const newBody = bodyRef.current?.innerHTML ?? row.body ?? ''
    const newSubject = editSubject.trim() || row.subject
    setBusyId(row.id)
    const { error } = await supabase.from('deck_outbox').update({ subject: newSubject, body: newBody }).eq('id', row.id)
    setBusyId(null)
    if (error) { flash(`${t('crm.outbox.saveFail', 'Speichern fehlgeschlagen')}: ${error.message}`); return }
    setEditId(null)
    flash(t('crm.outbox.saved', '✅ Gespeichert'))
    void load()
    // Aus der Korrektur lernen (Hintergrund): die KI destilliert verallgemeinerbare
    // Stil-Vorgaben aus Original→Bearbeitung → fließen in künftige Mails (deck_ai_rules).
    const orig = row.body ?? ''
    if (newBody && orig && newBody !== orig) {
      void supabase.functions.invoke('learn-mail', { body: { before: orig, after: newBody } })
        .then(({ data }) => {
          const learned = (data as { rules?: string[] } | null)?.rules ?? []
          if (learned.length) flash(`💡 ${t('crm.outbox.learned', 'Aus deiner Änderung gelernt')}: ${learned[0]}${learned.length > 1 ? ` (+${learned.length - 1})` : ''}`)
        })
        .catch(() => { /* Lernen optional */ })
    }
  }

  const discard = async (row: OutboxRow) => {
    if (!window.confirm(t('crm.outbox.confirmDiscard', 'Entwurf verwerfen? Der Eintrag wird entfernt.'))) return
    // Verwerfen = Eintrag löschen (nicht nur als „verworfen" markieren). Die zugrunde-
    // liegenden Decks bleiben — die löscht Sven bei Bedarf beim Kunden („Gesendete Angebote").
    await supabase.from('deck_outbox').delete().eq('id', row.id)
    setRows(prev => prev.filter(r => r.id !== row.id))
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
        <p className="text-sm text-gray-500 mb-5">{t('crm.outbox.intro2', 'Hier prüfst du alles an einem Ort: Deck per Chat anpassen (läuft im Hintergrund), Berechnung ansehen, je als fertig bestätigen, Mailtext bearbeiten, senden. Es wird nichts automatisch verschickt.')}</p>

        {toast && <div className="mb-4 text-sm rounded-lg px-3 py-2 bg-gray-900 text-white">{toast}</div>}
        {loading && <p className="text-gray-400">{t('common.loading', 'Lädt…')}</p>}
        {!loading && rows.length === 0 && (
          <div className="text-center text-gray-400 py-16 border border-dashed border-gray-200 rounded-2xl">
            {t('crm.outbox.empty', 'Noch keine Mails. Erstelle Sales Decks aus einem Kunden heraus.')}
          </div>
        )}

        <div className="space-y-3">
          {rows.map(r => {
            // Nur die Berechnungen anzeigen, die in DIESER Mail verlinkt sind — sonst
            // erscheinen alle (auch alte Duplikate aus früheren Wizard-Läufen) und die
            // Unterlagen wirken doppelt. Fallback: hat der Body keine /rechnung/-Links,
            // alle des Leads zeigen.
            const calcTokensInBody = new Set([...(r.body ?? '').matchAll(/\/rechnung\/([a-f0-9]+)/g)].map(m => m[1]))
            const rowCalcs = calcs.filter(c => c.lead_id === r.lead_id && (calcTokensInBody.size === 0 || calcTokensInBody.has(c.token)))
            return (
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
                    {r.email_sent_at && (
                      <span className="flex items-center gap-1.5">
                        <span className="text-[11px] text-green-600 font-medium">✅ Mail</span>
                        <button onClick={() => send(r, true)} disabled={busyId === r.id} title={t('crm.outbox.resendTitle', 'Mail erneut senden — mit der aktuellen Adresse aus dem Kunden')}
                          className="text-[11px] font-medium rounded-lg px-2 py-1 border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
                          {busyId === r.id ? '…' : `🔄 ${t('crm.outbox.resend', 'Erneut senden')}`}
                        </button>
                      </span>
                    )}
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
                <div className="border-t border-gray-100 px-4 py-3 space-y-4">
                  {/* ── Decks: ansehen · per Chat anpassen (Hintergrund) · als fertig bestätigen ── */}
                  <div>
                    <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">{t('crm.outbox.decksSection', 'Decks')}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      {(r.deck_tokens ?? []).map((tok, i) => {
                        const m = deckMeta[tok]
                        const approved = !!m?.approved_at
                        const rev = m?.revision ?? 0
                        const refining = !!m?.refining
                        const err = m?.refine_error
                        return (
                          <span key={tok} className="inline-flex items-center rounded-lg overflow-hidden ring-1 ring-black/5">
                            <a href={`${origin}/deck/${tok}`} target="_blank" rel="noreferrer"
                              title={approved ? 'Als fertig bestätigt' : rev > 0 ? `Version ${rev}` : 'Deck öffnen'}
                              className="text-xs font-medium px-2.5 py-1 text-white" style={{ backgroundColor: deckColor(rev, approved) }}>
                              {approved ? '✓ ' : '🔗 '}Deck {i + 1}{rev > 0 && !approved ? ` ·v${rev}` : ''}
                            </a>
                            {refining ? (
                              <span className="px-1.5 py-1 bg-gray-200 flex items-center" title="Wird im Hintergrund bearbeitet…">
                                <span className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
                              </span>
                            ) : (
                              <button onClick={() => setChat({ token: tok, label: `Deck ${i + 1}` })} title="Deck per Chat anpassen (läuft im Hintergrund)"
                                className="text-xs px-1.5 py-1 bg-gray-700 text-white hover:bg-orange-500">✏️</button>
                            )}
                            {err && !refining && (
                              <span className="px-1 py-1 bg-red-100 text-red-600 text-xs" title={`Bearbeitung fehlgeschlagen: ${err}`}>⚠</span>
                            )}
                            <button onClick={() => void toggleDeckApprove(tok)} title={approved ? 'Bestätigung aufheben' : 'Als fertig bestätigen'}
                              className={`text-xs px-1.5 py-1 ${approved ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700'}`}>✓</button>
                          </span>
                        )
                      })}
                      {!(r.deck_tokens ?? []).length && <span className="text-xs text-gray-400">{t('crm.outbox.noDecks', 'keine Decks')}</span>}
                    </div>
                  </div>

                  {/* ── Berechnungen: ansehen · als fertig bestätigen ── */}
                  {rowCalcs.length > 0 && (
                    <div>
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">{t('crm.outbox.calcsSection', 'Berechnungen')}</p>
                      <div className="space-y-1.5">
                        {rowCalcs.map(c => {
                          const approved = !!c.approved_at
                          return (
                            <div key={c.id} className="flex items-center gap-2">
                              <span className="flex-1 truncate text-xs text-gray-700">📊 {c.title ?? 'Berechnung'}{approved && <span className="ml-1 text-green-600 font-medium">· ✓ fertig</span>}</span>
                              <a href={`${origin}/rechnung/${c.token}`} target="_blank" rel="noreferrer" className="text-[11px] px-2 py-0.5 rounded text-white shrink-0" style={{ backgroundColor: approved ? '#16a34a' : '#2f6b4f' }}>{t('crm.outbox.view', 'Ansehen')}</a>
                              <button onClick={() => void openCalcEdit(c.token, r)} title={t('crm.outbox.editCalc', 'Werte bearbeiten')}
                                className="text-[11px] px-1.5 py-0.5 rounded shrink-0 bg-gray-100 text-gray-500 hover:bg-orange-100 hover:text-orange-700">✏️</button>
                              <button onClick={() => void toggleCalcApprove(c)} title={approved ? 'Bestätigung aufheben' : 'Als fertig bestätigen'}
                                className={`text-[11px] px-1.5 py-0.5 rounded shrink-0 ${approved ? 'bg-green-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-green-100 hover:text-green-700'}`}>✓</button>
                            </div>
                          )
                        })}
                      </div>
                      <p className="text-[11px] text-gray-400 mt-1.5">{t('crm.outbox.calcHint2', 'Eingabefehler? ✏️ öffnet die Berechnung zum Bearbeiten — gleicher Link, Werte werden aktualisiert.')}</p>
                    </div>
                  )}

                  {/* ── Mail: ansehen / bearbeiten ── */}
                  <div>
                    <div className="flex items-center gap-2 mb-2">
                      <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">{t('crm.outbox.mailSection', 'Begleit-Mail')}</p>
                      {r.status !== 'cancelled' && editId !== r.id && (
                        <button onClick={() => startEdit(r)}
                          className="ml-auto text-xs font-medium px-2.5 py-1 rounded-lg border border-gray-300 text-gray-700 hover:border-orange-400 hover:text-orange-600">
                          ✏️ {t('crm.outbox.edit', 'Bearbeiten')}
                        </button>
                      )}
                    </div>
                    {editId === r.id ? (
                      <div className="space-y-2">
                        <label className="block text-xs font-medium text-gray-500">{t('crm.outbox.subject', 'Betreff')}</label>
                        <input value={editSubject} onChange={e => setEditSubject(e.target.value)}
                          className="w-full text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:border-orange-400" />
                        <label className="block text-xs font-medium text-gray-500 pt-1">{t('crm.outbox.mailText', 'Mailtext')}</label>
                        <div
                          ref={el => { bodyRef.current = el; if (el && el.getAttribute('data-init') !== r.id) { el.innerHTML = r.body ?? ''; el.setAttribute('data-init', r.id) } }}
                          contentEditable suppressContentEditableWarning
                          className="text-sm text-gray-800 border border-gray-300 rounded-lg p-3 bg-white max-h-96 overflow-y-auto focus:outline-none focus:border-orange-400" />
                        <p className="text-[11px] text-gray-400">{t('crm.outbox.editHint', 'Du kannst direkt im Text schreiben — die Formatierung und die Deck-Links bleiben erhalten.')}</p>
                        <div className="flex gap-2 pt-1">
                          <button onClick={() => saveEdit(r)} disabled={busyId === r.id}
                            className="text-xs font-medium text-white rounded-lg px-3 py-1.5 disabled:opacity-40" style={{ backgroundColor: '#ff795d' }}>
                            {busyId === r.id ? t('crm.outbox.saving', 'Speichert…') : `💾 ${t('crm.outbox.save', 'Speichern')}`}
                          </button>
                          <button onClick={() => setEditId(null)} className="text-xs text-gray-500 hover:text-gray-800 px-3 py-1.5">{t('common.cancel', 'Abbrechen')}</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="text-sm text-gray-700 border border-gray-100 rounded-lg p-3 bg-gray-50 max-h-72 overflow-y-auto"
                          dangerouslySetInnerHTML={{ __html: r.body ?? '' }} />
                        {r.error_message && <p className="text-xs text-red-500 mt-2">{r.error_message}</p>}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
            )
          })}
        </div>
      </div>
      {chat && <DeckChat token={chat.token} label={chat.label} onClose={() => setChat(null)} onStarted={onRefineStarted} />}
      {editCalc && (
        <RechnerWizard
          lead={editCalc.lead}
          editCalc={{ token: editCalc.token, content: editCalc.content }}
          onClose={() => setEditCalc(null)}
          onDone={(msg) => { setEditCalc(null); flash(msg); void load() }}
        />
      )}
    </DashboardLayout>
  )
}
