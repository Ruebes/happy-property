// Anthropic-Aufrufe mit Retry, exponentiellem Backoff und Jitter.
//
// Vorher rief jede Edge Function die API selbst auf. generate-deck hatte dabei
// `for (let attempt = 0; attempt < 1 ...)` — also genau EINEN Versuch: ein 429
// oder 529 bedeutete „kein Deck", ohne Fehlerspur. Das Muster hier ist aus
// supabase/functions/studio/index.ts übernommen (Modell-Fallback-Kette) und um
// echten Backoff ergänzt.
//
// ACHTUNG (CLAUDE.md Regel 8): Änderungen wirken erst nach Redeploy JEDER
// importierenden Function.

const API = 'https://api.anthropic.com/v1/messages'

/** Fehler, bei denen ein erneuter Versuch sinnvoll ist. */
const TRANSIENT = /overloaded|rate.?limit|429|529|500|502|503|504|timeout|ECONNRESET|socket/i
/** Fehler, bei denen ein Modellwechsel hilft (Modell existiert nicht/kein Zugriff). */
const MODEL_GONE = /model|not_found|404/i

export interface AnthropicCall {
  model: string
  /** Ersatzmodelle, falls `model` nicht erreichbar ist. */
  fallbackModels?: string[]
  max_tokens: number
  system?: string
  messages: unknown[]
  tools?: unknown[]
  tool_choice?: unknown
  /** Zusätzliche Header, z.B. { 'anthropic-beta': 'pdfs-2024-09-25' }. */
  beta?: string
  /** Versuche je Modell (Standard 3). */
  attempts?: number
  /** Kennzeichnung für die Logzeile. */
  label?: string
}

export interface AnthropicResult {
  ok: boolean
  /** Rohe content-Liste der Antwort. */
  content: Array<Record<string, unknown>>
  stop_reason?: string
  model?: string
  attempts: number
  error?: string
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** Exponentiell mit Vollbereich-Jitter: 1s, 2s, 4s … gedeckelt bei 20s. */
function backoffMs(attempt: number): number {
  const base = Math.min(20000, 1000 * Math.pow(2, attempt))
  return Math.round(base * (0.5 + Math.random() * 0.5))
}

export async function callAnthropic(apiKey: string, call: AnthropicCall): Promise<AnthropicResult> {
  if (!apiKey) return { ok: false, content: [], attempts: 0, error: 'ANTHROPIC_API_KEY fehlt' }

  const models = [call.model, ...(call.fallbackModels ?? [])]
  const perModel = Math.max(1, call.attempts ?? 3)
  const tag = call.label ? `[anthropic:${call.label}]` : '[anthropic]'
  let total = 0
  let lastErr = 'unbekannt'

  for (const model of models) {
    for (let attempt = 0; attempt < perModel; attempt++) {
      total++
      try {
        const headers: Record<string, string> = {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        }
        if (call.beta) headers['anthropic-beta'] = call.beta

        const body: Record<string, unknown> = {
          model, max_tokens: call.max_tokens, messages: call.messages,
        }
        if (call.system) body.system = call.system
        if (call.tools) body.tools = call.tools
        if (call.tool_choice) body.tool_choice = call.tool_choice

        const res = await fetch(API, { method: 'POST', headers, body: JSON.stringify(body) })

        if (res.ok) {
          const data = await res.json() as { content?: Array<Record<string, unknown>>; stop_reason?: string }
          return { ok: true, content: data.content ?? [], stop_reason: data.stop_reason, model, attempts: total }
        }

        const txt = (await res.text()).slice(0, 400)
        lastErr = `HTTP ${res.status}: ${txt}`
        // Modell nicht verfügbar → sofort das nächste Modell probieren.
        if (res.status === 404 || MODEL_GONE.test(txt)) { console.warn(`${tag} ${model} nicht verfügbar, wechsle`); break }
        // Dauerhafte Fehler (400 ungültiger Request, 401 Key) — Retry hilft nicht.
        if (!TRANSIENT.test(String(res.status)) && !TRANSIENT.test(txt)) {
          console.error(`${tag} dauerhafter Fehler: ${lastErr}`)
          return { ok: false, content: [], attempts: total, error: lastErr }
        }
        if (attempt < perModel - 1) {
          const wait = backoffMs(attempt)
          console.warn(`${tag} ${lastErr} — Versuch ${attempt + 2}/${perModel} in ${wait} ms`)
          await sleep(wait)
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        if (!TRANSIENT.test(lastErr)) return { ok: false, content: [], attempts: total, error: lastErr }
        if (attempt < perModel - 1) await sleep(backoffMs(attempt))
      }
    }
  }
  console.error(`${tag} endgültig fehlgeschlagen nach ${total} Versuchen: ${lastErr}`)
  return { ok: false, content: [], attempts: total, error: lastErr }
}

/** Das Eingabeobjekt des erzwungenen Tools aus einer Antwort ziehen. */
export function toolInput<T = Record<string, unknown>>(res: AnthropicResult): T | null {
  const tu = res.content.find(c => c.type === 'tool_use') as { input?: unknown } | undefined
  return (tu?.input as T) ?? null
}

/** Reiner Text einer Antwort (für Aufrufe ohne Tool). */
export function textOf(res: AnthropicResult): string {
  return res.content.map(c => (typeof c.text === 'string' ? c.text : '')).join('\n').trim()
}
