-- ─────────────────────────────────────────────────────────────────────────────
-- Rückweg zu 20260930213000_s2_access_rules.sql
-- Stellt den Stand vom 30.9.2026 (vor S2) exakt wieder her. Quelle der Texte:
-- pg_policies, pg_get_functiondef und proacl/relacl/reloptions, live gelesen am
-- 30.9.2026 (nur lesend). Keine Datenänderung.
-- Als Ganzes in EINER Transaktion ausführen (SQL-Editor oder psql --single-transaction -f),
-- sonst ist „set local lock_timeout“ wirkungslos und ein Abbruch mittendrin hinterlässt
-- eine Mischung aus alten und neuen Regeln.
-- Achtung: Rückweg öffnet die in S2 geschlossenen Lücken wieder.
-- Frontend: ShortLink.tsx fällt ohne get_short_link automatisch auf den alten
-- Tabellen-Select zurück, muss also nicht mit zurückgerollt werden.
-- ─────────────────────────────────────────────────────────────────────────────

set local lock_timeout = '5s';

-- ── S1-2: handle_new_user wie vorher (Rolle aus raw_user_meta_data) ────────
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
begin
  insert into public.profiles (id, email, full_name, phone, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', ''),
    new.raw_user_meta_data->>'phone',
    coalesce(new.raw_user_meta_data->>'role', 'eigentuemer')
  )
  on conflict (id) do nothing;
  return new;
end;
$fn$;

-- ── F9-1: short_links wieder für anon lesbar, Anlegen für alle Eingeloggten ─
alter policy short_links_select on public.short_links
  to anon, authenticated
  using (true);

alter policy short_links_insert on public.short_links
  with check (true);

drop function if exists public.get_short_link(text);

-- ── F10-1 / S1-4 ───────────────────────────────────────────────────────────
alter policy sp_all on public.social_posts using (true) with check (true);
alter policy st_all on public.social_topics using (true) with check (true);
alter policy spm_all on public.social_post_messages using (true) with check (true);
alter policy social_interactions_staff on public.social_interactions using (true) with check (true);
alter policy si_auth_all on public.social_ideas using (true) with check (true);

-- ── F10-2 ──────────────────────────────────────────────────────────────────
alter policy web_sessions_read on public.web_sessions using (true);
alter policy web_events_read on public.web_events using (true);
alter policy web_replay_read on public.web_replay_chunks using (true);
alter policy web_reports_read on public.web_reports using (true);
alter policy seo_bot_hits_read on public.seo_bot_hits using (true);
alter policy seo_reports_read on public.seo_reports using (true);
alter policy seo_snapshots_read on public.seo_snapshots using (true);

-- ── F7-5 / S1-5 ────────────────────────────────────────────────────────────
alter policy seq_all_auth on public.list_sequences using (true) with check (true);
alter policy step_all_auth on public.sequence_steps using (true) with check (true);
alter policy enroll_read_auth on public.sequence_enrollments using (true);

-- ── I4-2 ───────────────────────────────────────────────────────────────────
alter policy eng_select_auth on public.engagement_events using (true);

-- ── S1-7 ───────────────────────────────────────────────────────────────────
alter policy prt_read on public.partner_review_tokens using (true);
alter policy prv_read on public.partner_reviews using (true);

-- ── S1-8 ───────────────────────────────────────────────────────────────────
alter policy app_authenticated_all on acquisition.discovery_fortschritt using (true) with check (true);
alter policy app_authenticated_all on acquisition.einstellungen using (true) with check (true);
alter policy app_authenticated_all on acquisition.email_pruefung using (true) with check (true);
alter policy app_authenticated_all on acquisition.leads using (true) with check (true);
alter policy app_authenticated_all on acquisition.leads_manuell using (true) with check (true);
alter policy app_authenticated_all on acquisition.outreach using (true) with check (true);
alter policy app_authenticated_all on acquisition.runs using (true) with check (true);
alter policy app_authenticated_all on acquisition.suppression using (true) with check (true);
alter policy app_authenticated_all on acquisition.templates using (true) with check (true);
alter policy app_authenticated_all on acquisition.zielgruppen using (true) with check (true);

-- ── F8-38 ──────────────────────────────────────────────────────────────────
alter policy all_read_verwaltungen on public.verwaltungen using (true);

-- ── S1-10 ──────────────────────────────────────────────────────────────────
alter policy whe_admin on public.webhook_errors using (true) with check (true);
alter policy des_admin on public.drive_external_sources using (true) with check (true);
alter policy auth_full_access on public.deck_clients using ((auth.uid() IS NOT NULL));
alter policy auth_full_access on public.decks using ((auth.uid() IS NOT NULL));
alter policy auth_full_access on public.project_deck_images using ((auth.uid() IS NOT NULL));

-- ── I4-24 / S1-14 / D3-3 (vorher: RLS aus) ─────────────────────────────────
alter table public.deck_assets_backup disable row level security;

-- ── S1-13 (vorher: reloptions leer) ────────────────────────────────────────
alter view public.deck_facts_resolved reset (security_invoker);

-- ── S1-18 ──────────────────────────────────────────────────────────────────
alter policy task_assignee_write on public.crm_task_assignees
  with check (((EXISTS ( SELECT 1
   FROM crm_tasks x
  WHERE ((x.id = crm_task_assignees.task_id) AND (x.created_by = auth.uid())))) OR (profile_id = auth.uid())));

alter policy task_msg_insert on public.crm_task_messages
  with check ((sender_id = auth.uid()));

-- Vorher relacl: {postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}, keine Spaltenrechte.
revoke update (read_at, notified_at) on public.crm_task_messages from authenticated;
grant  update on public.crm_task_messages to anon, authenticated;

-- Vorher: nur trg_crm_tasks_touch auf crm_tasks.
drop trigger if exists trg_crm_tasks_parent_lock on public.crm_tasks;
drop function if exists public.hp_crm_tasks_parent_lock();

-- ── S1-9 / S2-6 / I4-14 / E4-2 / S1-11 ─────────────────────────────────────
-- Vorher je: {=X/postgres,postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
grant execute on function public.claim_workflow_runs(integer) to public, anon, authenticated;
grant execute on function public.claim_deck_jobs(integer) to public, anon, authenticated;
grant execute on function public.hp_reap_deck_jobs(integer) to public, anon, authenticated;
grant execute on function public.hp_sunday_archive() to public, anon, authenticated;
grant execute on function public.hp_auto_lost() to public, anon, authenticated;
grant execute on function public.hp_archive_completed_deals() to public, anon, authenticated;
grant execute on function public.hp_klaviyo_upsert(uuid, jsonb) to public, anon, authenticated;
grant execute on function public.hp_sync_deck_assets_catalog(uuid) to public, anon, authenticated;
grant execute on function public.fn_ensure_deal_property(uuid) to public, anon, authenticated;
grant execute on function public.hp_seo_purge() to public, anon, authenticated;
grant execute on function public.find_task_by_assignee_phone(text) to public, anon, authenticated;
grant execute on function public.list_staff() to public, anon;

-- list_staff wie vorher (E-Mail für jeden Aufrufer), pg_get_functiondef live 30.9.2026.
CREATE OR REPLACE FUNCTION public.list_staff()
 RETURNS TABLE(id uuid, full_name text, email text, role text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $fn$
  select p.id, p.full_name, p.email, p.role
  from profiles p
  where p.role in ('admin','verwalter','mitarbeiter','funnel') and coalesce(p.is_active, true)
  order by p.full_name
$fn$;

-- ── E5-18 / F8-12 / S1-12 ──────────────────────────────────────────────────
-- Vorher: {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
grant execute on function public.claim_invoice_number() to authenticated;

-- ── I4-23 (vorher: proconfig leer) ─────────────────────────────────────────
alter function public.get_calculation_by_token(text) reset search_path;
alter function public.get_calculation_lang(text) reset search_path;
alter function public.get_deck_lang(text) reset search_path;
alter function public.get_contract_for_signing(uuid) reset search_path;
alter function public.sign_contract(uuid) reset search_path;
alter function public.claim_deck_jobs(integer) reset search_path;
alter function public.claim_workflow_runs(integer) reset search_path;
