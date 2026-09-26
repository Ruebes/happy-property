-- LinkedIn-Termine in eigenes Feld li_slots (alte Studio-Versionen im Browser-Cache
-- stürzten an der unbekannten Art 'linkedin' in slots ab).
update crm_settings set value = jsonb_set(value::jsonb, '{li_slots}',
  '[{"dow": 2, "kind": "linkedin", "time": "08:30"}, {"dow": 4, "kind": "linkedin", "time": "08:30"}]'::jsonb)::text,
  updated_at = now()
where key = 'social_autopilot';
