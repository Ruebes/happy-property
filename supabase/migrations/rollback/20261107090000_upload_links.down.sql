drop index if exists public.drive_folder_files_upload_link_idx;
alter table public.drive_folder_files drop column if exists upload_link_id;
drop table if exists public.upload_links;
