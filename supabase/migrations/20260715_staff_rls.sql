-- ── Mitarbeiter-RLS: additive Policies je Bereich über current_user_has_perm() ──
-- Nur-additiv (permissive) → bestehende admin/verwalter-Policies bleiben unberührt.
-- Aktiviert sich ausschließlich, wenn der Mitarbeiter das jeweilige Recht gesetzt hat.
-- Fehlende Tabellen werden übersprungen (to_regclass-Guard), damit die Migration robust ist.
do $$
declare
  rec record;
begin
  for rec in
    select * from (values
      -- Pipeline & Leads
      ('leads','pipeline'), ('deals','pipeline'), ('activities','pipeline'),
      ('crm_appointments','pipeline'), ('scheduled_messages','pipeline'),
      ('property_calculations','pipeline'), ('engagement_events','pipeline'),
      ('booking_conversations','pipeline'), ('lead_ai_summaries','pipeline'),
      ('crm_projects','pipeline'), ('crm_project_units','pipeline'),
      ('lead_registrations','pipeline'), ('crm_unit_documents','pipeline'),
      -- Sales-Decks
      ('sales_decks','decks'), ('deck_outbox','decks'), ('deck_ai_rules','decks'),
      -- Funnel & Newsletter
      ('funnel_config','funnel'), ('funnel_sessions','funnel'), ('funnel_events','funnel'),
      ('newsletter_campaigns','funnel'), ('newsletter_recipients','funnel'),
      -- Rechnungen
      ('crm_invoices','invoices'),
      -- Kontakte
      ('crm_business_contacts','contacts'), ('crm_developer_contacts','contacts'),
      ('crm_developers','contacts')
    ) as t(tbl, area)
  loop
    if to_regclass(rec.tbl) is not null then
      execute format('drop policy if exists %I on %I', rec.tbl || '_staff_perm', rec.tbl);
      execute format(
        'create policy %I on %I for all to authenticated using (current_user_has_perm(%L)) with check (current_user_has_perm(%L))',
        rec.tbl || '_staff_perm', rec.tbl, rec.area, rec.area);
    end if;
  end loop;
end $$;
