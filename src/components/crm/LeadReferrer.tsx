import { useEffect, useState, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { supabase } from '../../lib/supabase'

// ── Empfehlungsgeber ─────────────────────────────────────────────────────────
// Wer hat diesen Kunden empfohlen (Tippgeber-Programm)? Zuweisen, Provision je
// Kunde (Standard 1.000 €) und die Abrechnungsdaten des Tippgebers pflegen.
// Sobald der Deal auf „Provision erhalten" steht, schickt affiliate-api (Cron)
// Abrechnung + Revolut-Auszahlungslink automatisch an den Tippgeber.
// Fehlt seine Adresse, sucht affiliate-api sie in Profil und Drive-Unterlagen; sonst
// fragt Lotte per WhatsApp, sobald der Deal auf Reservierung steht (address.status).
// Alles läuft über affiliate-api (Tabellen sind per RLS dicht).

interface Referrer {
  id: string; name: string; email: string | null; whatsapp: string | null; lead_id: string | null
  street: string | null; postal_code: string | null; city: string | null; country: string | null
  is_business: boolean; vat_id: string | null; referred_count: number
}
interface Payout {
  id: string; amount: number; status: string; doc_no: string | null; doc_url: string | null
  payout_link_state: string | null; payout_link_error: string | null; paid_at: string | null
}
interface AddressState {
  status: 'ok' | 'searching' | 'not_found' | 'requested'
  source: string | null; note: string | null; requested_at: string | null; reply_text: string | null; due: boolean
}
interface State {
  referrer: Referrer | null; commission: number | null; default_commission: number; link_max: number
  payout: Payout | null; deal_done: boolean; address: AddressState | null
}
interface Hit { kind: 'affiliate' | 'lead'; id: string; name: string; email: string | null; hint: string }

const eur = (n: number) => n.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
const input = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400'
const emptyAddr = { name: '', email: '', whatsapp: '', street: '', postal_code: '', city: '', country: 'Deutschland', is_business: false, vat_id: '' }

export default function LeadReferrer({ leadId }: { leadId: string }) {
  const { t } = useTranslation()
  const [st, setSt] = useState<State | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [mode, setMode] = useState<'view' | 'pick' | 'new' | 'edit'>('view')
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [searching, setSearching] = useState(false)
  const [amount, setAmount] = useState('')
  const [form, setForm] = useState(emptyAddr)
  const searchSeq = useRef(0)

  const api = useCallback(async (body: Record<string, unknown>) => {
    const { data, error } = await supabase.functions.invoke('affiliate-api', { body: { lead_id: leadId, ...body } })
    let d = data as (Partial<State> & { ok?: boolean; error?: string; results?: Hit[] }) | null
    if (error) {
      // Fehlertext aus der Antwort holen (409 = schon abgerechnet, 403 = keine Rechte)
      const ctx = (error as { context?: Response }).context
      try { d = await ctx?.json() } catch { /* kein JSON */ }
      const err = new Error(d?.error ?? error.message) as Error & { status?: number }
      err.status = ctx?.status
      throw err
    }
    return d ?? {}
  }, [leadId])

  const apply = (d: Partial<State>) => {
    if (!('referrer' in d)) return
    const s = d as State
    setSt(s)
    setAmount(String(s.commission ?? s.default_commission).replace('.', ','))
  }

  const load = useCallback(async () => {
    setLoading(true)
    try { apply(await api({ action: 'referrer_get' })) }
    catch (e) {
      // Nur admin/verwalter sehen Provisionen; für alle anderen bleibt der Block weg.
      if ((e as { status?: number }).status === 403 || (e as { status?: number }).status === 401) setHidden(true)
      else setNotice(e instanceof Error ? e.message : 'Fehler')
    } finally { setLoading(false) }
  }, [api])
  useEffect(() => { void load() }, [load])

  // Solange Lotte in den Unterlagen sucht: still nachladen (alle 8 s, höchstens ~4 Min)
  const addrSearching = st?.address?.status === 'searching' && mode === 'view'
  const polls = useRef(0)
  useEffect(() => {
    if (!addrSearching) { polls.current = 0; return }
    if (polls.current >= 30) return
    const h = setTimeout(async () => {
      polls.current++
      try { apply(await api({ action: 'referrer_get' })) } catch { /* nächster Versuch */ }
    }, 8000)
    return () => clearTimeout(h)
  }, [addrSearching, st, api])

  // Suche (entprellt, letzte Anfrage gewinnt)
  useEffect(() => {
    if (mode !== 'pick') return
    const term = q.trim()
    if (term.length < 2) { setHits([]); return }
    const seq = ++searchSeq.current
    const h = setTimeout(async () => {
      setSearching(true)
      try {
        const d = await api({ action: 'referrer_search', q: term })
        if (seq === searchSeq.current) setHits(d.results ?? [])
      } catch { if (seq === searchSeq.current) setHits([]) }
      finally { if (seq === searchSeq.current) setSearching(false) }
    }, 250)
    return () => clearTimeout(h)
  }, [q, mode, api])

  const run = async (body: Record<string, unknown>, after?: () => void) => {
    setBusy(true); setNotice('')
    try {
      apply(await api(body))
      after?.()
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Fehler') }
    finally { setBusy(false) }
  }

  const parsedAmount = () => {
    const n = Number(amount.replace(/\./g, '').replace(',', '.'))
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null
  }

  const assign = (target: Record<string, unknown>, name: string) => {
    const amt = parsedAmount()
    if (!amt) { setNotice(t('crm.referrer.amountInvalid', 'Bitte eine gültige Provision eingeben.')); return }
    if (st?.deal_done && !window.confirm(t('crm.referrer.confirmDue', { amount: eur(amt), name }))) return
    void run({ action: 'referrer_set', commission: amt, ...target }, () => { setMode('view'); setQ(''); setHits([]) })
  }

  const saveAmount = () => {
    const amt = parsedAmount()
    if (!amt) { setNotice(t('crm.referrer.amountInvalid', 'Bitte eine gültige Provision eingeben.')); return }
    void run({ action: 'commission_set', amount: amt }, () => setNotice(t('crm.referrer.saved', 'Gespeichert.')))
  }

  const remove = () => {
    if (!st?.referrer || !window.confirm(t('crm.referrer.confirmRemove', { name: st.referrer.name }))) return
    void run({ action: 'referrer_remove' })
  }

  const openEdit = () => {
    const r = st?.referrer
    if (!r) return
    setForm({
      name: r.name, email: r.email ?? '', whatsapp: r.whatsapp ?? '', street: r.street ?? '',
      postal_code: r.postal_code ?? '', city: r.city ?? '', country: r.country ?? 'Deutschland',
      is_business: r.is_business, vat_id: r.vat_id ?? '',
    })
    setMode('edit')
  }

  const saveEdit = () => {
    if (!st?.referrer) return
    if (!form.email.trim() && !form.whatsapp.trim()) { setNotice(t('crm.referrer.needContact', 'Bitte E-Mail oder WhatsApp angeben.')); return }
    void run({ action: 'affiliate_update', affiliate_id: st.referrer.id, ...form }, () => setMode('view'))
  }

  const searchAgain = () => {
    if (!st?.referrer) return
    void run({ action: 'address_lookup', affiliate_id: st.referrer.id })
  }

  const createNew = () => {
    if (form.name.trim().length < 2) { setNotice(t('crm.referrer.needName', 'Bitte den Namen angeben.')); return }
    if (!form.email.trim() && !form.whatsapp.trim()) { setNotice(t('crm.referrer.needContact', 'Bitte E-Mail oder WhatsApp angeben.')); return }
    assign({ new_referrer: { name: form.name, email: form.email, whatsapp: form.whatsapp } }, form.name)
  }

  if (hidden) return null

  const r = st?.referrer ?? null
  const p = st?.payout ?? null
  const locked = !!p
  const amt = parsedAmount()
  const overMax = !!st && !!amt && amt > st.link_max
  const addressMissing = !!r && (!r.street || !r.postal_code || !r.city)

  const amountField = (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-500 w-20 flex-shrink-0">{t('crm.referrer.commission', 'Provision')}</label>
      <div className="relative w-36">
        <input value={amount} onChange={e => setAmount(e.target.value)} disabled={locked || busy} inputMode="decimal"
          className={`${input} pr-7 text-right disabled:bg-gray-50 disabled:text-gray-500`} />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">€</span>
      </div>
      {mode === 'view' && r && !locked && (
        <button onClick={saveAmount} disabled={busy || amt === (st?.commission ?? st?.default_commission)}
          className="px-3 py-1.5 rounded-lg text-xs font-medium border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-40">
          {t('crm.referrer.save', 'Speichern')}
        </button>
      )}
    </div>
  )

  const contactFields = (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder={t('crm.referrer.name', 'Name')} className={input} />
      <input value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder={t('crm.referrer.email', 'E-Mail')} type="email" className={input} />
      <input value={form.whatsapp} onChange={e => setForm(f => ({ ...f, whatsapp: e.target.value }))} placeholder={t('crm.referrer.whatsapp', 'WhatsApp (+49 …)')} className={input} />
    </div>
  )

  return (
    <div className="bg-white rounded-2xl shadow p-5">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h3 className="font-semibold text-gray-800 text-sm">🤝 {t('crm.referrer.title', 'Empfehlungsgeber')}</h3>
        {r && st && (
          <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
            p?.status === 'bezahlt' ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : p ? 'bg-amber-50 text-amber-700 border-amber-200'
            : 'bg-orange-50 text-hp-highlight border-orange-200'}`}>
            {p ? `${eur(p.amount)} · ${t(`crm.affiliates.status_${p.status}`, p.status)}` : eur(st.commission ?? st.default_commission)}
          </span>
        )}
      </div>

      {notice && <p className="mb-3 text-xs text-gray-600 bg-gray-50 rounded-lg px-3 py-2">{notice}</p>}

      {loading ? (
        <p className="text-sm text-gray-400">{t('common.loading', 'Lädt…')}</p>
      ) : !st ? null : mode === 'pick' || mode === 'new' ? (
        // ── Zuweisen: suchen oder neue Person ──
        <div className="space-y-3">
          {mode === 'pick' ? (
            <>
              <input autoFocus value={q} onChange={e => setQ(e.target.value)} className={input}
                placeholder={t('crm.referrer.searchPlaceholder', 'Name oder E-Mail suchen (Kunde oder Tippgeber) …')} />
              {q.trim().length >= 2 && (
                <div className="border border-gray-100 rounded-xl divide-y divide-gray-100 max-h-64 overflow-y-auto">
                  {searching && hits.length === 0 ? (
                    <p className="text-xs text-gray-400 px-3 py-2">{t('common.loading', 'Lädt…')}</p>
                  ) : hits.length === 0 ? (
                    <p className="text-xs text-gray-400 px-3 py-2">{t('crm.referrer.noResults', 'Kein Treffer.')}</p>
                  ) : hits.map(h => (
                    <button key={`${h.kind}-${h.id}`} disabled={busy}
                      onClick={() => assign(h.kind === 'affiliate' ? { affiliate_id: h.id } : { referrer_lead_id: h.id }, h.name)}
                      className="w-full text-left px-3 py-2 hover:bg-orange-50 disabled:opacity-50">
                      <span className="text-sm font-medium text-gray-800">{h.name}</span>
                      {h.email && <span className="text-xs text-gray-400"> · {h.email}</span>}
                      <span className="block text-[11px] text-gray-400">{h.hint}</span>
                    </button>
                  ))}
                </div>
              )}
              <button onClick={() => { setForm({ ...emptyAddr, name: q.trim() }); setMode('new') }}
                className="text-xs text-hp-highlight hover:underline">
                + {t('crm.referrer.newPerson', 'Nicht im CRM? Neue Person anlegen')}
              </button>
            </>
          ) : (
            <>
              {contactFields}
              <p className="text-[11px] text-gray-400">{t('crm.referrer.newHint', 'Die Person wird nur als Tippgeber angelegt, nicht als Lead. Adresse für die Abrechnung kannst du danach ergänzen.')}</p>
            </>
          )}
          {amountField}
          <p className="text-[11px] text-gray-400">{t('crm.referrer.commissionHint', { amount: eur(st.default_commission) })}</p>
          {overMax && <p className="text-[11px] text-amber-700">{t('crm.referrer.overLinkMax', { max: eur(st.link_max) })}</p>}
          <div className="flex gap-2">
            {mode === 'new' && (
              <button onClick={createNew} disabled={busy}
                className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[#ff795d] text-white hover:opacity-90 disabled:opacity-40">
                {t('crm.referrer.assignBtn', 'Zuweisen')}
              </button>
            )}
            <button onClick={() => { setMode('view'); setQ(''); setHits([]); setNotice(''); if (st) setAmount(String(st.commission ?? st.default_commission).replace('.', ',')) }}
              className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50">
              {t('crm.referrer.cancel', 'Abbrechen')}
            </button>
          </div>
        </div>
      ) : !r ? (
        // ── Noch keiner zugewiesen ──
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-gray-400">{t('crm.referrer.none', 'Kein Empfehlungsgeber zugewiesen.')}</p>
          <button onClick={() => { setNotice(''); setMode('pick') }}
            className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[#ff795d] text-white hover:opacity-90">
            + {t('crm.referrer.assign', 'Empfehlungsgeber zuweisen')}
          </button>
        </div>
      ) : mode === 'edit' ? (
        // ── Daten des Tippgebers für die Abrechnung ──
        <div className="space-y-2">
          {contactFields}
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <input value={form.street} onChange={e => setForm(f => ({ ...f, street: e.target.value }))} placeholder={t('crm.referrer.street', 'Straße + Nr.')} className={`${input} sm:col-span-2`} />
            <input value={form.postal_code} onChange={e => setForm(f => ({ ...f, postal_code: e.target.value }))} placeholder={t('crm.referrer.postalCode', 'PLZ')} className={input} />
            <input value={form.city} onChange={e => setForm(f => ({ ...f, city: e.target.value }))} placeholder={t('crm.referrer.city', 'Ort')} className={input} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-center">
            <input value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))} placeholder={t('crm.referrer.country', 'Land')} className={input} />
            <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs">
              {[false, true].map(b => (
                <button key={String(b)} onClick={() => setForm(f => ({ ...f, is_business: b }))}
                  className={`flex-1 px-2 py-2 ${form.is_business === b ? 'bg-orange-50 text-hp-highlight font-medium' : 'text-gray-500 hover:bg-gray-50'}`}>
                  {b ? t('crm.referrer.business', 'Unternehmer') : t('crm.referrer.private', 'Privatperson')}
                </button>
              ))}
            </div>
            {form.is_business && (
              <input value={form.vat_id} onChange={e => setForm(f => ({ ...f, vat_id: e.target.value }))} placeholder={t('crm.referrer.vatId', 'USt-IdNr. (DE…)')} className={input} />
            )}
          </div>
          <p className="text-[11px] text-gray-400">
            {form.is_business
              ? t('crm.referrer.businessHint', 'Unternehmer bekommen eine Gutschrift mit Reverse Charge (Leistungsort Zypern). Dafür braucht es die USt-IdNr.')
              : t('crm.referrer.privateHint', 'Privatpersonen bekommen eine Provisionsabrechnung ohne Umsatzsteuer.')}
          </p>
          <div className="flex gap-2 pt-1">
            <button onClick={saveEdit} disabled={busy}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[#ff795d] text-white hover:opacity-90 disabled:opacity-40">
              {t('crm.referrer.save', 'Speichern')}
            </button>
            <button onClick={() => setMode('view')} className="px-3 py-1.5 rounded-lg text-sm border border-gray-200 text-gray-600 hover:bg-gray-50">
              {t('crm.referrer.cancel', 'Abbrechen')}
            </button>
          </div>
        </div>
      ) : (
        // ── Zugewiesen ──
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {r.lead_id ? (
              <Link to={`/admin/crm/leads/${r.lead_id}`} className="text-sm font-semibold text-gray-800 hover:text-hp-highlight">{r.name}</Link>
            ) : (
              <span className="text-sm font-semibold text-gray-800">{r.name}</span>
            )}
            <span className="text-xs text-gray-400">{[r.email, r.whatsapp].filter(Boolean).join(' · ')}</span>
            {r.referred_count > 1 && (
              <span className="text-[11px] text-gray-400">· {t('crm.referrer.referredCount', { count: r.referred_count })}</span>
            )}
          </div>

          {amountField}
          {!locked && overMax && <p className="text-[11px] text-amber-700">{t('crm.referrer.overLinkMax', { max: eur(st.link_max) })}</p>}

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-gray-500 w-20 flex-shrink-0">{t('crm.referrer.billingData', 'Abrechnung an')}</span>
            {addressMissing ? (
              <span className="text-amber-700">{t('crm.referrer.addressMissing', 'Adresse fehlt, sie gehört auf die Abrechnung.')}</span>
            ) : (
              <span className="text-gray-700">
                {r.is_business ? `${t('crm.referrer.business', 'Unternehmer')}${r.vat_id ? ` (${r.vat_id})` : ''}` : t('crm.referrer.private', 'Privatperson')}
                {' · '}{r.street}, {r.postal_code} {r.city}{r.country ? `, ${r.country}` : ''}
                {st.address?.source && st.address.source !== 'manuell' && (
                  <span className="text-gray-400"> ({st.address.note ?? t(`crm.referrer.source_${st.address.source}`, st.address.source)})</span>
                )}
              </span>
            )}
            <button onClick={openEdit} className="text-hp-highlight hover:underline">{t('crm.referrer.edit', 'Bearbeiten')}</button>
          </div>

          {/* Wie die Adresse beschafft wird */}
          {addressMissing && !locked && st.address && (
            <div className="text-xs text-gray-500 pl-0 sm:pl-[5.5rem] space-y-0.5">
              {st.address.status === 'searching' ? (
                <p>{t('crm.referrer.addrSearching', 'Lotte sucht die Adresse gerade im Profil und in den Drive-Unterlagen …')}</p>
              ) : st.address.status === 'requested' ? (
                <>
                  <p>{st.address.note
                    ?? t('crm.referrer.addrRequested', { date: st.address.requested_at ? new Date(st.address.requested_at).toLocaleDateString('de-DE') : '' })}</p>
                  {st.address.reply_text && <p className="text-gray-400">{t('crm.referrer.addrReply', { text: st.address.reply_text })}</p>}
                </>
              ) : (
                <>
                  <p>
                    {t('crm.referrer.addrNotFound', { note: st.address.note ?? '' })}{' '}
                    <button onClick={searchAgain} disabled={busy} className="text-hp-highlight hover:underline disabled:opacity-40">{t('crm.referrer.addrSearchAgain', 'Erneut suchen')}</button>
                  </p>
                  <p>{!r.whatsapp
                    ? t('crm.referrer.addrNoWhatsapp', 'Keine WhatsApp-Nummer hinterlegt: bitte die Adresse selbst eintragen.')
                    : st.address.due
                      ? t('crm.referrer.addrAskSoon', { name: r.name.split(/\s+/)[0] })
                      : t('crm.referrer.addrAskLater', { name: r.name.split(/\s+/)[0] })}</p>
                </>
              )}
            </div>
          )}

          {/* Status */}
          <div className="text-xs rounded-lg bg-gray-50 px-3 py-2 text-gray-600 space-y-1">
            {p ? (
              <>
                <p>
                  {p.doc_url
                    ? <a href={p.doc_url} target="_blank" rel="noreferrer" className="text-hp-highlight hover:underline">{t('crm.referrer.doc', 'Abrechnung')} {p.doc_no}</a>
                    : t('crm.referrer.doc', 'Abrechnung')}
                  {' · '}{t(`crm.affiliates.status_${p.status}`, p.status)}
                  {p.payout_link_state && <> · {t(`crm.referrer.link_${p.payout_link_state}`, p.payout_link_state)}</>}
                </p>
                {p.payout_link_error && p.status !== 'bezahlt' && <p className="text-amber-700">{t('crm.referrer.linkError', { error: p.payout_link_error })}</p>}
                <p className="text-gray-400">{t('crm.referrer.locked', 'Abgerechnet: Zuweisung und Betrag sind gesperrt. Auszahlung steuerst du unter Tippgeber.')}</p>
              </>
            ) : st.deal_done ? (
              <p>{t('crm.referrer.statusDue', 'Kauf abgeschlossen: Abrechnung und Revolut-Link gehen beim nächsten Lauf raus (spätestens in 30 Minuten).')}</p>
            ) : (
              <p>{t('crm.referrer.statusPending', { name: r.name.split(/\s+/)[0] })}</p>
            )}
          </div>

          {!locked && (
            <div className="flex gap-3 text-xs">
              <button onClick={() => { setNotice(''); setMode('pick') }} disabled={busy} className="text-gray-500 hover:text-gray-800">{t('crm.referrer.change', 'Ändern')}</button>
              <button onClick={remove} disabled={busy} className="text-gray-400 hover:text-red-600">{t('crm.referrer.remove', 'Entfernen')}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
