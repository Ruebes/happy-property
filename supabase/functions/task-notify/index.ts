// task-notify — verschickt Aufgaben an Zuständige (intern + extern) und die
// täglichen Erinnerungen, jeweils über den gewählten Kanal (Mail/WhatsApp) mit
// dem persönlichen Erledigt-Link (/t/<token>). Interne Zuständige: Mail.
//
// Modi:
//   { mode: 'dispatch', task_id }  → einmalige Zustellung beim Anlegen
//   { mode: 'reminder' }           → Cron: alle offenen Aufgaben, 1×/Tag je Zuständigem
//   { mode: 'subtask_done', task_id } → Teilaufgabe erledigt: Rückmeldung an den,
//                                       der die Zuarbeit gestellt hat (WhatsApp, sonst Mail)
//   { mode: 'message', message_id }   → Aufgaben-Nachricht (Rückfrage/Status) an den
//                                       Empfänger + @Erwähnte: WhatsApp, sonst Mail,
//                                       IMMER mit Aufgabentitel + Direktlink
//   { mode: 'message_sweep' }         → Cron: alle Nachrichten ohne externe Meldung
//                                       (fängt Token-Link, Mail- und WhatsApp-Antworten ab)
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_SITE_URL?
// Deploy: supabase functions deploy task-notify --no-verify-jwt
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2'
import { lotteBossBild } from '../_shared/lotte.ts'
import { translateOutbound } from '../_shared/translate.ts'

// Lotte tritt gegenüber dem Team als Chefin auf, die Aufgaben verteilt.
const LOTTE_FROM = 'Lotte · Happy Property'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const PUBLIC_BASE = Deno.env.get('PUBLIC_SITE_URL') ?? 'https://portal.happy-property.com'
const esc = (s: string) => s.replace(/</g, '&lt;')

interface Assignee {
  id: string; task_id: string; profile_id: string | null
  ext_name: string | null; ext_email: string | null; ext_phone: string | null
  ext_lang: string | null
  channel: string; token: string; last_reminded_at: string | null
}
interface ExtCreator { name: string; email: string | null; phone: string | null; lang: string | null }
// ext_creator: Aufgabe kam von AUSSEN über einen persönlichen Buchungslink (/buchen?g=…);
// created_by ist dann nur der Link-Inhaber, der echte Absender steht hier.
interface Task { id: string; title: string; description: string | null; due_date: string | null; status: string; archived: boolean; parent_task_id?: string | null; ext_creator?: ExtCreator | null }
interface LinkedContact { name: string; role: string | null; phone: string | null; email: string | null }
interface ParentCtx { id: string; title: string; description: string | null; creator: string; messages: { who: string; body: string; created_at: string }[] }

// Direktlink in die App: öffnet die Aufgabe sofort (Tasks.tsx liest ?task=).
const appLink = (taskId: string) => `${PUBLIC_BASE}/admin/crm/tasks?task=${taskId}`

// Kontext der Hauptaufgabe zu einer Teilaufgabe: Titel, Beschreibung, wer sie
// gestellt hat und die letzten Nachrichten. Vorfall 15.9.: Leonards Rückfrage kam
// als Teilaufgabe bei Sven an - ohne dass erkennbar war, worauf sie sich bezog.
async function loadParentCtx(supabase: SupabaseClient, parentId: string | null | undefined): Promise<ParentCtx | null> {
  if (!parentId) return null
  const { data: p } = await supabase.from('crm_tasks').select('id, title, description, created_by').eq('id', parentId).maybeSingle()
  if (!p) return null
  const { data: creator } = await supabase.from('profiles').select('full_name').eq('id', p.created_by).maybeSingle()
  const { data: msgs } = await supabase.from('crm_task_messages')
    .select('body, created_at, sender_id, sender_label').eq('task_id', parentId)
    .order('created_at', { ascending: false }).limit(5)
  const senderIds = [...new Set((msgs ?? []).map(m => m.sender_id).filter(Boolean))] as string[]
  const names = new Map<string, string>()
  if (senderIds.length) {
    const { data: ps } = await supabase.from('profiles').select('id, full_name').in('id', senderIds)
    for (const r of (ps ?? []) as { id: string; full_name: string | null }[]) names.set(r.id, r.full_name ?? '')
  }
  const messages = ((msgs ?? []) as { body: string; created_at: string; sender_id: string | null; sender_label: string | null }[])
    .reverse()
    .filter(m => !/^[✅▶🏁✋]/u.test(m.body.trim()))   // Status-Notizen sind kein Kontext
    .map(m => ({ who: (m.sender_id && names.get(m.sender_id)) || m.sender_label || 'Extern', body: m.body, created_at: m.created_at }))
  return { id: p.id, title: p.title, description: p.description, creator: (creator as { full_name: string | null } | null)?.full_name ?? '', messages }
}
const fmtWhen = (iso: string) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })

function parentBlockWa(ctx: ParentCtx | null): string {
  if (!ctx) return ''
  let out = `\n\n🔗 Zuarbeit zur Aufgabe:\n*${ctx.title}*${ctx.creator ? ` (gestellt von ${ctx.creator})` : ''}`
  if (ctx.description) out += `\n${ctx.description.slice(0, 600)}`
  if (ctx.messages.length) {
    out += `\n\n🗨️ Bisheriger Verlauf:`
    for (const m of ctx.messages.slice(-4)) out += `\n• ${m.who} (${fmtWhen(m.created_at)}): ${m.body.slice(0, 300)}`
  }
  return out
}
function parentBlockHtml(ctx: ParentCtx | null): string {
  if (!ctx) return ''
  const msgs = ctx.messages.slice(-4).map(m =>
    `<p style="margin:6px 0;color:#374151;"><strong>${esc(m.who)}</strong> <span style="color:#9ca3af;font-size:12px;">${fmtWhen(m.created_at)}</span><br>${esc(m.body).replace(/\n/g, '<br>')}</p>`).join('')
  return `<div style="background:#eef2ff;border-radius:14px;padding:12px 16px;margin:12px 0;">
    <p style="font-size:13px;color:#6b7280;margin:0 0 4px;">🔗 Zuarbeit zur Aufgabe</p>
    <p style="font-size:15px;font-weight:600;color:#111827;margin:0;">${esc(ctx.title)}${ctx.creator ? ` <span style="font-weight:400;color:#6b7280;">(gestellt von ${esc(ctx.creator)})</span>` : ''}</p>
    ${ctx.description ? `<p style="color:#374151;white-space:pre-wrap;margin:6px 0 0;">${esc(ctx.description)}</p>` : ''}
    ${msgs ? `<p style="font-size:13px;color:#6b7280;margin:10px 0 2px;">🗨️ Bisheriger Verlauf</p>${msgs}` : ''}
  </div>`
}

// Telefonnummer aus dem Feld auf internationale Ziffern bringen (für wa.me/tel).
// Achtung: Nummern im CRM tragen teils unsichtbare Unicode-Richtungszeichen
// (U+202A/202C, geschützte Leerzeichen) — die müssen zuerst raus.
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u00a0]/g   // unsichtbare Richtungs-/Sonderzeichen
function waDigits(raw: string | null | undefined): string | null {
  if (!raw) return null
  let d = raw.replace(BIDI, '').replace(/[^\d+]/g, '')
  if (d.startsWith('+'))       d = d.slice(1)
  else if (d.startsWith('00')) d = d.slice(2)
  else if (d.startsWith('0'))  d = '49' + d.slice(1)
  d = d.replace(/\D/g, '')
  return d.length >= 8 ? d : null
}
// Nummer nur säubern (sichtbar bleiben lassen), ohne Formatumbau.
function cleanPhone(raw: string | null | undefined): string {
  return (raw ?? '').replace(BIDI, ' ').replace(/\s+/g, ' ').trim()
}

// Verknüpfte Kontakte (crm_task_leads → leads) laden. Sie werden dem Zuständigen
// mitgeschickt, damit ein Geschäftspartner ohne System-Zugang direkt weiß, an wen
// er sich wenden muss (z.B. „Unterlagen besorgen bei …").
async function loadLinkedContacts(supabase: SupabaseClient, taskId: string): Promise<LinkedContact[]> {
  const { data } = await supabase.from('crm_task_leads')
    .select('lead:leads(first_name, last_name, email, phone, whatsapp)')
    .eq('task_id', taskId)
  const out: LinkedContact[] = []
  // deno-lint-ignore no-explicit-any
  for (const r of (data ?? []) as any[]) {
    const l = r.lead
    if (!l) continue
    const name = `${l.first_name ?? ''} ${l.last_name ?? ''}`.trim()
    out.push({ name: name || l.email || 'Kontakt', role: null, phone: l.whatsapp || l.phone || null, email: l.email ?? null })
  }
  return out
}

function contactBlockWa(contacts: LinkedContact[]): string {
  if (!contacts.length) return ''
  const blocks = contacts.map(c => {
    const parts = [`👤 ${c.name}${c.role ? ` (${c.role})` : ''}`]
    const disp = cleanPhone(c.phone)
    const d = waDigits(c.phone)
    if (disp) parts.push(`📞 ${disp}`)
    if (d)    parts.push(`💬 https://wa.me/${d}`)
    if (c.email) parts.push(`✉️ ${c.email}`)
    return parts.join('\n')
  })
  return `\n\n📇 Kontakt:\n${blocks.join('\n\n')}`
}

function contactBlockHtml(contacts: LinkedContact[]): string {
  if (!contacts.length) return ''
  const items = contacts.map(c => {
    const disp = cleanPhone(c.phone)
    const d = waDigits(c.phone)
    return `<div style="margin:8px 0;">
      <strong style="color:#111827;">${esc(c.name)}</strong>${c.role ? ` <span style="color:#6b7280;">(${esc(c.role)})</span>` : ''}<br>
      ${disp ? `<span style="color:#374151;">📞 ${esc(disp)}</span>${d ? ` · <a href="https://wa.me/${d}" style="color:#ff795d;">WhatsApp</a>` : ''}<br>` : ''}
      ${c.email ? `<span style="color:#374151;">✉️ <a href="mailto:${esc(c.email)}" style="color:#ff795d;">${esc(c.email)}</a></span>` : ''}
    </div>`
  }).join('')
  return `<div style="background:#f8fafc;border-radius:14px;padding:12px 16px;margin:12px 0;">
    <p style="font-size:13px;color:#6b7280;margin:0 0 4px;">📇 Kontakt</p>${items}</div>`
}

function mailHtml(first: string, intro: string, task: Task, link: string, bossImg: string, contacts: LinkedContact[], parent: ParentCtx | null = null) {
  const due = task.due_date ? new Date(task.due_date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
    <div style="text-align:center;margin-bottom:6px;">
      <img src="${bossImg}" alt="Lotte" width="88" height="88" style="width:88px;height:88px;border-radius:50%;object-fit:cover;" />
      <p style="font-size:13px;color:#6b7280;margin:6px 0 0;">Lotte · deine Chefin bei Happy Property 🐾</p>
    </div>
    <p>Hallo ${esc(first)},</p>
    <p>${intro}</p>
    <div style="background:#faf7f4;border-radius:14px;padding:16px 18px;margin:14px 0;">
      <p style="font-size:16px;font-weight:600;color:#111827;margin:0 0 6px;">${esc(task.title)}</p>
      ${task.description ? `<p style="color:#374151;white-space:pre-wrap;margin:0;">${esc(task.description)}</p>` : ''}
      ${due ? `<p style="color:#6b7280;font-size:13px;margin:8px 0 0;">Frist: ${due}</p>` : ''}
    </div>
    ${parentBlockHtml(parent)}${contactBlockHtml(contacts)}
    <p style="text-align:center;margin:22px 0;">
      <a href="${link}" style="background:#ff795d;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;display:inline-block;">Öffnen &amp; erledigen</a>
    </p>
    <p style="font-size:13px;color:#6b7280;">Du kannst auch direkt auf diese Mail antworten — deine Nachricht landet als Bemerkung in der Aufgabe.</p>
    <p style="margin-top:16px;">Liebe Grüße<br>Lotte 🐾</p>
  </div>`
}

function waText(intro: string, task: Task, link: string, contacts: LinkedContact[], parent: ParentCtx | null = null) {
  return `${intro}\n\n*${task.title}*${task.description ? `\n${task.description}` : ''}${parentBlockWa(parent)}${contactBlockWa(contacts)}\n\nÖffnen & erledigen:\n${link}\n\nLiebe Grüße\nLotte 🐾\n(Du kannst auch einfach hier antworten.)`
}

// Eine Aufgabe an einen Zuständigen zustellen. Lotte vergibt sie als Chefin —
// jede Aufgabe geht ZUSÄTZLICH als WhatsApp mit einem zufälligen Lotte-Boss-Bild
// raus (Sven: „Alle Aufgaben werden zusätzlich nur noch als WhatsApp gestellt …
// jeder ein Bild von Lotte"). Fehlt die Telefonnummer (z.B. Giona), bleibt die
// Mail als Zustellweg.
async function deliver(supabase: SupabaseClient, a: Assignee, task: Task, kind: 'dispatch' | 'reminder') {
  const link = `${PUBLIC_BASE}/t/${a.token}`
  const introMail = kind === 'dispatch' ? 'ich bin Lotte und verteile die Aufgaben im Team. Hier ist eine für dich:' : 'kurze Erinnerung von mir — ist diese Aufgabe schon erledigt?'
  const introWa   = kind === 'dispatch' ? '🐾 Hallo, hier ist Lotte. Ich hab eine Aufgabe für dich:' : '🐾 Lotte hier — kurze Erinnerung: ist diese Aufgabe schon erledigt?'
  const subjectDe = `${kind === 'dispatch' ? 'Neue Aufgabe' : 'Erinnerung'}: ${task.title}`

  // Empfänger + Kanäle + Sprache bestimmen. Interne: profiles.language.
  // Externe (Geschäftspartner ohne System-Zugang): assignee.ext_lang.
  let email: string | null = null, phone: string | null = null, name = '', lang = 'de'
  let wantMail = false, wantWa = false
  if (a.profile_id) {
    const { data: p } = await supabase.from('profiles').select('full_name, email, phone, language').eq('id', a.profile_id).single()
    name = p?.full_name ?? ''; email = p?.email ?? null; phone = (p?.phone ?? '').trim() || null
    lang = p?.language === 'en' ? 'en' : 'de'
    // Interne Zuständige: Mail IMMER, WhatsApp ZUSÄTZLICH wenn eine Nummer da ist.
    wantMail = !!email
    wantWa   = !!phone
  } else {
    name = a.ext_name ?? ''; email = a.ext_email; phone = a.ext_phone
    lang = a.ext_lang === 'en' ? 'en' : 'de'
    wantMail = (a.channel === 'mail' || a.channel === 'both') && !!email
    wantWa   = (a.channel === 'whatsapp' || a.channel === 'both') && !!phone
  }
  const first = (name || '').split(' ')[0] || name
  const bossImg = await lotteBossBild(supabase)
  // Verknüpfte Kontakte (z.B. „Unterlagen besorgen bei …") mitschicken.
  const contacts = await loadLinkedContacts(supabase, task.id)
  // Teilaufgabe? Dann Hauptaufgabe + Verlauf mitschicken - sonst weiß der Empfänger
  // nicht, worauf sich z.B. eine Rückfrage bezieht (Vorfall Leonard/Sven 15.9.).
  const parent = await loadParentCtx(supabase, task.parent_task_id)
  let introMailX = parent && kind === 'dispatch' ? 'ich bin Lotte und verteile die Aufgaben im Team. Hier ist eine Zuarbeit für dich - den Bezug findest du gleich darunter:' : introMail
  let introWaX   = parent && kind === 'dispatch' ? '🐾 Hallo, hier ist Lotte. Ich hab eine Zuarbeit für dich - der Bezug steht gleich darunter:' : introWa
  // Von außen gestellt (persönlicher Link): Absender nennen, sonst wüsste Sven nicht,
  // von wem die Aufgabe kommt - created_by ist ja er selbst.
  if (task.ext_creator && kind === 'dispatch') {
    const c = task.ext_creator
    const who = `${c.name}${c.email ? ` · ${c.email}` : ''}${c.phone ? ` · ${cleanPhone(c.phone)}` : ''}`
    introMailX = `${esc(c.name)} hat dir über deinen persönlichen Link eine Aufgabe gestellt (${esc(who)}):`
    introWaX   = `🐾 Hallo, hier ist Lotte. ${c.name} hat dir über deinen persönlichen Link eine Aufgabe gestellt (${who}):`
  }

  // Texte auf Deutsch bauen, dann in die Empfängersprache übersetzen. translateOutbound
  // bewahrt HTML/URLs/Telefonnummern/E-Mails/Eigennamen (Lotte, Happy Property) und gibt
  // bei lang==='de' unverändert zurück — deutsche Empfänger kosten keinen KI-Aufruf.
  const tr = await translateOutbound({
    subject:  subjectDe,
    body:     wantMail ? mailHtml(first, introMailX, task, link, bossImg, contacts, parent) : null,
    whatsapp: wantWa   ? waText(introWaX, task, link, contacts, parent) : null,
  }, lang)
  // Token bleibt IMMER unübersetzt und geht erst nach der Übersetzung in den Betreff
  // (send-email/imap nutzen [#token] zum Zuordnen von Antworten).
  const subject = `${tr.subject ?? subjectDe} [#${a.token}]`

  if (wantMail && email) {
    await supabase.functions.invoke('send-email', { body: { already_translated: true, to: email, subject, from_name: LOTTE_FROM, html: tr.body ?? mailHtml(first, introMailX, task, link, bossImg, contacts, parent), lang } })
      .catch((e: unknown) => console.warn('[task-notify] mail:', e))
  }
  if (wantWa && phone) {
    await supabase.functions.invoke('send-whatsapp', { body: { already_translated: true,
      event_type: `task_${kind}`, override_text: tr.whatsapp ?? waText(introWaX, task, link, contacts, parent),
      lead_data: { lead_name: name || 'Empfänger', lead_phone: phone },
      persona_image: bossImg,   // Lotte als Chefin
    } }).catch((e: unknown) => console.warn('[task-notify] whatsapp:', e))
  }
  await supabase.from('crm_task_assignees').update({ last_reminded_at: new Date().toISOString() }).eq('id', a.id)
  return { assignee: a.id, mail: wantMail, whatsapp: wantWa, lang, contacts: contacts.length }
}

// ── Fertigmeldung an einen EXTERNEN Aufgabengeber (persönlicher Link) ────────
// Gleicher Riegel wie bei Teilaufgaben (done_notified_at, Compare-and-Swap), gleiche
// Aufrufer (In-App, Token-Link, Sweep). Sprache aus ext_creator.lang.
async function notifyExtCreatorDone(supabase: SupabaseClient, task: { id: string; title: string; ext_creator: ExtCreator | null; done_notified_at: string | null }) {
  const c = task.ext_creator!
  const { data: claimed } = await supabase.from('crm_tasks')
    .update({ done_notified_at: new Date().toISOString() })
    .eq('id', task.id).is('done_notified_at', null).select('id')
  if (!claimed || claimed.length === 0) return { skipped: 'bereits_gemeldet' }
  const release = async (why: unknown) => {
    console.warn('[task-notify] Versand (extern) fehlgeschlagen, Meldung bleibt offen:', why)
    await supabase.from('crm_tasks').update({ done_notified_at: null }).eq('id', task.id)
  }
  const en = c.lang === 'en'
  const first = (c.name || '').split(' ')[0] || c.name
  const safeTitle = task.title.replace(/[\r\n]+/g, ' ').slice(0, 160)
  const waText = en
    ? `✅ Done!\n\nHi ${first} 🐾\n\nSven has completed your task:\n\n*${task.title}*\n\nBest regards\nLotte 🐾`
    : `✅ Erledigt!\n\nHallo ${first} 🐾\n\nSven hat deine Aufgabe erledigt:\n\n*${task.title}*\n\nLiebe Grüße\nLotte 🐾`
  const phone = (c.phone ?? '').trim()
  let via = 'keiner'
  if (phone) {
    const { error: waErr } = await supabase.functions.invoke('send-whatsapp', { body: { already_translated: true,
      event_type: 'task_done_ext', override_text: waText,
      lead_data: { lead_name: c.name || 'Gast', lead_phone: phone },
      persona_image: await lotteBossBild(supabase),
    } }).catch((e: unknown) => ({ error: e }))
    if (waErr) { await release(waErr); return { skipped: 'versand_fehlgeschlagen' } }
    via = 'whatsapp'
  } else if (c.email) {
    const { error: mailErr } = await supabase.functions.invoke('send-email', { body: { already_translated: true,
      to: c.email, from_name: en ? "Lotte · Sven's personal assistant" : 'Lotte · Assistentin von Sven', lang: en ? 'en' : 'de', auto: true,
      subject: en ? `Done: ${safeTitle}` : `Erledigt: ${safeTitle}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
        <p>${en ? 'Hi' : 'Hallo'} ${esc(first)},</p>
        <p>${en ? 'Sven has completed your task:' : 'Sven hat deine Aufgabe erledigt:'}</p>
        <div style="background:#faf7f4;border-radius:14px;padding:16px 18px;margin:14px 0;">
          <p style="font-size:16px;font-weight:600;color:#111827;margin:0;">✅ ${esc(task.title)}</p>
        </div>
        <p>${en ? 'Best regards' : 'Liebe Grüße'}<br>Lotte 🐾</p>
      </div>`,
    } }).catch((e: unknown) => ({ error: e }))
    if (mailErr) { await release(mailErr); return { skipped: 'versand_fehlgeschlagen' } }
    via = 'mail'
  }
  console.log(`[task-notify] Externe Aufgabe ${task.id} erledigt → Meldung an ${c.name} via ${via}`)
  return { notified: true, via, external: true }
}

// ── Fertigmeldung einer Teilaufgabe an den Aufgabengeber ────────────────────
// Aufrufbar von allen drei Erledigt-Wegen (In-App-Button, Drag & Drop, Token-Link)
// und zusätzlich vom 5-Minuten-Sweep. Damit daraus trotzdem GENAU EINE Nachricht
// wird, ist done_notified_at der Riegel: nur wer den Übergang null → jetzt selbst
// gewinnt, verschickt. Zwei gleichzeitige Aufrufe → einer bekommt keine Zeile
// zurück und hört auf.
async function notifySubtaskDone(supabase: SupabaseClient, taskId: string) {
  const { data: t } = await supabase.from('crm_tasks')
    .select('id, title, description, parent_task_id, created_by, completed_by, status, done_notified_at, ext_creator')
    .eq('id', taskId).maybeSingle()
  const task = t as { id: string; title: string; parent_task_id: string | null; created_by: string; completed_by: string | null; status: string; done_notified_at: string | null; ext_creator: ExtCreator | null } | null
  if (!task) return { skipped: 'not_found' }
  if (task.status !== 'erledigt') return { skipped: 'nicht_erledigt' }
  // Von außen gestellte Aufgabe (persönlicher Link): Rückmeldung an den externen Absender.
  if (!task.parent_task_id && task.ext_creator) return await notifyExtCreatorDone(supabase, task)
  if (!task.parent_task_id) return { skipped: 'keine_teilaufgabe' }
  // Wer sich selbst zuarbeitet, braucht keine Rückmeldung.
  if (task.completed_by && task.completed_by === task.created_by) {
    await supabase.from('crm_tasks').update({ done_notified_at: new Date().toISOString() }).eq('id', task.id).is('done_notified_at', null)
    return { skipped: 'selbst_erledigt' }
  }

  // Compare-and-swap: nur EIN Aufruf gewinnt.
  const { data: claimed } = await supabase.from('crm_tasks')
    .update({ done_notified_at: new Date().toISOString() })
    .eq('id', task.id).is('done_notified_at', null).select('id')
  if (!claimed || claimed.length === 0) return { skipped: 'bereits_gemeldet' }

  const { data: giver } = await supabase.from('profiles').select('full_name, email, phone, role').eq('id', task.created_by).maybeSingle()
  const g = giver as { full_name: string | null; email: string | null; phone: string | null; role: string | null } | null
  // Nur an interne Rollen. Aufgaben koennen ueber die UI zwar nur intern angelegt
  // werden, aber profiles enthaelt auch Eigentuemer und Feriengaeste — eine interne
  // Meldung darf dort unter keinen Umstaenden landen.
  if (!g || !['admin', 'verwalter', 'mitarbeiter'].includes(g.role ?? '')) {
    console.warn(`[task-notify] Aufgabengeber ${task.created_by} ist nicht intern — keine Meldung`)
    return { skipped: 'empfaenger_nicht_intern' }
  }
  const { data: doer } = task.completed_by
    ? await supabase.from('profiles').select('full_name').eq('id', task.completed_by).maybeSingle()
    : { data: null }
  const { data: parent } = await supabase.from('crm_tasks').select('title').eq('id', task.parent_task_id).maybeSingle()

  const first     = (g?.full_name ?? '').split(' ')[0] || 'Hallo'
  const doerName  = (doer as { full_name: string | null } | null)?.full_name ?? 'Jemand aus dem Team'
  const parentTtl = (parent as { title: string } | null)?.title ?? ''

  // Bewusst OHNE freien Text aus Bemerkungen: send-whatsapp durchsucht den Body nach
  // /deck/<token> und YouTube-Links und haengt dann eigenstaendig Bilder an.
  const waText = `✅ Zuarbeit erledigt\n\n*${task.title}*${parentTtl ? `\nzu: ${parentTtl}` : ''}\n\n${doerName} hat die Teilaufgabe als erledigt markiert.`
  const phone  = (g?.phone ?? '').trim()

  // Bei Sendefehler wird der Riegel wieder geoeffnet, damit der 5-Minuten-Sweep es
  // erneut versucht. Sonst waere die Meldung endgueltig verloren: das Compare-and-Swap
  // sitzt bewusst VOR dem Versand (gegen Doppelmeldungen), und der Versand kann
  // scheitern, ohne dass es jemand merkt.
  const release = async (why: unknown) => {
    console.warn('[task-notify] Versand fehlgeschlagen, Meldung bleibt offen:', why)
    await supabase.from('crm_tasks').update({ done_notified_at: null }).eq('id', task.id)
  }

  let via = 'keiner'
  if (phone) {
    // Nummer VOR dem Aufruf pruefen: send-whatsapp nutzt ??, ein Leerstring wuerde
    // die Empfaengeraufloesung kippen statt sauber abzubrechen.
    const { error: waErr } = await supabase.functions.invoke('send-whatsapp', { body: { already_translated: true,
      event_type: 'subtask_done', override_text: `${waText}\n\nLiebe Grüße\nLotte 🐾`,
      lead_data: { lead_name: g.full_name ?? 'Team', lead_phone: phone },
      persona_image: await lotteBossBild(supabase),   // Lotte meldet zurück
      // KEIN lead_id: sonst landet die interne Meldung in einer Kundenakte.
    } }).catch((e: unknown) => ({ error: e }))
    if (waErr) { await release(waErr); return { skipped: 'versand_fehlgeschlagen' } }
    via = 'whatsapp'
  } else if (g.email) {
    // Rueckfallebene, damit die Meldung nicht still verschwindet, wenn im Profil
    // keine Telefonnummer hinterlegt ist.
    const { error: mailErr } = await supabase.functions.invoke('send-email', { body: { already_translated: true,
      // Zeilenumbrueche aus dem Titel raus: der Betreff geht ungeprueft in den
      // Mail-Header, ein CR/LF darin waere eine Header-Injektion.
      to: g.email, from_name: LOTTE_FROM, subject: `Zuarbeit erledigt: ${task.title.replace(/[\r\n]+/g, ' ').slice(0, 160)}`,
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
        <p>Hallo ${esc(first)},</p>
        <p>${esc(doerName)} hat deine Teilaufgabe als erledigt markiert:</p>
        <div style="background:#faf7f4;border-radius:14px;padding:16px 18px;margin:14px 0;">
          <p style="font-size:16px;font-weight:600;color:#111827;margin:0;">${esc(task.title)}</p>
          ${parentTtl ? `<p style="color:#6b7280;font-size:13px;margin:6px 0 0;">zu: ${esc(parentTtl)}</p>` : ''}
        </div>
        <p style="font-size:13px;color:#6b7280;">Trage im Profil eine Telefonnummer ein, dann kommt diese Meldung künftig per WhatsApp.</p>
      </div>`,
    } }).catch((e: unknown) => ({ error: e }))
    if (mailErr) { await release(mailErr); return { skipped: 'versand_fehlgeschlagen' } }
    via = 'mail'
  }
  console.log(`[task-notify] Teilaufgabe ${task.id} erledigt → Meldung an ${task.created_by} via ${via}`)
  return { notified: true, via }
}

// ── Aufgaben-Nachricht (Rückfrage/Status) extern melden ─────────────────────
// Jede Nachricht in crm_task_messages - egal ob aus der App, vom Token-Link, aus
// einer Mail- oder WhatsApp-Antwort - geht an den Empfänger raus: WhatsApp, sonst
// Mail. IMMER mit Aufgabentitel, ggf. Hauptaufgabe und Direktlink in die App.
// Vorher: nur ein In-App-Popup ohne Titel, Mail nur bei App-Nachrichten.
//
// @Erwähnungen: "@Sven …" im Text erreicht Sven zusätzlich, auch wenn die Nachricht
// an jemand anderen adressiert ist (Gionas Frage vom 11.9. hing so an Leonard fest).
//
// ext_notified_at ist der Riegel (Compare-and-Swap) - Sofort-Aufruf und
// 5-Minuten-Sweep können sich nicht doppeln.
const STATUS_NOTE = /^[✅▶🏁✋]/u
interface StaffRow { id: string; full_name: string | null; email: string | null; phone: string | null; role: string | null; language: string | null }

async function notifyMessage(supabase: SupabaseClient, messageId: string) {
  const { data: m } = await supabase.from('crm_task_messages')
    .select('id, task_id, sender_id, sender_label, recipient_id, body, created_at, ext_notified_at')
    .eq('id', messageId).maybeSingle()
  const msg = m as { id: string; task_id: string; sender_id: string | null; sender_label: string | null; recipient_id: string; body: string; created_at: string; ext_notified_at: string | null } | null
  if (!msg) return { skipped: 'not_found' }
  if (msg.ext_notified_at) return { skipped: 'bereits_gemeldet' }

  // Compare-and-Swap: nur EIN Aufruf gewinnt.
  const { data: claimed } = await supabase.from('crm_task_messages')
    .update({ ext_notified_at: new Date().toISOString() })
    .eq('id', msg.id).is('ext_notified_at', null).select('id')
  if (!claimed || claimed.length === 0) return { skipped: 'bereits_gemeldet' }

  // Status-Notizen (angenommen / in Bearbeitung / erledigt) bleiben In-App-Info.
  // Erledigt-Meldungen von Teilaufgaben laufen separat über subtask_done.
  if (STATUS_NOTE.test(msg.body.trim())) return { skipped: 'status_notiz' }

  const { data: t } = await supabase.from('crm_tasks').select('id, title, parent_task_id, archived').eq('id', msg.task_id).maybeSingle()
  const task = t as { id: string; title: string; parent_task_id: string | null; archived: boolean } | null
  if (!task) return { skipped: 'aufgabe_fehlt' }

  const { data: staffRaw } = await supabase.from('profiles').select('id, full_name, email, phone, role, language')
    .in('role', ['admin', 'verwalter', 'mitarbeiter'])
  const staff = (staffRaw ?? []) as StaffRow[]
  const byId = new Map(staff.map(x => [x.id, x]))
  const sender = msg.sender_id ? byId.get(msg.sender_id) : null
  const senderName = sender?.full_name || msg.sender_label || 'Jemand'

  // Empfänger: der adressierte Teilnehmer + alle @Erwähnten (Vorname oder voller
  // Name, Groß/Klein egal). Nie der Absender selbst.
  const targets = new Map<string, StaffRow>()
  const rec = byId.get(msg.recipient_id)
  if (rec && rec.id !== msg.sender_id) targets.set(rec.id, rec)
  const lower = msg.body.toLowerCase()
  for (const p of staff) {
    if (p.id === msg.sender_id || !p.full_name) continue
    const first = p.full_name.split(' ')[0].toLowerCase()
    const full  = p.full_name.toLowerCase()
    if (first.length >= 2 && (lower.includes(`@${first}`) || lower.includes(`@${full}`))) targets.set(p.id, p)
  }
  if (targets.size === 0) return { skipped: 'kein_interner_empfaenger' }

  const parent = await loadParentCtx(supabase, task.parent_task_id)
  const link = appLink(task.id)
  const bossImg = await lotteBossBild(supabase)
  // Ohne Zeilenumbrüche in den Betreff (Header-Injektion).
  const safeTitle = task.title.replace(/[\r\n]+/g, ' ').slice(0, 120)

  const out: Record<string, string> = {}
  for (const p of targets.values()) {
    const first = (p.full_name ?? '').split(' ')[0] || 'Hallo'
    const mentioned = p.id !== msg.recipient_id
    const lang = p.language === 'en' ? 'en' : 'de'
    const waDe = `💬 ${mentioned ? 'Du wurdest erwähnt' : 'Neue Nachricht'} zur Aufgabe\n\n*${task.title}*${parent ? `\n🔗 Zuarbeit zu: ${parent.title}` : ''}\n\n${senderName} schreibt:\n„${msg.body.slice(0, 1500)}“\n\nAufgabe öffnen & antworten:\n${link}\n\nLiebe Grüße\nLotte 🐾`
    const htmlDe = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1f2937;">
      <p>Hallo ${esc(first)},</p>
      <p>${esc(senderName)} hat ${mentioned ? 'dich in einer Aufgaben-Nachricht erwähnt' : 'dir zu einer Aufgabe geschrieben'}:</p>
      <div style="background:#faf7f4;border-radius:14px;padding:16px 18px;margin:14px 0;">
        <p style="font-size:16px;font-weight:600;color:#111827;margin:0;">${esc(task.title)}</p>
        ${parent ? `<p style="color:#6b7280;font-size:13px;margin:6px 0 0;">🔗 Zuarbeit zu: ${esc(parent.title)}</p>` : ''}
      </div>
      <blockquote style="border-left:3px solid #ff795d;padding-left:12px;color:#374151;white-space:pre-wrap;margin:0 0 14px;">${esc(msg.body)}</blockquote>
      <p style="text-align:center;margin:22px 0;">
        <a href="${link}" style="background:#ff795d;color:#fff;text-decoration:none;padding:12px 24px;border-radius:10px;font-weight:600;display:inline-block;">Aufgabe öffnen &amp; antworten</a>
      </p>
      <p style="margin-top:16px;">Liebe Grüße<br>Lotte 🐾</p>
    </div>`
    const tr = await translateOutbound({ subject: `Nachricht zur Aufgabe: ${safeTitle}`, body: htmlDe, whatsapp: waDe }, lang)

    const phone = (p.phone ?? '').trim()
    if (phone) {
      const { error } = await supabase.functions.invoke('send-whatsapp', { body: { already_translated: true,
        event_type: 'task_message', override_text: tr.whatsapp ?? waDe,
        lead_data: { lead_name: p.full_name ?? 'Team', lead_phone: phone },
        persona_image: bossImg,
        // KEIN lead_id: interne Meldung, darf in keiner Kundenakte landen.
      } }).catch((e: unknown) => ({ error: e }))
      if (!error) { out[p.id] = 'whatsapp'; continue }
      console.warn('[task-notify] message WhatsApp fehlgeschlagen, Mail als Ersatz:', error)
    }
    if (p.email) {
      const { error } = await supabase.functions.invoke('send-email', { body: { already_translated: true,
        to: p.email, from_name: LOTTE_FROM, subject: tr.subject ?? `Nachricht zur Aufgabe: ${safeTitle}`, html: tr.body ?? htmlDe, lang,
      } }).catch((e: unknown) => ({ error: e }))
      out[p.id] = error ? 'fehlgeschlagen' : 'mail'
      continue
    }
    out[p.id] = 'kein_kanal'
  }
  console.log(`[task-notify] Nachricht ${msg.id} (Aufgabe ${task.id}) →`, out)
  return { notified: true, targets: out }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const { mode, task_id, message_id } = await req.json().catch(() => ({}))
    const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)

    if (mode === 'dispatch') {
      if (!task_id) return json({ error: 'task_id fehlt' }, 400)
      const { data: task } = await supabase.from('crm_tasks').select('id,title,description,due_date,status,archived,parent_task_id,ext_creator').eq('id', task_id).single()
      if (!task) return json({ error: 'Aufgabe nicht gefunden' }, 404)
      const { data: asg } = await supabase.from('crm_task_assignees').select('*').eq('task_id', task_id)
      const out = []
      // Nur noch nicht benachrichtigte Zuständige zustellen — so benachrichtigt ein
      // erneuter Dispatch (nachträglich hinzugefügte Person) nur die Neuen.
      for (const a of (asg ?? []) as Assignee[]) {
        if (a.last_reminded_at) continue
        out.push(await deliver(supabase, a, task as Task, 'dispatch'))
      }
      return json({ ok: true, delivered: out })
    }

    if (mode === 'message') {
      if (!message_id) return json({ error: 'message_id fehlt' }, 400)
      return json({ ok: true, ...(await notifyMessage(supabase, message_id)) })
    }

    // Sicherheitsnetz für alle Wege, die keinen Sofort-Aufruf machen (Mail-Antwort
    // über imap-poll, WhatsApp-Antwort über timelines-webhook). Nur die letzten
    // 24 h - ältere Nachrichten nachträglich zu melden wäre Spam.
    if (mode === 'message_sweep') {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString()
      const { data: due } = await supabase.from('crm_task_messages').select('id')
        .is('ext_notified_at', null).gte('created_at', since).order('created_at').limit(30)
      const out = []
      for (const r of (due ?? []) as { id: string }[]) out.push(await notifyMessage(supabase, r.id))
      return json({ ok: true, swept: out.length, out })
    }

    if (mode === 'subtask_done') {
      if (!task_id) return json({ error: 'task_id fehlt' }, 400)
      return json({ ok: true, ...(await notifySubtaskDone(supabase, task_id)) })
    }

    // Sicherheitsnetz: erledigte Teilaufgaben, deren Meldung noch aussteht — faengt
    // jeden Erledigt-Weg ab, auch einen, den es heute noch nicht gibt.
    if (mode === 'subtask_sweep') {
      const { data: due } = await supabase.from('crm_tasks').select('id')
        .eq('status', 'erledigt').is('done_notified_at', null).or('parent_task_id.not.is.null,ext_creator.not.is.null').limit(50)
      const out = []
      for (const r of (due ?? []) as { id: string }[]) out.push(await notifySubtaskDone(supabase, r.id))
      return json({ ok: true, swept: out.length, out })
    }

    if (mode === 'reminder') {
      // Alle offenen (nicht erledigten, nicht archivierten) Aufgaben mit Zuständigen
      const cutoff = new Date(Date.now() - 20 * 3600_000).toISOString()   // max. 1×/Tag
      const { data: asg } = await supabase
        .from('crm_task_assignees')
        .select('*, task:crm_tasks!inner(id,title,description,due_date,status,archived,parent_task_id,ext_creator)')
        .neq('task.status', 'erledigt').eq('task.archived', false)
      let sent = 0
      for (const row of (asg ?? []) as (Assignee & { task: Task })[]) {
        if (row.last_reminded_at && row.last_reminded_at > cutoff) continue
        await deliver(supabase, row, row.task, 'reminder'); sent++
      }
      return json({ ok: true, reminded: sent })
    }

    return json({ error: 'unbekannter Modus' }, 400)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[task-notify]', msg)
    return json({ error: msg }, 500)
  }
})
