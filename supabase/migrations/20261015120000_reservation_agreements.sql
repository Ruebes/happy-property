-- Reservierungsvertrag automatisch (Sven 15.10.26):
-- Deal geht auf „Reservierung" → Kunde lädt seinen Ausweis in den Drive-Ordner →
-- reservation-agreement erkennt den Ausweis (KI liest Name + Passnummer), füllt den
-- Reservierungsvertrag des Bauträgers aus und schickt ihn an den Bauträger.
-- Kunde + Bauträger bekommen Drive-Zugang und Nachricht wie bisher über die
-- automation_rules der Stufe reservierung (unverändert).

-- ── Vorlage je Bauträger ("Reservierung Mito") ─────────────────────────────────
create table if not exists public.reservation_templates (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  developer_id      uuid not null references public.crm_developers(id) on delete cascade,
  name              text not null,
  is_active         boolean not null default true,
  -- false = jeder Vertrag geht erst an Sven zur Prüfung, nie direkt an den Bauträger
  auto_send         boolean not null default true,
  -- Kopf + Fuß des Vordrucks
  logo_text         text,
  company_name      text not null,
  title             text not null default 'Reservation agreement',
  accent_color      text not null default '#e3874a',
  company_address   text,
  company_tel       text,
  -- "MITO" → Property Name "MITO MAMBA"
  property_prefix   text,
  -- { "<crm_projects.id>": "Chloraka, Paphos, 8220, Cyprus" }; fehlt ein Projekt, gilt crm_projects.location
  project_addresses jsonb not null default '{}'::jsonb,
  -- { account_name, account_number, iban, swift, bank_name }
  bank              jsonb not null default '{}'::jsonb,
  -- Bedingungen, Absätze mit Leerzeile getrennt
  notes             text
);
create unique index if not exists reservation_templates_one_active
  on public.reservation_templates (developer_id) where is_active;

alter table public.reservation_templates enable row level security;
drop policy if exists reservation_templates_team_lesen on public.reservation_templates;
create policy reservation_templates_team_lesen on public.reservation_templates for select to authenticated
  using ((select public.current_user_role()) = any (array['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]));
drop policy if exists reservation_templates_admin_schreiben on public.reservation_templates;
create policy reservation_templates_admin_schreiben on public.reservation_templates for all to authenticated
  using ((select public.current_user_role()) = 'admin'::text)
  with check ((select public.current_user_role()) = 'admin'::text);

-- ── Ein Vertrag je Deal ────────────────────────────────────────────────────────
create table if not exists public.reservation_agreements (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deal_id           uuid not null references public.deals(id) on delete cascade,
  lead_id           uuid not null references public.leads(id) on delete cascade,
  unit_id           uuid references public.crm_project_units(id) on delete set null,
  template_id       uuid references public.reservation_templates(id) on delete set null,
  -- wartet_ausweis → (gesendet | pruefen); pruefen → gesendet per Knopf; abgebrochen = Deal verloren
  status            text not null default 'wartet_ausweis'
                      check (status in ('wartet_ausweis', 'pruefen', 'gesendet', 'fehler', 'abgebrochen')),
  -- Käufer aus den Ausweisen: [{ full_name, document_number, document_type, nationality, date_of_birth, expiry_date, file_id, file_name }]
  buyers            jsonb not null default '[]'::jsonb,
  -- Prüfergebnis je Drive-Datei, damit jede Datei nur einmal durch die KI läuft
  checked_files     jsonb not null default '{}'::jsonb,
  last_id_at        timestamptz,
  review_reason     text,
  error             text,
  -- ausgefüllte Felder des letzten erzeugten PDFs
  data              jsonb,
  pdf_path          text,
  unit_document_id  uuid,
  drive_file_id     text,
  sent_at           timestamptz,
  sent_to           text[],
  sven_notified_at  timestamptz
);
create unique index if not exists reservation_agreements_deal on public.reservation_agreements (deal_id);
create index if not exists reservation_agreements_offen on public.reservation_agreements (created_at)
  where status in ('wartet_ausweis', 'gesendet');

-- Nur Edge Functions schreiben (Service-Role umgeht RLS). Das Team darf lesen.
alter table public.reservation_agreements enable row level security;
drop policy if exists reservation_agreements_team_lesen on public.reservation_agreements;
create policy reservation_agreements_team_lesen on public.reservation_agreements for select to authenticated
  using ((select public.current_user_role()) = any (array['admin'::text, 'verwalter'::text, 'mitarbeiter'::text]));

-- ── Vorlage „Reservierung Mito" (nachgebaut aus dem Vordruck von Jelena Ilic, Mamba A1, 22.09.2026) ──
insert into public.reservation_templates
  (developer_id, name, logo_text, company_name, title, company_address, company_tel, property_prefix, project_addresses, bank, notes)
select d.id, 'Reservierung Mito', 'MITO', 'MITO INVESTMENTS LTD', 'Reservation agreement',
  '52 Chrysoneras Avenue Kissonerga 8574', '+357 99 11 6466', 'MITO',
  coalesce((
    select jsonb_object_agg(p.id::text, case p.name
      when 'Mamba'     then 'Chloraka, Paphos, 8220, Cyprus'
      when 'Infinity'  then '113 Evagora Pallikaridi Avenue, 8010 Paphos, Cyprus'
      when 'Sea View'  then 'Kissonerga, Paphos, Cyprus'
      else 'Paphos, Cyprus' end)
    from public.crm_projects p where p.developer ilike 'mito'
  ), '{}'::jsonb),
  jsonb_build_object(
    'account_name',   'MITO INVESTMENTS LTD',
    'account_number', '589-01-979683-01',
    'iban',           'CY93 0050 0589 0005 8901 9796 8301',
    'swift',          'HEBACY2N',
    'bank_name',      'HELLENIC BANK PUBLIC COMPANY LTD'),
  E'1. This reservation agreement will officially come into effect after the buyer''s reservation deposit reaches the designated account of MITO Developers.\n\n'
  || E'2. The buyer agrees to sign a Sales Agreement with MITO within THREE months (90 days) after this reservation agreement takes effect. If the buyer fails to sign the said agreement for more than three months or fails to fulfill the payment schedule in the contract after signing the contract, both parties agree that the reservation agreement will be canceled, and MITO has the right to unilaterally sell the property reserved by the buyer to other customers. The deposit paid by the buyer will become the buyer''s advance deposit with MITO. The advance deposit can be returned to the buyer or counted towards a new Sales Agreement with Mito.'
from public.crm_developers d
where d.name ilike 'mito'
  and not exists (select 1 from public.reservation_templates t where t.developer_id = d.id);

-- Schalter: on = an den Bauträger | test = alles nur an Sven | off = nichts tun.
-- Startet auf test; Sven schaltet nach der Abnahme auf on.
insert into public.crm_settings (key, value) values ('reservation_agreement_mode', 'test')
on conflict (key) do nothing;

-- Cron alle 5 Minuten. Header wie hp-owner-drive-sweep, damit kein Schlüssel im Repo steht.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'hp-reservation-agreement') then
    perform cron.unschedule('hp-reservation-agreement');
  end if;
  perform cron.schedule('hp-reservation-agreement', '*/5 * * * *',
    replace((select command from cron.job where jobname = 'hp-owner-drive-sweep'),
      'functions/v1/owner-drive', 'functions/v1/reservation-agreement'));
end $$;
