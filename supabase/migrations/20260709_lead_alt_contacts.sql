-- Mehrfach-Kontaktdaten je Lead: Haupt-Mail/-Nummer bleiben leads.email/phone/whatsapp,
-- weitere Adressen/Nummern als Arrays (z.B. privates Google-Konto neben Geschäftsmail).
-- Duplikat-Matching (Funnel/Webhooks) berücksichtigt die Alternativen mit.
alter table leads add column if not exists alt_emails text[] not null default '{}';
alter table leads add column if not exists alt_phones text[] not null default '{}';
