-- Neue Pipeline-Stufe „Provisionsrechnung“ (Sven 11.10.2026): zwischen Anzahlung und
-- Provision erhalten. Anzahlung = nur WhatsApp an Burkhard (Provision beim Bauträger
-- beantragen), Provisionsrechnung = Rechnung an Burkhard/Reeaals (Rechnungs-Fenster).
-- Die Stufe zählt wie Anzahlung als Verkauf: CAPI-Purchase/Kunde-Stufe feuern auch hier
-- (event_id je Deal bzw. Lead, on conflict do nothing → kein Doppel bei Anzahlung → Provisionsrechnung).

alter table public.deals drop constraint if exists deals_phase_check;
alter table public.deals add constraint deals_phase_check check (phase = any (array[
  'erstkontakt','termin_gebucht','no_show','finanzierung_de','finanzierung_cy','registrierung',
  'immobilienauswahl','reservierung','kaufvertrag','anzahlung','provisionsrechnung','provision_erhalten',
  'hold','kontakt_uebergeben','deal_verloren','archiviert']));

CREATE OR REPLACE FUNCTION public.werbe_capi_crm_deal_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_neu boolean;
begin
  begin
    if new.lead_id is null or new.phase is null or new.phase not in ('anzahlung', 'provisionsrechnung', 'provision_erhalten') then
      return new;
    end if;
    if tg_op = 'INSERT' then
      v_neu := true;
    else
      v_neu := old.phase is distinct from new.phase;
    end if;
    if v_neu then
      -- eine Stufe „Kunde“ je Lead (Anzahlung und später Provision = dieselbe event_id)
      perform public.werbe_capi_crm_stufe(new.lead_id, 'kunde', 'deals', new.id, now());
    end if;
  exception when others then
    raise warning 'werbe_capi_crm_deal_trg (%): % [%]', tg_op, sqlerrm, sqlstate;
  end;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.werbe_capi_deal_trg()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_neu boolean;
begin
  begin
    if new.lead_id is null or new.phase is null or new.phase not in ('anzahlung', 'provisionsrechnung', 'provision_erhalten') then
      return new;
    end if;
    if tg_op = 'INSERT' then
      v_neu := true;
    else
      v_neu := old.phase is distinct from new.phase;
    end if;
    if v_neu then
      -- event_id je Deal: Anzahlung und später Provision ergeben EIN Purchase (on conflict do nothing).
      perform public.werbe_capi_einreihen('sale-' || new.id::text, 'Purchase', new.lead_id, 'deals', new.id, now(),
                                          jsonb_build_object('phase', new.phase, 'commission_amount', new.commission_amount));
    end if;
  exception when others then
    raise warning 'werbe_capi_deal_trg (%): % [%]', tg_op, sqlerrm, sqlstate;
  end;
  return new;
end
$function$;

