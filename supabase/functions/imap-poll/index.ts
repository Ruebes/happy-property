// imap-poll — liest eingehende Mails aus dem IONOS-Postfach und ordnet sie zu.
//
// ZWEI Aufgaben pro Mail:
//   1) Trägt der Betreff einen Aufgaben-Token „… [#<token>]", ist es die Antwort
//      auf eine Aufgaben-Erinnerung → als Bemerkung in die Aufgabe schreiben.
//   2) Sonst: Absender-Adresse gegen leads.email prüfen. Passt sie zu einem Lead,
//      ist es eine KUNDENANTWORT → als eingehende Nachricht (activities, type email,
//      direction inbound) ins Lead-Konto schreiben, damit sie im Posteingang und in
//      der Lead-Chronik steht.
//
// Flags bleiben unberührt (BODY.PEEK). Dedupe über task_mail_processed (UID) — jede
// UID wird nur EINMAL verarbeitet, das restliche Postfach bleibt unangetastet.
// Fremd-Mails (kein Token, kein Lead-Treffer) werden nur als „gesehen" vermerkt.
//
// Secrets: IMAP_USER, IMAP_PASS, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// Deploy: supabase functions deploy imap-poll --no-verify-jwt
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.4'

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })
const HOST = 'imap.ionos.de', PORT = 993
const MAX_PER_RUN = 15

// ── Minimaler IMAP-Client über TLS ───────────────────────────────────────────
class Imap {
  conn!: Deno.TlsConn; enc = new TextEncoder(); dec = new TextDecoder(); n = 0
  async connect() { this.conn = await Deno.connectTls({ hostname: HOST, port: PORT }); await this.readRaw() }
  async readRaw() { const b = new Uint8Array(65536); const k = await this.conn.read(b); return k ? this.dec.decode(b.subarray(0, k)) : '' }
  async cmd(line: string): Promise<string> {
    const tag = 'a' + (++this.n)
    await this.conn.write(this.enc.encode(tag + ' ' + line + '\r\n'))
    let data = ''
    for (let i = 0; i < 400; i++) {
      const c = await this.readRaw(); data += c
      if (new RegExp('^' + tag + ' (OK|NO|BAD)', 'm').test(data)) break
    }
    return data
  }
  async login(u: string, p: string) { const e = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"'); return this.cmd(`LOGIN "${e(u)}" "${e(p)}"`) }
  async logout() { try { await this.cmd('LOGOUT'); this.conn.close() } catch { /* noop */ } }
}

// ── MIME-Helfer ──────────────────────────────────────────────────────────────
function utf8(bytes: string) { try { return decodeURIComponent(escape(bytes)) } catch { return bytes } }
function decodeQP(s: string) {
  const bytes = s.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
  return utf8(bytes)
}
function decodeMimeWords(s: string) {
  return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, _cs, enc, txt) => {
    try {
      if (enc.toUpperCase() === 'B') return decodeURIComponent(escape(atob(txt)))
      return decodeURIComponent(escape(decodeQP(txt.replace(/_/g, ' '))))
    } catch { return txt }
  }).replace(/\?=\s+=\?/g, '')
}
function header(raw: string, name: string): string {
  const re = new RegExp('^' + name + ':\\s*([\\s\\S]*?)(?=\\r\\n\\S|\\r\\n\\r\\n|$)', 'im')
  const m = raw.match(re); return m ? m[1].replace(/\r\n[ \t]+/g, ' ').trim() : ''
}
function stripQuoted(text: string): string {
  const lines = text.split(/\r?\n/); const out: string[] = []
  for (const ln of lines) {
    if (/^>/.test(ln)) break
    if (/^\s*(Am|On)\b.*\b(schrieb|wrote)\s*:?\s*$/.test(ln)) break
    if (/^-{2,}\s*(Ursprüngliche|Original)/i.test(ln)) break
    if (/^_{5,}/.test(ln)) break
    if (/^Von:\s/.test(ln) && out.length) break
    out.push(ln)
  }
  return out.join('\n').trim()
}
// Entfernt den IMAP-FETCH-Wrapper (…{<size>}\r\n<RFC822>…) → reine Nachricht.
function unwrapFetch(fetched: string): string {
  const m = fetched.match(/\{\d+\}\r?\n/)
  if (!m || m.index === undefined) return fetched
  let raw = fetched.slice(m.index + m[0].length)
  const tail = raw.search(/\r\n\)\r\n[aA]\d+ (OK|NO|BAD)/)   // schließende ) + Tag
  if (tail >= 0) raw = raw.slice(0, tail)
  return raw
}
function bodyAfterHeaders(s: string): { head: string; body: string } {
  const i = s.search(/\r\n\r\n/); if (i < 0) return { head: s, body: '' }
  return { head: s.slice(0, i), body: s.slice(i + 4) }
}
// Holt einen Part per Content-Type — egal wie tief verschachtelt (mixed→alternative).
// Body reicht bis zur nächsten Boundary-Zeile (--…).
function grabPart(raw: string, typeRe: RegExp): { section: string; cte: string; isHtml: boolean } | null {
  const m = new RegExp('Content-Type:\\s*' + typeRe.source, 'i').exec(raw)
  if (!m || m.index === undefined) return null
  const hEnd = raw.indexOf('\r\n\r\n', m.index)
  if (hEnd < 0) return null
  const partHead = raw.slice(m.index, hEnd)
  const rest = raw.slice(hEnd + 4)
  const bEnd = rest.search(/\r\n--[^\r\n]+(\r\n|--)/)
  return {
    section: bEnd >= 0 ? rest.slice(0, bEnd) : rest,
    cte: (partHead.match(/content-transfer-encoding:\s*([^\r\n]+)/i)?.[1] || '').trim().toLowerCase(),
    isHtml: /text\/html/i.test(partHead),
  }
}
function extractPlain(fetched: string): string {
  const raw = unwrapFetch(fetched)
  const chosen = grabPart(raw, /text\/plain/) || grabPart(raw, /text\/html/) || (() => {
    const { body } = bodyAfterHeaders(raw)
    return { section: body, cte: (raw.match(/content-transfer-encoding:\s*([^\r\n]+)/i)?.[1] || '').trim().toLowerCase(), isHtml: /content-type:\s*text\/html/i.test(raw) }
  })()
  let section = chosen.section
  if (chosen.cte === 'base64') { try { section = utf8(atob(section.replace(/\s+/g, ''))) } catch { /* noop */ } }
  else if (chosen.cte === 'quoted-printable' || /=\r?\n/.test(section) || /=[0-9A-Fa-f]{2}/.test(section)) section = decodeQP(section)
  if (chosen.isHtml) section = section.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  return stripQuoted(section)
}

// Absender-Adresse aus dem From-Header ziehen: „Max <max@x.de>" → „max@x.de".
function fromAddress(raw: string): string {
  const f = decodeMimeWords(header(raw, 'From'))
  const m = f.match(/<([^>]+)>/)
  return (m ? m[1] : f).trim().toLowerCase()
}
// IMAP-SINCE-Datum: DD-Mon-YYYY (englische Monatskürzel).
function imapSince(daysBack: number): string {
  const d = new Date(Date.now() - daysBack * 864e5)
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  return `${String(d.getUTCDate()).padStart(2, '0')}-${mon}-${d.getUTCFullYear()}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const imap = new Imap()
  const result = { scanned: 0, tasks: 0, leads: 0, skipped: 0, errors: [] as string[] }
  try {
    await imap.connect()
    const li = await imap.login(Deno.env.get('IMAP_USER') ?? '', Deno.env.get('IMAP_PASS') ?? '')
    if (!/OK/m.test(li)) return json({ error: 'IMAP-Login fehlgeschlagen' }, 500)
    await imap.cmd('SELECT INBOX')

    // Token-Mails (Aufgaben-Antworten) UND alle jüngeren Mails (Kunden-Antworten).
    // Zwei Suchen, per Set entdoppelt. SINCE begrenzt die zweite auf die letzten Tage,
    // damit nicht das ganze Postfach gescannt wird; task_mail_processed hält den Rest.
    const s1 = await imap.cmd('UID SEARCH HEADER Subject "[#"')
    const s2 = await imap.cmd(`UID SEARCH SINCE ${imapSince(14)}`)
    const parse = (r: string) => (r.match(/\* SEARCH([0-9 ]*)/i)?.[1] || '').trim().split(/\s+/).filter(Boolean)
    const uids = Array.from(new Set([...parse(s1), ...parse(s2)]))
      .sort((a, b) => Number(b) - Number(a))   // neueste zuerst
      .slice(0, MAX_PER_RUN)
    result.scanned = uids.length

    for (const uid of uids) {
      try {
        const { data: seen } = await supabase.from('task_mail_processed').select('uid').eq('uid', uid).maybeSingle()
        if (seen) { result.skipped++; continue }
        const fetched = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[])`)
        const subject = decodeMimeWords(header(fetched, 'Subject'))
        const token = subject.match(/\[#([a-f0-9]{8,20})\]/i)?.[1]
        // UID immer merken, damit dieselbe Mail nicht bei jedem Lauf neu verarbeitet wird.
        await supabase.from('task_mail_processed').insert({ uid })

        // (1) Aufgaben-Antwort mit Token → Bemerkung in die Aufgabe.
        if (token) {
          const { data: asg } = await supabase.from('crm_task_assignees')
            .select('id, task_id, profile_id, ext_name, task:crm_tasks!inner(created_by)')
            .eq('token', token).maybeSingle()
          if (!asg) { result.skipped++; continue }
          let label = asg.ext_name || 'Extern'
          if (asg.profile_id) { const { data: p } = await supabase.from('profiles').select('full_name').eq('id', asg.profile_id).single(); label = p?.full_name || label }
          const bodyText = (extractPlain(fetched) || '(leere Antwort)').slice(0, 4000)
          // deno-lint-ignore no-explicit-any
          const createdBy = (asg.task as any)?.created_by
          await supabase.from('crm_task_messages').insert({
            task_id: asg.task_id, sender_id: asg.profile_id ?? null, sender_label: `${label} (per Mail)`,
            recipient_id: createdBy, body: bodyText,
          })
          result.tasks++
          continue
        }

        // (2) Kundenantwort → Absender gegen leads.email prüfen.
        const addr = fromAddress(fetched)
        if (!addr || !addr.includes('@')) { result.skipped++; continue }
        // NIEMALS unsere eigene Adresse als Kunde behandeln: sonst würde jede Mail,
        // die wir selbst von info@ verschicken und die im Postfach landet, als
        // „Kundenantwort" fehlverbucht (ein Test-Lead trug info@happy-property.com).
        const own = (Deno.env.get('IMAP_USER') ?? '').trim().toLowerCase()
        if (addr === own || /(^|@)(no-?reply|mailer-daemon|postmaster)\b/.test(addr)) { result.skipped++; continue }
        const { data: leadRow } = await supabase.rpc('find_lead_by_email', { p_email: addr })
        const leadId = (leadRow as Array<{ id: string }> | null)?.[0]?.id
        if (!leadId) { result.skipped++; continue }   // Fremd-Mail (Newsletter, Bank, …) → ignorieren
        const bodyText = (extractPlain(fetched) || '(leere Nachricht)').slice(0, 4000)
        await supabase.from('activities').insert({
          lead_id:      leadId,
          type:         'email',
          direction:    'inbound',
          subject:      subject ? `Antwort: ${subject.slice(0, 160)}` : 'E-Mail erhalten',
          content:      bodyText,
          completed_at: new Date().toISOString(),
          auto:         false,   // eingehend = echte Kundennachricht → im Posteingang sichtbar
        })
        // Frische KI-Zusammenfassung erzwingen und Nachfass-Automatik stoppen —
        // eine echte Antwort ist wie bei WhatsApp ein „Kunde hat geantwortet".
        try { await supabase.from('lead_ai_summaries').delete().eq('lead_id', leadId) } catch { /* egal */ }
        result.leads++
      } catch (e) { result.errors.push(e instanceof Error ? e.message : String(e)) }
    }
    await imap.logout()
    return json({ ok: true, ...result })
  } catch (err) {
    try { await imap.logout() } catch { /* noop */ }
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[imap-poll]', msg)
    return json({ error: msg, ...result }, 500)
  }
})
