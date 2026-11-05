-- Rücknahme von 20261105120000_referral_commission_percent.sql.
-- Vorher prüfen: Kunden mit Prozentsatz fielen danach auf den Standardbetrag zurück.
--   select id from public.leads where referral_commission_percent is not null;
alter table public.leads drop constraint if exists leads_referral_commission_one_chk;
alter table public.leads drop constraint if exists leads_referral_commission_percent_chk;
alter table public.leads drop column if exists referral_commission_percent;
alter table public.affiliate_payouts drop column if exists commission_percent;
alter table public.affiliate_payouts drop column if exists commission_base;
