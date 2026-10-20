-- Stichwort-Automatik auch für YouTube (Function yt-keywords).
-- YouTube hat keine Direktnachrichten: der Kanal antwortet öffentlich unter dem
-- Kommentar. Protokoll in derselben Tabelle wie Facebook/Instagram.

alter table social_keyword_replies drop constraint if exists social_keyword_replies_platform_check;
alter table social_keyword_replies add constraint social_keyword_replies_platform_check
  check (platform in ('facebook', 'instagram', 'youtube'));

-- Regel FINANZAMT: auf YouTube mit Link zur Strategie-Seite antworten.
-- Andere Regeln bleiben auf YouTube aus (Feld youtube fehlt).
update crm_settings
   set value = (
     select jsonb_set(v, '{rules}', (
       select jsonb_agg(case when r->'keywords' ? 'finanzamt' then r || $p${
         "youtube": true,
         "youtube_replies": [
           "Danke dir! 🙌 YouTube hat leider keine Direktnachrichten, deshalb hier: Die komplette Strategie mit Beispielrechnung findest du unter https://portal.happy-property.com/s/finanzamt-strategie.html?src=youtube Ob sie für dich funktioniert, rechnet Sven gern mit dir durch. Das kostenlose Gespräch kannst du direkt auf der Seite buchen.",
           "Gern! Da YouTube keine Direktnachrichten hat, hier die Strategie aus dem Video mit Beispielrechnung: https://portal.happy-property.com/s/finanzamt-strategie.html?src=youtube Auf der Seite kannst du dir auch direkt ein kostenloses Gespräch mit Sven buchen."
         ]
       }$p$::jsonb else r end order by i)
       from jsonb_array_elements(v->'rules') with ordinality as e(r, i)))::text
     from (select value::jsonb v) s),
       updated_at = now()
 where key = 'social_keywords';
