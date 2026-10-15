import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { reservationCall } from '../../lib/reservationAgreement'

// Dokumente digital vom Bauträger unterschreiben lassen, zuerst Spezifikationen (Sven 15.10.).
// PDF hochladen → Bauträger bekommt WhatsApp + Mail mit Link /sign/d/<token> in seiner Sprache →
// nach der Unterschrift: Drive-Kundenordner, Objekt im Eigentümerportal, Mail an den Anwalt.

interface DealUnit { id: string; label: string }
interface SignDoc {
  id: string; kind: string; title: string; token: string; test: boolean; status: string
  sent_at: string | null; sent_to: string[] | null; signed_at: string | null; signer_name: string | null
  signed_pdf_path: string | null; error: string | null; created_at: string
}

const STATUS_STYLE: Record<string, string> = {
  offen: 'bg-amber-100 text-amber-800',
  unterschrieben: 'bg-green-600 text-white',
  abgebrochen: 'bg-gray-100 text-gray-400',
  fehler: 'bg-red-100 text-red-700',
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''))
    r.onerror = () => reject(new Error('read_failed'))
    r.readAsDataURL(file)
  })
}

export default function SignDocumentsCard({ leadId }: { leadId: string }) {
  const { t, i18n } = useTranslation()
  const [units, setUnits] = useState<DealUnit[]>([])
  const [dealId, setDealId] = useState('')
  const [docs, setDocs] = useState<SignDoc[]>([])
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState<'' | 'send' | 'test'>('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    const { data } = await supabase.from('deals')
      .select('id, phase, unit:crm_project_units!deals_unit_id_fkey(unit_number, project:crm_projects(name))')
      .eq('lead_id', leadId).not('unit_id', 'is', null).order('created_at', { ascending: false })
    const rows = (data ?? []) as unknown as Array<{ id: string; phase: string; unit: { unit_number: string; project: { name: string } | null } | null }>
    const list = rows.map(r => ({ id: r.id, label: `${r.unit?.project?.name ?? ''} ${r.unit?.unit_number ?? ''}`.trim() }))
    setUnits(list)
    setDealId(d => d || list[0]?.id || '')
    try {
      const r = await reservationCall<{ docs: SignDoc[] }>({ action: 'doc_list', lead_id: leadId })
      setDocs(r.docs)
    } catch { setDocs([]) }
  }, [leadId])
  useEffect(() => { load() }, [load])

  if (!units.length) return null

  const send = async (test: boolean) => {
    if (!file || !dealId) return
    if (!test && !window.confirm(t('signDocs.confirm', 'Dokument jetzt an den Bauträger zur Unterschrift schicken?'))) return
    setBusy(test ? 'test' : 'send'); setMsg(null)
    try {
      const r = await reservationCall<{ ok: boolean; errors: string[] }>({
        action: 'doc_create', deal_id: dealId, kind: 'specification', title: title.trim() || undefined,
        file_name: file.name, file_base64: await fileToBase64(file), test,
      })
      setMsg(r.errors?.length ? { ok: false, text: r.errors.join(' · ') }
        : { ok: true, text: test ? t('signDocs.testSent', 'Test ging an dich (Mail + WhatsApp mit Unterschriftslink).') : t('signDocs.sent', 'Ist beim Bauträger zur Unterschrift.') })
      if (!test) { setFile(null); setTitle('') }
      await load()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally { setBusy('') }
  }

  const openSigned = async (path: string) => {
    const w = window.open('', '_blank')
    const { data } = await supabase.storage.from('unit-documents').createSignedUrl(path, 300)
    if (data?.signedUrl && w) w.location.href = data.signedUrl
    else w?.close()
  }
  const fmt = (s: string) => new Date(s).toLocaleString(i18n.language === 'en' ? 'en-GB' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const statusLabel: Record<string, string> = {
    offen: t('signDocs.status.open', 'Wartet auf Unterschrift'),
    unterschrieben: t('signDocs.status.signed', 'Unterschrieben'),
    abgebrochen: t('signDocs.status.cancelled', 'Zurückgezogen'),
    fehler: t('signDocs.status.error', 'Fehler'),
  }
  const btn = 'px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors disabled:opacity-50'

  return (
    <div className="bg-white border border-gray-100 rounded-xl p-4 space-y-3">
      <div>
        <p className="text-sm font-semibold text-gray-800">✍️ {t('signDocs.title', 'Dokumente zur Unterschrift')}</p>
        <p className="text-xs text-gray-500 mt-0.5">
          {t('signDocs.subtitle', 'Z. B. Spezifikation: der Bauträger unterschreibt am Handy (jede Seite + Unterschriftsfeld). Danach Drive-Ordner, Eigentümerportal und Mail an den Anwalt.')}
        </p>
      </div>

      {docs.length > 0 && (
        <div className="space-y-1.5">
          {docs.map(d => (
            <div key={d.id} className="flex items-center justify-between gap-2 bg-gray-50 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm text-gray-800 truncate">{d.title}{d.test && <span className="ml-1.5 text-[10px] font-semibold text-blue-700">TEST</span>}</p>
                <p className="text-[11px] text-gray-500">
                  {d.status === 'unterschrieben' && d.signed_at ? `${d.signer_name ?? ''} · ${fmt(d.signed_at)}` : d.sent_at ? `${t('signDocs.sentAt', 'Geschickt')} ${fmt(d.sent_at)}` : ''}
                  {d.error && <span className="text-red-600"> · {d.error}</span>}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full ${STATUS_STYLE[d.status] ?? STATUS_STYLE.offen}`}>{statusLabel[d.status] ?? d.status}</span>
                {d.status === 'offen' && (
                  <button title={t('signDocs.copyLink', 'Unterschriftslink kopieren')}
                    onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/sign/d/${d.token}`).then(() => setMsg({ ok: true, text: t('signDocs.linkCopied', 'Link kopiert') }))}
                    className="text-xs text-gray-500 hover:text-gray-800">🔗</button>
                )}
                {d.signed_pdf_path && (
                  <button onClick={() => openSigned(d.signed_pdf_path!)} className="text-xs text-gray-500 hover:text-gray-800">📄</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {units.length > 1 && (
          <select value={dealId} onChange={e => setDealId(e.target.value)}
            className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-400">
            {units.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
          </select>
        )}
        <input value={title} onChange={e => setTitle(e.target.value)} placeholder={t('signDocs.titlePh', 'Titel (leer = „Spezifikation Projekt Einheit")')}
          className="border border-gray-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-orange-400" />
        <label className="sm:col-span-2 flex items-center gap-2 text-xs text-gray-600 cursor-pointer">
          <input type="file" accept="application/pdf" onChange={e => setFile(e.target.files?.[0] ?? null)} className="text-xs" />
        </label>
      </div>

      {msg && <p className={`text-xs ${msg.ok ? 'text-green-700' : 'text-amber-800'}`}>{msg.text}</p>}

      <div className="flex flex-wrap gap-2">
        <button onClick={() => send(true)} disabled={!file || !!busy} className={`${btn} border-gray-200 text-gray-600 bg-white hover:bg-gray-50`}>
          {busy === 'test' ? '…' : `🧪 ${t('signDocs.test', 'Test an mich')}`}
        </button>
        <button onClick={() => send(false)} disabled={!file || !!busy} className={`${btn} border-transparent text-white bg-hp-highlight hover:opacity-90`}>
          {busy === 'send' ? '…' : `📤 ${t('signDocs.send', 'An Bauträger zur Unterschrift')}`}
        </button>
      </div>
    </div>
  )
}
