import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'

// ── Developer-Mails im Posteingang ───────────────────────────────────────────
// imap-poll erkennt Mails von Bauträger-Domains (crm_developer_contacts) und
// legt sie mit Anhängen in partner_mails ab. Hier: ansehen + Dokumente per
// Klick einem Kunden zuordnen (→ Wohnungs-Dokumente des aktiven Deals + Notiz
// am Lead) oder die Mail löschen.

interface PartnerMail {
  id: string; from_addr: string; from_domain: string; subject: string; body: string
  attachments: Array<{ name: string; url: string; path: string }>
  assigned_lead_id: string | null; read_at: string | null; created_at: string
  developer: { name: string | null } | null
}
interface LeadHit { id: string; first_name: string | null; last_name: string | null; email: string | null }

export default function DevMails() {
  const { t } = useTranslation()
  const [mails, setMails] = useState<PartnerMail[]>([])
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [assignFor, setAssignFor] = useState<PartnerMail | null>(null)
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<LeadHit[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    const { data, error } = await supabase.from('partner_mails')
      .select('id, from_addr, from_domain, subject, body, attachments, assigned_lead_id, read_at, created_at, developer:crm_developers(name)')
      .order('created_at', { ascending: false }).limit(30)
    if (error) { console.error('[DevMails] load:', error); return }
    setMails((data as unknown as PartnerMail[]) ?? [])
  }, [])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (q.trim().length < 2) { setHits([]); return }
    const h = setTimeout(() => {
      void supabase.from('leads').select('id, first_name, last_name, email')
        .or(`first_name.ilike.%${q}%,last_name.ilike.%${q}%,email.ilike.%${q}%`).limit(6)
        .then(({ data }) => setHits((data as LeadHit[]) ?? []))
    }, 300)
    return () => clearTimeout(h)
  }, [q])

  const assign = async (m: PartnerMail, lead: LeadHit) => {
    setBusy(true); setNote('')
    try {
      const leadName = [lead.first_name, lead.last_name].filter(Boolean).join(' ')
      // 1) Anhänge in die Wohnungs-Dokumente des aktiven Deals (falls vorhanden)
      const { data: deal } = await supabase.from('deals').select('unit_id, project_id').eq('lead_id', lead.id)
        .not('unit_id', 'is', null).order('updated_at', { ascending: false }).limit(1).maybeSingle()
      const dl = deal as { unit_id: string | null; project_id: string | null } | null
      let docTarget = ''
      if (dl?.unit_id && m.attachments.length) {
        for (const a of m.attachments) {
          await supabase.from('crm_unit_documents').insert({
            unit_id: dl.unit_id, project_id: dl.project_id, name: a.name,
            file_name: a.name, file_path: a.url, doc_type: 'developer',
            notes: `Von ${m.from_addr} · ${m.subject}`.slice(0, 500),
          })
        }
        docTarget = t('crm.devmails.toUnitDocs', ' + in die Wohnungs-Dokumente gelegt')
      }
      // 2) Notiz am Lead mit Links (immer)
      const links = m.attachments.map(a => `• ${a.name}: ${a.url}`).join('\n')
      await supabase.from('activities').insert({
        lead_id: lead.id, type: 'note', direction: 'inbound',
        subject: `🏗 Developer-Mail: ${m.subject}`.slice(0, 200),
        content: `Von ${m.from_addr}\n\n${links || '(ohne Anhang)'}\n\n${m.body.slice(0, 1500)}`,
        completed_at: new Date().toISOString(), auto: false,
      })
      await supabase.from('partner_mails').update({ assigned_lead_id: lead.id, assigned_at: new Date().toISOString(), read_at: new Date().toISOString() }).eq('id', m.id)
      setNote(`✓ ${t('crm.devmails.assigned', 'Zugeordnet zu')} ${leadName}${docTarget}`)
      setAssignFor(null); setQ(''); await load()
    } catch (err) { setNote(`❌ ${err instanceof Error ? err.message : 'Fehler'}`) } finally { setBusy(false) }
  }
  const remove = async (m: PartnerMail) => {
    if (!window.confirm(t('crm.devmails.delConfirm', 'Diese Developer-Mail (inkl. gespeicherter Anhänge) löschen?') as string)) return
    if (m.attachments.length) await supabase.storage.from('mail-attachments').remove(m.attachments.map(a => a.path)).catch(() => null)
    await supabase.from('partner_mails').delete().eq('id', m.id)
    setMails(arr => arr.filter(x => x.id !== m.id))
  }

  if (!mails.length) return null
  const unread = mails.filter(m => !m.read_at).length
  return (
    <div className="bg-white rounded-2xl border border-amber-200/70 shadow-sm mb-4">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center justify-between px-4 py-3">
        <p className="font-semibold text-gray-900">🏗 {t('crm.devmails.title', 'Developer-Mails')}
          {unread > 0 && <span className="ml-2 text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 font-semibold">{unread} {t('crm.devmails.new', 'neu')}</span>}
        </p>
        <span className="text-gray-400">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-2">
          {note && <p className="text-sm rounded-lg px-3 py-2 bg-gray-50 text-gray-700">{note}</p>}
          {mails.map(m => (
            <div key={m.id} className={`border rounded-xl p-3 ${m.read_at ? 'border-gray-100 opacity-70' : 'border-amber-200 bg-amber-50/40'}`}>
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded(x => x === m.id ? null : m.id)}>
                  <p className="text-sm font-semibold text-gray-900 truncate">{m.subject || '(ohne Betreff)'}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {m.developer?.name ? `${m.developer.name} · ` : ''}{m.from_addr} · {new Date(m.created_at).toLocaleDateString('de-DE')}
                    {m.assigned_lead_id && <span className="text-green-600"> · ✓ {t('crm.devmails.assignedBadge', 'zugeordnet')}</span>}
                  </p>
                  {m.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {m.attachments.map((a, i) => (
                        <a key={i} href={a.url} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()}
                          className="text-[11px] px-2 py-1 rounded-lg bg-white border border-gray-200 text-gray-700 hover:border-amber-300">📎 {a.name.slice(0, 32)}</a>
                      ))}
                    </div>
                  )}
                  {expanded === m.id && <p className="text-xs text-gray-600 mt-2 whitespace-pre-wrap max-h-40 overflow-y-auto">{m.body}</p>}
                </div>
                <div className="flex flex-col gap-1 shrink-0">
                  <button onClick={() => { setAssignFor(assignFor?.id === m.id ? null : m); setQ('') }}
                    className="text-xs px-3 py-1.5 rounded-lg text-white font-medium" style={{ backgroundColor: '#ff795d' }}>
                    → {t('crm.devmails.assign', 'Kunde zuordnen')}
                  </button>
                  <button onClick={() => void remove(m)} className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-400 hover:text-red-600">🗑</button>
                </div>
              </div>
              {assignFor?.id === m.id && (
                <div className="mt-2 border-t border-amber-100 pt-2">
                  <input value={q} onChange={e => setQ(e.target.value)} autoFocus
                    className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-orange-400"
                    placeholder={t('crm.devmails.searchPh', 'Kunde suchen (Name oder E-Mail) …')} />
                  {hits.map(h => (
                    <button key={h.id} disabled={busy} onClick={() => void assign(m, h)}
                      className="w-full text-left text-sm px-3 py-2 hover:bg-gray-50 rounded-lg">
                      {[h.first_name, h.last_name].filter(Boolean).join(' ')} <span className="text-gray-400 text-xs">{h.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
