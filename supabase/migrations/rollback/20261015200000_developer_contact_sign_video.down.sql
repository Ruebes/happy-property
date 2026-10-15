-- Rücknahme von 20261015200000_developer_contact_sign_video.sql
alter table public.crm_developer_contacts drop column if exists sign_wa_video;
