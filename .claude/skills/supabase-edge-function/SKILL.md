---
name: supabase-edge-function
description: Erstellt eine neue Supabase Edge Function fuer das Happy Property CRM exakt nach dem bestehenden Projektmuster (Referenz send-email). Verwenden bei neuer Edge Function unter supabase/functions/ oder Ueberarbeitung danach. Nicht fuer Frontend-Code.
---

# Skill: Supabase Edge Function (Happy Property)

Neue Edge Functions folgen exakt dem bestehenden Projektmuster.
Referenz: supabase/functions/send-email/index.ts. Nicht abweichen,
ausser der Nutzer verlangt es ausdruecklich.

## Harte Regeln (aus dem bestehenden Code abgeleitet)

1. Runtime ist Deno, nicht Node. Imports ueber jsr: oder
   https://deno.land/x/... . Niemals npm-import aus node_modules.
2. CORS-Konstante immer wie in send-email, in jede Response als
   ...CORS gespreadet. OPTIONS-Preflight zuerst (Status 200, nur CORS).
3. Supabase-Client in Edge Functions mit SUPABASE_SERVICE_ROLE_KEY
   erstellen (serverseitig, RLS-Bypass gewollt). Das ist der EINZIGE
   legitime Ort fuer service role. Niemals dieses Pattern ins Frontend.
4. Secrets via Deno.env.get('NAME'). Pflicht mit !, optional mit ?? ''.
   Secret-Namen + Zweck oben im Datei-Header dokumentieren.
5. Fehlerbehandlung: const msg = err instanceof Error ? err.message :
   String(err). Catch -> Status 500 { error: msg }. Validierung -> 400.
6. Logging mit Funktions-Praefix: console.log('[name] ...'), warn, error.
7. CRM-Aktivitaet loggen wenn Kundeninteraktion: in activities-Tabelle
   schreiben (lead_id, deal_id, type, direction:'outbound', subject,
   content auf ~2000 Zeichen gekuerzt, completed_at). Log-Fehler nur
   warnen, Request nicht scheitern lassen.
8. Nicht-kritische Schritte graceful degradieren (siehe send-email
   SMTP-Fallback), nicht hart abbrechen.
9. Antwort immer JSON mit Content-Type application/json. Erfolg:
   { success: true, ... }.
10. Deployment-Kommando im Header dokumentieren:
    supabase functions deploy <name> --no-verify-jwt

## Vor dem Schreiben

Eine bestehende, thematisch nahe Function als konkrete Vorlage lesen
(send-email fuer Versand, *-webhook fuer eingehende Webhooks) und
deren Stil uebernehmen, statt das Muster aus dem Gedaechtnis zu bauen.
