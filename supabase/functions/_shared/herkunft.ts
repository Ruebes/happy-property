// Herkunft einer Anmeldung (Newsletter, Immobilienguide, Masterclass, /anmelden):
// Über welchen Kanal kam der Mensch? Sven will sehen, ob z. B. der Newsletter-Link
// in den YouTube-Videos Anmeldungen bringt (13.10.2026).
//
// Das Formular schickt `herkunft` mit: Link-Parameter der Seite (src, utm_*),
// document.referrer, Seite und die IDs des Web-Trackings (wa-track: Sitzung
// `_hpwa_s` aus sessionStorage, Gerät `_hpwa_v` aus localStorage).
//
// Reihenfolge (erste Quelle, die etwas weiß, gewinnt):
//   1. link             ?src= / ?utm_source= auf der Formularseite
//   2. besuch           wa-track-Sitzung: Herkunft beim Betreten der Website
//                       (Besucher kam über YouTube auf die Startseite und klickte
//                       sich dann zum Formular — der Seiten-Referrer wäre dann intern)
//   3. frueherer_besuch jüngster Besuch desselben Geräts mit externer Herkunft (30 Tage)
//   4. referrer         Referrer der Formularseite
//   sonst               kanal 'direkt'
//
// Gespeichert in newsletter_subscribers.properties:
//   herkunft      = erste Herkunft (wird nie überschrieben)
//   herkunft_log  = je Anmeldung { liste_id, liste, kanal, via, at, bestaetigt? } (max. 10)
// ACHTUNG: properties.channel ist der ZUSTELL-Kanal (email/whatsapp/both), nicht die Herkunft.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export interface HerkunftInput {
  src?: unknown; utm_source?: unknown; utm_medium?: unknown; utm_campaign?: unknown; utm_content?: unknown
  referrer?: unknown; page?: unknown; sid?: unknown; vid?: unknown
}

export interface Herkunft {
  kanal: string
  via: 'link' | 'besuch' | 'frueherer_besuch' | 'referrer' | 'unbekannt'
  utm?: Record<string, string>
  referrer?: string | null
  page?: string | null
  at: string
}

export interface HerkunftLogEintrag {
  liste_id: string | null; liste: string; kanal: string; via: Herkunft['via']; at: string; bestaetigt?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const str = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max)
const slug = (v: unknown) => str(v, 60).toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9._-]/g, '').slice(0, 40)

// Kurzformen aus Links und Werbeplattformen ({{site_source_name}} bei Meta liefert fb/ig/an/msg).
const ALIAS: Record<string, string> = {
  yt: 'youtube', 'youtube.com': 'youtube',
  ig: 'instagram', insta: 'instagram', 'instagram.com': 'instagram',
  fb: 'facebook', an: 'facebook', msg: 'facebook', 'facebook.com': 'facebook',
  li: 'linkedin', 'linkedin.com': 'linkedin', tt: 'tiktok', 'tiktok.com': 'tiktok',
  gads: 'google', adwords: 'google', 'google-ads': 'google', 'google.com': 'google',
  klaviyo: 'newsletter', wa: 'whatsapp',
  // ChatGPT hängt an Links von selbst utm_source=chatgpt.com an.
  'chatgpt.com': 'ki', chatgpt: 'ki', perplexity: 'ki', 'perplexity.ai': 'ki', 'claude.ai': 'ki', 'copilot.com': 'ki',
}
const kanalAusParam = (v: unknown): string => { const s = slug(v); return ALIAS[s] ?? s }

// Eigene Websites: Wechsel zwischen ihnen ist „Eigene Website", innerhalb derselben Seite intern.
const EIGENE = /(^|\.)(happy-property\.com|happy-property\.de|steuervorteil-zypern-immobilien\.com|vjlwgajmtqlwjjreowbu\.supabase\.co)$/

const REFERRER_REGELN: Array<[RegExp, string]> = [
  [/(^|\.)youtube\.com$|^youtu\.be$|com\.google\.android\.youtube/, 'youtube'],
  [/(^|\.)instagram\.com$|com\.instagram\.android/, 'instagram'],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me|messenger\.com)$|com\.facebook\./, 'facebook'],
  [/(^|\.)(linkedin\.com|lnkd\.in)$|com\.linkedin\.android/, 'linkedin'],
  [/(^|\.)tiktok\.com$|com\.zhiliaoapp|musical\.ly/, 'tiktok'],
  [/(^|\.)(t\.co|x\.com|twitter\.com)$/, 'x'],
  [/(^|\.)(whatsapp\.com|wa\.me)$|com\.whatsapp/, 'whatsapp'],
  // KI und Webmail VOR Google prüfen (gemini.google.com, mail.google.com, Gmail-App).
  [/(^|\.)(chatgpt\.com|openai\.com|perplexity\.ai|claude\.ai|gemini\.google\.com|copilot\.microsoft\.com)$/, 'ki'],
  [/^mail\.google\.com$|com\.google\.android\.gm$|^outlook\.(live|office|office365)\.com$|(^|\.)(web\.de|gmx\.(de|net|at|ch|com)|t-online\.de|mail\.yahoo\.com|freenet\.de|icloud\.com)$/, 'email'],
  [/(^|\.)google\.[a-z.]{2,8}$|googlequicksearchbox/, 'google'],
  [/(^|\.)(bing\.com|duckduckgo\.com|ecosia\.org|qwant\.com|startpage\.com|search\.brave\.com|yahoo\.com|yandex\.[a-z]+)$/, 'suche'],
]

const hostVon = (u: string): string => {
  try { return new URL(u.includes('://') ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}

// Referrer → Kanal. null = kein Referrer oder Klick innerhalb derselben Website (sagt nichts).
export function kanalAusReferrer(referrer: unknown, seitenHost: string): string | null {
  const host = hostVon(str(referrer, 500))
  if (!host) return null
  if (seitenHost && host === seitenHost.replace(/^www\./, '')) return null
  for (const [re, kanal] of REFERRER_REGELN) if (re.test(host)) return kanal
  if (EIGENE.test(host)) return 'website'
  return host.slice(0, 40)
}

type SitzungsZeile = { referrer: string | null; utm: Record<string, string> | null; site: string | null }

function ausSitzung(s: SitzungsZeile): string | null {
  const p = kanalAusParam(s.utm?.src) || kanalAusParam(s.utm?.utm_source)
  if (p) return p
  return kanalAusReferrer(s.referrer, s.site ?? '')
}

export async function ermittleHerkunft(sb: SupabaseClient, raw: unknown): Promise<Herkunft> {
  const at = new Date().toISOString()
  const input = (raw && typeof raw === 'object' ? raw : {}) as HerkunftInput
  const page = str(input.page, 300) || null
  const seitenHost = page ? hostVon(page) : ''
  const referrer = str(input.referrer, 300) || null
  const utm: Record<string, string> = {}
  for (const k of ['src', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content'] as const) {
    const v = str(input[k], 100)
    if (v) utm[k] = v
  }
  const basis = { utm: Object.keys(utm).length ? utm : undefined, referrer, page, at }

  // 1. Link-Parameter auf der Formularseite
  const ausLink = kanalAusParam(utm.src) || kanalAusParam(utm.utm_source)
  if (ausLink) return { kanal: ausLink, via: 'link', ...basis }

  // 2./3. Web-Tracking. Fehler hier dürfen die Anmeldung nie verhindern.
  try {
    const sid = str(input.sid, 40)
    if (UUID_RE.test(sid)) {
      const { data } = await sb.from('web_sessions').select('referrer, utm, site').eq('id', sid).maybeSingle()
      const k = data ? ausSitzung(data as SitzungsZeile) : null
      if (k) return { kanal: k, via: 'besuch', ...basis }
    }
    const vid = str(input.vid, 64)
    if (/^[0-9a-z-]{8,64}$/i.test(vid)) {
      const seit = new Date(Date.now() - 30 * 86400_000).toISOString()
      const { data } = await sb.from('web_sessions').select('referrer, utm, site')
        .eq('visitor_id', vid).gte('started_at', seit).order('started_at', { ascending: false }).limit(20)
      for (const s of (data ?? []) as SitzungsZeile[]) {
        const k = ausSitzung(s)
        if (k) return { kanal: k, via: 'frueherer_besuch', ...basis }
      }
    }
  } catch (e) { console.warn('[herkunft] web_sessions:', e) }

  // 4. Referrer der Formularseite
  const ausRef = kanalAusReferrer(referrer, seitenHost)
  if (ausRef) return { kanal: ausRef, via: 'referrer', ...basis }
  return { kanal: 'direkt', via: 'unbekannt', ...basis }
}

// Herkunft an die Abonnenten-Properties hängen: erste Herkunft bleibt, jede Anmeldung kommt ins Log.
export function mitHerkunft(
  props: Record<string, unknown>, h: Herkunft, liste: { id: string | null; name: string }, sofortBestaetigt = false,
): Record<string, unknown> {
  const log = (Array.isArray(props.herkunft_log) ? props.herkunft_log : []) as HerkunftLogEintrag[]
  const eintrag: HerkunftLogEintrag = { liste_id: liste.id, liste: liste.name, kanal: h.kanal, via: h.via, at: h.at }
  if (sofortBestaetigt) eintrag.bestaetigt = h.at
  return { ...props, herkunft: props.herkunft ?? h, herkunft_log: [...log, eintrag].slice(-10) }
}

// Beim DOI-Klick: offene Anmeldung zu dieser Liste als bestätigt markieren.
export function herkunftBestaetigt(props: Record<string, unknown>, listeId: string): Record<string, unknown> {
  if (!Array.isArray(props.herkunft_log)) return props
  const at = new Date().toISOString()
  return { ...props, herkunft_log: (props.herkunft_log as HerkunftLogEintrag[]).map(e => e.liste_id === listeId && !e.bestaetigt ? { ...e, bestaetigt: at } : e) }
}
