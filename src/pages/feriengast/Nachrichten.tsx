import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import GuestLayout from '../../components/GuestLayout'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../../lib/auth'

interface Message {
  id: string
  sender_id: string | null
  content: string
  is_read: boolean
  created_at: string
  sender?: { full_name: string; role: string } | null
}

function fmtTime(iso: string, lang: string) {
  const d = new Date(iso)
  const today = new Date(); today.setHours(0,0,0,0)
  const dDay = new Date(d); dDay.setHours(0,0,0,0)
  if (dDay.getTime() === today.getTime()) {
    return d.toLocaleTimeString(lang === 'de' ? 'de-DE' : 'en-GB', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString(lang === 'de' ? 'de-DE' : 'en-GB', { day: '2-digit', month: 'short' })
}

export default function Nachrichten() {
  const { t }       = useTranslation()
  const { profile } = useAuth()
  const lang        = profile?.language ?? 'de'
  const bottomRef   = useRef<HTMLDivElement>(null)

  const [messages, setMessages] = useState<Message[]>([])
  const [bookingId, setBookingId] = useState<string | null>(null)
  const [loading, setLoading]   = useState(true)
  const [text, setText]         = useState('')
  const [sending, setSending]   = useState(false)

  useEffect(() => {
    if (!profile) return
    let channel: ReturnType<typeof supabase.channel> | null = null

    ;(async () => {
      const { data: bData } = await supabase
        .from('bookings')
        .select('id')
        .eq('guest_id', profile.id)
        .order('check_in', { ascending: false })
        .limit(1)
        .single()
      if (!bData) { setLoading(false); return }
      setBookingId(bData.id)
      await loadMessages(bData.id)
      setLoading(false)

      // Realtime: neue Nachrichten sofort anzeigen, ohne Seite neu laden
      channel = supabase
        .channel(`messages:booking:${bData.id}`)
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'messages', filter: `booking_id=eq.${bData.id}` },
          payload => {
            const msg = payload.new as Message
            // Eigene Nachrichten sind bereits optimistisch gesetzt
            if (msg.sender_id === profile.id) return
            setMessages(prev => [...prev, msg])
            // Als gelesen markieren
            supabase
              .from('messages')
              .update({ is_read: true })
              .eq('id', msg.id)
              .then(() => { /* fire-and-forget */ })
          }
        )
        .subscribe()
    })()

    return () => {
      // Subscription aufräumen → kein Memory Leak
      channel?.unsubscribe()
    }
  }, [profile])

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function loadMessages(bid: string) {
    const { data } = await supabase
      .from('messages')
      .select('id, sender_id, content, is_read, created_at, sender:sender_id(full_name, role)')
      .eq('booking_id', bid)
      .order('created_at', { ascending: true })
    setMessages((data ?? []) as unknown as Message[])

    // Mark unread as read
    await supabase
      .from('messages')
      .update({ is_read: true })
      .eq('booking_id', bid)
      .eq('is_read', false)
      .neq('sender_id', profile!.id)
  }

  async function handleSend(e: React.FormEvent) {
    e.preventDefault()
    if (!text.trim() || !bookingId || !profile) return
    setSending(true)
    const content = text.trim()
    setText('')
    const { data } = await supabase
      .from('messages')
      .insert({ booking_id: bookingId, sender_id: profile.id, content })
      .select('id, sender_id, content, is_read, created_at')
      .single()
    if (data) {
      setMessages(m => [...m, { ...data, sender: { full_name: profile.full_name, role: profile.role } }])
    }
    setSending(false)
  }

  const isMe = (msg: Message) => msg.sender_id === profile?.id

  return (
    <GuestLayout>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-hp-black font-body">{t('guest.nav.messages')}</h1>
        <p className="text-sm text-gray-400 font-body mt-0.5">{t('guest.messages.subtitle')}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-32 text-gray-400 gap-3 font-body text-sm">
          <span className="w-5 h-5 border-2 border-gray-200 border-t-gray-400 rounded-full animate-spin" />
          {t('common.loading')}
        </div>
      ) : !bookingId ? (
        <div className="text-center py-32 text-gray-400 font-body">{t('guest.noBooking.desc')}</div>
      ) : (
        <div className="max-w-2xl flex flex-col" style={{ height: 'calc(100vh - 220px)' }}>
          {/* Messages */}
          <div className="flex-1 overflow-y-auto space-y-3 pb-4">
            {messages.length === 0 ? (
              <div className="text-center py-16 text-gray-400 font-body text-sm">
                {t('guest.messages.empty')}
              </div>
            ) : messages.map(msg => (
              <div key={msg.id}
                   className={`flex ${isMe(msg) ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-2xl px-4 py-3 ${
                  isMe(msg)
                    ? 'rounded-br-sm text-white'
                    : 'rounded-bl-sm bg-white border border-gray-100 text-hp-black'
                }`}
                style={isMe(msg) ? { backgroundColor: 'var(--color-highlight)' } : {}}>
                  {!isMe(msg) && (
                    <p className="text-xs font-semibold font-body mb-1 text-gray-500">
                      {msg.sender?.full_name ?? t('guest.messages.verwalter')}
                    </p>
                  )}
                  <p className="text-sm font-body leading-relaxed">{msg.content}</p>
                  <p className={`text-xs mt-1 font-body ${isMe(msg) ? 'text-white/70 text-right' : 'text-gray-400'}`}>
                    {fmtTime(msg.created_at, lang)}
                  </p>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <form onSubmit={handleSend}
                className="flex gap-2 pt-3 border-t border-gray-100">
            <input
              type="text"
              value={text}
              onChange={e => setText(e.target.value)}
              placeholder={t('guest.messages.placeholder')}
              className="flex-1 px-4 py-3 rounded-xl border border-gray-200 bg-white text-sm
                         font-body text-hp-black placeholder-gray-400
                         focus:outline-none focus:ring-2 focus:ring-hp-highlight focus:border-transparent"
            />
            <button type="submit" disabled={!text.trim() || sending}
                    className="px-5 py-3 rounded-xl text-white text-sm font-semibold font-body
                               hover:opacity-90 disabled:opacity-50 shrink-0 flex items-center gap-2"
                    style={{ backgroundColor: 'var(--color-highlight)' }}>
              {sending ? (
                <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              ) : '↑'}
              <span className="hidden sm:inline">{t('guest.messages.send')}</span>
            </button>
          </form>
        </div>
      )}
    </GuestLayout>
  )
}
