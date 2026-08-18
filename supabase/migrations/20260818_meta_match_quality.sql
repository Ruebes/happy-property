-- Meta: Event Match Quality + Landing-Page-Verlust messbar machen
--
-- Hintergrund (Audit 18.08.2026 gegen das Konto Sveru Marketing LLC):
-- Die Conversions-API-Events aus meta-ads-sync kamen nur mit E-Mail + Telefon
-- an. Meta bewertet die Zuordnungsqualität (Event Match Quality) daher mit
-- 4,6 von 10 — unter der 6,0-Schwelle, ab der Meta die Events voll für die
-- Optimierung nutzt. Die stärksten fehlenden Merkmale sind die Klick-ID (fbc)
-- und die Browser-ID (fbp), beide bei 0 % Abdeckung. Sie entstehen im Browser
-- beim Klick auf die Anzeige, also fangen wir sie im Funnel (/termin) ein und
-- legen sie am Lead ab, damit der Sync sie später mitschicken kann.
--
-- Zweitens: Meta liefert je Anzeige „Landing Page Views" und „Outbound Clicks".
-- Die Lücke dazwischen sind Leute, die geklickt haben, aber die Seite nie zu
-- sehen bekamen (Ladezeit/Abbruch). Im Konto liegt die Lücke bei rund 30 %.
-- Ohne diese beiden Spalten kann der Werbemanager das nicht anzeigen.

alter table public.leads
  add column if not exists fbc               text,
  add column if not exists fbp               text,
  add column if not exists client_user_agent text;

comment on column public.leads.fbc is
  'Meta Klick-ID: _fbc-Cookie oder aus dem fbclid der Anzeigen-URL gebaut. Geht als Zuordnungsmerkmal an die Conversions-API.';
comment on column public.leads.fbp is
  'Meta Browser-ID: _fbp-Cookie, vom Pixel gesetzt. Zuordnungsmerkmal für die Conversions-API.';
comment on column public.leads.client_user_agent is
  'Browserkennung aus der Buchungssitzung. Nur für Conversions-API-Events mit action_source=website.';

alter table public.ad_insights_daily
  add column if not exists landing_page_views integer not null default 0,
  add column if not exists outbound_clicks    integer not null default 0;

comment on column public.ad_insights_daily.landing_page_views is
  'Meta: Seitenaufrufe, bei denen die Zielseite wirklich geladen wurde.';
comment on column public.ad_insights_daily.outbound_clicks is
  'Meta: Klicks, die aus der Anzeige heraus zur Zielseite führen sollten. Differenz zu landing_page_views = Verlust beim Laden.';
