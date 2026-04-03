#!/usr/bin/env node
/**
 * Happy Property – Datenbank-Setup
 *
 * Benötigt in .env:
 *   SUPABASE_ACCESS_TOKEN     – Personal Access Token
 *                               https://supabase.com/dashboard/account/tokens
 *   SUPABASE_SERVICE_ROLE_KEY – Supabase Dashboard → Settings → API
 *
 * Ausführen:
 *   node scripts/setup-db.mjs
 */

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'

// ── .env laden ─────────────────────────────────────────────────
function loadEnv() {
  const env = {}
  try {
    const lines = readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim()
    }
  } catch {
    console.error('❌ .env nicht gefunden')
    process.exit(1)
  }
  return env
}

const env          = loadEnv()
const SUPABASE_URL = env.VITE_SUPABASE_URL
const SVC_KEY      = env.SUPABASE_SERVICE_ROLE_KEY
const PAT          = env.SUPABASE_ACCESS_TOKEN
const PROJECT_REF  = new URL(SUPABASE_URL).hostname.split('.')[0]

// Admin-Credentials: aus inline-Env-Vars oder Fallback
const ADMIN_EMAIL    = process.env.ADMIN_EMAIL    || 'admin@happyproperty.com'
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'HappyAdmin2026!'
const ADMIN_NAME     = process.env.ADMIN_NAME     || 'Happy Property Admin'

// ── 1. SQL-Migration via Management API ────────────────────────
async function runMigration() {
  console.log('\n📦 Schritt 1: SQL-Migration anwenden …')

  if (!PAT) {
    console.log('⚠️  SUPABASE_ACCESS_TOKEN fehlt.')
    console.log('   → Füge ihn in .env ein und starte erneut')
    console.log('   → ODER füge supabase/migrations/001_initial.sql')
    console.log('     manuell im SQL-Editor ein:')
    console.log(`   → https://supabase.com/dashboard/project/${PROJECT_REF}/sql`)
    return false
  }

  const sql = readFileSync(
    new URL('../supabase/migrations/001_initial.sql', import.meta.url), 'utf8'
  )

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PAT}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    }
  )

  if (!res.ok) {
    const body = await res.text()
    console.error('❌ Migration fehlgeschlagen:', body)
    return false
  }

  console.log('✅ Migration erfolgreich angewendet')
  console.log('   • 6 Tabellen erstellt (profiles, properties, documents,')
  console.log('     contracts, income_entries, bookings)')
  console.log('   • RLS für alle Tabellen aktiviert')
  console.log('   • Storage Buckets: documents + property-images')
  console.log('   • Signing RPCs: get_contract_for_signing, sign_contract')
  return true
}

// ── 2. Admin-User anlegen ──────────────────────────────────────
async function createAdminUser() {
  console.log('\n👤 Schritt 2: Admin-User anlegen …')

  if (!SVC_KEY) {
    console.log('⚠️  SUPABASE_SERVICE_ROLE_KEY fehlt.')
    console.log('   → Supabase Dashboard → Settings → API → service_role key')
    return false
  }

  const admin = createClient(SUPABASE_URL, SVC_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: list } = await admin.auth.admin.listUsers()
  const existing = list?.users?.find(u => u.email === ADMIN_EMAIL)

  if (existing) {
    console.log(`ℹ️  User ${ADMIN_EMAIL} existiert bereits – aktualisiere Profil …`)
    const { error } = await admin.from('profiles').upsert({
      id: existing.id,
      email: ADMIN_EMAIL,
      full_name: ADMIN_NAME,
      role: 'admin',
      language: 'de',
    })
    if (error) console.error('   Profil-Update Fehler:', error.message)
    else console.log('✅ Profil aktualisiert (Rolle: admin)')
    return true
  }

  const { data, error: createErr } = await admin.auth.admin.createUser({
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    email_confirm: true,
    user_metadata: { full_name: ADMIN_NAME, role: 'admin' },
  })

  if (createErr) {
    console.error('❌ User-Erstellung fehlgeschlagen:', createErr.message)
    return false
  }

  const { error: profileErr } = await admin.from('profiles').upsert({
    id: data.user.id,
    email: ADMIN_EMAIL,
    full_name: ADMIN_NAME,
    role: 'admin',
    language: 'de',
  })

  if (profileErr) console.error('⚠️  Profil-Eintrag Fehler:', profileErr.message)

  console.log('✅ Admin-User erstellt:')
  console.log(`   E-Mail : ${ADMIN_EMAIL}`)
  console.log(`   Name   : ${ADMIN_NAME}`)
  console.log('   Rolle  : admin')
  return true
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  console.log('🚀 Happy Property – Datenbank-Setup v2')
  console.log(`   Projekt: ${PROJECT_REF}\n`)
  console.log('   Rollen : admin / verwalter / eigentuemer')

  const migrationOk = await runMigration()
  const userOk      = await createAdminUser()

  console.log('\n─────────────────────────────────────')
  if (migrationOk && userOk) {
    console.log('🎉 Setup abgeschlossen! App starten: npm run dev')
    console.log('\n   Login: admin@happyproperty.com / HappyAdmin2026!')
  } else {
    console.log('⚠️  Setup teilweise abgeschlossen – siehe Hinweise oben.')
    if (!PAT) console.log('\n   SUPABASE_ACCESS_TOKEN fehlt  → .env ergänzen')
    if (!SVC_KEY) console.log('   SUPABASE_SERVICE_ROLE_KEY fehlt → .env ergänzen')
  }
}

main().catch(err => {
  console.error('\n❌ Unerwarteter Fehler:', err.message)
  process.exit(1)
})
