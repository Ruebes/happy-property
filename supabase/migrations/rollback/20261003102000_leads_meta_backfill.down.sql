-- Rückbau zu 20261003102000_leads_meta_backfill.sql (von Hand ausführen; liegt
-- bewusst im Unterordner rollback/, damit die Supabase-CLI die Datei nicht als
-- Migration einspielt). Als Ganzes in einer Transaktion ausführen.
--
-- Setzt genau die Werte zurück, die der Nachtrag laut public.leads_meta_nachtrag
-- geschrieben hat, und zwar nur, wenn sie seitdem unverändert sind. Was
-- meta-leads-sync, funnel-api oder meta-builder inzwischen selbst geschrieben
-- haben, bleibt stehen. meta_attr_quelle/meta_attr_at bekommen ihren vorherigen
-- Wert zurück. Danach wird das Protokoll gelöscht.
-- Nebenwirkung wie beim Nachtrag: leads.updated_at springt auf jetzt.
-- Ist die Protokoll-Tabelle nicht vorhanden (Nachtrag nie eingespielt), tut
-- die Datei nichts.

begin;

set local lock_timeout = '5s';

do $$
begin
  if to_regclass('public.leads_meta_nachtrag') is null then
    raise notice 'leads_meta_nachtrag fehlt, nichts zurückzubauen';
    return;
  end if;

  update public.leads l
     set meta_ad_id       = case when n.meta_ad_id is not null
                                  and l.meta_ad_id = n.meta_ad_id
                                 then null else l.meta_ad_id end,
         meta_adset_id    = case when n.meta_adset_id is not null
                                  and l.meta_adset_id = n.meta_adset_id
                                 then null else l.meta_adset_id end,
         meta_campaign_id = case when n.meta_campaign_id is not null
                                  and l.meta_campaign_id = n.meta_campaign_id
                                 then null else l.meta_campaign_id end,
         meta_leadgen_id  = case when n.meta_leadgen_id is not null
                                  and l.meta_leadgen_id = n.meta_leadgen_id
                                 then null else l.meta_leadgen_id end,
         meta_attr_quelle = case when n.meta_attr_quelle is not null
                                  and l.meta_attr_quelle = n.meta_attr_quelle
                                 then n.vorher_quelle else l.meta_attr_quelle end,
         meta_attr_at     = case when n.meta_attr_at is not null
                                  and l.meta_attr_at = n.meta_attr_at
                                 then n.vorher_at else l.meta_attr_at end
    from public.leads_meta_nachtrag n
   where n.lead_id = l.id;

  drop table public.leads_meta_nachtrag;
end;
$$;

notify pgrst, 'reload schema';

commit;
