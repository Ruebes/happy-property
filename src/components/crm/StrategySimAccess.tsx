import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { sendWhatsApp } from '../../lib/whatsapp'
import { shortLinkFor, simulatorUrl, simulatorWhatsappText, simulatorMail } from '../../lib/simulatorAccess'
import type { SimUnit, SimParams } from '../../lib/strategy'

// ── Simulator für den Kunden freischalten (Sven 23.10.26) ───────────────────
// Oben im Simulator („Fahrplan bearbeiten"): Der Kunde bekommt unter
// /simulator/:token einen eigenen Simulator, per WhatsApp (Kurzlink) und als
// HTML-Mail. Was er dort baut, wird gespeichert und ist hier zu sehen.
export interface SimInfo { token: string; sim_enabled_at: string | null; customer_updated_at: string | null }

interface Contact { email: string | null; phone: string | null; language: string | null }

export default function StrategySimAccess({ lead, units, params, info, onChanged, onClose }: {
  lead: { id: string; first_name: string; last_name: string }
  units: SimUnit[]; params: SimParams
  info: SimInfo | null
  onChanged: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [contact, setContact] = useState<Contact | null>(null)
  const [token, setToken] = useState(info?.token ?? '')
  const [link, setLink] = useState<{ short: string; full: string } | null>(null)
  const [waOn, setWaOn] = useState(true)
  const [mailOn, setMailOn] = useState(true)
  const [waText, setWaText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const enabled = !!info?.sim_enabled_at

  // Kontakt + Plan sichern (Token) + Kurzlink, dann den WhatsApp-Text vorbelegen
  useEffect(() => { void (async () => {
    try {
      const { data: l } = await supabase.from('leads').select('email, whatsapp, phone, language').eq('id', lead.id).maybeSingle()
      const lr = l as { email?: string | null; whatsapp?: string | null; phone?: string | null; language?: string | null } | null
      const c: Contact = { email: lr?.email?.trim() || null, phone: (lr?.whatsapp || lr?.phone)?.trim() || null, language: lr?.language ?? null }
      setContact(c)
      setWaOn(!!c.phone); setMailOn(!!c.email)
      let tok = info?.token ?? ''
      if (!tok) {
        const { data, error } = await supabase.from('crm_strategy_scenarios')
          .upsert({ lead_id: lead.id, config: { unitsV2: units, paramsV2: params }, updated_at: new Date().toISOString() }, { onConflict: 'lead_id' })
          .select('token').single()
        if (error) throw error
        tok = (data as { token: string }).token
      }
      setToken(tok)
      const sl = await shortLinkFor(simulatorUrl(tok))
      setLink(sl)
      setWaText(simulatorWhatsappText(lead.first_name, sl.short, c.language))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  })() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id])

  const unlockAndSend = async () => {
    if (!token || !link || busy) return
    setBusy(true); setErr(''); setMsg('')
    try {
      // Aktuellen Stand sichern, damit der Kunde genau diesen Plan als Ausgangspunkt bekommt
      const { error: upErr } = await supabase.from('crm_strategy_scenarios')
        .update({ config: { unitsV2: units, paramsV2: params }, recipient_name: `${lead.first_name} ${lead.last_name}`.trim(), updated_at: new Date().toISOString() })
        .eq('token', token)
      if (upErr) throw upErr
      if (!enabled) {
        const { error } = await supabase.from('crm_strategy_scenarios').update({ sim_enabled_at: new Date().toISOString() }).eq('token', token)
        if (error) throw error
        const { data: chk } = await supabase.from('crm_strategy_scenarios').select('sim_enabled_at').eq('token', token).maybeSingle()
        if (!(chk as { sim_enabled_at: string | null } | null)?.sim_enabled_at) throw new Error(t('crm.simAccess.errSave', 'Freischaltung wurde nicht gespeichert - fehlen die Rechte?'))
      }
      const sent: string[] = []
      const failed: string[] = []
      if (waOn && contact?.phone) {
        const r = await sendWhatsApp({ event_type: 'no_show', override_text: waText.trim(), lead_id: lead.id,
          lead_data: { lead_name: `${lead.first_name} ${lead.last_name}`.trim(), lead_phone: contact.phone } })
        if (r.success) sent.push('WhatsApp'); else failed.push(`WhatsApp: ${r.error ?? '?'}`)
      }
      if (mailOn && contact?.email) {
        const m = simulatorMail(lead.first_name, link.full, contact.language)
        const { data, error } = await supabase.functions.invoke('send-email', { body: { to: contact.email, subject: m.subject, html: m.html, lead_id: lead.id } })
        const e2 = error?.message ?? (data as { error?: string } | null)?.error
        if (e2) failed.push(`E-Mail: ${e2}`); else sent.push(t('crm.simAccess.mail', 'E-Mail'))
      }
      onChanged()
      if (failed.length) setErr(failed.join(' · '))
      setMsg(sent.length
        ? t('crm.simAccess.sent', 'Freigeschaltet und gesendet: {{list}}', { list: sent.join(', ') })
        : t('crm.simAccess.unlocked', 'Freigeschaltet. Nichts gesendet, du kannst den Link selbst weitergeben.'))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }

  const lock = async () => {
    if (!token || busy) return
    setBusy(true); setErr(''); setMsg('')
    const { error } = await supabase.from('crm_strategy_scenarios').update({ sim_enabled_at: null }).eq('token', token)
    setBusy(false)
    if (error) { setErr(error.message); return }
    onChanged()
    setMsg(t('crm.simAccess.locked', 'Zugang gesperrt. Der Link funktioniert nicht mehr, die Eingaben des Kunden bleiben gespeichert.'))
  }

  const fmt = (iso: string) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="fixed inset-0 z-[75] bg-black/40 flex items-start justify-center overflow-y-auto p-3 sm:p-6" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg my-6 p-5 space-y-3" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-gray-900">🔓 {t('crm.simAccess.title', 'Simulator für den Kunden')}</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {t('crm.simAccess.sub', '{{name}} bekommt einen eigenen Simulator mit diesem Plan als Ausgangspunkt. Seine Eingaben werden gespeichert, dein Fahrplan bleibt unverändert.', { name: `${lead.first_name} ${lead.last_name}`.trim() })}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">✕</button>
        </div>

        <div className={`rounded-lg px-3 py-2 text-xs border ${enabled ? 'bg-green-50 border-green-200 text-green-900' : 'bg-gray-50 border-gray-200 text-gray-700'}`}>
          {enabled
            ? t('crm.simAccess.on', 'Freigeschaltet seit {{d}}.', { d: fmt(info!.sim_enabled_at!) })
            : t('crm.simAccess.off', 'Noch nicht freigeschaltet.')}
          {info?.customer_updated_at && ` ${t('crm.simAccess.lastChange', 'Letzte Änderung des Kunden: {{d}}.', { d: fmt(info.customer_updated_at) })}`}
        </div>

        {link && (
          <div className="flex items-center gap-2">
            <input readOnly value={link.short} onFocus={e => e.currentTarget.select()}
              className="flex-1 border border-gray-200 rounded-lg px-2.5 py-1.5 text-xs bg-gray-50" />
            <button onClick={() => void navigator.clipboard?.writeText(link.full)}
              className="px-3 py-1.5 rounded-lg text-xs border border-gray-300 text-gray-600 hover:bg-gray-50">
              {t('crm.sim.copy', 'Link kopieren')}
            </button>
          </div>
        )}

        <div className="space-y-1.5">
          <label className={`flex items-center gap-2 text-sm ${contact?.phone ? 'text-gray-800 cursor-pointer' : 'text-gray-400'}`}>
            <input type="checkbox" className="w-4 h-4 accent-orange-500" checked={waOn && !!contact?.phone} disabled={!contact?.phone}
              onChange={e => setWaOn(e.target.checked)} />
            {t('crm.simAccess.byWa', 'per WhatsApp')} {contact?.phone ? <span className="text-gray-400 text-xs">{contact.phone}</span> : <span className="text-xs">({t('crm.simAccess.noPhone', 'keine Nummer')})</span>}
          </label>
          {waOn && contact?.phone && (
            <textarea value={waText} onChange={e => setWaText(e.target.value)} rows={9}
              className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-xs font-sans focus:outline-none focus:ring-2 focus:ring-orange-300" />
          )}
          <label className={`flex items-center gap-2 text-sm ${contact?.email ? 'text-gray-800 cursor-pointer' : 'text-gray-400'}`}>
            <input type="checkbox" className="w-4 h-4 accent-orange-500" checked={mailOn && !!contact?.email} disabled={!contact?.email}
              onChange={e => setMailOn(e.target.checked)} />
            {t('crm.simAccess.byMail', 'per E-Mail (HTML)')} {contact?.email ? <span className="text-gray-400 text-xs">{contact.email}</span> : <span className="text-xs">({t('crm.simAccess.noEmail', 'keine E-Mail')})</span>}
          </label>
        </div>

        {msg && <p className="text-xs text-green-800 bg-green-50 border border-green-200 rounded-lg px-3 py-2">✓ {msg}</p>}
        {err && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</p>}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap gap-2">
            {info?.customer_updated_at && token && (
              <a href={`/strategie/${token}?kunde=1`} target="_blank" rel="noreferrer"
                className="px-3 py-1.5 rounded-lg text-sm border border-orange-300 text-orange-700 hover:bg-orange-50">
                👁 {t('crm.simAccess.view', 'Strategie des Kunden')}
              </a>
            )}
            {enabled && (
              <button onClick={() => void lock()} disabled={busy}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-500 hover:text-red-600 disabled:opacity-40">
                {t('crm.simAccess.lock', 'Zugang sperren')}
              </button>
            )}
          </div>
          <button onClick={() => void unlockAndSend()} disabled={busy || !link}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-40 bg-[#ff795d] hover:opacity-90">
            {busy ? t('crm.simAccess.busy', 'Wird gesendet…')
              : enabled
                ? ((waOn && contact?.phone) || (mailOn && contact?.email) ? t('crm.simAccess.resend', 'Erneut senden') : t('crm.simAccess.save', 'Plan aktualisieren'))
                : ((waOn && contact?.phone) || (mailOn && contact?.email) ? t('crm.simAccess.unlockSend', 'Freischalten und senden') : t('crm.simAccess.unlockOnly', 'Nur freischalten'))}
          </button>
        </div>
        <p className="text-[11px] text-gray-400">
          {t('crm.simAccess.hint2', 'Solange der Kunde nichts ändert, sieht er immer deinen aktuellen Fahrplan. Sobald er selbst etwas verstellt, bleibt seine Variante, bis er sie zurücksetzt.')}
        </p>
      </div>
    </div>
  )
}
