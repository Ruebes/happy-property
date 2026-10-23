alter table public.affiliates
  drop column if exists address_source,
  drop column if exists address_note,
  drop column if exists address_checked_at,
  drop column if exists address_requested_at,
  drop column if exists address_reply_text;
