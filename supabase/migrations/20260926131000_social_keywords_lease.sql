-- Stichwort-Automatik (Function social-keywords): Sperren gegen doppelte Läufe und
-- öffentliche Ersatz-Antwort, wenn Meta keine private Nachricht erlaubt.
--
-- 1) last_attempt_at: Zeitpunkt des letzten Sendeversuchs einer Zeile. Eine
--    Wiederholung wird nur beansprucht, wenn der letzte Versuch älter als 10 Minuten
--    ist (RPC social_keywords_claim, atomar in EINEM UPDATE). So kann ein Lauf keine
--    Zeile übernehmen, die ein anderer Lauf gerade noch sendet.
-- 2) Lauf-Sperre in crm_settings social_keywords_running_since (verfällt nach
--    5 Minuten), damit sich Cron-Lauf und Handstart nicht überlappen.
-- 3) public_fallback_replies in crm_settings social_keywords ergänzen (nur wenn der
--    Schlüssel fehlt, alle anderen Einstellungen bleiben unverändert).

alter table social_keyword_replies add column if not exists last_attempt_at timestamptz;

create or replace function social_keywords_claim(p_id uuid, p_lease_minutes int default 10)
returns setof social_keyword_replies
language sql
security definer
set search_path = public
as $$
  update social_keyword_replies
     set last_attempt_at = now(), attempts = attempts + 1
   where id = p_id
     and status = 'pending'
     and (last_attempt_at is null or last_attempt_at < now() - make_interval(mins => p_lease_minutes))
  returning *;
$$;

create or replace function social_keywords_run_lock(p_run text, p_ttl_seconds int default 300)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  ok boolean;
begin
  insert into crm_settings (key, value, updated_at)
  values ('social_keywords_running_since', json_build_object('since', now(), 'run', p_run)::text, now())
  on conflict (key) do update
     set value = excluded.value, updated_at = excluded.updated_at
   where crm_settings.value = ''
      or crm_settings.updated_at is null
      or crm_settings.updated_at < now() - make_interval(secs => p_ttl_seconds)
  returning true into ok;
  return coalesce(ok, false);
end
$$;

create or replace function social_keywords_run_unlock(p_run text)
returns void
language sql
security definer
set search_path = public
as $$
  update crm_settings
     set value = '', updated_at = now()
   where key = 'social_keywords_running_since'
     and position(p_run in value) > 0;
$$;

-- Nur die Edge Function (Service-Role) darf diese Funktionen aufrufen.
revoke all on function social_keywords_claim(uuid, int) from public, anon, authenticated;
revoke all on function social_keywords_run_lock(text, int) from public, anon, authenticated;
revoke all on function social_keywords_run_unlock(text) from public, anon, authenticated;
grant execute on function social_keywords_claim(uuid, int) to service_role;
grant execute on function social_keywords_run_lock(text, int) to service_role;
grant execute on function social_keywords_run_unlock(text) to service_role;

-- Ersatz-Texte ergänzen, bestehendes JSON sonst unverändert lassen
do $$
begin
  update crm_settings
     set value = jsonb_pretty(value::jsonb || jsonb_build_object('public_fallback_replies', jsonb_build_array(
           'Hier ist dein Zypern-Report als PDF: {{link}} 📩',
           'Gern! Den aktuellen Zypern-Report findest du hier: {{link}}'
         ))),
         updated_at = now()
   where key = 'social_keywords'
     and not (value::jsonb ? 'public_fallback_replies');
exception when invalid_text_representation then
  raise notice 'crm_settings social_keywords ist kein gültiges JSON, public_fallback_replies nicht ergänzt';
end
$$;
