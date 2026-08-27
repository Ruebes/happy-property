#!/usr/bin/env node
// Wendet EINE Migrationsdatei via Supabase Management API an (Muster: setup-db.mjs).
// Aufruf: node scripts/apply-migration.mjs supabase/migrations/<datei>.sql
import { readFileSync } from 'fs'

function loadEnv() {
  const env = {}
  const lines = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
  for (const line of lines) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim()
  }
  return env
}

const env = loadEnv()
const PROJECT_REF = new URL(env.VITE_SUPABASE_URL).hostname.split('.')[0]
const file = process.argv[2]
if (!file) { console.error('Migrationsdatei fehlt'); process.exit(1) }
const sql = readFileSync(file, 'utf8')

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: sql }),
})
const body = await res.text()
if (!res.ok) { console.error('❌', res.status, body.slice(0, 500)); process.exit(1) }
console.log('✅ Migration angewendet:', file)
if (body && body !== '[]') console.log(body.slice(0, 20000))
