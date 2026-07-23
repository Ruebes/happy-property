import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { supabase } from '../../lib/supabase'
import { CustomSelect } from '../CustomSelect'

// ── Registrierungen ──────────────────────────────────────────────────────────
// Bei welchen Developern ist der Kunde registriert (Provisionsschutz). Wird
// beim Deck-Versand im Postausgang geprüft: Deck-Projekt-Developer ohne
// Registrierung → Warnung vor dem Senden.

interface RegRow { id: string; developer: string; registered_at: string | null; note: string | null }

export default function LeadRegistrations({ leadId }: { leadId: string }) {
  const { t } = useTranslation()
  const [regs, setRegs] = useState<RegRow[]>([])
  const [developers, setDevelopers] = useState<string[]>([])
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const [{ data: r }, { data: d }] = await Promise.all([
        supabase.from('lead_registrations').select('id, developer, registered_at, note').eq('lead_id', leadId).order('registered_at', { ascending: false }),
        supabase.from('crm_developers').select('name').eq('active', true).order('name'),
      ])
      setRegs((r as RegRow[]) ?? [])
      setDevelopers(Array.from(new Set(((d as { name: string }[]) ?? []).map(x => x.name.trim()))))
    } catch (err) {
      console.error('[LeadRegistrations] fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [leadId])

  useEffect(() => { void fetchAll() }, [fetchAll])

  const add = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const { error } = await supabase.from('lead_registrations')
        .upsert({ lead_id: leadId, developer: selected }, { onConflict: 'lead_id,developer' })
      if (error) throw error
      setSelected('')
      await fetchAll()
    } catch (err) {
      console.error('[LeadRegistrations] add:', err)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!window.confirm(t('crm.registrations.confirmRemove', 'Registrierung wirklich entfernen?'))) return
    setBusy(true)
    try {
      await supabase.from('lead_registrations').delete().eq('id', id)
      await fetchAll()
    } finally {
      setBusy(false)
    }
  }

  const available = developers.filter(d => !regs.some(r => r.developer.toLowerCase() === d.toLowerCase()))

  return (
    <div className="bg-white rounded-2xl shadow p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-semibold text-gray-800 text-sm">
          🏗️ {t('crm.registrations.title', 'Registrierungen bei Developern')}
        </h3>
        {regs.length === 0 && !loading && (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
            {t('crm.registrations.none', 'Bei keinem Developer registriert')}
          </span>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-gray-400">{t('common.loading', 'Lädt…')}</p>
      ) : (
        <>
          {regs.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {regs.map(r => (
                <span key={r.id} className="inline-flex items-center gap-1.5 text-xs font-medium bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-full pl-2.5 pr-1 py-1">
                  ✓ {r.developer}
                  {r.registered_at && (
                    <span className="text-emerald-600/70 font-normal">
                      {new Date(r.registered_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                    </span>
                  )}
                  <button
                    onClick={() => void remove(r.id)}
                    disabled={busy}
                    className="ml-0.5 w-4 h-4 flex items-center justify-center rounded-full text-emerald-700 hover:bg-emerald-100"
                    title={t('crm.registrations.remove', 'Entfernen')}
                  >×</button>
                </span>
              ))}
            </div>
          )}

          <div className="flex items-center gap-2">
            <CustomSelect
              value={selected}
              onChange={(v) => setSelected(v)}
              options={available.map(d => ({ value: d, label: d }))}
              placeholder={t('crm.registrations.pick', 'Developer wählen…')}
              className="min-w-[12rem]"
            />
            <button
              onClick={() => void add()}
              disabled={!selected || busy}
              className="px-3 py-1.5 rounded-lg text-sm font-medium bg-[#ff795d] text-white hover:opacity-90 disabled:opacity-40"
            >
              + {t('crm.registrations.add', 'Registriert')}
            </button>
          </div>
          <p className="text-[11px] text-gray-400 mt-2">
            {t('crm.registrations.hint', 'Wird beim Deck-Versand geprüft — ohne Registrierung beim Projekt-Developer kommt eine Warnung.')}
          </p>
        </>
      )}
    </div>
  )
}
