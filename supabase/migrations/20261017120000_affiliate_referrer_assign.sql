-- Tippgeber-Programm, Ausbau 17.10.2026:
--   1. Empfehlungsgeber in jedem Kunden manuell zuweisen (leads.referred_by_affiliate
--      gab es schon, nur ohne Oberflaeche) + Provision je Kunde (Standard 1.000 €,
--      null = Standard).
--   2. Adresse/Status des Tippgebers fuer eine ordentliche Provisionsabrechnung
--      (Privatperson vs. Unternehmer mit USt-IdNr. → Gutschrift mit Reverse Charge).
--   3. Revolut-Payout-Link geht direkt mit der Abrechnung raus; Zustand des Links
--      wird nachgehalten (awaiting = Freigabe in der Revolut-App, processed = bezahlt).
-- Alles additiv, alte Bundles/Functions ignorieren die neuen Spalten.

alter table leads add column if not exists referral_commission numeric(10,2);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'leads_referral_commission_chk') then
    alter table leads add constraint leads_referral_commission_chk
      check (referral_commission is null or (referral_commission > 0 and referral_commission <= 100000));
  end if;
end $$;
comment on column leads.referral_commission is 'Tippgeber-Provision fuer diesen Kunden in EUR; null = Standard 1.000 €';

alter table affiliates add column if not exists street      text;
alter table affiliates add column if not exists postal_code text;
alter table affiliates add column if not exists city        text;
alter table affiliates add column if not exists country     text;
alter table affiliates add column if not exists is_business boolean not null default false;
alter table affiliates add column if not exists vat_id      text;

alter table affiliate_payouts add column if not exists service_date           date;
alter table affiliate_payouts add column if not exists payout_link_id         text;
alter table affiliate_payouts add column if not exists payout_link_state      text;
alter table affiliate_payouts add column if not exists payout_link_expires_at timestamptz;
alter table affiliate_payouts add column if not exists payout_link_sent_at    timestamptz;
alter table affiliate_payouts add column if not exists payout_link_error      text;
alter table affiliate_payouts add column if not exists payout_link_attempt    int not null default 0;

create index if not exists affiliate_payouts_link_open_idx on affiliate_payouts (payout_link_state)
  where payout_link_id is not null and status <> 'bezahlt';
