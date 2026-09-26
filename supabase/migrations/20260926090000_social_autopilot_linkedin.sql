-- Autopilot: LinkedIn bekommt eigene Posts (Di + Do 08:30, politisch angehaucht,
-- streitbar, seriös) statt der LinkedIn-Fassung der News (Svens Wunsch 26.9.2026).
insert into social_topics (key, label, icon, sort) values ('linkedin', 'LinkedIn-Meinung', '💼', 45)
  on conflict (key) do nothing;

update crm_settings set value = (
  select jsonb_set(value::jsonb, '{slots}', (
    select jsonb_agg(s - 'li_time') from jsonb_array_elements(value::jsonb -> 'slots') s
  ) || '[{"dow": 2, "kind": "linkedin", "time": "08:30"}, {"dow": 4, "kind": "linkedin", "time": "08:30"}]'::jsonb)::text
), updated_at = now()
where key = 'social_autopilot' and value not like '%"linkedin"%';
