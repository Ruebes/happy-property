// Gemeinsamer Routen-Leser für scripts/verify-nav.mjs und
// scripts/verify-entity-links.mjs: liest src/App.tsx mit der
// TypeScript-Compiler-API und liefert jede <Route path="..."> samt dem wirksamen
// Guard (Schnittmenge aller umschließenden <ProtectedRoute>).
//
// Bewusst ohne eigene Ausgabe und ohne process.exit: Auffälligkeiten gehen über
// onProblem(check, msg) an das aufrufende Skript (check = Prüfnummer aus
// verify-nav: 1 Pfad, 2 Rollen, 3 Rechte).

import { readFileSync } from 'node:fs'
import ts from 'typescript'

export const ALL_ROLES = ['admin', 'verwalter', 'mitarbeiter', 'funnel', 'eigentuemer', 'feriengast']

export function parseAppRoutes(appFile, onProblem = () => {}) {
  const appText = readFileSync(appFile, 'utf8')
  const sf = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lineOf = node => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1

  function jsxAttrs(opening) {
    const map = new Map()
    for (const prop of opening.attributes.properties) {
      if (ts.isJsxAttribute(prop)) map.set(prop.name.getText(sf), prop.initializer ?? null)
    }
    return map
  }

  // "text" oder {'text'} oder {`text`} -> text, sonst null
  function literalString(init) {
    if (!init) return null
    if (ts.isStringLiteral(init)) return init.text
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text
    }
    return null
  }

  // {['a', 'b']} -> ['a', 'b'], sonst null
  function literalStringArray(init) {
    if (!init || !ts.isJsxExpression(init) || !init.expression) return null
    const e = init.expression
    if (!ts.isArrayLiteralExpression(e)) return null
    const out = []
    for (const el of e.elements) {
      if (!ts.isStringLiteral(el) && !ts.isNoSubstitutionTemplateLiteral(el)) return null
      out.push(el.text)
    }
    return out
  }

  // element={<Tag .../>} -> { tag, attrs }
  function elementOf(init) {
    if (!init || !ts.isJsxExpression(init) || !init.expression) return null
    const e = init.expression
    if (ts.isJsxSelfClosingElement(e)) return { tag: e.tagName.getText(sf), attrs: jsxAttrs(e) }
    if (ts.isJsxElement(e)) return { tag: e.openingElement.tagName.getText(sf), attrs: jsxAttrs(e.openingElement) }
    return null
  }

  const routes = []   // { path, line, guards, inShell, elementTag, guard, kind }
  let shellRouteCount = 0

  function enterRoute(opening, ctx, line) {
    const attrs = jsxAttrs(opening)
    const el = elementOf(attrs.get('element'))
    let next = ctx
    if (el?.tag === 'ProtectedRoute') {
      const hasRoles = el.attrs.has('allowedRoles')
      const allowedRoles = hasRoles ? literalStringArray(el.attrs.get('allowedRoles')) : null
      if (hasRoles && !allowedRoles) onProblem(2, `App.tsx Zeile ${line}: allowedRoles ist kein wörtliches String-Array, Guard nicht prüfbar`)
      for (const r of allowedRoles ?? []) if (!ALL_ROLES.includes(r)) onProblem(2, `App.tsx Zeile ${line}: unbekannte Rolle "${r}" in allowedRoles`)
      const permission = el.attrs.has('permission') ? literalString(el.attrs.get('permission')) : undefined
      if (el.attrs.has('permission') && !permission) onProblem(3, `App.tsx Zeile ${line}: permission ist kein wörtlicher String`)
      const anyPermission = el.attrs.has('anyPermission') ? literalStringArray(el.attrs.get('anyPermission')) : undefined
      if (el.attrs.has('anyPermission') && !anyPermission) onProblem(3, `App.tsx Zeile ${line}: anyPermission ist kein wörtliches String-Array`)
      next = { ...ctx, guards: [...ctx.guards, { allowedRoles, permission: permission ?? undefined, anyPermission: anyPermission ?? undefined, line }] }
    } else if (el?.tag === 'ShellGate' || el?.tag === 'AppShell') {
      // ShellGate ist die Weiche vor der AppShell (src/components/ShellGate.tsx)
      shellRouteCount++
      next = { ...ctx, inShell: true }
    }
    if (attrs.has('path')) {
      const path = literalString(attrs.get('path'))
      if (path === null) onProblem(1, `App.tsx Zeile ${line}: path ist kein wörtlicher String`)
      else routes.push({ path, line, guards: next.guards, inShell: next.inShell, elementTag: el?.tag ?? null })
    }
    return next
  }

  function visit(node, ctx) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(sf) === 'Route') {
      const next = enterRoute(node.openingElement, ctx, lineOf(node))
      for (const child of node.children) visit(child, next)
      return
    }
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(sf) === 'Route') {
      enterRoute(node, ctx, lineOf(node))
      return
    }
    ts.forEachChild(node, child => visit(child, ctx))
  }
  visit(sf, { guards: [], inShell: false })

  // Wirksamer Guard einer Route = Schnittmenge aller umschließenden ProtectedRoutes
  function effectiveGuard(route) {
    let roles = null
    const permissions = new Set()
    let anyPermission
    for (const g of route.guards) {
      if (g.allowedRoles) roles = roles ? roles.filter(r => g.allowedRoles.includes(r)) : [...g.allowedRoles]
      if (g.permission) permissions.add(g.permission)
      if (g.anyPermission) {
        if (anyPermission) onProblem(3, `App.tsx Zeile ${route.line}: ${route.path} hat zwei verschachtelte anyPermission-Guards`)
        anyPermission = g.anyPermission
      }
    }
    if (permissions.size > 1) onProblem(3, `App.tsx Zeile ${route.line}: ${route.path} hat zwei verschiedene permission-Guards (${[...permissions].join(', ')})`)
    return { roles: roles ?? [...ALL_ROLES], permission: [...permissions][0], anyPermission }
  }

  for (const route of routes) {
    route.guard = effectiveGuard(route)
    const isDev = route.path.startsWith('/__dev')
    if (route.guards.length === 0 || isDev) route.kind = 'public'
    else if (route.guard.roles.length === 1 && route.guard.roles[0] === 'feriengast') route.kind = 'guest'
    else route.kind = 'guarded'
  }

  const routeByPath = new Map()
  for (const route of routes) {
    if (routeByPath.has(route.path)) {
      onProblem(1, `App.tsx: Pfad ${route.path} ist zweimal als Route eingetragen (Zeilen ${routeByPath.get(route.path).line} und ${route.line})`)
      continue
    }
    routeByPath.set(route.path, route)
  }

  return { appText, sf, lineOf, routes, routeByPath, shellRouteCount }
}

// Bildet ProtectedRoute nach: die Rolle muss erlaubt sein, Rechte zählen nur für
// Mitarbeiter. Öffentliche Routen gelten hier als nicht erlaubt (für Menü und
// Telefon-Leiste; verify-entity-links behandelt sie getrennt).
export function guardAllowsRoute(route, profile, hasPerm) {
  if (!route || route.kind === 'public') return false
  const g = route.guard
  if (!g.roles.includes(profile.role)) return false
  if (profile.role === 'mitarbeiter') {
    if (g.permission && !hasPerm(profile, g.permission)) return false
    if (g.anyPermission && !g.anyPermission.some(p => hasPerm(profile, p))) return false
  }
  return true
}

// Findet die Route zu einem konkreten Pfad ohne Query (z.B. /admin/crm/leads/abc).
// Feste Segmente müssen exakt passen, ":name" steht für genau ein nicht leeres
// Segment. Die Auffang-Route "*" zählt nicht. Bei mehreren Treffern gewinnt die
// Route mit den meisten festen Segmenten (wie im Router).
export function matchRoute(routes, pathname) {
  const parts = pathname.split('/').filter(Boolean)
  let best = null
  let bestScore = -1
  for (const route of routes) {
    if (route.path === '*') continue
    const pattern = route.path.split('/').filter(Boolean)
    if (pattern.length !== parts.length) continue
    let score = 0
    let ok = true
    for (let i = 0; i < pattern.length; i++) {
      if (pattern[i].startsWith(':')) { if (!parts[i]) { ok = false; break } }
      else if (pattern[i] === parts[i]) score++
      else { ok = false; break }
    }
    if (ok && score > bestScore) { best = route; bestScore = score }
  }
  return best
}
