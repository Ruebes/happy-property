-- ─────────────────────────────────────────────────────────────────────────────
-- S2 Zugriffsregeln (RLS, Grants, SECURITY-DEFINER-Funktionen), Audit 30.9.2026
-- Keine Datenänderung, keine Tabelle gelöscht. Bestehende Policies werden per
-- ALTER POLICY unter ihrem Namen geändert (kein Moment ohne Policy).
-- Edge Functions und pg_cron laufen als Service-Role/postgres und sind nicht betroffen.
-- Rückweg: supabase/migrations/rollback/20260930213000_s2_access_rules.down.sql
-- Version 20260930213000 (nicht 200000): origin/main hat schon 20260930200000_developer_contact_drive_access.sql.
--
-- REIHENFOLGE BEIM AUSROLLEN (sonst zeigen alle /s/-Kurzlinks aus WhatsApp „ungültig“):
--   1. Frontend mit neuer ShortLink.tsx pushen und warten, bis Vercel sie ausliefert.
--   2. Einen echten /s/<code> öffnen: er muss weiterleiten (läuft dann noch über den Tabellen-Fallback).
--   3. Erst danach diese Migration einspielen. Umgekehrt (DB zuerst) liest die alte ShortLink.tsx als anon
--      die Tabelle, bekommt 0 Zeilen ohne Fehler und meldet jeden Kurzlink als ungültig.
-- Ausführen als Ganzes in einer Transaktion (SQL-Editor oder psql --single-transaction -f).
-- Setzt das Live-Schema voraus: mehrere Policies/Objekte (acquisition.*, sp_all, st_all, spm_all, si_auth_all,
-- eng_select_auth, prt_read, prv_read, all_read_verwaltungen, whe_admin, des_admin, auth_full_access,
-- deck_assets_backup, find_task_by_assignee_phone) stehen in keiner Repo-Migration; auf einer frisch aus dem
-- Repo gebauten DB (db reset/Branch) bricht die Datei ab und ändert nichts. Drift später separat schließen.
--
-- F10-1: social_posts/social_topics/social_post_messages/social_interactions nur noch Funnel-Berechtigte (Admin, Verwalter, Mitarbeiter mit Recht funnel, Rolle funnel) = Route Social Studio; Eigentümer raus.
-- S1-4: dasselbe zusätzlich für social_ideas (si_auth_all); Social Studio (/admin/crm/social) behält vollen Zugriff.
-- F10-2: web_sessions/web_events/web_replay_chunks/web_reports sowie seo_bot_hits/seo_reports/seo_snapshots nur Admin (einzige Leser: Admin-Seiten Web-Analytics und SEO); Berichts-Links laufen weiter über die Definer-RPCs.
-- F7-5: list_sequences/sequence_steps (lesen+schreiben) nur Funnel-Berechtigte (Workflows, Newsletter-Listen); subscriber-optin (Service-Role) unverändert.
-- S1-5: sequence_enrollments bleibt nur lesbar, aber nur noch für Funnel-Berechtigte.
-- I4-2: engagement_events Lesen per eng_select_auth nur noch Funnel-Berechtigte (Newsletter-Statistik); Pipeline-Berechtigte behalten Zugriff über engagement_events_staff_perm; Eigentümer raus.
-- S1-7: partner_review_tokens/partner_reviews nur Admin; Partner-Links laufen weiter über die Edge Function partner-review (Service-Role).
-- F9-1: short_links nicht mehr für anon lesbar; neue Funktion get_short_link(p_code) löst genau einen Code auf (anon+authenticated); Lesen/Anlegen der Tabelle nur Admin/Verwalter/Mitarbeiter (Terminmodal); ShortLink.tsx folgt nur https-Zielen auf portal.happy-property.com und calendar.google.com (alle 96 Bestandsziele geprüft).
-- S1-8: Schema acquisition: alle 10 Tabellen nur noch Admin (Akquise-App loggt als Sven ein); Pipeline und Edge Functions nutzen die Service-Role.
-- F8-38: verwaltungen lesen nur Admin/Verwalter/Mitarbeiter und Eigentümer/Miteigentümer einer Immobilie mit genau dieser Verwaltung (Objektseite); der Eigentümer-Zweig weicht bewusst von „nur Team“ ab und wartet auf Svens OK (s. unten).
-- S1-10: webhook_errors und drive_external_sources nur Admin; Alt-Tabellen deck_clients/decks/project_deck_images nur Mitarbeiter mit Recht decks (+Admin/Verwalter).
-- I4-24: deck_assets_backup bekommt RLS ohne Policy (nur Service-Role/SQL-Editor), Tabelle und Zeile bleiben.
-- S1-14: siehe I4-24 (gleiche Tabelle).
-- D3-3: siehe I4-24 (gleiche Tabelle, kein Drop).
-- S1-13: View deck_facts_resolved läuft mit security_invoker (RLS von deck_facts greift); kein Leser betroffen.
-- S1-9: Wartungsfunktionen claim_workflow_runs, claim_deck_jobs, hp_reap_deck_jobs, hp_sunday_archive, hp_auto_lost, hp_archive_completed_deals, hp_klaviyo_upsert, hp_sync_deck_assets_catalog, fn_ensure_deal_property, hp_seo_purge nur noch Service-Role (+Eigentümer postgres für Cron/Trigger).
-- S2-6: wie S1-9, zusätzlich find_task_by_assignee_phone nur Service-Role, list_staff nicht mehr für anon.
-- I4-14: claim_deck_jobs, hp_reap_deck_jobs, hp_sync_deck_assets_catalog nur Service-Role (in S1-9 enthalten).
-- E4-2: claim_deck_jobs, hp_reap_deck_jobs nur Service-Role (in S1-9 enthalten).
-- S1-11: list_staff nur eingeloggt (authenticated, Service-Role) und E-Mail nur noch für Team-Rollen (Admin, Verwalter, Mitarbeiter, Funnel) bzw. Service-Role; Eigentümer/Fremdkonten bekommen id, Name, Rolle (Aufgaben-Hinweise brauchen nur id+Name); find_task_by_assignee_phone nur Service-Role (WhatsApp-Eingang).
-- E5-18: claim_invoice_number nicht mehr für authenticated; generate-invoice (Service-Role) behält es.
-- F8-12: siehe E5-18.
-- S1-12: siehe E5-18.
-- I4-23: fester search_path = public, pg_temp für get_calculation_by_token, get_calculation_lang, get_deck_lang, get_contract_for_signing, sign_contract, claim_deck_jobs, claim_workflow_runs (Rückgabe unverändert).
-- S1-2: handle_new_user setzt die Rolle immer auf 'eigentuemer' (nie mehr aus Signup-Metadaten); admin-user-ops und create-eigentuemer-access setzen die echte Rolle danach per Service-Role-Upsert.
-- F2b-4: Eigentümer dürfen in crm_unit_documents nur noch selbst hochgeladene Zeilen löschen (wie die Oberfläche); Admin/Verwalter/Pipeline-Mitarbeiter unverändert; Storage-Policy bleibt.
-- F2a-7: siehe F2b-4.
-- S1-18: Aufgaben: sich selbst als Beteiligten eintragen nur, wenn man schon Beteiligter ist (Ersteller trägt weiter jeden ein); Chat-Nachrichten nur von Beteiligten; an Nachrichten dürfen Eingeloggte nur noch read_at/notified_at ändern (keine verschobenen/gefälschten Nachrichten); parent_task_id lässt sich nach dem Anlegen nicht mehr auf eine andere Aufgabe umhängen (Service-Role/SQL-Editor ausgenommen, Lösen auf NULL erlaubt).
--
-- Bewusst NICHT in dieser Migration (Svens Entscheidung, siehe Übergabe):
--   * F8-38: Eigentümer/Miteigentümer lesen die ganze Zeile ihrer Verwaltung (inkl. notes), weil die Objektseite
--     (PropertyDetail) Adresse/Kontakt einbettet. Abweichung von „nur Team“, braucht Svens OK; heute keine Notizen gespeichert.
--   * F2b-4/F2a-7: Storage-Policy unit_docs_eigentuemer_delete bleibt; Eigentümer können die Datei eines vom Admin
--     hochgeladenen Einheiten-Dokuments weiter aus dem Bucket löschen (Zahlungsbelege pay-/inv- brauchen das).
--   * S1-2: Selbstregistrierung ist noch an (disable_signup=false); nur im Supabase-Dashboard abschaltbar.
--   * S1-8: Pipeline-Repo-Migrationen 0008/0014/0016 setzen app_authenticated_all bei erneutem Lauf wieder auf true.
--   * S1-7/F9-1: bisher lesbare Tokens (Partner-Links, Termin-Manage-Tokens) bleiben gültig; neu ausstellen = Entscheidung.
-- ─────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

-- ── S1-2: handle_new_user ohne Rolle aus raw_user_meta_data ────────────────
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
begin
  insert into public.profiles (id, email, full_name, phone, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'phone',
    'eigentuemer'
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

-- ── F9-1: Kurzlinks über eine Definer-Funktion statt Tabellen-Select ───────
create or replace function public.get_short_link(p_code text)
 returns text
 language sql
 stable
 security definer
 set search_path to 'public', 'pg_temp'
as $fn$
  select s.target from public.short_links s where s.code = p_code limit 1
$fn$;

revoke all on function public.get_short_link(text) from public;
grant execute on function public.get_short_link(text) to anon, authenticated, service_role;

alter policy short_links_select on public.short_links
  to authenticated
  using ((select public.current_user_role()) = any (array['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]));

alter policy short_links_insert on public.short_links
  with check ((select public.current_user_role()) = any (array['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]));

-- ── F10-1 / S1-4: Social-Studio-Tabellen = Route /admin/crm/social ────────
alter policy sp_all on public.social_posts
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text)
  with check ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

alter policy st_all on public.social_topics
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text)
  with check ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

alter policy spm_all on public.social_post_messages
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text)
  with check ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

alter policy social_interactions_staff on public.social_interactions
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text)
  with check ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

alter policy si_auth_all on public.social_ideas
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text)
  with check ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

-- ── F10-2: Web-Analytics und SEO-Rohdaten nur Admin ────────────────────────
alter policy web_sessions_read on public.web_sessions
  using ((select public.current_user_role()) = 'admin'::text);

alter policy web_events_read on public.web_events
  using ((select public.current_user_role()) = 'admin'::text);

alter policy web_replay_read on public.web_replay_chunks
  using ((select public.current_user_role()) = 'admin'::text);

alter policy web_reports_read on public.web_reports
  using ((select public.current_user_role()) = 'admin'::text);

alter policy seo_bot_hits_read on public.seo_bot_hits
  using ((select public.current_user_role()) = 'admin'::text);

alter policy seo_reports_read on public.seo_reports
  using ((select public.current_user_role()) = 'admin'::text);

alter policy seo_snapshots_read on public.seo_snapshots
  using ((select public.current_user_role()) = 'admin'::text);

-- ── F7-5 / S1-5: Newsletter-Automationen = Route funnel ────────────────────
alter policy seq_all_auth on public.list_sequences
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text)
  with check ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

alter policy step_all_auth on public.sequence_steps
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text)
  with check ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

alter policy enroll_read_auth on public.sequence_enrollments
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

-- ── I4-2: engagement_events (Newsletter-Statistik über newsletter_engagement) ─
-- Pipeline-Berechtigte lesen weiter über engagement_events_staff_perm (unverändert).
alter policy eng_select_auth on public.engagement_events
  using ((select public.current_user_has_perm('funnel'::text)) or (select public.current_user_role()) = 'funnel'::text);

-- ── S1-7: Partner-Review nur Admin (Links laufen über die Edge Function) ────
alter policy prt_read on public.partner_review_tokens
  using ((select public.current_user_role()) = 'admin'::text);

alter policy prv_read on public.partner_reviews
  using ((select public.current_user_role()) = 'admin'::text);

-- ── S1-8: Schema acquisition nur Admin (Akquise-App = Login Sven) ──────────
alter policy app_authenticated_all on acquisition.discovery_fortschritt
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.einstellungen
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.email_pruefung
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.leads
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.leads_manuell
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.outreach
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.runs
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.suppression
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.templates
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy app_authenticated_all on acquisition.zielgruppen
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

-- ── F8-38: Verwaltungen nur Team + Eigentümer der zugeordneten Immobilie ───
alter policy all_read_verwaltungen on public.verwaltungen
  using (
    (select public.current_user_role()) = any (array['admin'::text, 'verwalter'::text, 'mitarbeiter'::text])
    or exists (
      select 1 from public.properties p
       where p.verwaltung_id = verwaltungen.id
         and p.id in (select public.hp_my_property_ids())
    )
  );

-- ── S1-10: Fehlerprotokoll, Drive-Zusatzquellen, Alt-Deck-Tabellen ─────────
alter policy whe_admin on public.webhook_errors
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

alter policy des_admin on public.drive_external_sources
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

-- auth_full_access hat kein WITH CHECK: USING gilt damit auch für Schreibzugriffe.
alter policy auth_full_access on public.deck_clients
  using ((select public.current_user_has_perm('decks'::text)));

alter policy auth_full_access on public.decks
  using ((select public.current_user_has_perm('decks'::text)));

alter policy auth_full_access on public.project_deck_images
  using ((select public.current_user_has_perm('decks'::text)));

-- ── I4-24 / S1-14 / D3-3: Sicherungstabelle ohne API-Zugriff ───────────────
alter table public.deck_assets_backup enable row level security;

-- ── S1-13: View mit den Rechten des Aufrufers ──────────────────────────────
alter view public.deck_facts_resolved set (security_invoker = true);

-- ── F2b-4 / F2a-7: Eigentümer löschen nur eigene Uploads ───────────────────
alter policy crm_unit_docs_eigentuemer_delete on public.crm_unit_documents
  using (
    uploaded_by = (select auth.uid())
    and unit_id in (select public.hp_owner_unit_ids())
  );

-- ── S1-18: Aufgaben-Beteiligung nicht selbst erschleichen ──────────────────
-- USING bleibt: Annehmen (accepted_at), eigene Zeile entfernen, Ersteller-Pflege.
alter policy task_assignee_write on public.crm_task_assignees
  with check (
    exists (
      select 1 from public.crm_tasks x
       where x.id = crm_task_assignees.task_id
         and x.created_by = (select auth.uid())
    )
    or (
      profile_id = (select auth.uid())
      and public.is_task_participant(task_id)
    )
  );

alter policy task_msg_insert on public.crm_task_messages
  with check (
    sender_id = (select auth.uid())
    and public.is_task_participant(task_id)
  );

-- task_msg_update (recipient_id = ich, ohne WITH CHECK) erlaubte, eine eigene Nachricht in eine fremde
-- Aufgabe zu verschieben und Absender/Text zu fälschen. Die Oberfläche schreibt nur read_at (Tasks.tsx)
-- und notified_at (TaskNotifications.tsx); alles andere schreiben Edge Functions mit Service-Role.
revoke update on public.crm_task_messages from anon, authenticated;
grant  update (read_at, notified_at) on public.crm_task_messages to authenticated;

-- crm_tasks_update prüft parent_task_id nicht (nur crm_tasks_insert). Umhängen unter eine fremde Aufgabe
-- öffnete über task_parent_context deren Titel, Beschreibung und letzte Nachrichten. Die Oberfläche setzt
-- parent_task_id nur beim Anlegen. Lösen auf NULL bleibt erlaubt (harmlos); Service-Role/SQL-Editor
-- (auth.uid() null) ausgenommen. Nicht in die Policy, weil Teilaufgaben-Bearbeiter sonst ihre Teilaufgabe
-- nicht mehr ändern könnten.
create or replace function public.hp_crm_tasks_parent_lock()
 returns trigger
 language plpgsql
 set search_path to 'public', 'pg_temp'
as $fn$
begin
  if new.parent_task_id is not null
     and new.parent_task_id is distinct from old.parent_task_id
     and (select auth.uid()) is not null then
    raise exception 'parent_task_id kann nach dem Anlegen nicht geändert werden'
      using errcode = '42501';
  end if;
  return new;
end;
$fn$;

drop trigger if exists trg_crm_tasks_parent_lock on public.crm_tasks;
create trigger trg_crm_tasks_parent_lock
  before update of parent_task_id on public.crm_tasks
  for each row execute function public.hp_crm_tasks_parent_lock();

-- ── S1-9 / S2-6 / I4-14 / E4-2 / S1-11: Definer-Funktionen ohne anon ───────
-- Nur Service-Role (Edge Functions) und der Eigentümer postgres (pg_cron, Trigger).
revoke execute on function public.claim_workflow_runs(integer) from public, anon, authenticated;
grant  execute on function public.claim_workflow_runs(integer) to service_role;

revoke execute on function public.claim_deck_jobs(integer) from public, anon, authenticated;
grant  execute on function public.claim_deck_jobs(integer) to service_role;

revoke execute on function public.hp_reap_deck_jobs(integer) from public, anon, authenticated;
grant  execute on function public.hp_reap_deck_jobs(integer) to service_role;

revoke execute on function public.hp_sunday_archive() from public, anon, authenticated;
grant  execute on function public.hp_sunday_archive() to service_role;

revoke execute on function public.hp_auto_lost() from public, anon, authenticated;
grant  execute on function public.hp_auto_lost() to service_role;

revoke execute on function public.hp_archive_completed_deals() from public, anon, authenticated;
grant  execute on function public.hp_archive_completed_deals() to service_role;

revoke execute on function public.hp_klaviyo_upsert(uuid, jsonb) from public, anon, authenticated;
grant  execute on function public.hp_klaviyo_upsert(uuid, jsonb) to service_role;

revoke execute on function public.hp_sync_deck_assets_catalog(uuid) from public, anon, authenticated;
grant  execute on function public.hp_sync_deck_assets_catalog(uuid) to service_role;

revoke execute on function public.fn_ensure_deal_property(uuid) from public, anon, authenticated;
grant  execute on function public.fn_ensure_deal_property(uuid) to service_role;

revoke execute on function public.hp_seo_purge() from public, anon, authenticated;
grant  execute on function public.hp_seo_purge() to service_role;

revoke execute on function public.find_task_by_assignee_phone(text) from public, anon, authenticated;
grant  execute on function public.find_task_by_assignee_phone(text) to service_role;

-- list_staff: Aufgaben-Seiten und Aufgaben-Hinweise (eingeloggt) behalten es.
revoke execute on function public.list_staff() from public, anon;
grant  execute on function public.list_staff() to authenticated, service_role;

-- E-Mail der Team-Konten nur noch für Team-Rollen (Tasks/StaffHome: Namens-Fallback) und Service-Role/postgres
-- (auth.uid() null). Eigentümer und Fremdkonten (TaskNotifications nutzt nur id+full_name) bekommen NULL.
-- Gleiche Signatur, ACL bleibt (CREATE OR REPLACE).
create or replace function public.list_staff()
 returns table(id uuid, full_name text, email text, role text)
 language sql
 stable security definer
 set search_path to 'public'
as $fn$
  select p.id, p.full_name,
         case when (select auth.uid()) is null
                or (select public.current_user_role()) = any (array['admin'::text, 'verwalter'::text, 'mitarbeiter'::text, 'funnel'::text])
              then p.email end,
         p.role
  from profiles p
  where p.role in ('admin','verwalter','mitarbeiter','funnel') and coalesce(p.is_active, true)
  order by p.full_name
$fn$;

-- ── E5-18 / F8-12 / S1-12: Rechnungsnummer nur noch über generate-invoice ──
revoke execute on function public.claim_invoice_number() from public, anon, authenticated;
grant  execute on function public.claim_invoice_number() to service_role;

-- ── I4-23: fester search_path für Token- und Job-Funktionen ────────────────
alter function public.get_calculation_by_token(text) set search_path to 'public', 'pg_temp';
alter function public.get_calculation_lang(text) set search_path to 'public', 'pg_temp';
alter function public.get_deck_lang(text) set search_path to 'public', 'pg_temp';
alter function public.get_contract_for_signing(uuid) set search_path to 'public', 'pg_temp';
alter function public.sign_contract(uuid) set search_path to 'public', 'pg_temp';
alter function public.claim_deck_jobs(integer) set search_path to 'public', 'pg_temp';
alter function public.claim_workflow_runs(integer) set search_path to 'public', 'pg_temp';
