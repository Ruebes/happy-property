import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'
import { useAuth } from '../../../lib/auth'

// ── Posteingang ───────────────────────────────────────────────────────────────
// EIN Ort für die echte Kundenkommunikation: Mail UND WhatsApp, ein- und
// ausgehend, nach Kontakt gebündelt. Automatische Nachrichten (Drip, Bot, System)
// sind bewusst AUSGEBLENDET — erkennbar an activities.auto=false; eingehende
// Nachrichten sind immer echte Kundennachrichten und werden immer gezeigt.
//
// Blauer Punkt = ungelesene eingehende Nachricht. Beim Öffnen der Konversation
// werden ihre eingehenden Nachrichten als gelesen markiert (activities.read_at).

interface Msg {
  id: string
  type: 'email' | 'whatsapp'
  direction: 'inbound' | 'outbound'
  subject: string | null
  content: string | null
  at: string
  unread: boolean
}
interface Convo {
  lead_id: string
  name: string
  email: string | null
  phone: string | null
  whatsapp: string | null
  msgs: Msg[]
  lastAt: string
  lastDir: 'inbound' | 'outbound'
  channels: Set<'email' | 'whatsapp'>
  unread: number
}

type ChannelFilter = 'all' | 'whatsapp' | 'email'
const ATTACH_BUCKET = 'crm-project-images'

const fileToB64 = (f: File): Promise<string> => new Promise((res, rej) => {
  const r = new FileReader()
  r.onload = () => res(String(r.result).split(',')[1] ?? '')
  r.onerror = rej
  r.readAsDataURL(f)
})

export default function Inbox() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { profile } = useAuth()
  const [convos, setConvos] = useState<Convo[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string | null>(null)
  const [channel, setChannel] = useState<ChannelFilter>('all')
  const [onlyOpen, setOnlyOpen] = useState(false)   // nur unbeantwortete (letzte Nachricht eingehend)
  const [search, setSearch] = useState('')
  const [reply, setReply] = useState('')
  const [replyChannel, setReplyChannel] = useState<'whatsapp' | 'email'>('whatsapp')
  const [attach, setAttach] = useState<File | null>(null)
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState('')
  const threadRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 4000) }

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const { data, error } = await supabase
        .from('activities')
        .select('id, lead_id, type, direction, subject, content, created_at, completed_at, auto, read_at, lead:leads!inner(first_name, last_name, email, phone, whatsapp)')
        .in('type', ['email', 'whatsapp'])
        .or('auto.eq.false,direction.eq.inbound')
        .not('lead_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1000)
      if (error) throw error
      const byLead = new Map<string, Convo>()
      // deno-lint-ignore no-explicit-any
      for (const r of (data ?? []) as any[]) {
        const lead = r.lead
        if (!lead) continue
        const at = r.completed_at || r.created_at
        const unread = r.direction === 'inbound' && !r.read_at
        let c = byLead.get(r.lead_id)
        if (!c) {
          c = {
            lead_id: r.lead_id,
            name: `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || t('crm.inbox.unknown', 'Unbekannt'),
            email: lead.email, phone: lead.phone, whatsapp: lead.whatsapp,
            msgs: [], lastAt: at, lastDir: r.direction, channels: new Set(), unread: 0,
          }
          byLead.set(r.lead_id, c)
        }
        c.msgs.push({ id: r.id, type: r.type, direction: r.direction, subject: r.subject, content: r.content, at, unread })
        if (unread) c.unread++
        c.channels.add(r.type)
      }
      const list = Array.from(byLead.values()).map(c => {
        c.lastAt = c.msgs[0]?.at ?? c.lastAt
        c.lastDir = c.msgs[0]?.direction ?? c.lastDir
        c.msgs.reverse()
        return c
      }).sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1))
      setConvos(list)
      setSelected(s => s && list.some(c => c.lead_id === s) ? s : (list[0]?.lead_id ?? null))
    } catch (err) {
      console.error('[Inbox] fetchAll:', err)
      setConvos([])
    } finally { setLoading(false) }
  }, [t])

  useEffect(() => { void fetchAll() }, [fetchAll])

  // Konversation geöffnet → eingehende Nachrichten als gelesen markieren.
  const markRead = useCallback(async (leadId: string) => {
    const c = convos.find(x => x.lead_id === leadId)
    if (!c || c.unread === 0) return
    setConvos(cs => cs.map(x => x.lead_id === leadId
      ? { ...x, unread: 0, msgs: x.msgs.map(m => m.unread ? { ...m, unread: false } : m) }
      : x))
    const { error } = await supabase.from('activities').update({ read_at: new Date().toISOString() })
      .eq('lead_id', leadId).eq('direction', 'inbound').is('read_at', null)
    if (error) console.warn('[Inbox] markRead:', error.message)
  }, [convos])

  useEffect(() => { if (selected) void markRead(selected) }, [selected, markRead])

  const filtered = useMemo(() => convos.filter(c => {
    if (channel !== 'all' && !c.channels.has(channel)) return false
    if (onlyOpen && c.lastDir !== 'inbound') return false
    if (search.trim()) {
      const q = search.toLowerCase()
      if (!c.name.toLowerCase().includes(q) && !(c.email ?? '').toLowerCase().includes(q)) return false
    }
    return true
  }), [convos, channel, onlyOpen, search])

  const current = useMemo(() => convos.find(c => c.lead_id === selected) ?? null, [convos, selected])
  const unreadCount = useMemo(() => convos.filter(c => c.unread > 0).length, [convos])

  useEffect(() => {
    if (!current) return
    const lastCh = current.msgs[current.msgs.length - 1]?.type
    if (lastCh === 'email' && current.email) setReplyChannel('email')
    else if (current.whatsapp || current.phone) setReplyChannel('whatsapp')
    else if (current.email) setReplyChannel('email')
    setReply(''); setAttach(null)
  }, [current])

  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight }, [current, sending])

  const sendReply = async () => {
    if (!current || (!reply.trim() && !attach)) return
    const text = reply.trim()
    setSending(true)
    try {
      if (replyChannel === 'whatsapp') {
        const phone = current.whatsapp || current.phone
        if (!phone) { showToast(t('crm.inbox.noPhone', 'Kein WhatsApp-/Telefonkontakt hinterlegt')); return }
        // Anhang bei WhatsApp: in den Bucket laden, URL an send-whatsapp geben.
        // Grosse Bilder verkleinert send-whatsapp selbst auf unter 2 MB.
        let file_url: string | undefined, file_name: string | undefined
        if (attach) {
          const ext = (attach.name.split('.').pop() || 'bin').toLowerCase()
          const path = `whatsapp/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
          const up = await supabase.storage.from(ATTACH_BUCKET).upload(path, attach, { cacheControl: '3600', upsert: false })
          if (up.error) throw up.error
          file_url = supabase.storage.from(ATTACH_BUCKET).getPublicUrl(path).data.publicUrl
          file_name = attach.name
        }
        const { data, error } = await supabase.functions.invoke('send-whatsapp', { body: {
          event_type: 'no_show', override_text: text || ' ',
          lead_data: { lead_name: current.name, lead_phone: phone },
          ...(file_url ? { file_url, file_name } : {}),
        } })
        if (error) throw error
        const r = data as { success?: boolean; attached?: boolean; attach_error?: string } | null
        if (!r?.success) throw new Error('WhatsApp')
        if (attach && r.attached === false) showToast(t('crm.inbox.attachFailed', 'Text gesendet, Anhang leider nicht: {{e}}', { e: r.attach_error ?? '' }))
        await supabase.from('activities').insert({
          lead_id: current.lead_id, type: 'whatsapp', direction: 'outbound',
          subject: `WhatsApp → ${current.name}`, content: `${text}${attach ? `\n📎 ${attach.name}` : ''}`.slice(0, 2000),
          created_by: profile?.id ?? null, completed_at: new Date().toISOString(), auto: false,
        })
      } else {
        if (!current.email) { showToast(t('crm.inbox.noEmail', 'Keine E-Mail-Adresse hinterlegt')); return }
        const lastSubj = [...current.msgs].reverse().find(m => m.type === 'email')?.subject ?? ''
        const subject = lastSubj ? (/^re:/i.test(lastSubj) ? lastSubj : `Re: ${lastSubj.replace(/^Antwort:\s*/i, '')}`) : t('crm.inbox.defaultSubject', 'Ihre Anfrage bei Happy Property')
        const html = text
          ? `<div style="font-family:Arial,sans-serif;font-size:15px;color:#374151;white-space:pre-wrap">${text.replace(/</g, '&lt;')}</div>`
          : `<div style="font-family:Arial,sans-serif;font-size:15px;color:#374151">${t('crm.inbox.seeAttachment', 'Siehe Anhang.')}</div>`
        const attachments = attach ? [{ filename: attach.name, content_base64: await fileToB64(attach), content_type: attach.type || 'application/octet-stream' }] : undefined
        const { data, error } = await supabase.functions.invoke('send-email', { body: { to: current.email, subject, html, lead_id: null, ...(attachments ? { attachments } : {}) } })
        if (error) throw error
        if ((data as { success?: boolean } | null)?.success === false) throw new Error((data as { error?: string }).error || 'E-Mail')
        await supabase.from('activities').insert({
          lead_id: current.lead_id, type: 'email', direction: 'outbound',
          subject, content: `${text}${attach ? `\n📎 ${attach.name}` : ''}`.slice(0, 2000),
          created_by: profile?.id ?? null, completed_at: new Date().toISOString(), auto: false,
        })
      }
      setReply(''); setAttach(null)
      showToast(t('crm.inbox.sent', 'Gesendet ✓'))
      await fetchAll()
    } catch (err) {
      console.error('[Inbox] sendReply:', err)
      showToast(`❌ ${err instanceof Error ? err.message : t('crm.inbox.sendError', 'Senden fehlgeschlagen')}`)
    } finally { setSending(false) }
  }

  const relTime = (iso: string) => {
    const d = new Date(iso), now = Date.now(), diff = (now - d.getTime()) / 1000
    if (diff < 3600) return t('crm.inbox.minAgo', 'vor {{n}} Min', { n: Math.max(1, Math.floor(diff / 60)) })
    if (diff < 86400) return t('crm.inbox.hAgo', 'vor {{n}} Std', { n: Math.floor(diff / 3600) })
    return d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
  }
  const chIcon = (c: 'email' | 'whatsapp') => c === 'whatsapp' ? '💬' : '✉️'

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && <div className="fixed bottom-6 right-6 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">{toast}</div>}
      <div className="p-4 md:p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('crm.inbox.title', 'Posteingang')}</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {t('crm.inbox.subtitle', 'Deine Kundenkommunikation — Mail und WhatsApp, ein- und ausgehend. Automatische Nachrichten sind ausgeblendet.')}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {(['all', 'whatsapp', 'email'] as ChannelFilter[]).map(ch => (
              <button key={ch} onClick={() => setChannel(ch)}
                className={`px-3 py-1.5 rounded-xl text-sm font-medium border ${channel === ch ? 'text-white border-transparent' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
                style={channel === ch ? { backgroundColor: '#ff795d' } : undefined}>
                {ch === 'all' ? t('crm.inbox.chAll', 'Alle') : ch === 'whatsapp' ? `💬 ${t('crm.inbox.chWa', 'WhatsApp')}` : `✉️ ${t('crm.inbox.chMail', 'Mail')}`}
              </button>
            ))}
            <button onClick={() => setOnlyOpen(o => !o)}
              className={`px-3 py-1.5 rounded-xl text-sm font-medium border ${onlyOpen ? 'text-white border-transparent' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              style={onlyOpen ? { backgroundColor: '#0ea5e9' } : undefined}>
              {t('crm.inbox.onlyOpen', 'Unbeantwortet')}{unreadCount > 0 && ` (${unreadCount})`}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-24"><div className="w-8 h-8 border-4 border-orange-300 border-t-orange-500 rounded-full animate-spin" /></div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-4 h-[calc(100vh-220px)] min-h-[480px]">
            {/* Konversationsliste */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col overflow-hidden">
              <div className="p-2 border-b border-gray-100">
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder={t('crm.inbox.search', 'Suchen …')}
                  className="w-full px-3 py-2 rounded-xl border border-gray-200 text-sm focus:outline-none focus:ring-2 focus:ring-orange-200" />
              </div>
              <div className="flex-1 overflow-y-auto divide-y divide-gray-50">
                {filtered.length === 0 ? (
                  <p className="text-sm text-gray-400 text-center py-10">{t('crm.inbox.empty', 'Keine Konversationen.')}</p>
                ) : filtered.map(c => {
                  const last = c.msgs[c.msgs.length - 1]
                  return (
                    <button key={c.lead_id} onClick={() => setSelected(c.lead_id)}
                      className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 transition-colors ${selected === c.lead_id ? 'bg-orange-50' : ''}`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-sm truncate flex items-center gap-1.5 ${c.unread > 0 ? 'font-bold text-gray-900' : 'font-medium text-gray-800'}`}>
                          {c.unread > 0 && <span className="w-2 h-2 rounded-full bg-sky-500 shrink-0" title={t('crm.inbox.unread', 'ungelesen') ?? ''} />}
                          {c.name}
                        </span>
                        <span className="text-[11px] text-gray-400 shrink-0">{relTime(c.lastAt)}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <span className="text-xs shrink-0">{Array.from(c.channels).map(chIcon).join('')}</span>
                        <span className={`text-xs truncate ${c.unread > 0 ? 'text-gray-700 font-medium' : 'text-gray-500'}`}>
                          {last?.direction === 'outbound' ? '↩ ' : ''}{(last?.content ?? '').replace(/\s+/g, ' ').slice(0, 60)}
                        </span>
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Thread */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm flex flex-col overflow-hidden">
              {!current ? (
                <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">{t('crm.inbox.pick', 'Konversation auswählen')}</div>
              ) : (
                <>
                  <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-gray-900 truncate">{current.name}</div>
                      <div className="text-xs text-gray-400 truncate">{[current.email, current.whatsapp || current.phone].filter(Boolean).join(' · ')}</div>
                    </div>
                    <button onClick={() => navigate(`/admin/crm/leads/${current.lead_id}`)}
                      className="shrink-0 text-xs font-medium text-gray-600 border border-gray-200 rounded-lg px-3 py-1.5 hover:bg-gray-50">
                      {t('crm.inbox.openLead', 'Kontakt öffnen')} →
                    </button>
                  </div>

                  <div ref={threadRef} className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/50">
                    {current.msgs.map(m => {
                      const out = m.direction === 'outbound'
                      return (
                        <div key={m.id} className={`flex ${out ? 'justify-end' : 'justify-start'}`}>
                          <div className={`max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm ${out ? 'text-white rounded-br-sm' : 'bg-white border border-gray-100 text-gray-800 rounded-bl-sm'}`}
                            style={out ? { backgroundColor: '#ff795d' } : undefined}>
                            <div className={`text-[10px] mb-0.5 ${out ? 'text-white/80' : 'text-gray-400'}`}>
                              {chIcon(m.type)} {new Date(m.at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </div>
                            {m.type === 'email' && m.subject && <div className={`font-semibold text-xs mb-0.5 ${out ? 'text-white' : 'text-gray-700'}`}>{m.subject}</div>}
                            <div className="whitespace-pre-wrap break-words">{m.content}</div>
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Antwort */}
                  <div className="border-t border-gray-100 p-3">
                    <div className="flex items-center gap-2 mb-2">
                      {(['whatsapp', 'email'] as const).map(ch => {
                        const avail = ch === 'whatsapp' ? !!(current.whatsapp || current.phone) : !!current.email
                        return (
                          <button key={ch} disabled={!avail} onClick={() => setReplyChannel(ch)}
                            className={`px-2.5 py-1 rounded-lg text-xs font-medium border disabled:opacity-40 ${replyChannel === ch ? 'text-white border-transparent' : 'border-gray-200 text-gray-600'}`}
                            style={replyChannel === ch ? { backgroundColor: ch === 'whatsapp' ? '#22c55e' : '#0ea5e9' } : undefined}>
                            {ch === 'whatsapp' ? `💬 ${t('crm.inbox.chWa', 'WhatsApp')}` : `✉️ ${t('crm.inbox.chMail', 'Mail')}`}
                          </button>
                        )
                      })}
                      <div className="ml-auto" />
                      <button onClick={() => fileRef.current?.click()} disabled={sending}
                        className="px-2.5 py-1 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                        title={t('crm.inbox.attach', 'Datei anhängen') ?? ''}>
                        📎 {t('crm.inbox.attach', 'Anhang')}
                      </button>
                      <input ref={fileRef} type="file" className="hidden"
                        onChange={e => { const f = e.target.files?.[0]; if (f) setAttach(f); if (fileRef.current) fileRef.current.value = '' }} />
                    </div>
                    {attach && (
                      <div className="flex items-center gap-2 mb-2 text-xs bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-1.5">
                        <span className="truncate">📎 {attach.name} · {Math.round(attach.size / 1024)} KB</span>
                        {replyChannel === 'whatsapp' && attach.size > 2_000_000 && !attach.type.startsWith('image/') && (
                          <span className="text-amber-600 shrink-0">{t('crm.inbox.tooBigForWa', 'zu groß für WhatsApp')}</span>
                        )}
                        <button onClick={() => setAttach(null)} className="ml-auto text-gray-400 hover:text-red-500 shrink-0">✕</button>
                      </div>
                    )}
                    <div className="flex items-end gap-2">
                      <textarea value={reply} onChange={e => setReply(e.target.value)}
                        onKeyDown={e => {
                          // Enter sendet; Cmd/Strg+Enter (und Shift+Enter) macht einen Zeilenumbruch.
                          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void sendReply() }
                        }}
                        rows={2} placeholder={t('crm.inbox.replyPlaceholder', 'Antwort schreiben … (Enter sendet, ⌘/Strg+Enter = Zeilenumbruch)')}
                        className="flex-1 px-3 py-2 rounded-xl border border-gray-200 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-orange-200" />
                      <button onClick={() => void sendReply()} disabled={sending || (!reply.trim() && !attach)}
                        className="px-4 py-2 rounded-xl text-white text-sm font-medium disabled:opacity-50 shrink-0" style={{ backgroundColor: '#ff795d' }}>
                        {sending ? t('common.saving', 'sendet …') : t('crm.inbox.send', 'Senden')}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  )
}
