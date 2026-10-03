-- Downloadbereich der Eigentümer in Ordner gliedern + Zypern-Report automatisch ablegen.
--   category      Ordner im Portal (/eigentuemer/downloads?ordner=<category>)
--   report_month  YYYY-MM, nur beim automatisch abgelegten Zypern-Report gesetzt;
--                 unique = jede Ausgabe landet höchstens einmal im Portal.
alter table public.owner_documents
  add column if not exists category text not null default 'sonstiges',
  add column if not exists report_month text;

alter table public.owner_documents drop constraint if exists owner_documents_category_check;
alter table public.owner_documents add constraint owner_documents_category_check
  check (category in ('monatsbericht', 'steuer', 'wohnung', 'vermietung', 'ratgeber', 'sonstiges'));

create unique index if not exists owner_documents_report_month_key
  on public.owner_documents (report_month) where report_month is not null;

-- Bestand einsortieren
update public.owner_documents set category = 'steuer'   where category = 'sonstiges' and title ilike '%steuer%';
update public.owner_documents set category = 'ratgeber' where category = 'sonstiges' and title ilike '%guide%';
update public.owner_documents set category = 'wohnung'  where category = 'sonstiges' and property_id is not null;
