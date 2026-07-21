import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import DashboardLayout from '../../../../components/DashboardLayout'
import { supabase } from '../../../../lib/supabase'

// ── KI-Antwort-Agent: Einstellungen ─────────────────────────────────────────────
// Erklärt den Entwurf-Workflow und bietet den Autopilot-Schalter.
//
// WICHTIG (Sicherheit): Der Schalter speichert nur die Präferenz in crm_settings
// (key 'ai_autopilot_enabled'). Aktuell liest KEIN Backend dieses Flag, um etwas
// automatisch zu versenden – der Auto-Versand-Loop ist bewusst noch nicht scharf.
// Solange Sven nicht ausdrücklich „jetzt live" sagt und der Backend-Teil deployt
// wird, bleibt alles im reinen Entwurf-Modus. Einschalten ist daher derzeit inert.

const AUTOPILOT_KEY = 'ai_autopilot_enabled'

export default function AiAgent() {
  const { t } = useTranslation()

  const [enabled, setEnabled] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving,  setSaving]  = useState(false)
  const [toast,   setToast]   = useState('')

  // Deck-Follow-up-Automatik (automation_rules, event_type 'deck_viewed_followup').
  // ACHTUNG: dieser Schalter ist NICHT inert — EIN = es geht 45 Min nach dem ersten
  // Deck-Aufruf WIRKLICH automatisch eine WhatsApp an den echten Kunden raus.
  const [dfActive, setDfActive] = useState(false)
  const [dfRuleId, setDfRuleId] = useState<string | null>(null)
  const [dfSaving, setDfSaving] = useState(false)

  // Termin-Bot (crm_settings 'booking_bot_enabled'). ECHT scharf: EIN = der Bot
  // schreibt automatisch mit Kunden, schlägt Termine vor und bucht sie.
  const [botActive, setBotActive] = useState(false)
  const [botSaving, setBotSaving] = useState(false)
  const [autoEngage, setAutoEngage] = useState(false)
  const [aeSaving, setAeSaving] = useState(false)

  // Gelernte KI-Vorgaben (deck_ai_rules): Stil-/Inhaltsregeln, die in Decks (kind 'deck')
  // bzw. Begleit-Mails (kind 'mail') einfließen. Das System lernt sie automatisch aus
  // Svens Korrekturen; hier sichtbar, abschaltbar, löschbar, manuell ergänzbar.
  const [rules, setRules] = useState<{ id: string; kind: string; rule: string; active: boolean }[]>([])
  const [newRule, setNewRule] = useState('')
  const [newKind, setNewKind] = useState<'deck' | 'mail'>('mail')

  const showToast = (m: string) => { setToast(m); setTimeout(() => setToast(''), 3000) }

  const loadRules = useCallback(async () => {
    const { data } = await supabase.from('deck_ai_rules').select('id, kind, rule, active').order('created_at', { ascending: false })
    setRules((data ?? []) as { id: string; kind: string; rule: string; active: boolean }[])
  }, [])
  useEffect(() => { void loadRules() }, [loadRules])

  const addRule = async () => {
    const r = newRule.trim()
    if (!r) return
    const { error } = await supabase.from('deck_ai_rules').insert({ kind: newKind, scope: 'global', rule: r, active: true })
    if (error) { showToast(`❌ ${error.message}`); return }
    setNewRule(''); void loadRules(); showToast(t('crm.aiAgent.ruleAdded', 'Vorgabe gespeichert'))
  }
  const toggleRule = async (id: string, active: boolean) => {
    await supabase.from('deck_ai_rules').update({ active: !active }).eq('id', id); void loadRules()
  }
  const deleteRule = async (id: string) => {
    await supabase.from('deck_ai_rules').delete().eq('id', id); void loadRules()
  }

  const fetchSetting = useCallback(async () => {
    setLoading(true)
    try {
      const { data } = await supabase
        .from('crm_settings')
        .select('value')
        .eq('key', AUTOPILOT_KEY)
        .maybeSingle()
      setEnabled((data as { value?: string } | null)?.value === 'true')
      // Deck-Follow-up-Regel laden
      const { data: rule } = await supabase.from('automation_rules')
        .select('id, is_active').eq('event_type', 'deck_viewed_followup').maybeSingle()
      const rr = rule as { id?: string; is_active?: boolean } | null
      setDfRuleId(rr?.id ?? null)
      setDfActive(rr?.is_active === true)
      // Termin-Bot-Schalter laden
      const { data: b } = await supabase.from('crm_settings').select('value').eq('key', 'booking_bot_enabled').maybeSingle()
      setBotActive((b as { value?: string } | null)?.value === 'true')
      const { data: ae } = await supabase.from('crm_settings').select('value').eq('key', 'booking_bot_auto_engage').maybeSingle()
      setAutoEngage((ae as { value?: string } | null)?.value === 'true')
    } catch (err) {
      console.error('[AiAgent] fetch:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchSetting() }, [fetchSetting])

  // Deck-Follow-up scharfschalten / abschalten. EINSCHALTEN = echte Nachrichten.
  const toggleDeckFollowup = async () => {
    if (!dfRuleId) { showToast('❌ ' + t('crm.aiAgent.dfNoRule', 'Regel nicht gefunden')); return }
    const next = !dfActive
    if (next && !window.confirm(t('crm.aiAgent.dfConfirm',
      'Ab jetzt geht ~45 Minuten nach dem ERSTEN Deck-Aufruf automatisch eine WhatsApp an den Kunden (Favorit? + Termin-Link). Das sind ECHTE Nachrichten an echte Kunden. Jetzt scharfschalten?'))) {
      return
    }
    setDfSaving(true)
    try {
      const { error } = await supabase.from('automation_rules')
        .update({ is_active: next, updated_at: new Date().toISOString() }).eq('id', dfRuleId)
      if (error) { showToast(`❌ ${error.message}`); return }
      setDfActive(next)
      showToast(next
        ? t('crm.aiAgent.dfOn',  '✅ Deck-Follow-up ist scharf — WhatsApp geht automatisch raus')
        : t('crm.aiAgent.dfOff', 'Deck-Follow-up aus'))
    } finally {
      setDfSaving(false)
    }
  }

  // Termin-Bot scharfschalten / abschalten. EINSCHALTEN = echter Auto-Dialog.
  const toggleBookingBot = async () => {
    const next = !botActive
    if (next && !window.confirm(t('crm.aiAgent.botConfirm',
      'Der Termin-Bot schreibt ab jetzt AUTOMATISCH mit echten Kunden per WhatsApp, schlägt Termine vor und bucht sie in deinen Kalender — bei No-Show, Erstkontakt und Deck-Ansicht. WICHTIG: Dein Google-Kalender muss für die Service-Adresse freigegeben sein, sonst kennt der Bot deine freien Zeiten nicht. Jetzt scharfschalten?'))) {
      return
    }
    setBotSaving(true)
    try {
      const { error } = await supabase.from('crm_settings')
        .upsert({ key: 'booking_bot_enabled', value: next ? 'true' : 'false', updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) { showToast(`❌ ${error.message}`); return }
      setBotActive(next)
      showToast(next
        ? t('crm.aiAgent.botOn',  '✅ Termin-Bot ist scharf')
        : t('crm.aiAgent.botOff', 'Termin-Bot aus'))
    } finally {
      setBotSaving(false)
    }
  }

  // Lotte klinkt sich bei Terminanfragen ein (crm_settings 'booking_bot_auto_engage').
  const toggleAutoEngage = async () => {
    const next = !autoEngage
    if (next && !window.confirm(t('crm.aiAgent.aeConfirm',
      'Fragt ein Kunde im WhatsApp-Chat nach einem Termin/Anruf, klinkt sich Lotte (Svens persönliche Assistentin) automatisch ein, stellt sich kurz vor und schlägt freie Zeiten vor — auch mitten in einem laufenden Gespräch. Fachliche Fragen bleiben bei dir. Jetzt scharfschalten?'))) {
      return
    }
    setAeSaving(true)
    try {
      const { error } = await supabase.from('crm_settings')
        .upsert({ key: 'booking_bot_auto_engage', value: next ? 'true' : 'false', updated_at: new Date().toISOString() }, { onConflict: 'key' })
      if (error) { showToast(`❌ ${error.message}`); return }
      setAutoEngage(next)
      showToast(next
        ? t('crm.aiAgent.aeOn',  '✅ Lotte klinkt sich bei Terminanfragen ein')
        : t('crm.aiAgent.aeOff', 'Auto-Einklinken aus'))
    } finally {
      setAeSaving(false)
    }
  }

  const toggle = async () => {
    const next = !enabled
    // Beim EINSCHALTEN ausdrücklich bestätigen lassen.
    if (next && !window.confirm(t('crm.aiAgent.confirmOn',
      'Vollautomatik als Wunsch speichern? Hinweis: Es wird dadurch NICHTS automatisch versendet. Der automatische Versand wird erst nach ausdrücklicher Freischaltung im Backend aktiv – bis dahin bleibt alles im Entwurf-Modus.'))) {
      return
    }
    setSaving(true)
    try {
      const { error } = await supabase
        .from('crm_settings')
        .upsert(
          { key: AUTOPILOT_KEY, value: next ? 'true' : 'false', updated_at: new Date().toISOString() },
          { onConflict: 'key' },
        )
      if (error) { showToast(`❌ ${error.message}`); return }
      setEnabled(next)
      showToast(next
        ? t('crm.aiAgent.savedOn',  'Vollautomatik-Wunsch gespeichert (noch nicht scharf)')
        : t('crm.aiAgent.savedOff', 'Autopilot aus – nur Entwürfe'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <DashboardLayout basePath="/admin/crm">
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-gray-800 text-white px-4 py-2 rounded-xl text-sm shadow-lg">
          {toast}
        </div>
      )}

      <div className="p-6 space-y-5 max-w-3xl">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            🤖 {t('crm.aiAgent.title', 'KI-Antwort-Agent')}
          </h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {t('crm.aiAgent.subtitle', 'Entwürfe für eingehende Kundennachrichten – du prüfst und gibst frei. Das System lernt aus deinen Freigaben und Korrekturen.')}
          </p>
        </div>

        {/* So funktioniert's */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-700">{t('crm.aiAgent.howTitle', 'So funktioniert’s')}</h2>
          <ol className="space-y-2 text-sm text-gray-600">
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">1.</span>
              {t('crm.aiAgent.step1', 'Im Lead unter „🤖 KI-Antwort" die eingehende Kundennachricht übernehmen und einen Entwurf erzeugen.')}
            </li>
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">2.</span>
              {t('crm.aiAgent.step2', 'Entwurf prüfen, bei Bedarf korrigieren.')}
            </li>
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">3.</span>
              {t('crm.aiAgent.step3', 'Freigeben & kopieren – den Text schickst du wie gewohnt selbst (WhatsApp/E-Mail).')}
            </li>
            <li className="flex gap-2">
              <span className="text-orange-500 font-semibold">4.</span>
              {t('crm.aiAgent.step4', 'Das System merkt sich deine freigegebenen/korrigierten Antworten und wird mit der Zeit besser.')}
            </li>
          </ol>
        </div>

        {/* Autopilot-Schalter */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          {loading ? (
            <div className="flex justify-center py-6">
              <div className="w-7 h-7 border-4 border-orange-200 border-t-orange-500 rounded-full animate-spin" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-sm font-semibold text-gray-700">{t('crm.aiAgent.autopilotTitle', 'Vollautomatik (Autopilot)')}</h2>
                  <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                    {enabled
                      ? t('crm.aiAgent.autopilotOnDesc',  'Wunsch „voll automatisch" ist gespeichert. Der automatische Versand ist aber noch NICHT scharf – es wird weiterhin nichts ohne deine Freigabe gesendet.')
                      : t('crm.aiAgent.autopilotOffDesc', 'Aus: Die KI erstellt nur Entwürfe. Jede Antwort gibst du selbst frei.')}
                  </p>
                </div>
                {/* Toggle */}
                <button
                  onClick={toggle}
                  disabled={saving}
                  role="switch"
                  aria-checked={enabled}
                  className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                    enabled ? 'bg-orange-500' : 'bg-gray-300'
                  }`}
                >
                  <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                    enabled ? 'translate-x-6' : 'translate-x-1'
                  }`} />
                </button>
              </div>

              {/* Sicherheits-Hinweis (immer sichtbar) */}
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 leading-relaxed">
                {t('crm.aiAgent.safety', 'Sicherheit: Dieser Schalter speichert nur deine Präferenz. Selbst eingeschaltet versendet das System derzeit NICHTS automatisch – der Auto-Versand wird erst nach ausdrücklicher Freischaltung im Backend aktiv. So kann nichts versehentlich an echte Kunden rausgehen.')}
              </div>
            </div>
          )}
        </div>

        {/* ── Deck-Follow-up (WhatsApp) — echter Auto-Versand ────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">💬 {t('crm.aiAgent.dfTitle', 'Deck-Follow-up (WhatsApp)')}</h2>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                {dfActive
                  ? t('crm.aiAgent.dfOnDesc', 'SCHARF: ~45 Min nach dem ersten Deck-Aufruf geht automatisch eine WhatsApp an den Kunden — nur zu Bürozeiten (8–21 Uhr), einmal pro Lead. Storniert sich, sobald der Kunde einen Termin bucht oder „kein Interesse" schreibt.')
                  : t('crm.aiAgent.dfOffDesc', 'Aus: Es wird nichts gesendet. Eingeschaltet fragt eine automatische WhatsApp ~45 Min nach dem ersten Deck-Aufruf nach dem Favoriten und bietet einen Termin-Link — dein Hebel vom 1. in den 2. Call.')}
              </p>
            </div>
            <button
              onClick={() => void toggleDeckFollowup()}
              disabled={dfSaving || !dfRuleId}
              role="switch"
              aria-checked={dfActive}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                dfActive ? 'bg-green-500' : 'bg-gray-300'
              }`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                dfActive ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>

          {/* Nachrichten-Vorschau */}
          <div>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
              {t('crm.aiAgent.dfPreview', 'Das bekommt der Kunde')}
            </div>
            <div className="bg-gray-50 border border-gray-100 rounded-xl p-4 text-xs text-gray-600 whitespace-pre-line leading-relaxed">
              {t('crm.aiAgent.dfMessage', 'Hey [Vorname], ich wollte kurz nachhören 🙂 Konntest du schon in Ruhe über die Objekte schauen? Welches spricht dich am meisten an?\n\nWenn du magst, nehmen wir uns 15 Minuten und ich beantworte dir alle offenen Fragen — hier kannst du dir direkt einen Termin aussuchen: calendly.com/sven-happy-property/30min\n\nLiebe Grüße, Sven')}
            </div>
          </div>

          {dfActive
            ? (
              <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 leading-relaxed">
                ⚠ {t('crm.aiAgent.dfLiveWarn', 'Aktiv: Es gehen ECHTE WhatsApp-Nachrichten an echte Kunden raus. Zum Stoppen den Schalter wieder auf Aus stellen.')}
              </div>
            ) : (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 leading-relaxed">
                {t('crm.aiAgent.dfSafety', 'Sicherheit: Solange dieser Schalter aus ist, wird nichts geplant und nichts gesendet. Erst beim Einschalten (mit Rückfrage) wird der automatische Versand scharf.')}
              </div>
            )}
        </div>

        {/* ── Termin-Bot (WhatsApp) — schlägt Termine vor + bucht ────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">🤝 {t('crm.aiAgent.botTitle', 'Termin-Bot (WhatsApp)')}</h2>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                {botActive
                  ? t('crm.aiAgent.botOnDesc', 'SCHARF: Bei No-Show, Erstkontakt und Deck-Ansicht schreibt der Bot dem Kunden per WhatsApp, schlägt 2 freie Termine (deutsche Zeit) vor, versteht die Antwort, gleicht deinen Kalender ab und bucht — inkl. Terminbestätigung. Fragt Zoom oder WhatsApp-Telefonat.')
                  : t('crm.aiAgent.botOffDesc', 'Aus: Der Bot schreibt nicht. Eingeschaltet nimmt er dem Kunden das Terminfinden ab — schlägt Termine vor, bucht sie in deinen Kalender und bestätigt. Dein Hebel, damit aus Interesse ein zweiter Call wird.')}
              </p>
            </div>
            <button
              onClick={() => void toggleBookingBot()}
              disabled={botSaving}
              role="switch"
              aria-checked={botActive}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                botActive ? 'bg-green-500' : 'bg-gray-300'
              }`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                botActive ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>

          {/* Ablauf-Vorschau */}
          <div>
            <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
              {t('crm.aiAgent.botFlow', 'So läuft es ab')}
            </div>
            <ol className="space-y-1.5 text-xs text-gray-600">
              <li className="flex gap-2"><span className="text-green-600 font-semibold">1.</span> {t('crm.aiAgent.botStep1', 'Bot: „Ich hätte Samstag 17:00 oder Montag 12:00 (deutsche Zeit) — was passt dir?"')}</li>
              <li className="flex gap-2"><span className="text-green-600 font-semibold">2.</span> {t('crm.aiAgent.botStep2', 'Kunde wählt → Bot fragt: Zoom oder kurz telefonieren über WhatsApp?')}</li>
              <li className="flex gap-2"><span className="text-green-600 font-semibold">3.</span> {t('crm.aiAgent.botStep3', 'Kunde kann nicht → Bot fragt Tag + vor-/nachmittags, gleicht Kalender ab, schlägt neuen Slot vor')}</li>
              <li className="flex gap-2"><span className="text-green-600 font-semibold">4.</span> {t('crm.aiAgent.botStep4', 'Termin wird gebucht (Kalender + Zoom-Link) + Bestätigung geht raus. Bei Verwirrung: Übergabe an dich.')}</li>
            </ol>
          </div>

          {/* Kalender-Abhängigkeit */}
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-800 leading-relaxed">
            {t('crm.aiAgent.botCalendarNote', 'Voraussetzung: Dein Google-Kalender muss für die Service-Adresse freigegeben sein (Einstellungen → Integrationen), sonst kennt der Bot deine freien Zeiten nicht.')}
          </div>

          {/* Lotte klinkt sich bei Terminanfragen ein */}
          <div className="border-t border-gray-100 pt-4 flex items-start justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700">🌸 {t('crm.aiAgent.aeTitle', 'Lotte klinkt sich bei Terminanfragen ein')}</h3>
              <p className="text-xs text-gray-500 mt-1 leading-relaxed">
                {t('crm.aiAgent.aeDesc', 'Fragt ein Kunde mitten im Chat nach einem Termin/Anruf, stellt sich Lotte (Svens persönliche Assistentin) kurz vor und schlägt sofort freie Zeiten vor — auch während ein persönliches Gespräch läuft. Fachliche Fragen bleiben bei dir. Den Lottes Text bearbeitest du bei den Bot-Nachrichten. Wirkt nur, wenn der Termin-Bot oben AN ist.')}
              </p>
            </div>
            <button
              onClick={() => void toggleAutoEngage()}
              disabled={aeSaving}
              role="switch"
              aria-checked={autoEngage}
              className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                autoEngage ? 'bg-green-500' : 'bg-gray-300'
              }`}
            >
              <span className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                autoEngage ? 'translate-x-6' : 'translate-x-1'
              }`} />
            </button>
          </div>

          {botActive && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-xs text-red-700 leading-relaxed">
              ⚠ {t('crm.aiAgent.botLiveWarn', 'Aktiv: Der Bot führt ECHTE WhatsApp-Gespräche mit echten Kunden und bucht echte Termine. Zum Stoppen den Schalter wieder auf Aus stellen.')}
            </div>
          )}
        </div>

        {/* ── Gelernte KI-Vorgaben (Decks + Mails) ───────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">🧠 {t('crm.aiAgent.rulesTitle', 'Gelernte Vorgaben für Decks & Mails')}</h2>
            <p className="text-xs text-gray-500 mt-1 leading-relaxed">
              {t('crm.aiAgent.rulesDesc', 'Das System lernt automatisch aus deinen Änderungen: Was du im Deck-Chatfenster anpasst (mit „merken") und was du an Begleit-Mails im Postausgang korrigierst, wird hier zu Vorgaben — und fließt in jedes neue Deck bzw. jede neue Mail. Du kannst Vorgaben abschalten, löschen oder selbst hinzufügen.')}
            </p>
          </div>

          {/* Manuell hinzufügen */}
          <div className="flex flex-col sm:flex-row gap-2">
            <select value={newKind} onChange={e => setNewKind(e.target.value as 'deck' | 'mail')}
              className="border border-gray-200 rounded-lg px-2 py-2 text-sm bg-white shrink-0">
              <option value="mail">{t('crm.aiAgent.kindMail', '✉️ Mails')}</option>
              <option value="deck">{t('crm.aiAgent.kindDeck', '📑 Decks')}</option>
            </select>
            <input value={newRule} onChange={e => setNewRule(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void addRule() }}
              placeholder={t('crm.aiAgent.rulePlaceholder', 'z.B. Immer mit dem stärksten Argument beginnen, kurze Sätze, keine Floskeln')}
              className="flex-1 border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-300" />
            <button onClick={() => void addRule()} disabled={!newRule.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-40 shrink-0" style={{ backgroundColor: '#ff795d' }}>
              {t('crm.aiAgent.ruleAdd', 'Hinzufügen')}
            </button>
          </div>

          {/* Liste */}
          {(['mail', 'deck'] as const).map(kind => {
            const list = rules.filter(r => r.kind === kind)
            return (
              <div key={kind}>
                <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">
                  {kind === 'mail' ? t('crm.aiAgent.forMails', 'Für Begleit-Mails') : t('crm.aiAgent.forDecks', 'Für Sales-Decks')} ({list.length})
                </div>
                {list.length === 0 ? (
                  <p className="text-xs text-gray-400 italic mb-2">{t('crm.aiAgent.noneYet', 'Noch nichts gelernt — bearbeite eine Mail/ein Deck, dann erscheint es hier.')}</p>
                ) : (
                  <ul className="space-y-1.5 mb-2">
                    {list.map(r => (
                      <li key={r.id} className={`flex items-center gap-2 text-sm border rounded-lg px-3 py-2 ${r.active ? 'border-gray-100 bg-gray-50' : 'border-gray-100 bg-white opacity-50'}`}>
                        <span className="flex-1">{r.rule}</span>
                        <button onClick={() => void toggleRule(r.id, r.active)} title={r.active ? t('crm.aiAgent.deactivate', 'Deaktivieren') : t('crm.aiAgent.activate', 'Aktivieren')}
                          className={`text-[11px] px-2 py-0.5 rounded shrink-0 ${r.active ? 'bg-green-100 text-green-700' : 'bg-gray-200 text-gray-500'}`}>
                          {r.active ? t('crm.aiAgent.active', 'aktiv') : t('crm.aiAgent.inactive', 'aus')}
                        </button>
                        <button onClick={() => void deleteRule(r.id)} title={t('common.delete', 'Löschen')}
                          className="text-gray-300 hover:text-red-500 shrink-0 px-1">🗑</button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </DashboardLayout>
  )
}
