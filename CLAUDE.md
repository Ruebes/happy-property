# CLAUDE.md — Happy Property CRM

> Dieses Briefing wird bei jedem Session-Start automatisch geladen.
> Es ersetzt das wiederholte Erklären von Stack, Struktur und bekannten Bugs.
> Kurz halten. Konventionen, keine Doku.

## Projekt

Internes CRM für Happy Property — Cyprus Real-Estate-Investment-Brokerage,
Zielgruppe deutschsprachige Kapitalanleger. Verwaltet Leads, Pipeline,
Projekte, Objekte, Termine, Dokumente und Kommunikation (WhatsApp/E-Mail).
Mehrsprachig (DE primär, EN) via i18next. Läuft als PWA.

- **Owner:** Sven (mit DU ansprechen)
- **Hosting:** Vercel (Frontend), Supabase (Backend/DB/Auth/Edge Functions)
- **Supabase Projekt-Ref:** `vjlwgajmtqlwjjreowbu`
- **Lokaler Pfad:** `/Users/ArPritsch/Downloads/happy-property`

## Stack

| Bereich   | Technologie |
|-----------|-------------|
| Framework | React 18.3 + react-router-dom 6.23 |
| Build     | Vite 5.2 (PWA via vite-plugin-pwa 1.3) |
| Sprache   | TypeScript 5.4 (strict) |
| Styling   | Tailwind CSS 3.4 + PostCSS + Autoprefixer |
| Backend   | Supabase JS 2.43 (DB, Auth, Storage, Edge Functions) |
| i18n      | i18next 23 + react-i18next + browser-languagedetector |

## Befehle

| Zweck | Befehl |
|-------|--------|
| Dev-Server starten | `npm run dev` |
| Production-Build (inkl. TS-Check) | `npm run build` → `tsc && vite build` |
| Build lokal ansehen | `npm run preview` |

`npm run build` macht **zuerst** `tsc` (TypeScript-Typecheck), **dann** `vite build`.
Wenn `npm run build` grün ist, ist TypeScript sauber UND der Build deploybar.

## Projektstruktur

```
src/
  App.tsx              # Router / App-Root
  main.tsx             # Entry
  components/          # Wiederverwendbare UI-Komponenten
  pages/               # Seiten (Routen)
    admin/crm/         # CRM-Kern: AllLeads, LeadDetail, Pipeline,
                       #   Projects, ProjectDetail, CrmDashboard,
                       #   Templates, Settings, Statistics, Calendar, Archived
    admin/             # Admin-Bereich (sonstige)
    investor/ feriengast/ eigentuemer/ verwalter/ verwaltung/
    Dashboard.tsx Login.tsx SetPassword.tsx Sign.tsx Profile.tsx
    Objekte.tsx PropertyDetail.tsx Kalender.tsx Dokumente.tsx
  lib/
    supabase.ts          # NORMALER Supabase-Client (anon key) — Default
    supabaseAdmin.ts     # ADMIN-Client (service role) — NUR Server/Edge, NIE im Browser-Render-Pfad
    auth.tsx             # Auth-Context / Session-Handling
    crmTypes.ts          # Zentrale CRM-TypeScript-Typen
    date.ts              # Datums-Helper
    googleCalendar.ts    # Google-Calendar-Integration
    i18n.ts              # i18next-Setup
    whatsapp.ts          # WhatsApp (TimelinesAI)
    workflowDocuments.ts # Dokument-Workflow-Logik
  locales/             # Übersetzungen (DE/EN)
  styles/              # globals.css + Tailwind
supabase/functions/    # 14 Edge Functions (siehe unten)
```

### Supabase Edge Functions

`admin-user-ops`, `analyze-invoice`, `calendly-webhook`,
`create-eigentuemer-access`, `create-zoom-meeting`, `crm-webhook-sender`,
`notify-bank-change`, `process-scheduled-messages`, `schedule-message`,
`send-booking-confirmation`, `send-email`, `send-whatsapp`,
`timelines-webhook`, `typeform-webhook`

## Harte Regeln (immer einhalten)

1. **Supabase-Client-Trennung:**
   Im Frontend/Browser **immer** aus `src/lib/supabase.ts` importieren.
   `src/lib/supabaseAdmin.ts` (service role) darf **niemals** in einen
   Browser-gerenderten Pfad importiert werden — nur in Edge Functions /
   serverseitigem Code. Ein zweiter Client-Instanz im Frontend ist eine
   häufige Ursache für Auth-/Session-Bugs.

2. **Kein doppelter Supabase-Client:** Nie `createClient(...)` neu aufrufen.
   Immer die bestehende Instanz aus `lib/supabase.ts` verwenden.

3. **Build muss grün sein:** Vor jedem Commit `npm run build` ausführen.
   TypeScript-Fehler werden **nie** mit `any`, `@ts-ignore` oder
   `// @ts-expect-error` zugepflastert, sondern behoben. Ein Pre-Commit-Hook
   blockt Commits bei rotem Build hart.

4. **Typen aus `crmTypes.ts`:** CRM-Datenstrukturen nicht lokal neu definieren,
   sondern die zentralen Typen aus `src/lib/crmTypes.ts` verwenden/erweitern.

5. **i18n:** Neue UI-Strings nicht hardcoden, sondern über i18next + `locales/`
   (DE und EN pflegen).

6. **Tailwind statt Inline-Styles:** Styling über Tailwind-Klassen, keine
   `style={{...}}`-Inline-Styles außer wo unvermeidbar (z.B. dynamische Werte).

## Bekannte Fallstricke (gelöste Bugs — nicht reproduzieren)

### #1 — Persistenter Session-/Spinner-Bug (auth.tsx)
**Symptom:** Endlos drehender Lade-Spinner, Session "hängt".
**Ursache:** `onAuthStateChange` setzte fälschlich `loading: true` bei
`SIGNED_IN`-Events **nach** der Initialisierung.
**Regel:** In `src/lib/auth.tsx` darf der `onAuthStateChange`-Handler nach
abgeschlossener Initial-Session-Prüfung **niemals** `loading: true` setzen.
`SIGNED_IN`-/`TOKEN_REFRESHED`-Events nach Init nur State aktualisieren,
nie erneut in den Loading-Zustand zurückfallen.

### #2 — Spinner-Hänger durch veralteten Lazy-Chunk nach Deploy
**Symptom:** Navigation auf eine Route hängt im Vollbild-Spinner; **nur ein manueller
Reload** (Return in der Adressleiste) hilft, Warten nicht. Tritt v.a. bei lange offener
Tab-Session nach einem (oder mehreren) Deploys auf — auch im Eigentümer-/Kundenportal.
**Ursache:** Die alte `index.html` referenziert alte JS-Chunknamen; nach dem Deploy
existieren die nicht mehr → `import()` der Lazy-Route schlägt fehl → `<Suspense>` hat
kein Error-Handling → Spinner hängt ewig. (NICHT der Auth-Deadlock aus #1 — der ist
in `auth.tsx`/`supabase.ts` gehärtet.)
**Regel:** Lazy-Routen **immer** über `lazyWithReload` aus `src/lib/lazyWithReload.ts`
laden (nicht direkt `React.lazy`). Der Wrapper lädt bei Chunk-Ladefehler einmalig
automatisch neu (sessionStorage-Guard gegen Reload-Loop) + globaler
`vite:preloadError`-Handler. So recovert die App selbst, statt zu hängen.

<!-- Weitere gelöste Bugs hier ergänzen, sobald sie auftreten:
### #3 — <Titel>
**Symptom:** ...
**Ursache:** ...
**Regel:** ...
-->

## Arbeitsweise mit Sven

- Direkt antworten, nichts erfinden. Bei Unklarheit nachfragen statt raten.
- Keine langen Einleitungen.
- Auf Deutsch, Sven mit DU ansprechen.
