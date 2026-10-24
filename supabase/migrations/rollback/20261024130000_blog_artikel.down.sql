drop function if exists public.blog_zuruecknehmen(uuid);
drop function if exists public.blog_ablehnen(uuid, text);
drop function if exists public.blog_freigeben(uuid);
drop function if exists public.blog_naechster_termin();
drop table if exists public.blog_artikel;
delete from public.crm_settings where key = 'blog_autopilot';
delete from public.social_topics where key = 'blog';
