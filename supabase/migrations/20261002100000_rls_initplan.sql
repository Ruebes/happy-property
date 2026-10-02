-- -----------------------------------------------------------------------------
-- RLS-Helfer einmal pro Abfrage statt pro Zeile (Audit P4-1, Advisor auth_rls_initplan)
-- Erzeugt von scripts/gen-rls-initplan.mjs aus pg_policies, live gelesen am 2.10.2026. Nicht von Hand ändern,
-- sondern den Generator mit einem frischen Stand neu laufen lassen.
-- Umfang: alle betroffenen Policies in public und acquisition: 163 Policies auf 91 Tabellen,
-- davon 107 mit mindestens einem Aufruf außerhalb jeder Unterabfrage (dort wirkt es am stärksten).
--
-- Was passiert: in USING und WITH CHECK wird jeder Aufruf von auth.uid(), current_user_role() und
-- current_user_has_perm('<feste Zeichenkette>') in ( SELECT ... AS ...) eingepackt. Postgres rechnet ihn
-- dann einmal pro Abfrage aus (InitPlan) statt für jede gelesene Zeile neu. Sonst bleibt jeder Ausdruck
-- Zeichen für Zeichen der Live-Stand.
--
-- Ändert kein Zugriffsergebnis: die drei Funktionen hängen nur vom eingeloggten Nutzer ab und liefern
-- innerhalb einer Abfrage für jede Zeile denselben Wert. Nur ALTER POLICY: keine Policy wird gelöscht
-- oder neu angelegt (auch die doppelten Policies aus P4-6 bleiben), Rollen, Befehl und permissive/
-- restrictive bleiben unverändert. Nicht eingepackt: schon eingepackte Aufrufe und Aufrufe mit
-- Spaltenbezug wie current_user_has_perm(('werbung_'::text || platform)) (zeilenabhängig).
--
-- Schutz: der erste Block bricht ab, ohne etwas zu ändern, wenn eine dieser Policies live nicht mehr
-- exakt dem Stand vom 2.10.2026 entspricht (dann Generator mit frischem pg_policies-Stand neu laufen
-- lassen). Der letzte Block bricht ab, wenn das Ergebnis nicht exakt dem erwarteten Text entspricht.
--
-- VOR DEM EINSPIELEN PFLICHT: Sichtbarkeitsmatrix als Trockenlauf (rls-matrix.mjs: Schnappschuss
-- vorher, Schnappschuss mit --with <diese Datei>, dann diff) muss 0 Unterschiede zeigen.
-- Einspielen als Ganzes in EINER Transaktion zu einer ruhigen Zeit (SQL-Editor oder
-- psql --single-transaction -f): ALTER POLICY sperrt jede Tabelle kurz exklusiv, lock_timeout 3 s.
--
-- Rückweg: supabase/migrations/rollback/20261002100000_rls_initplan.down.sql stellt die Originaltexte exakt wieder her.
-- -----------------------------------------------------------------------------
set local lock_timeout = '3s';
-- gleicher Suchpfad wie beim Lesen von pg_policies: Namen werden genauso aufgelöst und
-- der Prüfblock vergleicht denselben Text, den pg_policies beim Lesen geliefert hat
set local search_path = public;

do $guard$
declare
  v_abweichend text;
begin
  select string_agg(format('%s.%s/%s', e.s, e.t, e.p), ', ' order by e.s, e.t, e.p)
    into v_abweichend
  from (values
    ('public', 'activities', 'activities_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'activities', 'crm_activities_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'activity_log', 'activity_log_admin_read', '22ed65f5aabee3b2eb019a76bead8c06'),
    ('public', 'ad_actions', 'ad_actions_insert', '6d0076b7dd0e877c86a24d3a6aac59ff'),
    ('public', 'ad_actions', 'ad_actions_read', '640fcd61eba74ad14e7075159f1c0040'),
    ('public', 'ad_actions', 'ad_actions_update', '640fcd61eba74ad14e7075159f1c0040'),
    ('public', 'ad_catalog', 'ad_catalog_read', '640fcd61eba74ad14e7075159f1c0040'),
    ('public', 'ad_insights_daily', 'ad_insights_read', '640fcd61eba74ad14e7075159f1c0040'),
    ('public', 'ad_settings', 'ad_settings_read', '12d4f8a8100b7fdbb23ff1a7c5af80a1'),
    ('public', 'ad_settings', 'ad_settings_update', '2f3dccdaa96dd4096d29069313c6d6b8'),
    ('public', 'ads_ai_examples', 'ads_ai_examples_read', '2f3dccdaa96dd4096d29069313c6d6b8'),
    ('public', 'ads_ai_rules', 'ads_ai_rules_rw', '2f3dccdaa96dd4096d29069313c6d6b8'),
    ('public', 'ai_reply_examples', 'ai_reply_examples_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'automation_rules', 'admin_automation_rules', 'f13f7f9fc93a7c5cf86f47601c2274ce'),
    ('public', 'bank_change_notifications', 'admin_verwalter_read', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'bank_change_notifications', 'admin_verwalter_update', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'bank_change_notifications', 'owner_insert', 'd92432e64e4c00058aa2947d0360e51c'),
    ('public', 'bank_change_notifications', 'owner_read_own', '5c4f86eed44e70580df23041e77381dc'),
    ('public', 'booking_bot_messages', 'booking_bot_messages_staff', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'booking_conversations', 'booking_conv_admin_read', 'cadefe8beb6900deec91526d53c3a8ab'),
    ('public', 'booking_conversations', 'booking_conversations_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'booking_invites', 'bi_admin_all', '784b8b0db124bbb443991e5f6b7a4076'),
    ('public', 'booking_invites', 'bi_own_read', '313e44480baa6ba818924c8249bea5ce'),
    ('public', 'bookings', 'bookings_eigentuemer_select', 'f71a4517e4d2c79826eb94758049b714'),
    ('public', 'bookings', 'bookings_guest_read', '7265e9cb5d9a3e76f55f50afa5d8ade3'),
    ('public', 'bookings', 'bookings_verwalter_admin_select', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'bookings', 'bookings_verwalter_admin_update', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'bookings', 'bookings_verwalter_admin_write', '18066a568b8bd33a5941e5e0d238b489'),
    ('public', 'capi_log', 'capi_log_read', '12d4f8a8100b7fdbb23ff1a7c5af80a1'),
    ('public', 'communication_optouts', 'admin_verwalter_optouts', '22ed65f5aabee3b2eb019a76bead8c06'),
    ('public', 'construction_photos', 'construction_photos_admin', 'aa7bc11f9c22f6c4c711388c04abdab6'),
    ('public', 'construction_photos', 'construction_photos_eigentuemer_select', 'd29a016ed589724f946fe75f00a24923'),
    ('public', 'contracts', 'contracts_eigentuemer_select', 'f71a4517e4d2c79826eb94758049b714'),
    ('public', 'contracts', 'contracts_verwalter_admin_select', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'contracts', 'contracts_verwalter_admin_update', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'contracts', 'contracts_verwalter_admin_write', '18066a568b8bd33a5941e5e0d238b489'),
    ('public', 'crm_adhoc_messages', 'crm_adhoc_messages_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'crm_appointments', 'admin_verwalter_all', '8c75b02b200d62f3737622be8056ae38'),
    ('public', 'crm_appointments', 'crm_appointments_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'crm_business_contacts', 'crm_business_contacts_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'crm_business_contacts', 'crm_business_contacts_staff_perm', '7e36dcbb57423ce4a6216263add38cfb'),
    ('public', 'crm_developer_contacts', 'crm_developer_contacts_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'crm_developer_contacts', 'crm_developer_contacts_staff_perm', '7e36dcbb57423ce4a6216263add38cfb'),
    ('public', 'crm_developers', 'crm_developers_rw', '8c75b02b200d62f3737622be8056ae38'),
    ('public', 'crm_developers', 'crm_developers_staff_perm', '7e36dcbb57423ce4a6216263add38cfb'),
    ('public', 'crm_invoice_items', 'crm_invoice_items_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'crm_invoices', 'crm_invoices_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'crm_invoices', 'crm_invoices_staff_perm', 'ee1e14dbf7702c5422f9293c734d3e19'),
    ('public', 'crm_project_units', 'crm_project_units_rw', '8c75b02b200d62f3737622be8056ae38'),
    ('public', 'crm_project_units', 'crm_project_units_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'crm_projects', 'crm_projects_rw', '8c75b02b200d62f3737622be8056ae38'),
    ('public', 'crm_projects', 'crm_projects_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'crm_settings', 'crm_settings_staff', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'crm_strategy_scenarios', 'strategy_staff', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'crm_strategy_scenarios', 'strategy_staff_perm', '38de4b423e6229f1f8f3d473571c9ce7'),
    ('public', 'crm_task_assignees', 'task_assignee_write', 'ecb9479b3bbae9f1d706fb02eb15bb05'),
    ('public', 'crm_task_attachments', 'cta_reporter_read', '7674fae7e9044c63b9c8034e086e974c'),
    ('public', 'crm_task_attachments', 'cta_staff_all', '8fd69b9e3e3b6ab52d4d160583ddb7fa'),
    ('public', 'crm_task_leads', 'task_lead_write', 'ada107a6b97ce2f0ab3e2252cf379249'),
    ('public', 'crm_task_messages', 'task_msg_update', '0a14077d967fcda7c2d5e44e94e31d12'),
    ('public', 'crm_tasks', 'crm_tasks_delete', 'a319faabd68bb768fd92100c62085c30'),
    ('public', 'crm_tasks', 'crm_tasks_insert', '228c2ef899455ff50f7241e4bab6b6b1'),
    ('public', 'crm_tasks', 'crm_tasks_select', '68cf709abbf9f7480d3ab02e84bbdcd3'),
    ('public', 'crm_tasks', 'crm_tasks_update', '25fb713a38b0b86d4e9f62f1ce297008'),
    ('public', 'crm_unit_documents', 'crm_unit_docs_eigentuemer_insert', '9bd74cd8b02823930772fd66a68e337c'),
    ('public', 'crm_unit_documents', 'crm_unit_documents_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'crm_unit_documents', 'unit_docs_rw', '8c75b02b200d62f3737622be8056ae38'),
    ('public', 'crm_unit_payments', 'unit_payments_rw', '8c75b02b200d62f3737622be8056ae38'),
    ('public', 'crm_webhooks', 'crm_webhooks_admin', '2c74c856867b1e44741f149a89c85d91'),
    ('public', 'deal_projects', 'deal_projects_rw', '8c75b02b200d62f3737622be8056ae38'),
    ('public', 'deals', 'crm_deals_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'deals', 'deals_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'deck_ai_rules', 'deck_ai_rules_staff', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'deck_ai_rules', 'deck_ai_rules_staff_perm', '38de4b423e6229f1f8f3d473571c9ce7'),
    ('public', 'deck_assets_catalog', 'deck_assets_catalog_staff', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'deck_assets_catalog', 'deck_assets_catalog_staff_perm', '38de4b423e6229f1f8f3d473571c9ce7'),
    ('public', 'deck_facts', 'deck_facts_staff', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'deck_facts', 'deck_facts_staff_perm', '38de4b423e6229f1f8f3d473571c9ce7'),
    ('public', 'deck_generation_jobs', 'deck_jobs_staff', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'deck_generation_jobs', 'deck_jobs_staff_perm', '38de4b423e6229f1f8f3d473571c9ce7'),
    ('public', 'deck_outbox', 'deck_outbox_staff', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'deck_outbox', 'deck_outbox_staff_perm', '38de4b423e6229f1f8f3d473571c9ce7'),
    ('public', 'documents', 'documents_eigentuemer_delete', 'b88a38df3deaaece3d230a9ad9e4a0c1'),
    ('public', 'documents', 'documents_eigentuemer_select', 'f71a4517e4d2c79826eb94758049b714'),
    ('public', 'documents', 'documents_eigentuemer_write', '13c837115299073a39d61fea6a3c0d7b'),
    ('public', 'documents', 'documents_verwalter_admin_delete', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'documents', 'documents_verwalter_admin_select', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'documents', 'documents_verwalter_admin_update', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'documents', 'documents_verwalter_admin_write', '18066a568b8bd33a5941e5e0d238b489'),
    ('public', 'email_templates', 'crm_templates_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'engagement_events', 'engagement_events_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'fin_payables', 'fin_payables_staff', '784b8b0db124bbb443991e5f6b7a4076'),
    ('public', 'fin_rules', 'fin_rules_staff', '784b8b0db124bbb443991e5f6b7a4076'),
    ('public', 'fin_transactions', 'fin_transactions_staff', '784b8b0db124bbb443991e5f6b7a4076'),
    ('public', 'funnel_config', 'funnel_config_staff_perm', '8ba860a4b3ad3fabb3dd0680fb29068f'),
    ('public', 'funnel_config', 'funnel_config_write', '909d904c72c792672229e97134366857'),
    ('public', 'funnel_events', 'funnel_events_staff', '3c46c0a0a0c023bc2a08f658b67ea080'),
    ('public', 'funnel_events', 'funnel_events_staff_perm', '8ba860a4b3ad3fabb3dd0680fb29068f'),
    ('public', 'funnel_sessions', 'funnel_sessions_staff', '3c46c0a0a0c023bc2a08f658b67ea080'),
    ('public', 'funnel_sessions', 'funnel_sessions_staff_perm', '8ba860a4b3ad3fabb3dd0680fb29068f'),
    ('public', 'funnel_workflow_runs', 'fwr_staff', '8ba860a4b3ad3fabb3dd0680fb29068f'),
    ('public', 'funnel_workflows', 'fw_staff', '8ba860a4b3ad3fabb3dd0680fb29068f'),
    ('public', 'guest_agreements', 'guest_agreements_admin_all', '22ed65f5aabee3b2eb019a76bead8c06'),
    ('public', 'guest_agreements', 'guest_agreements_guest_insert', 'b65661ab783a00efda94895832e3f5dc'),
    ('public', 'guest_agreements', 'guest_agreements_guest_read', '7265e9cb5d9a3e76f55f50afa5d8ade3'),
    ('public', 'health_findings', 'hf_admin', '784b8b0db124bbb443991e5f6b7a4076'),
    ('public', 'health_runs', 'hr_admin', '784b8b0db124bbb443991e5f6b7a4076'),
    ('public', 'income_entries', 'income_eigentuemer_select', 'f71a4517e4d2c79826eb94758049b714'),
    ('public', 'income_entries', 'income_verwalter_admin_select', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'income_entries', 'income_verwalter_admin_update', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'income_entries', 'income_verwalter_admin_write', '18066a568b8bd33a5941e5e0d238b489'),
    ('public', 'invoice_articles', 'invoice_articles_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'invoice_customers', 'invoice_customers_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'invoice_settings', 'invoice_settings_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'lead_ai_summaries', 'admin_only', 'f13f7f9fc93a7c5cf86f47601c2274ce'),
    ('public', 'lead_ai_summaries', 'lead_ai_summaries_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'lead_registrations', 'lead_registrations_staff', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'lead_registrations', 'lead_registrations_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'leads', 'crm_leads_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'leads', 'leads_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'messages', 'messages_booking_participant', '0c10b132aa58cf430fd9051a098e9677'),
    ('public', 'newsletter_campaigns', 'newsletter_campaigns_admin', 'b9a98076c03862715b183855fd984af4'),
    ('public', 'newsletter_campaigns', 'newsletter_campaigns_staff_perm', '8ba860a4b3ad3fabb3dd0680fb29068f'),
    ('public', 'newsletter_list_members', 'nl_members_admin', 'aad9c4cbc1551f60c41cde8c91eafb7a'),
    ('public', 'newsletter_lists', 'nl_lists_admin', 'aad9c4cbc1551f60c41cde8c91eafb7a'),
    ('public', 'newsletter_subscribers', 'nl_subs_admin', 'aad9c4cbc1551f60c41cde8c91eafb7a'),
    ('public', 'owner_documents', 'od_read', '759d9892f4afa6dc135d7bf0c97a760c'),
    ('public', 'owner_documents', 'od_write', '1a72908f9b63debeb2039f0b2acc8b0e'),
    ('public', 'owner_notifications', 'on_read', '313e44480baa6ba818924c8249bea5ce'),
    ('public', 'owner_notifications', 'on_update', 'c8e301bd8d6a61ab096188bb67b42684'),
    ('public', 'partner_mails', 'pm_staff', 'aad9c4cbc1551f60c41cde8c91eafb7a'),
    ('public', 'personal_booking_links', 'pbl_admin_all', '784b8b0db124bbb443991e5f6b7a4076'),
    ('public', 'portal_logins', 'portal_logins_admin_select', '4dc68a8f3765e179c46e3ed1c1bc6c93'),
    ('public', 'portal_logins', 'portal_logins_eigentuemer_insert', 'd57c5b4ebbc739fa698832584ae75564'),
    ('public', 'profiles', 'profiles_admin_all', '4dc68a8f3765e179c46e3ed1c1bc6c93'),
    ('public', 'profiles', 'profiles_own_select', '3650f7d3da8c01ef9c073f90c4277e96'),
    ('public', 'profiles', 'profiles_own_update', '3650f7d3da8c01ef9c073f90c4277e96'),
    ('public', 'profiles', 'profiles_verwalter_admin_select', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'properties', 'properties_admin_select', '4dc68a8f3765e179c46e3ed1c1bc6c93'),
    ('public', 'properties', 'properties_eigentuemer_select', '62c7dc54fe1ea939a1eab2e0c4c20ec6'),
    ('public', 'properties', 'properties_verwalter_delete', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'properties', 'properties_verwalter_select', '2e44a34be6f047760987991f042c5794'),
    ('public', 'properties', 'properties_verwalter_update', '9b3a8d4a24c9b6b05a2719069f39cacd'),
    ('public', 'properties', 'properties_verwalter_write', '18066a568b8bd33a5941e5e0d238b489'),
    ('public', 'property_calculations', 'pc_staff_all', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'property_calculations', 'property_calculations_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'property_co_owners', 'property_co_owners_owner_delete', '05a05b8d6cacaf1bd18fe3fcba84ef21'),
    ('public', 'property_co_owners', 'property_co_owners_owner_insert', 'd925a5c5733c0c640d0e1efe29fb7a37'),
    ('public', 'property_co_owners', 'property_co_owners_staff_all', '7d34ecb1caaab031d73a0b32a10e741d'),
    ('public', 'sales_decks', 'sales_decks_staff_all', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'sales_decks', 'sales_decks_staff_perm', '38de4b423e6229f1f8f3d473571c9ce7'),
    ('public', 'scheduled_messages', 'admin_verwalter_scheduled_messages', '22ed65f5aabee3b2eb019a76bead8c06'),
    ('public', 'scheduled_messages', 'scheduled_messages_staff_perm', 'a2219b7ec63da59d5e19f840f521d17c'),
    ('public', 'social_account_daily', 'social_account_daily_staff_read', '431e27450c7315998a980e32e75df70c'),
    ('public', 'social_keyword_replies', 'social_keyword_replies_staff_read', '431e27450c7315998a980e32e75df70c'),
    ('public', 'social_post_metrics', 'social_post_metrics_staff_read', '431e27450c7315998a980e32e75df70c'),
    ('public', 'studio_prepared_ads', 'spa_staff', '41145301365a7cf515f3697cb9c433af'),
    ('public', 'subscription_plans', 'subscription_plans_rw', '2c32fc1feed4ac4b8e8384b0f8f486ea'),
    ('public', 'verwaltungen', 'admins_manage_verwaltungen', 'b9a98076c03862715b183855fd984af4'),
    ('public', 'verwaltungen', 'verwalter_update_own_verwaltung', '13834404ebe3315ab47a0de7fa709b19'),
    ('public', 'whatsapp_templates', 'admin_only', 'b9a98076c03862715b183855fd984af4'),
    ('public', 'workflow_documents', 'admin_only', 'f13f7f9fc93a7c5cf86f47601c2274ce'),
    ('public', 'yt_videos', 'yt_videos_staff', '67731346b76feacca60eed536c8c9c13')
  ) as e(s, t, p, h)
  left join pg_catalog.pg_policies x
    on x.schemaname = e.s and x.tablename = e.t and x.policyname = e.p
  where x.policyname is null
     or md5(coalesce(x.qual, '<null>') || chr(10) || coalesce(x.with_check, '<null>')) <> e.h;
  if v_abweichend is not null then
    raise exception 'RLS-Initplan abgebrochen, nichts geändert. Diese Policies weichen vom gelesenen Stand ab oder fehlen: %', v_abweichend
      using hint = 'Generator scripts/gen-rls-initplan.mjs mit frischem pg_policies-Stand neu laufen lassen.';
  end if;
end $guard$;

ALTER POLICY activities_staff_perm ON public.activities
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY crm_activities_rw ON public.activities
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY activity_log_admin_read ON public.activity_log
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY ad_actions_insert ON public.ad_actions
  WITH CHECK ((( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm) OR current_user_has_perm(('werbung_'::text || platform))));

ALTER POLICY ad_actions_read ON public.ad_actions
  USING ((( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm) OR current_user_has_perm(('werbung_'::text || platform))));

ALTER POLICY ad_actions_update ON public.ad_actions
  USING ((( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm) OR current_user_has_perm(('werbung_'::text || platform))));

ALTER POLICY ad_catalog_read ON public.ad_catalog
  USING ((( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm) OR current_user_has_perm(('werbung_'::text || platform))));

ALTER POLICY ad_insights_read ON public.ad_insights_daily
  USING ((( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm) OR current_user_has_perm(('werbung_'::text || platform))));

ALTER POLICY ad_settings_read ON public.ad_settings
  USING ((( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm) OR ( SELECT current_user_has_perm('werbung_meta'::text) AS current_user_has_perm)));

ALTER POLICY ad_settings_update ON public.ad_settings
  USING (( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm));

ALTER POLICY ads_ai_examples_read ON public.ads_ai_examples
  USING (( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm));

ALTER POLICY ads_ai_rules_rw ON public.ads_ai_rules
  USING (( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm));

ALTER POLICY ai_reply_examples_rw ON public.ai_reply_examples
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY admin_automation_rules ON public.automation_rules
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))));

ALTER POLICY admin_verwalter_read ON public.bank_change_notifications
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY admin_verwalter_update ON public.bank_change_notifications
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY owner_insert ON public.bank_change_notifications
  WITH CHECK ((owner_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY owner_read_own ON public.bank_change_notifications
  USING ((owner_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY booking_bot_messages_staff ON public.booking_bot_messages
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY booking_conv_admin_read ON public.booking_conversations
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY booking_conversations_staff_perm ON public.booking_conversations
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY bi_admin_all ON public.booking_invites
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY bi_own_read ON public.booking_invites
  USING ((profile_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY bookings_eigentuemer_select ON public.bookings
  USING (((( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text) AND (property_id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids))));

ALTER POLICY bookings_guest_read ON public.bookings
  USING ((guest_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY bookings_verwalter_admin_select ON public.bookings
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY bookings_verwalter_admin_update ON public.bookings
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY bookings_verwalter_admin_write ON public.bookings
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY capi_log_read ON public.capi_log
  USING ((( SELECT current_user_has_perm('werbung'::text) AS current_user_has_perm) OR ( SELECT current_user_has_perm('werbung_meta'::text) AS current_user_has_perm)));

ALTER POLICY admin_verwalter_optouts ON public.communication_optouts
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY construction_photos_admin ON public.construction_photos
  USING ((( SELECT current_user_role() AS current_user_role) = 'admin'::text))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = 'admin'::text));

ALTER POLICY construction_photos_eigentuemer_select ON public.construction_photos
  USING (((( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text) AND (project_id IN ( SELECT u.project_id
   FROM crm_project_units u
  WHERE (u.id IN ( SELECT hp_owner_unit_ids() AS hp_owner_unit_ids))))));

ALTER POLICY contracts_eigentuemer_select ON public.contracts
  USING (((( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text) AND (property_id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids))));

ALTER POLICY contracts_verwalter_admin_select ON public.contracts
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY contracts_verwalter_admin_update ON public.contracts
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY contracts_verwalter_admin_write ON public.contracts
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY crm_adhoc_messages_rw ON public.crm_adhoc_messages
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY admin_verwalter_all ON public.crm_appointments
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY crm_appointments_staff_perm ON public.crm_appointments
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY crm_business_contacts_rw ON public.crm_business_contacts
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY crm_business_contacts_staff_perm ON public.crm_business_contacts
  USING (( SELECT current_user_has_perm('contacts'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('contacts'::text) AS current_user_has_perm));

ALTER POLICY crm_developer_contacts_rw ON public.crm_developer_contacts
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY crm_developer_contacts_staff_perm ON public.crm_developer_contacts
  USING (( SELECT current_user_has_perm('contacts'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('contacts'::text) AS current_user_has_perm));

ALTER POLICY crm_developers_rw ON public.crm_developers
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY crm_developers_staff_perm ON public.crm_developers
  USING (( SELECT current_user_has_perm('contacts'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('contacts'::text) AS current_user_has_perm));

ALTER POLICY crm_invoice_items_rw ON public.crm_invoice_items
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY crm_invoices_rw ON public.crm_invoices
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY crm_invoices_staff_perm ON public.crm_invoices
  USING (( SELECT current_user_has_perm('invoices'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('invoices'::text) AS current_user_has_perm));

ALTER POLICY crm_project_units_rw ON public.crm_project_units
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY crm_project_units_staff_perm ON public.crm_project_units
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY crm_projects_rw ON public.crm_projects
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY crm_projects_staff_perm ON public.crm_projects
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY crm_settings_staff ON public.crm_settings
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY strategy_staff ON public.crm_strategy_scenarios
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY strategy_staff_perm ON public.crm_strategy_scenarios
  USING (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm));

ALTER POLICY task_assignee_write ON public.crm_task_assignees
  USING (((EXISTS ( SELECT 1
   FROM crm_tasks x
  WHERE ((x.id = crm_task_assignees.task_id) AND (x.created_by = ( SELECT auth.uid() AS uid))))) OR (profile_id = ( SELECT auth.uid() AS uid))))
  WITH CHECK (((EXISTS ( SELECT 1
   FROM crm_tasks x
  WHERE ((x.id = crm_task_assignees.task_id) AND (x.created_by = ( SELECT auth.uid() AS uid))))) OR ((profile_id = ( SELECT auth.uid() AS uid)) AND is_task_participant(task_id))));

ALTER POLICY cta_reporter_read ON public.crm_task_attachments
  USING ((EXISTS ( SELECT 1
   FROM crm_tasks tk
  WHERE ((tk.id = crm_task_attachments.task_id) AND (tk.reporter_profile_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY cta_staff_all ON public.crm_task_attachments
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text])));

ALTER POLICY task_lead_write ON public.crm_task_leads
  USING ((EXISTS ( SELECT 1
   FROM crm_tasks x
  WHERE ((x.id = crm_task_leads.task_id) AND (x.created_by = ( SELECT auth.uid() AS uid))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM crm_tasks x
  WHERE ((x.id = crm_task_leads.task_id) AND (x.created_by = ( SELECT auth.uid() AS uid))))));

ALTER POLICY task_msg_update ON public.crm_task_messages
  USING ((recipient_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY crm_tasks_delete ON public.crm_tasks
  USING ((created_by = ( SELECT auth.uid() AS uid)));

ALTER POLICY crm_tasks_insert ON public.crm_tasks
  WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) AND ((parent_task_id IS NULL) OR hp_parent_task_participant(parent_task_id))));

ALTER POLICY crm_tasks_select ON public.crm_tasks
  USING (((created_by = ( SELECT auth.uid() AS uid)) OR (assigned_to = ( SELECT auth.uid() AS uid)) OR my_task_assignee(id) OR ((parent_task_id IS NOT NULL) AND hp_parent_task_participant(parent_task_id))));

ALTER POLICY crm_tasks_update ON public.crm_tasks
  USING (((created_by = ( SELECT auth.uid() AS uid)) OR (assigned_to = ( SELECT auth.uid() AS uid)) OR my_task_assignee(id)))
  WITH CHECK (((created_by = ( SELECT auth.uid() AS uid)) OR (assigned_to = ( SELECT auth.uid() AS uid)) OR my_task_assignee(id)));

ALTER POLICY crm_unit_docs_eigentuemer_insert ON public.crm_unit_documents
  WITH CHECK (((uploaded_by = ( SELECT auth.uid() AS uid)) AND (unit_id IN ( SELECT hp_owner_unit_ids() AS hp_owner_unit_ids))));

ALTER POLICY crm_unit_documents_staff_perm ON public.crm_unit_documents
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY unit_docs_rw ON public.crm_unit_documents
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY unit_payments_rw ON public.crm_unit_payments
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY crm_webhooks_admin ON public.crm_webhooks
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = 'admin'::text));

ALTER POLICY deal_projects_rw ON public.deal_projects
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY crm_deals_rw ON public.deals
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY deals_staff_perm ON public.deals
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY deck_ai_rules_staff ON public.deck_ai_rules
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY deck_ai_rules_staff_perm ON public.deck_ai_rules
  USING (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm));

ALTER POLICY deck_assets_catalog_staff ON public.deck_assets_catalog
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY deck_assets_catalog_staff_perm ON public.deck_assets_catalog
  USING (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm));

ALTER POLICY deck_facts_staff ON public.deck_facts
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY deck_facts_staff_perm ON public.deck_facts
  USING (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm));

ALTER POLICY deck_jobs_staff ON public.deck_generation_jobs
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY deck_jobs_staff_perm ON public.deck_generation_jobs
  USING (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm));

ALTER POLICY deck_outbox_staff ON public.deck_outbox
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY deck_outbox_staff_perm ON public.deck_outbox
  USING (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm));

ALTER POLICY documents_eigentuemer_delete ON public.documents
  USING (((( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text) AND (uploaded_by = ( SELECT auth.uid() AS uid)) AND (property_id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids))));

ALTER POLICY documents_eigentuemer_select ON public.documents
  USING (((( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text) AND (property_id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids))));

ALTER POLICY documents_eigentuemer_write ON public.documents
  WITH CHECK (((( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text) AND (uploaded_by = ( SELECT auth.uid() AS uid)) AND (property_id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids))));

ALTER POLICY documents_verwalter_admin_delete ON public.documents
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY documents_verwalter_admin_select ON public.documents
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY documents_verwalter_admin_update ON public.documents
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY documents_verwalter_admin_write ON public.documents
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY crm_templates_rw ON public.email_templates
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY engagement_events_staff_perm ON public.engagement_events
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY fin_payables_staff ON public.fin_payables
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY fin_rules_staff ON public.fin_rules
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY fin_transactions_staff ON public.fin_transactions
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY funnel_config_staff_perm ON public.funnel_config
  USING (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm));

ALTER POLICY funnel_config_write ON public.funnel_config
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'funnel'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'funnel'::text]))))));

ALTER POLICY funnel_events_staff ON public.funnel_events
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text, 'funnel'::text])));

ALTER POLICY funnel_events_staff_perm ON public.funnel_events
  USING (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm));

ALTER POLICY funnel_sessions_staff ON public.funnel_sessions
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text, 'funnel'::text])));

ALTER POLICY funnel_sessions_staff_perm ON public.funnel_sessions
  USING (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm));

ALTER POLICY fwr_staff ON public.funnel_workflow_runs
  USING (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm));

ALTER POLICY fw_staff ON public.funnel_workflows
  USING (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm));

ALTER POLICY guest_agreements_admin_all ON public.guest_agreements
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY guest_agreements_guest_insert ON public.guest_agreements
  WITH CHECK ((guest_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY guest_agreements_guest_read ON public.guest_agreements
  USING ((guest_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY hf_admin ON public.health_findings
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY hr_admin ON public.health_runs
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY income_eigentuemer_select ON public.income_entries
  USING (((( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text) AND (property_id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids))));

ALTER POLICY income_verwalter_admin_select ON public.income_entries
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY income_verwalter_admin_update ON public.income_entries
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY income_verwalter_admin_write ON public.income_entries
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY invoice_articles_rw ON public.invoice_articles
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY invoice_customers_rw ON public.invoice_customers
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY invoice_settings_rw ON public.invoice_settings
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY admin_only ON public.lead_ai_summaries
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))));

ALTER POLICY lead_ai_summaries_staff_perm ON public.lead_ai_summaries
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY lead_registrations_staff ON public.lead_registrations
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY lead_registrations_staff_perm ON public.lead_registrations
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY crm_leads_rw ON public.leads
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY leads_staff_perm ON public.leads
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY messages_booking_participant ON public.messages
  USING ((EXISTS ( SELECT 1
   FROM bookings b
  WHERE ((b.id = messages.booking_id) AND ((b.guest_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
           FROM profiles
          WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))))));

ALTER POLICY newsletter_campaigns_admin ON public.newsletter_campaigns
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))));

ALTER POLICY newsletter_campaigns_staff_perm ON public.newsletter_campaigns
  USING (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('funnel'::text) AS current_user_has_perm));

ALTER POLICY nl_members_admin ON public.newsletter_list_members
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))));

ALTER POLICY nl_lists_admin ON public.newsletter_lists
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))));

ALTER POLICY nl_subs_admin ON public.newsletter_subscribers
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))));

ALTER POLICY od_read ON public.owner_documents
  USING (((property_id IS NULL) OR (property_id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids)) OR (EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin'::text, 'verwalter'::text])))))));

ALTER POLICY od_write ON public.owner_documents
  USING ((EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles pr
  WHERE ((pr.id = ( SELECT auth.uid() AS uid)) AND (pr.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY on_read ON public.owner_notifications
  USING ((profile_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY on_update ON public.owner_notifications
  USING ((profile_id = ( SELECT auth.uid() AS uid)))
  WITH CHECK ((profile_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY pm_staff ON public.partner_mails
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]))))));

ALTER POLICY pbl_admin_all ON public.personal_booking_links
  USING ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = ( SELECT auth.uid() AS uid)) AND (p.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY portal_logins_admin_select ON public.portal_logins
  USING ((( SELECT current_user_role() AS current_user_role) = 'admin'::text));

ALTER POLICY portal_logins_eigentuemer_insert ON public.portal_logins
  WITH CHECK ((profile_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY profiles_admin_all ON public.profiles
  USING ((( SELECT current_user_role() AS current_user_role) = 'admin'::text));

ALTER POLICY profiles_own_select ON public.profiles
  USING ((id = ( SELECT auth.uid() AS uid)));

ALTER POLICY profiles_own_update ON public.profiles
  USING ((id = ( SELECT auth.uid() AS uid)));

ALTER POLICY profiles_verwalter_admin_select ON public.profiles
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY properties_admin_select ON public.properties
  USING ((( SELECT current_user_role() AS current_user_role) = 'admin'::text));

ALTER POLICY properties_eigentuemer_select ON public.properties
  USING (((id IN ( SELECT hp_my_property_ids() AS hp_my_property_ids)) AND (( SELECT current_user_role() AS current_user_role) = 'eigentuemer'::text)));

ALTER POLICY properties_verwalter_delete ON public.properties
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY properties_verwalter_select ON public.properties
  USING ((( SELECT current_user_role() AS current_user_role) = 'verwalter'::text));

ALTER POLICY properties_verwalter_update ON public.properties
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY properties_verwalter_write ON public.properties
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY pc_staff_all ON public.property_calculations
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY property_calculations_staff_perm ON public.property_calculations
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY property_co_owners_owner_delete ON public.property_co_owners
  USING ((EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = property_co_owners.property_id) AND (p.owner_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY property_co_owners_owner_insert ON public.property_co_owners
  WITH CHECK (((EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = property_co_owners.property_id) AND (p.owner_id = ( SELECT auth.uid() AS uid))))) AND (invited_by = ( SELECT auth.uid() AS uid))));

ALTER POLICY property_co_owners_staff_all ON public.property_co_owners
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY sales_decks_staff_all ON public.sales_decks
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY sales_decks_staff_perm ON public.sales_decks
  USING (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('decks'::text) AS current_user_has_perm));

ALTER POLICY admin_verwalter_scheduled_messages ON public.scheduled_messages
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text]))))));

ALTER POLICY scheduled_messages_staff_perm ON public.scheduled_messages
  USING (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm));

ALTER POLICY social_account_daily_staff_read ON public.social_account_daily
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text, 'funnel'::text])));

ALTER POLICY social_keyword_replies_staff_read ON public.social_keyword_replies
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text, 'funnel'::text])));

ALTER POLICY social_post_metrics_staff_read ON public.social_post_metrics
  USING ((( SELECT current_user_role() AS current_user_role) = ANY (ARRAY['admin'::text, 'verwalter'::text, 'mitarbeiter'::text, 'funnel'::text])));

ALTER POLICY spa_staff ON public.studio_prepared_ads
  USING ((( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND ((profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text])) OR (((profiles.permissions ->> 'werbung'::text))::boolean IS TRUE)))))))
  WITH CHECK ((( SELECT current_user_has_perm('pipeline'::text) AS current_user_has_perm) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND ((profiles.role = ANY (ARRAY['admin'::text, 'verwalter'::text])) OR (((profiles.permissions ->> 'werbung'::text))::boolean IS TRUE)))))));

ALTER POLICY subscription_plans_rw ON public.subscription_plans
  USING ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])))
  WITH CHECK ((( SELECT profiles.role
   FROM profiles
  WHERE (profiles.id = ( SELECT auth.uid() AS uid))) = ANY (ARRAY['admin'::text, 'verwalter'::text])));

ALTER POLICY admins_manage_verwaltungen ON public.verwaltungen
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))));

ALTER POLICY verwalter_update_own_verwaltung ON public.verwaltungen
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.verwaltung_id = verwaltungen.id) AND (profiles.role = 'verwalter'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.verwaltung_id = verwaltungen.id) AND (profiles.role = 'verwalter'::text)))));

ALTER POLICY admin_only ON public.whatsapp_templates
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))))
  WITH CHECK ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))));

ALTER POLICY admin_only ON public.workflow_documents
  USING ((EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.role = 'admin'::text)))));

ALTER POLICY yt_videos_staff ON public.yt_videos
  USING (( SELECT current_user_has_perm('youtube'::text) AS current_user_has_perm))
  WITH CHECK (( SELECT current_user_has_perm('youtube'::text) AS current_user_has_perm));

do $verify$
declare
  v_abweichend text;
begin
  select string_agg(format('%s.%s/%s', e.s, e.t, e.p), ', ' order by e.s, e.t, e.p)
    into v_abweichend
  from (values
    ('public', 'activities', 'activities_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'activities', 'crm_activities_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'activity_log', 'activity_log_admin_read', '912b5af9501365904eb7e82f20cf59c4'),
    ('public', 'ad_actions', 'ad_actions_insert', '9600d599a7f515af33bfdf395fdf2a62'),
    ('public', 'ad_actions', 'ad_actions_read', '4df583a394a180efaa15f9c910505050'),
    ('public', 'ad_actions', 'ad_actions_update', '4df583a394a180efaa15f9c910505050'),
    ('public', 'ad_catalog', 'ad_catalog_read', '4df583a394a180efaa15f9c910505050'),
    ('public', 'ad_insights_daily', 'ad_insights_read', '4df583a394a180efaa15f9c910505050'),
    ('public', 'ad_settings', 'ad_settings_read', '6da95dd897a0883afa322910305acac7'),
    ('public', 'ad_settings', 'ad_settings_update', '0bb08e3db5b5fd5d75942cea431dafa3'),
    ('public', 'ads_ai_examples', 'ads_ai_examples_read', '0bb08e3db5b5fd5d75942cea431dafa3'),
    ('public', 'ads_ai_rules', 'ads_ai_rules_rw', '0bb08e3db5b5fd5d75942cea431dafa3'),
    ('public', 'ai_reply_examples', 'ai_reply_examples_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'automation_rules', 'admin_automation_rules', '7e477300647d0eda650969fdf2823a10'),
    ('public', 'bank_change_notifications', 'admin_verwalter_read', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'bank_change_notifications', 'admin_verwalter_update', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'bank_change_notifications', 'owner_insert', '0b703f4d05e68b436fd2d6acbfa3fced'),
    ('public', 'bank_change_notifications', 'owner_read_own', '1b29efdec0d1b4874f7352f816f6b921'),
    ('public', 'booking_bot_messages', 'booking_bot_messages_staff', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'booking_conversations', 'booking_conv_admin_read', '680a87716bda288803266476a844e8d3'),
    ('public', 'booking_conversations', 'booking_conversations_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'booking_invites', 'bi_admin_all', '4ca0454842aa51bdf5e060a33b17bf47'),
    ('public', 'booking_invites', 'bi_own_read', 'e3de3ff76c651b18d035b0df5710b6c3'),
    ('public', 'bookings', 'bookings_eigentuemer_select', '768925787159e19fe1ed3046e4966374'),
    ('public', 'bookings', 'bookings_guest_read', '546661c782f922a909d822d56cb6bb57'),
    ('public', 'bookings', 'bookings_verwalter_admin_select', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'bookings', 'bookings_verwalter_admin_update', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'bookings', 'bookings_verwalter_admin_write', 'cbdec3582c2af4be32ef0dfd327a6fa5'),
    ('public', 'capi_log', 'capi_log_read', '6da95dd897a0883afa322910305acac7'),
    ('public', 'communication_optouts', 'admin_verwalter_optouts', '912b5af9501365904eb7e82f20cf59c4'),
    ('public', 'construction_photos', 'construction_photos_admin', '0d16cc14263af5b6e8de45f55fb2a51b'),
    ('public', 'construction_photos', 'construction_photos_eigentuemer_select', '37570cfb450958766253e93c556a1ed8'),
    ('public', 'contracts', 'contracts_eigentuemer_select', '768925787159e19fe1ed3046e4966374'),
    ('public', 'contracts', 'contracts_verwalter_admin_select', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'contracts', 'contracts_verwalter_admin_update', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'contracts', 'contracts_verwalter_admin_write', 'cbdec3582c2af4be32ef0dfd327a6fa5'),
    ('public', 'crm_adhoc_messages', 'crm_adhoc_messages_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'crm_appointments', 'admin_verwalter_all', '0ad7933141033b240f8269ae827728f7'),
    ('public', 'crm_appointments', 'crm_appointments_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'crm_business_contacts', 'crm_business_contacts_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'crm_business_contacts', 'crm_business_contacts_staff_perm', 'fe813c7f2dc19bd28962c91deef65321'),
    ('public', 'crm_developer_contacts', 'crm_developer_contacts_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'crm_developer_contacts', 'crm_developer_contacts_staff_perm', 'fe813c7f2dc19bd28962c91deef65321'),
    ('public', 'crm_developers', 'crm_developers_rw', '0ad7933141033b240f8269ae827728f7'),
    ('public', 'crm_developers', 'crm_developers_staff_perm', 'fe813c7f2dc19bd28962c91deef65321'),
    ('public', 'crm_invoice_items', 'crm_invoice_items_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'crm_invoices', 'crm_invoices_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'crm_invoices', 'crm_invoices_staff_perm', '43c84f296fd18d55f64c9973fa01f6e3'),
    ('public', 'crm_project_units', 'crm_project_units_rw', '0ad7933141033b240f8269ae827728f7'),
    ('public', 'crm_project_units', 'crm_project_units_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'crm_projects', 'crm_projects_rw', '0ad7933141033b240f8269ae827728f7'),
    ('public', 'crm_projects', 'crm_projects_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'crm_settings', 'crm_settings_staff', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'crm_strategy_scenarios', 'strategy_staff', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'crm_strategy_scenarios', 'strategy_staff_perm', '8ef976b6199e4fe601082d0a17f80abc'),
    ('public', 'crm_task_assignees', 'task_assignee_write', '7f20a26e51a3c427ae7b32c0f09b9332'),
    ('public', 'crm_task_attachments', 'cta_reporter_read', '4b567fefcb17f7977444100a28e40a3f'),
    ('public', 'crm_task_attachments', 'cta_staff_all', 'dce3048afe688b9f132c48b3574c67a9'),
    ('public', 'crm_task_leads', 'task_lead_write', 'a43be8666634f21518ebd75b274b11b3'),
    ('public', 'crm_task_messages', 'task_msg_update', '0c1da63fe1226f66fd173cb7e4fa7263'),
    ('public', 'crm_tasks', 'crm_tasks_delete', '3d330b0328ff2cf638ddf7f95826c8b3'),
    ('public', 'crm_tasks', 'crm_tasks_insert', '785f66e94f425cb7c313616e4e75fed0'),
    ('public', 'crm_tasks', 'crm_tasks_select', 'a19a6ded3c784b09d34c08191ecc6af8'),
    ('public', 'crm_tasks', 'crm_tasks_update', '16ab1d64993cbc629cffd43825e5b09a'),
    ('public', 'crm_unit_documents', 'crm_unit_docs_eigentuemer_insert', 'f2a5869ec333fc161df3b9bbb37a113f'),
    ('public', 'crm_unit_documents', 'crm_unit_documents_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'crm_unit_documents', 'unit_docs_rw', '0ad7933141033b240f8269ae827728f7'),
    ('public', 'crm_unit_payments', 'unit_payments_rw', '0ad7933141033b240f8269ae827728f7'),
    ('public', 'crm_webhooks', 'crm_webhooks_admin', '3590527d0c561c8adc4922111eb7d5ab'),
    ('public', 'deal_projects', 'deal_projects_rw', '0ad7933141033b240f8269ae827728f7'),
    ('public', 'deals', 'crm_deals_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'deals', 'deals_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'deck_ai_rules', 'deck_ai_rules_staff', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'deck_ai_rules', 'deck_ai_rules_staff_perm', '8ef976b6199e4fe601082d0a17f80abc'),
    ('public', 'deck_assets_catalog', 'deck_assets_catalog_staff', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'deck_assets_catalog', 'deck_assets_catalog_staff_perm', '8ef976b6199e4fe601082d0a17f80abc'),
    ('public', 'deck_facts', 'deck_facts_staff', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'deck_facts', 'deck_facts_staff_perm', '8ef976b6199e4fe601082d0a17f80abc'),
    ('public', 'deck_generation_jobs', 'deck_jobs_staff', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'deck_generation_jobs', 'deck_jobs_staff_perm', '8ef976b6199e4fe601082d0a17f80abc'),
    ('public', 'deck_outbox', 'deck_outbox_staff', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'deck_outbox', 'deck_outbox_staff_perm', '8ef976b6199e4fe601082d0a17f80abc'),
    ('public', 'documents', 'documents_eigentuemer_delete', '3a60912e1c322b09791c1334d6428e6d'),
    ('public', 'documents', 'documents_eigentuemer_select', '768925787159e19fe1ed3046e4966374'),
    ('public', 'documents', 'documents_eigentuemer_write', '12e1263a3ccec1ae5b29d7f686b2d340'),
    ('public', 'documents', 'documents_verwalter_admin_delete', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'documents', 'documents_verwalter_admin_select', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'documents', 'documents_verwalter_admin_update', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'documents', 'documents_verwalter_admin_write', 'cbdec3582c2af4be32ef0dfd327a6fa5'),
    ('public', 'email_templates', 'crm_templates_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'engagement_events', 'engagement_events_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'fin_payables', 'fin_payables_staff', '4ca0454842aa51bdf5e060a33b17bf47'),
    ('public', 'fin_rules', 'fin_rules_staff', '4ca0454842aa51bdf5e060a33b17bf47'),
    ('public', 'fin_transactions', 'fin_transactions_staff', '4ca0454842aa51bdf5e060a33b17bf47'),
    ('public', 'funnel_config', 'funnel_config_staff_perm', '03144ef1875392e908c7ca00f13d5363'),
    ('public', 'funnel_config', 'funnel_config_write', '5fdeaccb62bd3cfce6ad60d64c5e4457'),
    ('public', 'funnel_events', 'funnel_events_staff', '9116c9850a604c4dd5479389e127b405'),
    ('public', 'funnel_events', 'funnel_events_staff_perm', '03144ef1875392e908c7ca00f13d5363'),
    ('public', 'funnel_sessions', 'funnel_sessions_staff', '9116c9850a604c4dd5479389e127b405'),
    ('public', 'funnel_sessions', 'funnel_sessions_staff_perm', '03144ef1875392e908c7ca00f13d5363'),
    ('public', 'funnel_workflow_runs', 'fwr_staff', '03144ef1875392e908c7ca00f13d5363'),
    ('public', 'funnel_workflows', 'fw_staff', '03144ef1875392e908c7ca00f13d5363'),
    ('public', 'guest_agreements', 'guest_agreements_admin_all', '912b5af9501365904eb7e82f20cf59c4'),
    ('public', 'guest_agreements', 'guest_agreements_guest_insert', '91def662462e12c45986f6ef5686162f'),
    ('public', 'guest_agreements', 'guest_agreements_guest_read', '546661c782f922a909d822d56cb6bb57'),
    ('public', 'health_findings', 'hf_admin', '4ca0454842aa51bdf5e060a33b17bf47'),
    ('public', 'health_runs', 'hr_admin', '4ca0454842aa51bdf5e060a33b17bf47'),
    ('public', 'income_entries', 'income_eigentuemer_select', '768925787159e19fe1ed3046e4966374'),
    ('public', 'income_entries', 'income_verwalter_admin_select', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'income_entries', 'income_verwalter_admin_update', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'income_entries', 'income_verwalter_admin_write', 'cbdec3582c2af4be32ef0dfd327a6fa5'),
    ('public', 'invoice_articles', 'invoice_articles_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'invoice_customers', 'invoice_customers_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'invoice_settings', 'invoice_settings_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'lead_ai_summaries', 'admin_only', '7e477300647d0eda650969fdf2823a10'),
    ('public', 'lead_ai_summaries', 'lead_ai_summaries_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'lead_registrations', 'lead_registrations_staff', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'lead_registrations', 'lead_registrations_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'leads', 'crm_leads_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'leads', 'leads_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'messages', 'messages_booking_participant', '2368037a30d94155e6bade682d448e82'),
    ('public', 'newsletter_campaigns', 'newsletter_campaigns_admin', '30a55a5b7b9cca9488de1f490d49860d'),
    ('public', 'newsletter_campaigns', 'newsletter_campaigns_staff_perm', '03144ef1875392e908c7ca00f13d5363'),
    ('public', 'newsletter_list_members', 'nl_members_admin', '9d65e6f09a6dc783ecc1bd490cd17bfb'),
    ('public', 'newsletter_lists', 'nl_lists_admin', '9d65e6f09a6dc783ecc1bd490cd17bfb'),
    ('public', 'newsletter_subscribers', 'nl_subs_admin', '9d65e6f09a6dc783ecc1bd490cd17bfb'),
    ('public', 'owner_documents', 'od_read', 'c3cddbb7e54b2c30f62d02350a1cda9b'),
    ('public', 'owner_documents', 'od_write', 'bd7b7e1de217ede1c47cbf0e0e8ef2d1'),
    ('public', 'owner_notifications', 'on_read', 'e3de3ff76c651b18d035b0df5710b6c3'),
    ('public', 'owner_notifications', 'on_update', '993996a32c555451087fa1ed56749800'),
    ('public', 'partner_mails', 'pm_staff', '9d65e6f09a6dc783ecc1bd490cd17bfb'),
    ('public', 'personal_booking_links', 'pbl_admin_all', '4ca0454842aa51bdf5e060a33b17bf47'),
    ('public', 'portal_logins', 'portal_logins_admin_select', 'c5529f29d098a1e2bb42764c7bd5ad53'),
    ('public', 'portal_logins', 'portal_logins_eigentuemer_insert', 'a000cce2b908ff44059998c8edbfa062'),
    ('public', 'profiles', 'profiles_admin_all', 'c5529f29d098a1e2bb42764c7bd5ad53'),
    ('public', 'profiles', 'profiles_own_select', 'e806364b95e8bca646366c62a63487fc'),
    ('public', 'profiles', 'profiles_own_update', 'e806364b95e8bca646366c62a63487fc'),
    ('public', 'profiles', 'profiles_verwalter_admin_select', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'properties', 'properties_admin_select', 'c5529f29d098a1e2bb42764c7bd5ad53'),
    ('public', 'properties', 'properties_eigentuemer_select', 'bd072886a15bd7d336caeed1ac4e254f'),
    ('public', 'properties', 'properties_verwalter_delete', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'properties', 'properties_verwalter_select', 'a1348e5bb5c5ba23f7558b7218cd98a8'),
    ('public', 'properties', 'properties_verwalter_update', 'a7df107161d5a468c3950cdef7addf7d'),
    ('public', 'properties', 'properties_verwalter_write', 'cbdec3582c2af4be32ef0dfd327a6fa5'),
    ('public', 'property_calculations', 'pc_staff_all', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'property_calculations', 'property_calculations_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'property_co_owners', 'property_co_owners_owner_delete', '86afdc8c8d41a7da4dd01588065decc8'),
    ('public', 'property_co_owners', 'property_co_owners_owner_insert', '3a0aa3a97466583f76a449a5beb0174f'),
    ('public', 'property_co_owners', 'property_co_owners_staff_all', '77bab5b28daf19c91f8b5f708fe93252'),
    ('public', 'sales_decks', 'sales_decks_staff_all', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'sales_decks', 'sales_decks_staff_perm', '8ef976b6199e4fe601082d0a17f80abc'),
    ('public', 'scheduled_messages', 'admin_verwalter_scheduled_messages', '912b5af9501365904eb7e82f20cf59c4'),
    ('public', 'scheduled_messages', 'scheduled_messages_staff_perm', '66fc670b6899ef9cb5a9c29e5384fa8d'),
    ('public', 'social_account_daily', 'social_account_daily_staff_read', '46806cec78478697d2b4f196fe72b640'),
    ('public', 'social_keyword_replies', 'social_keyword_replies_staff_read', '46806cec78478697d2b4f196fe72b640'),
    ('public', 'social_post_metrics', 'social_post_metrics_staff_read', '46806cec78478697d2b4f196fe72b640'),
    ('public', 'studio_prepared_ads', 'spa_staff', '88e6ed41d771d28f32cfa56e6be6a39b'),
    ('public', 'subscription_plans', 'subscription_plans_rw', 'e296ee8d8f6f7a2b912870e1a03f8f54'),
    ('public', 'verwaltungen', 'admins_manage_verwaltungen', '30a55a5b7b9cca9488de1f490d49860d'),
    ('public', 'verwaltungen', 'verwalter_update_own_verwaltung', 'd61c48db033142a9ced750f8925a5203'),
    ('public', 'whatsapp_templates', 'admin_only', '30a55a5b7b9cca9488de1f490d49860d'),
    ('public', 'workflow_documents', 'admin_only', '7e477300647d0eda650969fdf2823a10'),
    ('public', 'yt_videos', 'yt_videos_staff', '80f94fcf4a0fbe1aa9206037e52024b8')
  ) as e(s, t, p, h)
  left join pg_catalog.pg_policies x
    on x.schemaname = e.s and x.tablename = e.t and x.policyname = e.p
  where x.policyname is null
     or md5(coalesce(x.qual, '<null>') || chr(10) || coalesce(x.with_check, '<null>')) <> e.h;
  if v_abweichend is not null then
    raise exception 'RLS-Initplan: Ergebnis entspricht nicht dem erwarteten Text, alles wird zurückgerollt: %', v_abweichend
      using hint = 'Generator prüfen, Ausdruck nach ALTER POLICY anders formatiert als erwartet.';
  end if;
end $verify$;
