-- Neue Pipeline-Stufen Hold + Kontakt übergeben + Tracking für wiederkehrende Nachrichten
alter table deals drop constraint if exists deals_phase_check;
alter table deals add constraint deals_phase_check check (phase = any (array[
  'erstkontakt','termin_gebucht','no_show','finanzierung_de','finanzierung_cy','registrierung',
  'immobilienauswahl','reservierung','kaufvertrag','anzahlung','provision_erhalten',
  'hold','kontakt_uebergeben','deal_verloren','archiviert']));
alter table deals add column if not exists hold_contact          boolean not null default false;
alter table deals add column if not exists handover_notes        text;
alter table deals add column if not exists handover_at           timestamptz;
alter table deals add column if not exists last_hold_msg_at       timestamptz;
alter table deals add column if not exists last_handover_ping_at  timestamptz;
