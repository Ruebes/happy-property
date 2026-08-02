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

// ── Developer-Mails: Domains der Bauträger-Kontakte + optionale Extra-Liste ──
// (crm_settings key developer_mail_domains, kommagetrennt). Freemail-Domains
// zählen nie als Developer-Domain.
const FREEMAIL = ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'gmx.de', 'gmx.net', 'web.de', 'icloud.com', 't-online.de']
async function devDomains(supabase: SupabaseClient): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  const { data } = await supabase.from('crm_developer_contacts').select('email, developer_id')
  for (const c of ((data ?? []) as { email: string | null; developer_id: string | null }[])) {
    const d = (c.email ?? '').split('@')[1]?.toLowerCase().trim()
    if (d && !FREEMAIL.includes(d)) map.set(d, c.developer_id)
  }
  const { data: extra } = await supabase.from('crm_settings').select('value').eq('key', 'developer_mail_domains').maybeSingle()
  for (const d of (((extra as { value?: string } | null)?.value ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean))) {
    if (!map.has(d)) map.set(d, null)
  }
  return map
}
// MIME-Anhänge (base64 + filename) flach aus dem Roh-Text ziehen.
function extractAttachments(raw: string): Array<{ name: string; b64: string; mime: string }> {
  const out: Array<{ name: string; b64: string; mime: string }> = []
  const parts = raw.split(/\r?\n--[^\r\n]+\r?\n/)
  for (const p of parts.slice(1)) {
    const headEnd = p.search(/\r?\n\r?\n/); if (headEnd < 0) continue
    const head = p.slice(0, headEnd)
    if (!/content-transfer-encoding:\s*base64/i.test(head)) continue
    const fn = head.match(/filename\*?="?([^";\r\n]+)"?/i)?.[1] || head.match(/name="?([^";\r\n]+)"?/i)?.[1]
    if (!fn) continue
    const mime = (head.match(/content-type:\s*([^;\r\n]+)/i)?.[1] || 'application/octet-stream').trim()
    const body = p.slice(headEnd).replace(/[^A-Za-z0-9+/=]/g, '')
    if (body.length < 100) continue
    out.push({ name: decodeMimeWords(fn), b64: body, mime })
    if (out.length >= 8) break
  }
  return out
}
async function storeDevMail(supabase: SupabaseClient, uid: string, raw: string, addr: string, subject: string, devId: string | null): Promise<boolean> {
  const { data: dup } = await supabase.from('partner_mails').select('id').eq('uid', uid).maybeSingle()
  if (dup) return false
  const atts = extractAttachments(raw)
  const stored: Array<{ name: string; url: string; path: string }> = []
  for (let i = 0; i < atts.length; i++) {
    try {
      const bytes = Uint8Array.from(atob(atts[i].b64), c => c.charCodeAt(0))
      if (bytes.length > 15_000_000) continue
      const safe = atts[i].name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-80)
      const path = `${uid}-${i}-${safe}`
      const { error } = await supabase.storage.from('mail-attachments').upload(path, bytes, { contentType: atts[i].mime, upsert: true })
      if (error) { console.warn('[imap-poll] Anhang-Upload:', error.message); continue }
      stored.push({ name: atts[i].name, url: `${Deno.env.get('SUPABASE_URL')}/storage/v1/object/public/mail-attachments/${path}`, path })
    } catch (e) { console.warn('[imap-poll] Anhang:', e) }
  }
  await supabase.from('partner_mails').insert({
    uid, from_addr: addr, from_domain: addr.split('@')[1]?.toLowerCase() ?? '', developer_id: devId,
    subject: subject.slice(0, 300), body: (extractPlain(raw) || '').slice(0, 4000), attachments: stored,
  })
  return true
}

// Lead per Absenderadresse finden — primäre email ODER alt_emails (case-insensitiv,
// googlemail→gmail normalisiert). Ersetzt die alte RPC, die NUR die Primär-Mail prüfte
// (Rainer schrieb von rainer.wallmeyer@…, sein Lead trägt rw@… → fiel durch).
// deno-lint-ignore no-explicit-any
async function findLead(supabase: any, rawAddr: string): Promise<string | null> {
  const norm = (x: string | null | undefined) => (x ?? '').toLowerCase().trim().replace('googlemail.com', 'gmail.com')
  const e = norm(rawAddr)
  if (!e.includes('@')) return null
  const { data } = await supabase.from('leads')
    .select('id, email, alt_emails, created_at')
    .or(`email.ilike.${e},alt_emails.cs.{${e}}`)
    .order('created_at', { ascending: false }).limit(10)
  for (const l of (data ?? []) as Array<{ id: string; email: string | null; alt_emails: string[] | null }>) {
    if (norm(l.email) === e) return l.id
    if ((l.alt_emails ?? []).some(a => norm(a) === e)) return l.id
  }
  return null
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const imap = new Imap()
  const reqBody = await req.json().catch(() => ({} as Record<string, unknown>))
  const mode = (reqBody.mode as string) || 'poll'
  const result = { scanned: 0, tasks: 0, leads: 0, skipped: 0, errors: [] as string[] }
  try {
    await imap.connect()
    const li = await imap.login(Deno.env.get('IMAP_USER') ?? '', Deno.env.get('IMAP_PASS') ?? '')
    if (!/OK/m.test(li)) return json({ error: 'IMAP-Login fehlgeschlagen' }, 500)
    const sel = await imap.cmd('SELECT INBOX')

    // ── Diagnose: welches Postfach, wie viele Mails, letzte Absender/Betreffe ──
    // Kein Import — nur zum Prüfen, ob IMAP_USER wirklich info@ ist und was drin liegt.
    if (mode === 'diagnose') {
      const exists = Number(sel.match(/\*\s+(\d+)\s+EXISTS/i)?.[1] ?? 0)
      const sr = await imap.cmd(`UID SEARCH SINCE ${imapSince(90)}`)
      const dUids = (sr.match(/\* SEARCH([0-9 ]*)/i)?.[1] || '').trim().split(/\s+/).filter(Boolean)
        .sort((a, b) => Number(b) - Number(a)).slice(0, 25)
      const recent: Array<{ uid: string; from: string; subject: string; date: string }> = []
      for (const uid of dUids) {
        const f = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])`)
        recent.push({ uid, from: fromAddress(f), subject: decodeMimeWords(header(f, 'Subject')).slice(0, 90), date: header(f, 'Date') })
      }
      await imap.logout()
      return json({ ok: true, mailbox: (Deno.env.get('IMAP_USER') ?? '').trim(), total_in_inbox: exists, since90d: dUids.length, recent })
    }

    // ── Backfill: Backlog importieren. Weiteres Zeitfenster, IGNORIERT die
    // task_mail_processed-Sperre (die „verbrennt" übersprungene Mails), dedupt aber
    // gegen bereits vorhandene Activities (lead_id + Betreff) → keine Doubletten.
    // Task-Token-Mails bleiben dem normalen Poll überlassen.
    if (mode === 'backfill') {
      const days = Math.min(400, Number(reqBody.days) || 60)
      const limit = Math.min(400, Number(reqBody.limit) || 250)
      const own = (Deno.env.get('IMAP_USER') ?? '').trim().toLowerCase()
      const sr = await imap.cmd(`UID SEARCH SINCE ${imapSince(days)}`)
      const bUids = (sr.match(/\* SEARCH([0-9 ]*)/i)?.[1] || '').trim().split(/\s+/).filter(Boolean)
        .sort((a, b) => Number(b) - Number(a)).slice(0, limit)
      const bf = { scanned: bUids.length, imported: 0, dup: 0, nolead: 0, own: 0, token: 0 }
      const detail: Array<{ from: string; subject: string }> = []
      for (const uid of bUids) {
        try {
          const fetched = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[])`)
          const subj = decodeMimeWords(header(fetched, 'Subject'))
          if (/\[#[a-f0-9]{8,20}\]/i.test(subj)) { bf.token++; continue }
          const addr = fromAddress(fetched)
          if (!addr || addr === own || /(^|@)(no-?reply|mailer-daemon|postmaster)\b/.test(addr)) { bf.own++; continue }
          const leadId = await findLead(supabase, addr)
          if (!leadId) { bf.nolead++; continue }
          const activitySubject = subj ? `Antwort: ${subj.slice(0, 160)}` : 'E-Mail erhalten'
          const { data: exists } = await supabase.from('activities').select('id')
            .eq('lead_id', leadId).eq('type', 'email').eq('direction', 'inbound').eq('subject', activitySubject).limit(1)
          if (exists && exists.length) { bf.dup++; continue }
          const bodyText = (extractPlain(fetched) || '(leere Nachricht)').slice(0, 4000)
          await supabase.from('activities').insert({
            lead_id: leadId, type: 'email', direction: 'inbound',
            subject: activitySubject, content: bodyText, completed_at: new Date().toISOString(), auto: false,
          })
          bf.imported++; detail.push({ from: addr, subject: subj.slice(0, 60) })
        } catch (e) { result.errors.push(e instanceof Error ? e.message : String(e)) }
      }
      await imap.logout()
      return json({ ok: true, mode: 'backfill', ...bf, detail })
    }

    // ── Devscan: NUR Developer-Mails der letzten N Tage einsammeln (idempotent
    // über partner_mails.uid — ignoriert die task_mail_processed-Sperre).
    if (mode === 'devscan') {
      const days = Math.min(120, Number(reqBody.days) || 30)
      const devs = await devDomains(supabase)
      const sr = await imap.cmd(`UID SEARCH SINCE ${imapSince(days)}`)
      const dUids = (sr.match(/\* SEARCH([0-9 ]*)/i)?.[1] || '').trim().split(/\s+/).filter(Boolean)
        .sort((a, b) => Number(b) - Number(a)).slice(0, 200)
      const ds = { scanned: dUids.length, dev: 0, domains: Array.from(devs.keys()) }
      for (const uid of dUids) {
        try {
          const fetched = await imap.cmd(`UID FETCH ${uid} (BODY.PEEK[])`)
          const addr = fromAddress(fetched)
          if (!addr) continue
          const dom = addr.split('@')[1]?.toLowerCase() ?? ''
          if (!devs.has(dom)) continue
          if (await storeDevMail(supabase, uid, fetched, addr, decodeMimeWords(header(fetched, 'Subject')), devs.get(dom) ?? null)) ds.dev++
        } catch (e) { result.errors.push(e instanceof Error ? e.message : String(e)) }
      }
      await imap.logout()
      return json({ ok: true, mode: 'devscan', ...ds })
    }

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

    let devCache: Map<string, string | null> | null = null
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
        const leadId = await findLead(supabase, addr)
        if (!leadId) {
          // Developer-Mail? Absender-Domain gegen die Bauträger-Kontakte prüfen.
          const dom = addr.split('@')[1]?.toLowerCase() ?? ''
          if (!devCache) devCache = await devDomains(supabase)
          if (dom && devCache.has(dom)) {
            if (await storeDevMail(supabase, uid, fetched, addr, subject, devCache.get(dom) ?? null)) result.tasks += 0, (result as unknown as { dev?: number }).dev = ((result as unknown as { dev?: number }).dev ?? 0) + 1
            continue
          }
          result.skipped++; continue   // Fremd-Mail (Newsletter, Bank, …) → ignorieren
        }
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
