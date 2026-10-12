-- Rücknahme von 20261012151000_project_own_video.sql
alter table public.crm_projects drop column if exists own_video_url;
