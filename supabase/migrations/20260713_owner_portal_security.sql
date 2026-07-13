-- Eigentümer-Portal Sicherheits-Härtung (Audit 2026-07-13)
-- Schließt Cross-Tenant-Lecks: Eingeloggte Eigentümer (role 'eigentuemer') konnten
-- über zu offene RLS-/Storage-Policies (using(true) bzw. nur bucket_id-Check) Daten
-- ANDERER Eigentümer und interne Staff-Daten lesen/ändern/löschen.
-- Zugriff läuft künftig nur noch für Staff (admin/verwalter) bzw. — bei eigenen
-- Dokumenten — für den jeweiligen Eigentümer. Öffentliche Pfade (Rechnung /rechnung/:token)
-- laufen über SECURITY-DEFINER-RPCs und sind nicht betroffen. Edge Functions nutzen
-- den service_role-Key und umgehen RLS ohnehin.

-- ── 1. KRITISCH: documents-Storage-Bucket (Mietverträge/Rechnungen als PDF) ──
-- Vorher: jeder authenticated konnte ALLE Dateien listen/laden/löschen.
-- Pfadschema: <property_id>/<timestamp>-<rand>-<name>  →  erstes Segment = property_id.
drop policy if exists "docs_storage_read"   on storage.objects;
drop policy if exists "docs_storage_upload" on storage.objects;
drop policy if exists "docs_storage_delete" on storage.objects;

create policy "docs_storage_read" on storage.objects for select to authenticated
  using (
    bucket_id = 'documents' and (
      public.current_user_role() in ('admin','verwalter')
      or exists (
        select 1 from public.properties p
        where p.id::text = split_part(name, '/', 1)
          and p.owner_id = auth.uid()
      )
    )
  );
create policy "docs_storage_upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and public.current_user_role() in ('admin','verwalter'));
create policy "docs_storage_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and public.current_user_role() in ('admin','verwalter'));

-- ── 2. Tabellen-Policies mit using(true) → auf Staff einschränken ──
-- property_calculations: Rendite-Rechnungen aller Kunden. Öffentlicher /rechnung/:token
-- läuft über RPC get_calculation_by_token (SECURITY DEFINER), braucht keine anon-Policy.
drop policy if exists "pc_auth_all" on public.property_calculations;
create policy "pc_staff_all" on public.property_calculations for all to authenticated
  using (public.current_user_role() in ('admin','verwalter'))
  with check (public.current_user_role() in ('admin','verwalter'));

-- lead_registrations: Lead↔Developer-Provisionsschutz (rein intern)
drop policy if exists "lead_registrations_rw" on public.lead_registrations;
create policy "lead_registrations_staff" on public.lead_registrations for all to authenticated
  using (public.current_user_role() in ('admin','verwalter'))
  with check (public.current_user_role() in ('admin','verwalter'));

-- funnel_sessions / funnel_events: Interessenten-Tracking (auch Rolle 'funnel' = Statistik)
drop policy if exists "funnel_sessions_read" on public.funnel_sessions;
create policy "funnel_sessions_staff" on public.funnel_sessions for select to authenticated
  using (public.current_user_role() in ('admin','verwalter','funnel'));
drop policy if exists "funnel_events_read" on public.funnel_events;
create policy "funnel_events_staff" on public.funnel_events for select to authenticated
  using (public.current_user_role() in ('admin','verwalter','funnel'));

-- deck_outbox: ausgehende Kunden-Mails (Empfänger + HTML)
drop policy if exists "deck_outbox_staff" on public.deck_outbox;
create policy "deck_outbox_staff" on public.deck_outbox for all to authenticated
  using (public.current_user_role() in ('admin','verwalter'))
  with check (public.current_user_role() in ('admin','verwalter'));

-- crm_settings / booking_bot_messages / deck_ai_rules: interne CRM-/Bot-Daten
drop policy if exists "crm_settings_rw" on public.crm_settings;
create policy "crm_settings_staff" on public.crm_settings for all to authenticated
  using (public.current_user_role() in ('admin','verwalter'))
  with check (public.current_user_role() in ('admin','verwalter'));
drop policy if exists "booking_bot_messages_all" on public.booking_bot_messages;
create policy "booking_bot_messages_staff" on public.booking_bot_messages for all to authenticated
  using (public.current_user_role() in ('admin','verwalter'))
  with check (public.current_user_role() in ('admin','verwalter'));
drop policy if exists "deck_ai_rules_all" on public.deck_ai_rules;
create policy "deck_ai_rules_staff" on public.deck_ai_rules for all to authenticated
  using (public.current_user_role() in ('admin','verwalter'))
  with check (public.current_user_role() in ('admin','verwalter'));

notify pgrst, 'reload schema';
