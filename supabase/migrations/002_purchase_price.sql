-- ============================================================
-- Happy Property – Migration 002: Kaufpreis-Felder
-- ============================================================

alter table public.properties
  add column if not exists purchase_price_gross numeric(14,2),
  add column if not exists vat_rate             numeric(5,2) not null default 19,
  add column if not exists purchase_price_net   numeric(14,2);

comment on column public.properties.purchase_price_gross is 'Kaufpreis Brutto (€)';
comment on column public.properties.vat_rate             is 'MwSt.-Satz in % (Standard 19)';
comment on column public.properties.purchase_price_net   is 'Kaufpreis Netto = Brutto / (1 + MwSt/100), wird clientseitig berechnet und gespeichert';
