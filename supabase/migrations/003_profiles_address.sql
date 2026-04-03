-- ============================================================
-- Happy Property – Migration 003
-- Erweitert profiles um Adressfelder und is_active Flag
-- ============================================================

alter table public.profiles
  add column if not exists address_street  text,
  add column if not exists address_zip     text,
  add column if not exists address_city    text,
  add column if not exists address_country text,
  add column if not exists is_active       boolean not null default true;
