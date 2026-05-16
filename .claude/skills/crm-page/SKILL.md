---
name: crm-page
description: >
  Erstellt eine neue CRM-Seite oder -Komponente für das Happy Property
  CRM exakt nach dem bestehenden Projektmuster (Referenz:
  src/pages/admin/crm/Pipeline.tsx). Verwenden, wenn eine neue Seite
  unter src/pages/admin/crm/ oder eine CRM-Komponente unter
  src/components/crm/ angelegt oder nach diesem Muster überarbeitet
  werden soll. Nicht für Edge Functions (dafür: supabase-edge-function).
---

# Skill: CRM-Seite / -Komponente (Happy Property)

Neue CRM-Seiten folgen **exakt** dem bestehenden Muster.
Referenz: `src/pages/admin/crm/Pipeline.tsx`. Vor dem Schreiben eine
thematisch nahe bestehende Seite lesen und deren Stil übernehmen,
nicht aus dem Gedächtnis rekonstruieren.

## Import-Reihenfolge (verbindlich)

```ts
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'        // falls Navigation
import DashboardLayout from '../../../components/DashboardLayout'
import { supabase } from '../../../lib/supabase'       // NUR dieser Client
import { useAuth } from '../../../lib/auth'
import type { Deal, DealPhase } from '../../../lib/crmTypes'
// CRM-Konstanten aus crmTypes (DEAL_PHASES, PHASE_ICONS, etc.)
// CRM-Komponenten aus '../../../components/crm/...'
// Integrationen aus '../../../lib/whatsapp' etc.
```

Relativ-Pfade beachten: Seiten in `src/pages/admin/crm/` → `../../../`.
Nie aus `lib/supabaseAdmin` importieren (service role, nur Edge).

## Struktur einer Seite

1. Sub-Komponenten (Modals, Cards) **oberhalb** des Default-Exports,
   mit eigenen `interface ...Props`. Abschnitte mit
   `// ── Name ───────` kommentieren.
2. Default-Export-Funktion = die Seite.
3. Hooks oben: `useTranslation`, `useNavigate`, `useAuth`, dann
   `useState`-Block, dann `useCallback`-Fetches, dann `useEffect`.
4. Render endet in `<DashboardLayout basePath={basePath}>`.

## Daten-Pattern

```ts
const fetchX = useCallback(async () => {
  setLoading(true)
  try {
    const { data, error } = await supabase
      .from('<table>')
      .select(`...`)            // nested selects wie in Pipeline
      .order('updated_at', { ascending: false })
    if (error) throw error
    setX((data as unknown as X[]) ?? [])
  } catch (err) {
    console.error('[<Komponente>] fetchX:', err)
    setX([])
  } finally {
    setLoading(false)
  }
}, [])

useEffect(() => { fetchX() }, [fetchX])
```

## Harte Regeln (aus dem bestehenden Code abgeleitet)

1. **Nur `supabase` aus `lib/supabase.ts`.** Niemals `supabaseAdmin`,
   niemals `createClient` in einer Seite/Komponente.
2. **i18n Pflicht:** Jeder sichtbare String über
   `t('namespace.key', 'Deutscher Fallback')`. Keine hartkodierten
   UI-Texte. Keys konsistent zum bestehenden Schema
   (`crm.pipeline.*`, `crm.lead.*`, `crm.phases.*`, `common.*`).
3. **Fehlerbehandlung:** Jeder Supabase-Call in `try/catch`.
   `console.error('[<Komponente>] <kontext>:', err)`. Bei Fetch-Fehler
   State auf sicheren Leerwert (`[]` / `null`) setzen.
4. **Loading-State:** `setLoading(true)` am Anfang, `false` im
   `finally`. Spinner exakt wie bestehend:
   `border-4 border-orange-300 border-t-orange-500 ... animate-spin`.
5. **Optimistic Updates mit Rollback:** Bei Mutationen State sofort
   aktualisieren, alten Wert merken, bei Supabase-Fehler zurückrollen
   (siehe `handleDrop` in Pipeline).
6. **Aktivitäts-Logging:** Relevante Aktionen (Statuswechsel, Anlegen,
   Versand) in `activities` schreiben:
   `{ lead_id, deal_id, type, direction: 'outbound', content,
   created_by: profile?.id ?? null }`.
7. **Automation/Webhook fire-and-forget:**
   `supabase.functions.invoke('<fn>', { body }).catch(e =>
   console.warn('[<Komponente>] <fn> failed:', e))` — niemals den
   UI-Flow an einem fehlgeschlagenen Nebeneffekt scheitern lassen.
8. **Styling:** Tailwind-Klassen. Primär-Buttons/Akzent in Coral als
   Inline-Style `style={{ backgroundColor: '#ff795d' }}` (bestehende
   Konvention — hier Inline ist okay, sonst Tailwind). Modals:
   `fixed inset-0 z-50 ... bg-black/40`, Karte `bg-white rounded-2xl`.
9. **Typen aus `crmTypes.ts`** verwenden/erweitern, nicht lokal
   redefinieren. Lokale Form-Interfaces (z.B. `LeadForm`) sind okay.
10. **Layout:** Seite immer in `<DashboardLayout basePath={basePath}>`.
    `basePath` = `/admin/crm` (für admin + verwalter erreichbar).
11. **Toast-Pattern** für Nutzer-Feedback wie in Pipeline
    (`showToastMsg`, 3s Timeout, `fixed bottom-6 right-6`).

## Routing

Neue Seite muss in der Route-Konfiguration registriert werden
(`App.tsx` bzw. wo Routen unter `/admin/crm` definiert sind).
Daran erinnern, nicht stillschweigend übergehen.
