// ── Eigene Kennzahlen: kleiner Formel-Rechner (ohne eval) ────────────────────
// Erlaubt: Zahlen (Komma oder Punkt), Spaltennamen (z. B. ausgaben, termine),
// + - * / und Klammern. Teilen durch 0 oder fehlende Werte ergeben „-".
// Beispiel: ausgaben / (termine + stattgefunden)

export type FormelKnoten =
  | { t: 'zahl'; v: number }
  | { t: 'name'; v: string }
  | { t: 'neg'; a: FormelKnoten }
  | { t: 'op'; op: '+' | '-' | '*' | '/'; a: FormelKnoten; b: FormelKnoten }

type Token = { t: 'zahl'; v: number } | { t: 'name'; v: string } | { t: 'sym'; v: string }

/** Fehler mit Code (Übersetzung im UI: crm.werbung.zentrale.formel.<code>, Platzhalter {{x}}) */
export interface FormelFehler { code: FormelFehlerCode; x?: string }
export type FormelFehlerCode = 'leer' | 'zuLang' | 'zahl' | 'zeichen' | 'unvollstaendig' | 'unbekannt' | 'klammer' | 'stelle' | 'ungueltig'

/** Deutsche Fallback-Texte der Fehlercodes */
export const FORMEL_FEHLER_TEXT: Record<FormelFehlerCode, { k: string; d: string }> = {
  leer: { k: 'crm.werbung.zentrale.formel.leer', d: 'Die Formel ist leer.' },
  zuLang: { k: 'crm.werbung.zentrale.formel.zuLang', d: 'Die Formel ist zu lang.' },
  zahl: { k: 'crm.werbung.zentrale.formel.zahl', d: 'Die Zahl „{{x}}" ist ungültig.' },
  zeichen: { k: 'crm.werbung.zentrale.formel.zeichen', d: 'Das Zeichen „{{x}}" ist in Formeln nicht erlaubt.' },
  unvollstaendig: { k: 'crm.werbung.zentrale.formel.unvollstaendig', d: 'Die Formel ist unvollständig.' },
  unbekannt: { k: 'crm.werbung.zentrale.formel.unbekannt', d: 'Unbekannte Kennzahl „{{x}}".' },
  klammer: { k: 'crm.werbung.zentrale.formel.klammer', d: 'Eine Klammer wird nicht geschlossen.' },
  stelle: { k: 'crm.werbung.zentrale.formel.stelle', d: '„{{x}}" steht an der falschen Stelle.' },
  ungueltig: { k: 'crm.werbung.zentrale.formel.ungueltig', d: 'Die Formel ist ungültig.' },
}

export type FormelErgebnis = { ok: true; ast: FormelKnoten } | { ok: false; fehler: FormelFehler }

const NAME_START = /[A-Za-zÄÖÜäöüß_]/
const NAME_TEIL = /[A-Za-z0-9ÄÖÜäöüß_]/

function zerlege(text: string): Token[] | FormelFehler {
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue }
    if (/[0-9]/.test(c)) {
      let j = i
      while (j < text.length && /[0-9.,]/.test(text[j])) j++
      const roh = text.slice(i, j).replace(',', '.')
      const v = Number(roh)
      if (!Number.isFinite(v) || (roh.match(/\./g) ?? []).length > 1) return { code: 'zahl', x: text.slice(i, j) }
      out.push({ t: 'zahl', v })
      i = j
      continue
    }
    if (NAME_START.test(c)) {
      let j = i
      while (j < text.length && NAME_TEIL.test(text[j])) j++
      out.push({ t: 'name', v: text.slice(i, j).toLowerCase() })
      i = j
      continue
    }
    if ('+-*/()'.includes(c)) { out.push({ t: 'sym', v: c }); i++; continue }
    return { code: 'zeichen', x: c }
  }
  return out
}

/** Formel prüfen und in einen Baum übersetzen. erlaubt = gültige Spaltennamen. */
export function parseFormel(text: string, erlaubt: ReadonlySet<string>): FormelErgebnis {
  const roh = text.trim()
  if (!roh) return { ok: false, fehler: { code: 'leer' } }
  if (roh.length > 300) return { ok: false, fehler: { code: 'zuLang' } }
  const tokens = zerlege(roh)
  if (!Array.isArray(tokens)) return { ok: false, fehler: tokens }
  let pos = 0
  let fehler: FormelFehler | null = null
  const peek = (): Token | undefined => tokens[pos]
  const istSym = (v: string) => { const p = peek(); return p?.t === 'sym' && p.v === v }

  const faktor = (): FormelKnoten | null => {
    const p = peek()
    if (!p) { fehler = { code: 'unvollstaendig' }; return null }
    if (p.t === 'zahl') { pos++; return { t: 'zahl', v: p.v } }
    if (p.t === 'name') {
      pos++
      if (!erlaubt.has(p.v)) { fehler = { code: 'unbekannt', x: p.v }; return null }
      return { t: 'name', v: p.v }
    }
    if (p.v === '-') { pos++; const a = faktor(); return a ? { t: 'neg', a } : null }
    if (p.v === '(') {
      pos++
      const a = ausdruck()
      if (!a) return null
      if (!istSym(')')) { fehler = { code: 'klammer' }; return null }
      pos++
      return a
    }
    fehler = { code: 'stelle', x: p.v }
    return null
  }
  const term = (): FormelKnoten | null => {
    let a = faktor()
    while (a && (istSym('*') || istSym('/'))) {
      const op = (peek() as { v: string }).v as '*' | '/'
      pos++
      const b = faktor()
      if (!b) return null
      a = { t: 'op', op, a, b }
    }
    return a
  }
  const ausdruck = (): FormelKnoten | null => {
    let a = term()
    while (a && (istSym('+') || istSym('-'))) {
      const op = (peek() as { v: string }).v as '+' | '-'
      pos++
      const b = term()
      if (!b) return null
      a = { t: 'op', op, a, b }
    }
    return a
  }

  const ast = ausdruck()
  if (!ast) return { ok: false, fehler: fehler ?? { code: 'ungueltig' } }
  if (pos < tokens.length) {
    const p = tokens[pos]
    return { ok: false, fehler: { code: 'stelle', x: p.t === 'zahl' ? String(p.v) : p.v } }
  }
  return { ok: true, ast }
}

/** Formel ausrechnen. Fehlende Werte oder Teilen durch 0 ergeben null. */
export function berechneFormel(ast: FormelKnoten, wert: (name: string) => number | null): number | null {
  switch (ast.t) {
    case 'zahl': return ast.v
    case 'name': return wert(ast.v)
    case 'neg': { const a = berechneFormel(ast.a, wert); return a == null ? null : -a }
    case 'op': {
      const a = berechneFormel(ast.a, wert)
      const b = berechneFormel(ast.b, wert)
      if (a == null || b == null) return null
      if (ast.op === '+') return a + b
      if (ast.op === '-') return a - b
      if (ast.op === '*') return a * b
      if (b === 0) return null
      const r = a / b
      return Number.isFinite(r) ? r : null
    }
  }
}
