-- Tippgeber-Programm, Ausbau 5.11.2026: Provision je Kunde auch prozentual.
--   leads.referral_commission_percent: Prozent unserer Netto-Provision aus dem Deal.
--   Schließt einen festen Betrag aus (entweder referral_commission oder Prozent).
--   affiliate_payouts.commission_percent + commission_base: wie der ausgezahlte Betrag
--   zustande kam, als Nachweis. Bei festen Beträgen bleiben beide leer.
-- Alles additiv, alte Bundles/Functions ignorieren die neuen Spalten.

alter table leads add column if not exists referral_commission_percent numeric(5,2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_referral_commission_percent_chk') then
    alter table leads add constraint leads_referral_commission_percent_chk
      check (referral_commission_percent is null or (referral_commission_percent > 0 and referral_commission_percent <= 100));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'leads_referral_commission_one_chk') then
    alter table leads add constraint leads_referral_commission_one_chk
      check (referral_commission is null or referral_commission_percent is null);
  end if;
end $$;
comment on column leads.referral_commission_percent is 'Tippgeber-Provision fuer diesen Kunden in Prozent unserer Netto-Provision; null = fester Betrag (referral_commission bzw. Standard)';

alter table affiliate_payouts add column if not exists commission_percent numeric(5,2);
alter table affiliate_payouts add column if not exists commission_base    numeric(12,2);
comment on column affiliate_payouts.commission_percent is 'Prozentsatz, mit dem amount berechnet wurde; null = fester Betrag';
comment on column affiliate_payouts.commission_base is 'Netto-Provision, auf die der Prozentsatz angewendet wurde; null = fester Betrag';
