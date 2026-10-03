// meta-builder: alles, was einen SEITEN-Token braucht (Sofortformulare).
//
// leadgen_forms lesen und anlegen verlangt einen Page Access Token. Den holt der
// System-User-Token über /me/accounts (Muster aus meta-leads-sync, gemessen
// 23.8.26: mit dem System-Token direkt kommt „(#190) This method must be called
// with a Page Access Token“). Der Seiten-Token bleibt nur im Speicher: nie in
// Logs, nie in Antworten, nie in URLs (immer Authorization-Header).

import { GRAPH, graphAll, metaErrorFromBody, MetaApiError, metaWritesDisabled } from '../_shared/metaGraph.ts'
import { lintHasBlockers, lintText, type LintIssue } from '../_shared/metaLint.ts'
import type { LeadformCreateRequest, LeadformCreateResponse, LeadFormQuestion, LeadFormSpec } from '../_shared/metaSpec.ts'
import {
  arr, BuilderError, forbiddenNames, logWrite, metaId, obj, str, type Ctx, type Raw,
} from './common.ts'

/** Seiten-Token für pageId (oder null, wenn die Seite nicht am System-User hängt). */
export async function pageAccessToken(pageId: string): Promise<string | null> {
  const list = await graphAll<{ id?: string; access_token?: string }>('me/accounts', { fields: 'id,access_token', limit: 100 }, { maxPages: 3 })
  const own = list.find(p => str(p.id) === pageId)
  return own?.access_token ? String(own.access_token) : null
}

async function pageFetch<T>(method: 'GET' | 'POST', path: string, pageToken: string, params: Raw, timeoutMs: number): Promise<T> {
  if (method === 'POST' && metaWritesDisabled()) {
    throw new MetaApiError({ status: 0, kind: 'permission', userMsg: 'META_WRITES_DISABLED', message: 'Schreibzugriffe an Meta sind per META_WRITES_DISABLED gesperrt' })
  }
  const clean = path.replace(/^\/+/, '')
  if (!/^[0-9]{6,25}\/[a-z_]+$/.test(clean)) throw new MetaApiError({ status: 0, kind: 'validation', message: 'Ungültiger Seiten-Pfad' })
  let url = `${GRAPH}/${clean}`
  let body: string | undefined
  if (method === 'GET') {
    const q = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || /^access_token$/i.test(k)) continue
      q.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
    }
    const qs = q.toString()
    if (qs) url += `?${qs}`
  } else {
    body = JSON.stringify(params)
  }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res: Response
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${pageToken}` }
    if (body) headers['Content-Type'] = 'application/json'
    res = await fetch(url, { method, headers, body, signal: ctrl.signal })
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    // bewusst ohne err.message (könnte die URL enthalten)
    throw new MetaApiError({ status: 0, kind: 'transient', message: aborted ? `Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s` : 'Netzwerkfehler beim Seiten-Aufruf' })
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text.slice(0, 200) } }
  if (!res.ok || obj(json).error) throw metaErrorFromBody(res.status, json, `HTTP ${res.status}`)
  return json as T
}

export interface LeadFormInfo { id: string; name: string; status?: string; locale?: string; page_id?: string }

/** Sofortformulare der Seite (tolerant: Fehler -> leere Liste + Warnung). */
export async function listLeadForms(pageId: string, warnings: string[]): Promise<LeadFormInfo[]> {
  try {
    const token = await pageAccessToken(pageId)
    if (!token) {
      warnings.push('Sofortformulare: kein Seiten-Token (Seite hängt nicht am System-User oder Recht pages_show_list fehlt).')
      return []
    }
    const j = await pageFetch<{ data?: Raw[] }>('GET', `${pageId}/leadgen_forms`, token, { fields: 'id,name,status,locale', limit: 100 }, 25_000)
    return arr<Raw>(j?.data).map(f => ({
      id: str(f.id), name: str(f.name),
      ...(str(f.status) ? { status: str(f.status) } : {}),
      ...(str(f.locale) ? { locale: str(f.locale) } : {}),
      page_id: pageId,
    })).filter(f => f.id)
  } catch (err) {
    const m = err instanceof MetaApiError ? (err.userMsg || err.message) : 'unbekannter Fehler'
    warnings.push(`Sofortformulare nicht lesbar: ${m.slice(0, 160)}`)
    return []
  }
}

// ── leadform_create ──────────────────────────────────────────────────────────

const QUESTION_TYPES: readonly LeadFormQuestion['type'][] = ['FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'EMAIL', 'PHONE', 'CITY', 'COUNTRY', 'CUSTOM']

function cleanText(v: unknown, max: number): string {
  return str(v).replace(/\s+/g, ' ').trim().slice(0, max)
}

export async function modeLeadformCreate(ctx: Ctx, req: LeadformCreateRequest): Promise<LeadformCreateResponse> {
  const st = await ctx.settings()
  const pageId = metaId(req.page_id ?? st.default_page_id ?? ctx.env.pageId, 'page_id')
  const spec = obj(req.spec) as unknown as LeadFormSpec
  const name = cleanText(spec.name, 200)
  if (!name) throw new BuilderError(400, 'invalid_request', 'Das Formular braucht einen Namen.')
  const privacy = str(spec.privacy_policy_url).trim()
  if (!/^https:\/\/[^\s/?#]+\.[^\s]+$/i.test(privacy)) {
    throw new BuilderError(400, 'invalid_request', 'Datenschutz-Link fehlt oder ist kein https-Link.', 'Zum Beispiel https://happy-property.de/datenschutz')
  }
  const questionsIn = arr<LeadFormQuestion>(spec.questions)
  if (!questionsIn.length) throw new BuilderError(400, 'invalid_request', 'Das Formular braucht mindestens eine Frage.')
  if (questionsIn.length > 15) throw new BuilderError(400, 'invalid_request', 'Höchstens 15 Fragen je Formular.')

  // Kundensichtbare Texte: gleiche Regeln wie Anzeigen (Gedankenstriche, Umlaute, Versprechen, Projektnamen)
  const lctx = { forbiddenNames: await forbiddenNames(ctx.sb) }
  const lint: LintIssue[] = []
  const check = (text: string, field: string) => { if (text) lint.push(...lintText(text, field, lctx, 'leadform')) }

  const questions: Raw[] = []
  const keys = new Set<string>()
  for (const [i, q] of questionsIn.entries()) {
    const type = str(q?.type) as LeadFormQuestion['type']
    if ((QUESTION_TYPES as readonly string[]).indexOf(type) < 0) throw new BuilderError(400, 'invalid_request', `Frage ${i + 1}: unbekannter Typ "${type}".`)
    if (type !== 'CUSTOM') { questions.push({ type }); continue }
    const label = cleanText(q.label, 200)
    const key = cleanText(q.key, 60).replace(/[^A-Za-z0-9_]/g, '_') || `frage_${i + 1}`
    if (!label) throw new BuilderError(400, 'invalid_request', `Frage ${i + 1}: Text fehlt.`)
    if (keys.has(key)) throw new BuilderError(400, 'invalid_request', `Frage ${i + 1}: Schlüssel "${key}" doppelt.`)
    keys.add(key)
    check(label, 'leadform.questions')
    const item: Raw = { type: 'CUSTOM', key, label }
    const opts = arr<{ value?: string; key?: string }>(q.options)
    if (opts.length) {
      item.options = opts.map((o, j) => {
        const value = cleanText(o?.value, 100)
        if (!value) throw new BuilderError(400, 'invalid_request', `Frage ${i + 1}, Antwort ${j + 1}: Text fehlt.`)
        check(value, 'leadform.questions')
        return { value, key: (cleanText(o?.key, 60).replace(/[^A-Za-z0-9_]/g, '_') || `a${j + 1}`) }
      })
    }
    questions.push(item)
  }

  const introHead = cleanText(spec.intro_headline, 60)
  const introText = cleanText(spec.intro_text, 600)
  const tyTitle = cleanText(spec.thank_you_title, 60) || 'Danke!'
  const tyBody = cleanText(spec.thank_you_body, 600)
  const tyUrl = str(spec.thank_you_url).trim()
  const linkText = cleanText(spec.privacy_link_text, 70) || 'Datenschutzerklärung'
  for (const [t, f] of [[name, 'leadform.name'], [introHead, 'leadform.intro'], [introText, 'leadform.intro'], [tyTitle, 'leadform.thank_you'], [tyBody, 'leadform.thank_you'], [linkText, 'leadform.privacy']] as const) check(t, f)
  if (tyUrl && !/^https:\/\/[^\s/?#]+\.[^\s]+$/i.test(tyUrl)) throw new BuilderError(400, 'invalid_request', 'Der Link auf der Danke-Seite muss mit https:// beginnen.')
  if (lintHasBlockers(lint)) {
    throw new BuilderError(422, 'lint_blocked', 'Das Formular verstößt gegen eine harte Text-Regel.', 'Gedankenstriche, ae/oe/ue, Versprechen und Projektnamen entfernen.', lint.filter(x => x.severity === 'blocker'))
  }

  const body: Raw = {
    name,
    locale: spec.locale === 'en_US' ? 'EN_US' : 'DE_DE',
    privacy_policy: { url: privacy, link_text: linkText },
    questions,
    // „Höhere Absicht“: Überprüfungsschritt vor dem Absenden (HP-Standard an)
    is_optimized_for_quality: spec.higher_intent !== false,
    block_display_for_non_targeted_viewer: true,
    thank_you_page: {
      title: tyTitle,
      ...(tyBody ? { body: tyBody } : {}),
      button_type: tyUrl ? 'VIEW_WEBSITE' : 'NONE',
      ...(tyUrl ? { website_url: tyUrl, button_text: 'Zur Website' } : {}),
    },
  }
  if (introHead || introText) {
    body.context_card = { title: introHead || name, style: 'PARAGRAPH_STYLE', content: introText ? [introText] : [] }
  }
  if (tyUrl) body.follow_up_action_url = tyUrl

  const token = await pageAccessToken(pageId)
  if (!token) {
    throw new BuilderError(403, 'forbidden', 'Für diese Seite gibt es keinen Seiten-Token.',
      'Die Seite muss im Business Manager dem System-User zugewiesen sein (Recht pages_manage_ads, pages_show_list).')
  }
  const path = `${pageId}/leadgen_forms`
  try {
    const res = await pageFetch<Raw>('POST', path, token, body, 30_000)
    const formId = str(res.id)
    await logWrite(ctx, { level: 'leadform', path, entityId: formId || null, request: body, after: res })
    if (!formId) throw new BuilderError(502, 'meta_error', 'Meta hat keine Formular-ID zurückgegeben.')
    return { form_id: formId }
  } catch (err) {
    if (err instanceof MetaApiError) await logWrite(ctx, { level: 'leadform', path, request: body, err })
    throw err
  }
}
