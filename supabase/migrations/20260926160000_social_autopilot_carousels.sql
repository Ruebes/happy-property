-- News als Karussell statt Einzelbild (Sven 26.9.2026): Mo, Do, So je ein Karussell,
-- die Einzelbild-News am Di und Fr entfallen. Art bleibt 'news' (ältere Studio-
-- Versionen kennen neue Arten nicht), das Format steht im neuen Feld 'format'.
update crm_settings set value = jsonb_set(value::jsonb, '{slots}', (
  select jsonb_agg(
    case when s->>'kind' = 'news' then s || '{"format":"carousel"}'::jsonb else s end
  ) from jsonb_array_elements(value::jsonb -> 'slots') s
  where not (s->>'kind' = 'news' and (s->>'dow')::int in (2, 5))
))::text, updated_at = now()
where key = 'social_autopilot';
