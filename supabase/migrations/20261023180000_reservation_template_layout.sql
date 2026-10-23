-- Reservierungsvorlagen mit eigenem Vordruck je Bauträger (Sven 23.10.2026, Pafilia/Minthis).
-- layout: 'mito' = bisheriger Aufbau (pdf.ts), 'pafilia' = Pafilia-Vordruck (pdfPafilia.ts)
-- extra:  Zusatzfelder des Vordrucks, z. B. {registration_no, payment_term, reservation_term, price_note}
-- Rücknahme: alter table public.reservation_templates drop column if exists layout, drop column if exists extra;
alter table public.reservation_templates
  add column if not exists layout text not null default 'mito',
  add column if not exists extra jsonb not null default '{}'::jsonb;
