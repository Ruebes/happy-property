// Vertragstest für den Kampagnen-Assistenten (Meta-Builder).
//
// Hält zusammen, was sonst auseinanderläuft (Lehre aus #3 in CLAUDE.md):
//   1. Spiegel byte-identisch: metaSpec.ts, metaLint.ts, werbeMathe.ts
//      (supabase/functions/_shared/* <-> src/lib/*), rein ohne Imports
//   2. Jeder i18n-Schlüssel aus metaSpec/metaLint existiert in de + en
//      (src/locales/*.json ODER, bis zum Merge, in den Fragment-Dateien)
//   3. Abhängigkeiten vollständig: Ziel -> Conversion-Ort -> Leistungsziel ->
//      Abrechnung / Attribution / promoted_object, CTA, blame-Pfade
//   4. applyHousing idempotent und entfernt alles Verbotene
//   5. Plan-B-Payload: PAUSED, HOUSING, url_tags, contextual_multi_ads OPT_OUT,
//      advantage_audience explizit, Medien je Platzierung
//   5c. Bearbeiten: editDiff (Lernphase, Sperren, Budgetart, Werbemittel-Tausch,
//      Vergleich ohne Anzeigenamen), validateEditFields, Budgetplanung
//   5d. Werbemittel komplett + Conversion-Orte (Runde 2): vorhandener Beitrag (FB/IG),
//      Karussell (Video-Karten, Schalter), Formate 1:1/4:5/9:16/1.91:1 + Zuschnitt,
//      Textvarianten ohne Platzierungs-Medien, alle CTAs (WhatsApp, Anruf, Messenger,
//      Website + Sofortformular), mehrsprachig, Partnerschaft, Tracking, Vorschau-Formate
//   6. Lint-Fälle (Gedankenstriche, Rendite-%, Finanzierung, ae/oe/ue, Längen,
//      Projektnamen, sauberer Text) + adCopy.ts nutzt dieselben Regex
//
// Ausführen: node scripts/verify-meta-spec.mjs   (npm run verify:meta)

import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

const fails = []
const warns = []
const ok = (cond, msg) => { if (!cond) fails.push(msg) }
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${msg}: erwartet ${JSON.stringify(b)}, ist ${JSON.stringify(a)}`) }

// ── 1. Spiegel ───────────────────────────────────────────────────────────────
const MIRRORS = [
  ['supabase/functions/_shared/metaSpec.ts', 'src/lib/metaSpec.ts', true],
  ['supabase/functions/_shared/metaLint.ts', 'src/lib/metaLint.ts', true],
  ['supabase/functions/_shared/werbeMathe.ts', 'src/lib/werbeMathe.ts', false],
]
for (const [edge, src, required] of MIRRORS) {
  if (!existsSync(edge) || !existsSync(src)) {
    if (required) fails.push(`Spiegel fehlt: ${existsSync(edge) ? src : edge}`)
    else warns.push(`Spiegel übersprungen (Datei fehlt noch): ${existsSync(edge) ? src : edge}`)
    continue
  }
  const a = readFileSync(edge), b = readFileSync(src)
  if (!a.equals(b)) fails.push(`Spiegel nicht identisch: ${edge} <-> ${src}`)
}
for (const f of ['supabase/functions/_shared/metaSpec.ts', 'supabase/functions/_shared/metaLint.ts']) {
  if (!existsSync(f)) continue
  const s = readFileSync(f, 'utf8')
  const name = f.split('/').pop()
  // Code ohne Kommentare (sonst schlagen die Hinweise im Kopfkommentar an)
  const code = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
  ok(s.split('\n')[0].startsWith(`// IDENTISCH zu src/lib/${name}`), `${name}: erste Zeile muss den IDENTISCH-Hinweis tragen`)
  ok(!/^\s*import\s/m.test(code), `${name}: darf nichts importieren`)
  ok(!/\.at\(/.test(code), `${name}: kein .at() (lib ES2020)`)
  ok(!/Object\.hasOwn\b/.test(code), `${name}: kein Object.hasOwn (lib ES2020)`)
  ok(!/\.replaceAll\(/.test(code), `${name}: kein replaceAll (lib ES2020)`)
  ok(!/\(\?<[=!]/.test(code), `${name}: keine Lookbehind-Regex (alte Safari)`)
  ok(!/[‒-―]/.test(s), `${name}: Gedankenstrich-Zeichen im Quelltext (als \\u2012 schreiben)`)
}

// ── Bündeln ──────────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), 'hpmeta-'))
const bundle = (file, name) => {
  const out = join(dir, name)
  execSync(`npx --yes esbuild ${file} --bundle --format=esm --platform=neutral --log-level=error --outfile=${out}`, { stdio: 'pipe' })
  return import(out)
}
const S = await bundle('supabase/functions/_shared/metaSpec.ts', 'metaSpec.mjs')
const L = await bundle('supabase/functions/_shared/metaLint.ts', 'metaLint.mjs')
const A = await bundle('supabase/functions/_shared/adCopy.ts', 'adCopy.mjs')

// ── 2. i18n ──────────────────────────────────────────────────────────────────
// Fragment-Verzeichnisse des Build-Workflows (Übergang bis die Fragmente in
// src/locales gemergt sind; Runde 1 = i18n, Runde 2 = i18n2, Runde 3 = i18n3). Überschreibbar mit
// META_I18N_DIR (mehrere mit Komma getrennt).
const BUILD_DIR = '/private/tmp/claude-502/-Users-ArPritsch-Downloads/5da4d416-b511-4540-bf49-56b4aeb8fc5c/scratchpad/ads/build'
const FRAGMENT_DIRS = (process.env.META_I18N_DIR ?? `${BUILD_DIR}/i18n,${BUILD_DIR}/i18n2,${BUILD_DIR}/i18n3`).split(',').map(x => x.trim()).filter(Boolean)
const lookup = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
const sources = { de: [], en: [] }
for (const lang of ['de', 'en']) {
  sources[lang].push({ name: `src/locales/${lang}.json`, data: JSON.parse(readFileSync(`src/locales/${lang}.json`, 'utf8')) })
  for (const dirF of FRAGMENT_DIRS) {
    if (!existsSync(dirF)) continue
    for (const f of readdirSync(dirF).filter(x => x.endsWith(`.${lang}.json`))) {
      try { sources[lang].push({ name: f, data: JSON.parse(readFileSync(join(dirF, f), 'utf8')) }) }
      catch (e) { fails.push(`i18n-Fragment unlesbar: ${f} (${e.message})`) }
    }
  }
}
const labelKeys = [...S.allLabelKeys(), ...L.allLintKeys()]
let missingDe = 0, missingEn = 0
for (const key of labelKeys) {
  for (const lang of ['de', 'en']) {
    const hit = sources[lang].map(s => lookup(s.data, key)).find(v => typeof v === 'string' && v.trim())
    if (!hit) {
      if (lang === 'de') missingDe++; else missingEn++
      if ((lang === 'de' ? missingDe : missingEn) <= 15) fails.push(`i18n fehlt (${lang}): ${key}`)
    } else if (lang === 'de' && /[‒-―]/.test(hit)) fails.push(`i18n de mit Gedankenstrich: ${key}`)
  }
}
if (missingDe > 15 || missingEn > 15) fails.push(`i18n: insgesamt ${missingDe} (de) / ${missingEn} (en) Schlüssel fehlen`)

// ── 3. Abhängigkeiten ────────────────────────────────────────────────────────
const labelOf = (opts, v) => opts.some(o => o.value === v)
for (const obj of S.OBJECTIVES) {
  ok(labelOf(S.OBJECTIVE_OPTIONS, obj), `Ziel ohne Option: ${obj}`)
  const dests = S.destinationsFor(obj)
  ok(dests.length > 0, `Ziel ohne Conversion-Ort: ${obj}`)
  for (const dest of Object.keys(S.GOALS_BY_OBJ_DEST[obj] ?? {})) {
    ok(labelOf(S.DESTINATION_OPTIONS, dest), `Conversion-Ort ohne Option/Label: ${dest}`)
    ok(dests.includes(dest), `destinationsFor(${obj}) fehlt ${dest}`)
    const goals = S.goalsFor(obj, dest)
    ok(goals.length > 0, `${obj}/${dest}: kein Leistungsziel`)
    for (const g of goals) {
      ok(labelOf(S.GOAL_OPTIONS, g), `Leistungsziel ohne Option/Label: ${g}`)
      const bills = S.billingFor(g)
      ok(bills.length > 0, `Leistungsziel ohne Abrechnung: ${g}`)
      for (const b of bills) ok(labelOf(S.BILLING_OPTIONS, b), `Abrechnung ohne Option/Label: ${b} (${g})`)
      const attrs = S.attributionFor(g)
      ok(attrs.length > 0, `Leistungsziel ohne Attribution: ${g}`)
      for (const a of attrs) {
        ok(labelOf(S.ATTRIBUTION_OPTIONS, a), `Attribution ohne Option/Label: ${a}`)
        ok(Array.isArray(S.ATTRIBUTION_SPECS[a]) && S.ATTRIBUTION_SPECS[a].length > 0, `Attribution ohne Spec: ${a}`)
      }
      const rule = S.promotedRuleFor(obj, dest, g)
      ok(!!rule, `keine promoted_object-Regel: ${obj}/${dest}/${g}`)
      if (rule) for (const k of S.promotedAllowed(rule)) ok(S.PROMOTED_KEYS.includes(k), `unbekannter promoted_object-Schlüssel ${k}`)
    }
  }
}
ok(S.CTA_BY_DESTINATION.lead_form.every(c => ['APPLY_NOW', 'DOWNLOAD', 'GET_QUOTE', 'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE'].includes(c)), 'Sofortformular-CTAs außerhalb der erlaubten sechs')
for (const kind of S.AD_DESTINATION_KINDS) {
  ok(S.ctaFor(kind).length > 0, `Ziel-Art ohne CTA: ${kind}`)
  for (const c of S.ctaFor(kind)) ok(labelOf(S.CTA_OPTIONS, c), `CTA ohne Option: ${c}`)
  ok(labelOf(S.AD_DESTINATION_KIND_OPTIONS, kind), `Ziel-Art ohne Option: ${kind}`)
}
for (const d of S.AD_SUPPORTED_DESTINATIONS) ok(S.adKindsFor(d).length > 0, `unterstützter Conversion-Ort ohne Ziel-Art: ${d}`)
for (const o of S.DESTINATION_OPTIONS) if (o.unsupported) ok(!!o.reasonKey, `gesperrter Conversion-Ort ohne Grund: ${o.value}`)
for (const f of S.CREATIVE_FEATURES) ok(!!S.CREATIVE_FEATURE_INFO[f], `Creative-Feature ohne Info: ${f}`)
for (const pl of S.PUBLISHER_PLATFORMS) {
  const field = S.POSITION_FIELD_BY_PLATFORM[pl]
  for (const r of S.REMOVED_POSITIONS[field]) ok(!S.POSITIONS_BY_PLATFORM[pl].includes(r), `entfernte Platzierung noch wählbar: ${pl}.${r}`)
}
ok(!S.FACEBOOK_POSITIONS.includes('video_feeds') && !S.INSTAGRAM_POSITIONS.includes('explore') && !S.MESSENGER_POSITIONS.includes('story'), 'v26: entfernte Platzierungen in den Listen')
const fieldKeys = S.FIELD_SPECS.map(f => f.key)
ok(new Set(fieldKeys).size === fieldKeys.length, 'FieldSpec-Schlüssel doppelt')
for (const f of S.FIELD_SPECS) {
  if (f.virtual) continue
  eq(S.apiPathToFieldKey(f.level, f.api), f.key, `apiPathToFieldKey(${f.level}, ${f.api})`)
  for (const al of f.apiAliases ?? []) eq(S.apiPathToFieldKey(f.level, al), f.key, `apiPathToFieldKey(${f.level}, ${al})`)
}
eq(S.apiPathToFieldKey('adset', ['targeting', 'age_min']), 'adset.targeting.age', 'blame targeting.age_min')
eq(S.apiPathToFieldKey('adset', ['targeting', 'geo_locations', 'cities', '0', 'radius']), 'adset.targeting.geo_locations', 'blame cities radius')
eq(S.apiPathToFieldKey('ad', 'creative.object_story_spec.link_data.message'), 'ad.primary_texts', 'blame creative message')
eq(S.apiPathToFieldKey('ad', ['creative', 'asset_feed_spec', 'titles']), 'ad.headlines', 'blame asset_feed titles')
eq(S.apiPathToFieldKey('ad', 'object_story_spec.link_data.call_to_action.value.lead_gen_form_id'), 'ad.destination.form_id', 'blame lead form')
eq(S.apiPathToFieldKey('adset', 'promoted_object'), 'adset.promoted_object.pixel_id', 'blame promoted_object')
eq(S.apiPathToFieldKey('campaign', ['is_adset_budget_sharing_enabled']), 'campaign.is_adset_budget_sharing_enabled', 'blame budget sharing')
ok(S.EU_COUNTRIES.length === 27 && S.EU_COUNTRIES.includes('DE') && S.EU_COUNTRIES.includes('AT') && !S.EU_COUNTRIES.includes('CH'), 'EU_COUNTRIES unvollständig')

// ── 4. applyHousing ──────────────────────────────────────────────────────────
const dirty = {
  v: 1,
  campaign: {
    name: 'Test', objective: 'OUTCOME_LEADS', buying_type: 'AUCTION', special_ad_categories: [],
    special_ad_category_country: [], budget_level: 'adset', is_adset_budget_sharing_enabled: false,
  },
  adsets: [{
    key: 'a1', name: 'Gruppe', destination: 'WEBSITE', optimization_goal: 'OFFSITE_CONVERSIONS', billing_event: 'IMPRESSIONS',
    promoted_object: { pixel_id: S.HP_PIXEL_ID, custom_event_type: 'LEAD' }, attribution: 'click_7d_view_1d',
    daily_budget_cents: 5000,
    targeting: {
      geo_locations: {
        countries: ['DE'], zips: [{ key: 'DE:10115' }], neighborhoods: [{ key: '123' }],
        cities: [{ key: '1', radius: 5, distance_unit: 'kilometer' }, { key: '2', radius: 20, distance_unit: 'mile' }],
        custom_locations: [{ latitude: 52.5, longitude: 13.4 }],
      },
      excluded_geo_locations: { countries: ['AT'] },
      age_min: 25, age_max: 45, age_range: [25, 45], genders: [1], locales: [5],
      flexible_spec: [{ behaviors: [{ id: 'b1' }], interests: [{ id: 'i1' }] }, { work_positions: [{ id: 'w1' }] }],
      exclusions: { interests: [{ id: 'x' }] },
      income: [{ id: 'inc' }],
      custom_audiences: [{ id: 'c1', subtype: 'WEBSITE' }, { id: 'c2', subtype: 'LOOKALIKE' }],
      targeting_relaxation_types: { lookalike: 1, custom_audience: 1 },
      targeting_automation: { individual_setting: { age: 1 } },
    },
    placements: { mode: 'advantage' }, dsa_beneficiary: 'X', dsa_payor: 'Y',
  }],
  ads: [],
}
const dirtyCopy = JSON.stringify(dirty)
const h1 = S.applyHousing(dirty)
ok(JSON.stringify(dirty) === dirtyCopy, 'applyHousing verändert die Eingabe')
const t1 = h1.spec.adsets[0].targeting
ok(h1.spec.campaign.special_ad_categories.includes('HOUSING'), 'applyHousing: HOUSING fehlt')
eq(h1.spec.campaign.special_ad_category_country, ['DE'], 'applyHousing: Land')
eq([t1.age_min, t1.age_max], [18, 65], 'applyHousing: Alter')
ok(t1.genders === undefined && t1.age_range === undefined, 'applyHousing: genders/age_range nicht entfernt')
ok(!t1.geo_locations.zips && !t1.geo_locations.neighborhoods, 'applyHousing: PLZ/Stadtteile nicht entfernt')
ok(t1.excluded_geo_locations === undefined && t1.exclusions === undefined && t1.income === undefined, 'applyHousing: Ausschlüsse/Demografie nicht entfernt')
ok(JSON.stringify(t1.flexible_spec) === JSON.stringify([{ interests: [{ id: 'i1' }] }]), `applyHousing: flexible_spec falsch bereinigt ${JSON.stringify(t1.flexible_spec)}`)
eq(t1.custom_audiences.map(a => a.id), ['c1'], 'applyHousing: Lookalike nicht entfernt')
ok(t1.targeting_relaxation_types?.lookalike === undefined && t1.targeting_relaxation_types?.custom_audience === 1, 'applyHousing: Advantage Lookalike')
ok(t1.geo_locations.cities[0].radius === 17 && t1.geo_locations.cities[1].radius === 20, 'applyHousing: Radius (Städte mindestens 17 km)')
ok(t1.geo_locations.custom_locations[0].radius === 15, 'applyHousing: Radius custom_location')
ok(t1.targeting_automation.advantage_audience === 1 && t1.targeting_automation.individual_setting === undefined, 'applyHousing: advantage_audience nicht explizit')
ok(h1.changes.length > 0 && h1.locks.length > 0, 'applyHousing: keine changes/locks gemeldet')
const housingIssues = S.validateDraft(h1.spec).filter(i => i.code.startsWith('housing_'))
ok(housingIssues.length === 0, `nach applyHousing noch Housing-Fehler: ${housingIssues.map(i => i.code).join(', ')}`)
const h2 = S.applyHousing(h1.spec)
ok(JSON.stringify(h2.spec) === JSON.stringify(h1.spec), 'applyHousing nicht idempotent (spec)')
ok(h2.changes.length === 0, `applyHousing nicht idempotent (changes: ${h2.changes.map(c => c.code).join(', ')})`)
const dirtyIssues = S.validateDraft(dirty).map(i => i.code)
ok(dirtyIssues.includes('housing_missing'), 'validateDraft erkennt fehlende Sonderkategorie Wohnen nicht')
// Ohne HOUSING laufen die Housing-Prüfungen nicht; mit HOUSING ohne applyHousing müssen sie greifen
const dirtyHousing = JSON.parse(dirtyCopy); dirtyHousing.campaign.special_ad_categories = ['HOUSING']; dirtyHousing.campaign.special_ad_category_country = ['DE']
dirtyHousing.adsets[0].targeting.geo_locations.custom_locations = [{ latitude: 52.5, longitude: 13.4, radius: 5, distance_unit: 'kilometer' }]
const dhIssues = S.validateDraft(dirtyHousing).map(i => i.code)
for (const c of ['housing_age', 'housing_gender', 'housing_geo_type', 'housing_exclusion', 'housing_radius', 'city_radius', 'housing_detailed', 'housing_lookalike', 'housing_advantage_audience'])
  ok(dhIssues.includes(c), `validateDraft erkennt ${c} nicht`)

// ── 5. Plan B ────────────────────────────────────────────────────────────────
eq(S.URL_TAGS_STANDARD, 'utm_source=meta&utm_medium=paid&utm_campaign={{campaign.id}}&utm_term={{adset.id}}&utm_content={{ad.id}}', 'URL_TAGS_STANDARD')
if (existsSync('supabase/functions/_shared/metaGraph.ts')) {
  const g = readFileSync('supabase/functions/_shared/metaGraph.ts', 'utf8')
  const m = /URL_TAGS_STANDARD\s*=\s*'([^']+)'/.exec(g)
  if (m) eq(m[1], S.URL_TAGS_STANDARD, 'URL_TAGS_STANDARD metaGraph.ts vs metaSpec.ts')
  else warns.push('metaGraph.ts: URL_TAGS_STANDARD nicht gefunden')
}
const IG = '17841400000000000'
const planB = S.TEMPLATES.plan_b.build({ instagram_user_id: IG, dsa_beneficiary: 'Sveru Ltd', dsa_payor: 'Sveru Ltd' })
const media = {
  feed_4x5: { media_id: 'm-feed', image_hash: 'hashfeed' },
  story_9x16: { media_id: 'm-story', image_hash: 'hashstory' },
}
planB.ads.push(...S.TEMPLATES.plan_b.pair({
  kennung: '08_steuer-zurueck', instagram_user_id: IG, media,
  primary_texts: ['Immobilien auf Zypern, EU-Mitglied. Du kaufst auf Zypern und holst dir in Deutschland Steuern zurück.'],
  headlines: ['Steuern zurückholen mit Zypern'], descriptions: ['30 Minuten, unverbindlich'],
}))
eq(planB.ads.map(a => [a.key, a.adset_key, a.destination.url]), [
  ['08_steuer-zurueck_lang', 'lang', S.PLAN_B_LP_LANG], ['08_steuer-zurueck_kurz', 'kurz', S.PLAN_B_LP_KURZ],
], 'Plan B Paar')
const hb = S.applyHousing(planB)
eq(hb.changes.map(c => c.code), [], 'Plan B braucht keine Housing-Korrektur')
const pbIssues = S.validateDraft(hb.spec)
const pbErrors = pbIssues.filter(i => i.severity === 'error')
ok(pbErrors.length === 0, `Plan B validateDraft-Fehler: ${pbErrors.map(i => `${i.node}:${i.field}:${i.code}`).join(', ')}`)
const camp = S.buildCampaignPayload(hb.spec.campaign)
eq(camp.status, 'PAUSED', 'Kampagne status')
eq(camp.objective, 'OUTCOME_LEADS', 'Kampagne objective')
eq(camp.special_ad_categories, ['HOUSING'], 'Kampagne HOUSING')
eq(camp.special_ad_category_country, ['DE'], 'Kampagne Land')
eq(camp.is_adset_budget_sharing_enabled, false, 'Kampagne is_adset_budget_sharing_enabled explizit false')
ok(camp.daily_budget === undefined && camp.bid_strategy === undefined, 'Kampagne ohne CBO darf kein Budget/Gebot haben')
for (const a of hb.spec.adsets) {
  const p = S.buildAdsetPayload(a, hb.spec.campaign, 'CAMPAIGN_ID')
  eq(p.status, 'PAUSED', `${a.key} status`)
  eq([p.destination_type, p.optimization_goal, p.billing_event], ['WEBSITE', 'OFFSITE_CONVERSIONS', 'IMPRESSIONS'], `${a.key} Ziel`)
  eq(p.promoted_object, { pixel_id: S.HP_PIXEL_ID, custom_event_type: 'SCHEDULE' }, `${a.key} promoted_object`)
  eq(p.attribution_spec, [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }], `${a.key} attribution`)
  eq([p.daily_budget, p.bid_strategy], [6900, 'LOWEST_COST_WITHOUT_CAP'], `${a.key} Budget`)
  eq(p.targeting.targeting_automation, { advantage_audience: 1 }, `${a.key} advantage_audience explizit`)
  eq([p.targeting.age_min, p.targeting.age_max], [18, 65], `${a.key} Alter`)
  ok(p.targeting.publisher_platforms === undefined && p.targeting.genders === undefined, `${a.key}: Advantage+ Platzierungen ohne Platzierungsfelder`)
  eq([p.dsa_beneficiary, p.dsa_payor], ['Sveru Ltd', 'Sveru Ltd'], `${a.key} DSA`)
}
const lang = hb.spec.ads[0]
const cr = S.buildCreativePayload(lang, { placements: hb.spec.adsets[0].placements })
eq(cr.mode, 'asset_feed', 'Creative mit 4:5 + 9:16 = Medien je Platzierung')
const cp = cr.payload
eq(cp.url_tags, S.URL_TAGS_STANDARD, 'Creative url_tags')
eq(cp.contextual_multi_ads, { enroll_status: 'OPT_OUT' }, 'Creative contextual_multi_ads')
const feats = cp.degrees_of_freedom_spec?.creative_features_spec ?? {}
ok(S.CREATIVE_FEATURES.every(f => feats[f]?.enroll_status === 'OPT_OUT'), 'Creative: nicht alle Advantage+ Funktionen explizit OPT_OUT')
eq(cp.object_story_spec, { page_id: S.HP_PAGE_ID, instagram_user_id: IG }, 'Creative Identität')
const afs = cp.asset_feed_spec
eq(afs.optimization_type, 'PLACEMENT', 'asset_feed optimization_type')
eq(afs.ad_formats, ['SINGLE_IMAGE'], 'asset_feed ad_formats')
eq(afs.images.map(i => [i.hash, i.adlabels[0].name]), [['hashstory', S.PAC_LABEL_STORY], ['hashfeed', S.PAC_LABEL_FEED]], 'asset_feed images/labels')
eq(afs.asset_customization_rules.length, 2, 'asset_feed 2 Platzierungsregeln')
ok(afs.asset_customization_rules.every(r => r.image_label && r.customization_spec.publisher_platforms.length), 'asset_feed Regeln mit Label + Plattform')
eq(afs.link_urls, [{ website_url: S.PLAN_B_LP_LANG }], 'asset_feed link_urls')
eq(afs.call_to_action_types, ['BOOK_NOW'], 'asset_feed CTA')
eq(afs.bodies.length, 1, 'asset_feed bodies')
// Einzelmedium -> link_data mit CTA value.link
const single = JSON.parse(JSON.stringify(lang)); delete single.media.story_9x16
const sp = S.buildCreativePayload(single, {}).payload
eq(S.creativeMode(single), 'link_data', 'Einzelbild + ein Text = link_data')
eq(sp.object_story_spec.link_data.call_to_action, { type: 'BOOK_NOW', value: { link: S.PLAN_B_LP_LANG } }, 'link_data CTA value.link')
eq(sp.object_story_spec.link_data.image_hash, 'hashfeed', 'link_data image_hash')
// 5 Texte -> asset_feed mit 5 bodies; 6 Texte -> Fehler
const five = JSON.parse(JSON.stringify(single)); five.primary_texts = ['Eins.', 'Zwei.', 'Drei.', 'Vier.', 'Fünf.']
eq(S.buildCreativePayload(five, {}).payload.asset_feed_spec.bodies.length, 5, '5 Primärtexte im asset_feed')
const six = JSON.parse(JSON.stringify(hb.spec)); six.ads[0].primary_texts = ['1.', '2.', '3.', '4.', '5.', '6.']
ok(S.validateDraft(six).some(i => i.code === 'too_many_texts'), '6 Primärtexte nicht erkannt')
const adp = S.buildAdPayload(lang, 'ADSET_ID', { creative_id: 'CR' }, { draftId: '1234abcd-0000-0000-0000-000000000000' })
eq([adp.status, adp.adset_id, adp.adlabels, adp.conversion_domain], ['PAUSED', 'ADSET_ID', [{ name: 'hp_draft_1234abcd' }], 'steuervorteil-zypern-immobilien.com'], 'Ad-Payload')
const allPayloads = JSON.stringify([camp, cp, sp, adp])
ok(!/[‒-―]/.test(allPayloads), 'Payload enthält Gedankenstrich')
ok(!/"status":"ACTIVE"/.test(allPayloads), 'Payload enthält ACTIVE')
// Lead-Formular: CTA-Einschränkung + Ziel-Abgleich
const leadAd = JSON.parse(JSON.stringify(single)); leadAd.destination = { kind: 'lead_form', form_id: 'F1' }; leadAd.cta_type = 'BOOK_NOW'
const leadDraft = JSON.parse(JSON.stringify(hb.spec)); leadDraft.ads = [leadAd]
const leadCodes = S.validateDraft(leadDraft).map(i => i.code)
ok(leadCodes.includes('cta_lead_form') && leadCodes.includes('destination_mismatch'), `Sofortformular-Prüfung fehlt: ${leadCodes.join(', ')}`)
// Pixel-Abweichung (Befund Plan B 2.10.) als Warnung
const wrongPixel = JSON.parse(JSON.stringify(hb.spec)); wrongPixel.adsets[0].promoted_object.pixel_id = '987745530157374'
ok(S.validateDraft(wrongPixel).some(i => i.code === 'pixel_mismatch' && i.severity === 'warn'), 'falsches Pixel nicht gewarnt')
// DSA fehlt bei EU
const noDsa = JSON.parse(JSON.stringify(hb.spec)); noDsa.adsets[0].dsa_payor = ''
ok(S.validateDraft(noDsa).some(i => i.code === 'dsa_missing'), 'fehlende DSA nicht erkannt')

// ── 5b. Bestehende Kampagnen, Ziele, Beschreibungen, Advantage+, Radius ─────
const codesOf = (spec, opts) => S.validateDraft(spec, opts)
const PLANB_CAMP = '120248678452490314'
// Neue Gruppe in bestehender HOUSING-Kampagne: Wohnen-Regeln greifen (add_adsets)
const addSpec = JSON.parse(JSON.stringify(hb.spec))
addSpec.campaign.existing_id = PLANB_CAMP
addSpec.adsets[0].existing_id = '120248678452700314'
addSpec.adsets[1].targeting = {
  geo_locations: { countries: ['DE'], cities: [{ key: '1', radius: 15, distance_unit: 'kilometer' }] },
  age_min: 30, age_max: 55, genders: [1], flexible_spec: [{ behaviors: [{ id: 'b1' }] }],
}
const hAdd = S.applyHousing(addSpec)
const tAdd = hAdd.spec.adsets[1].targeting
eq(hAdd.spec.campaign.special_ad_categories, ['HOUSING'], 'add_adsets: Kategorie der bestehenden Kampagne bleibt')
ok(tAdd.genders === undefined && tAdd.age_min === 18 && tAdd.age_max === 65 && tAdd.flexible_spec === undefined, `add_adsets in HOUSING-Kampagne: Wohnen-Regeln nicht angewandt ${JSON.stringify(tAdd)}`)
eq(tAdd.geo_locations.cities[0].radius, 17, 'add_adsets in HOUSING-Kampagne: Stadt-Radius 17 km')
eq(tAdd.targeting_automation, { advantage_audience: 1 }, 'add_adsets in HOUSING-Kampagne: advantage_audience explizit')
ok(!codesOf(hAdd.spec).some(i => i.severity === 'error'), `add_adsets in HOUSING-Kampagne: Fehler ${codesOf(hAdd.spec).filter(i => i.severity === 'error').map(i => i.code).join(', ')}`)
const pAdd = S.buildAdsetPayload(hAdd.spec.adsets[1], hAdd.spec.campaign, PLANB_CAMP)
ok(pAdd.targeting.genders === undefined && pAdd.targeting.flexible_spec === undefined, 'add_adsets: Payload ohne Geschlecht/Verhalten')
// Neue Anzeige in bestehender HOUSING-Gruppe (add_ads): nichts zu korrigieren, keine Fehler
const addAds = JSON.parse(JSON.stringify(hb.spec))
addAds.campaign.existing_id = PLANB_CAMP
addAds.adsets.forEach(a => { a.existing_id = `AS_${a.key}` })
eq(S.applyHousing(addAds).changes.map(c => c.code), [], 'add_ads in HOUSING-Kampagne: keine Housing-Korrektur nötig')
ok(!codesOf(addAds).some(i => i.severity === 'error'), 'add_ads in HOUSING-Kampagne: Fehler')
// Bestehende Kampagne OHNE HOUSING + Neues: Fehler (Server lässt nur Admin mit Begründung durch)
const noHousing = JSON.parse(JSON.stringify(addSpec)); noHousing.campaign.special_ad_categories = []; noHousing.campaign.special_ad_category_country = []
const hNo = S.applyHousing(noHousing)
eq(hNo.spec.campaign.special_ad_categories, [], 'bestehende Kampagne: applyHousing erzwingt keine Kategorie')
ok(codesOf(hNo.spec).some(i => i.code === 'housing_existing' && i.severity === 'error'), 'Neues in Kampagne ohne HOUSING nicht als Fehler erkannt')
ok(codesOf(hNo.spec, { realEstate: false }).some(i => i.code === 'housing_existing' && i.severity === 'warn'), 'Nicht-Immobilien-Entwurf: housing_existing nur Hinweis')
const onlyExisting = JSON.parse(JSON.stringify(hNo.spec)); onlyExisting.adsets.forEach(a => { a.existing_id = a.existing_id || 'X' }); onlyExisting.ads = []
ok(codesOf(onlyExisting).some(i => i.code === 'housing_existing' && i.severity === 'warn'), 'ohne Neues: housing_existing nur Hinweis')
ok(S.isRealEstateDraft('plan_b') && S.isRealEstateDraft(null) && S.isRealEstateDraft('unbekannt'), 'isRealEstateDraft')
// Bestehende Gruppe mit WEBSITE_AND_PHONE_CALL (laufendes Plan B) nimmt neue Website-Anzeigen
const wpc = JSON.parse(JSON.stringify(addAds)); wpc.adsets.forEach(a => { a.destination = 'WEBSITE_AND_PHONE_CALL' })
const wpcCodes = codesOf(wpc).map(i => i.code)
ok(!wpcCodes.includes('destination_unsupported') && !wpcCodes.includes('destination_mismatch'), `WEBSITE_AND_PHONE_CALL: Website-Anzeige abgelehnt (${wpcCodes.join(', ')})`)
const wpcLead = JSON.parse(JSON.stringify(wpc)); wpcLead.ads[0].destination = { kind: 'lead_form', form_id: 'F1' }; wpcLead.ads[0].cta_type = 'SIGN_UP'
ok(codesOf(wpcLead).some(i => i.code === 'destination_mismatch'), 'WEBSITE_AND_PHONE_CALL: Sofortformular-Anzeige nicht abgelehnt')
const wpcNew = JSON.parse(JSON.stringify(wpc)); delete wpcNew.adsets[0].existing_id
ok(codesOf(wpcNew).some(i => i.node === wpcNew.adsets[0].key && i.field === 'adset.destination' && i.severity === 'error'), 'neue Gruppe mit WEBSITE_AND_PHONE_CALL nicht als nicht unterstützt erkannt')
// Beschreibungen: höchstens eine; asset_feed genau eine (leer = Leerzeichen); zählen nicht für den Modus
const twoDesc = JSON.parse(JSON.stringify(hb.spec)); twoDesc.ads[0].descriptions = ['Eins', 'Zwei']
ok(codesOf(twoDesc).some(i => i.code === 'descriptions_single' && i.field === 'ad.descriptions' && i.severity === 'error'), 'zwei Beschreibungen nicht als Fehler erkannt')
const singleTwoDesc = JSON.parse(JSON.stringify(single)); singleTwoDesc.descriptions = ['Eins', 'Zwei']
eq(S.creativeMode(singleTwoDesc), 'asset_feed_text', 'zwei Beschreibungen ohne Platzierungs-Medien = Textvarianten')
ok(!codesOf({ ...JSON.parse(JSON.stringify(hb.spec)), ads: [singleTwoDesc] }).some(i => i.code === 'descriptions_single'), 'Textvarianten ohne Platzierungs-Medien: bis 5 Beschreibungen erlaubt')
eq(afs.descriptions, [{ text: '30 Minuten, unverbindlich' }], 'asset_feed: genau eine Beschreibung')
const noDesc = JSON.parse(JSON.stringify(lang)); noDesc.descriptions = []
eq(S.buildCreativePayload(noDesc, { placements: hb.spec.adsets[0].placements }).payload.asset_feed_spec.descriptions, [{ text: ' ' }], 'asset_feed ohne Beschreibung: Leerzeichen statt Landingpage-Text')
// Advantage+ Zielgruppe: fehlt = 1 (Payload und Prüfung gleich), false/'0' = 0
eq([S.effectiveAdvantageAudience(undefined), S.effectiveAdvantageAudience(1), S.effectiveAdvantageAudience(0), S.effectiveAdvantageAudience(false), S.effectiveAdvantageAudience('0')], [1, 1, 0, 0, 0], 'effectiveAdvantageAudience')
const advSpec = JSON.parse(JSON.stringify(hNo.spec)); advSpec.adsets[1].targeting = { geo_locations: { countries: ['DE'] }, age_min: 30, age_max: 55 }
ok(codesOf(advSpec).some(i => i.code === 'advantage_age' && i.node === advSpec.adsets[1].key), 'advantage_age bei fehlendem advantage_audience nicht erkannt')
eq(S.buildTargeting(advSpec.adsets[1], advSpec.campaign).targeting_automation, { advantage_audience: 1 }, 'buildTargeting: fehlend = 1 explizit')
advSpec.adsets[1].targeting.targeting_automation = { advantage_audience: false }
eq(S.buildTargeting(advSpec.adsets[1], advSpec.campaign).targeting_automation, { advantage_audience: 0 }, 'buildTargeting: false = 0')
ok(!codesOf(advSpec).some(i => i.code === 'advantage_age' && i.node === advSpec.adsets[1].key), 'advantage_age trotz Advantage+ aus')
// Stadt-Radius (Meta: 10-50 Meilen bzw. 17-80 km, immer) vs. Wohnen-Minimum 15 km für Adressen
const radiusCase = (geo, hec) => {
  const sp = JSON.parse(JSON.stringify(hb.spec))
  if (!hec) { sp.campaign.special_ad_categories = []; sp.campaign.special_ad_category_country = [] }
  sp.adsets[0].targeting.geo_locations = geo
  return codesOf(sp).filter(i => i.node === sp.adsets[0].key).map(i => i.code)
}
ok(radiusCase({ cities: [{ key: '1', radius: 15, distance_unit: 'kilometer' }] }, true).includes('city_radius'), 'Wohnen: Stadt mit 15 km nicht abgelehnt')
ok(radiusCase({ cities: [{ key: '1', radius: 15, distance_unit: 'kilometer' }] }, false).includes('city_radius'), 'Stadt mit 15 km ohne Wohnen nicht abgelehnt')
ok(!radiusCase({ cities: [{ key: '1', radius: 17, distance_unit: 'kilometer' }] }, true).some(c => c === 'city_radius' || c === 'housing_radius'), 'Wohnen: Stadt mit 17 km abgelehnt')
ok(!radiusCase({ cities: [{ key: '1', radius: 10, distance_unit: 'mile' }] }, true).includes('city_radius'), 'Stadt mit 10 Meilen abgelehnt')
ok(radiusCase({ cities: [{ key: '1', radius: 9, distance_unit: 'mile' }] }, true).includes('city_radius'), 'Stadt mit 9 Meilen nicht abgelehnt')
ok(radiusCase({ cities: [{ key: '1', radius: 81, distance_unit: 'kilometer' }] }, true).includes('city_radius'), 'Stadt mit 81 km nicht abgelehnt')
ok(!radiusCase({ custom_locations: [{ latitude: 34.77, longitude: 32.42, radius: 15, distance_unit: 'kilometer' }] }, true).some(c => c === 'city_radius' || c === 'housing_radius'), 'Wohnen: Adresse mit 15 km abgelehnt')
ok(radiusCase({ custom_locations: [{ latitude: 34.77, longitude: 32.42, radius: 10, distance_unit: 'kilometer' }] }, true).includes('housing_radius'), 'Wohnen: Adresse mit 10 km nicht abgelehnt')
eq(S.CITY_MIN_RADIUS_KM, 17, 'CITY_MIN_RADIUS_KM')
// Video ohne Vorschaubild: serverseitig Fehler (nicht erst nach Kampagne + Gruppen), im Browser Warnung (Server holt das Bild nach)
const vid = JSON.parse(JSON.stringify(hb.spec)); vid.ads[0].format = 'single_video'; vid.ads[0].media = { feed_4x5: { media_id: 'm-v', video_id: 'V1' } }
ok(S.validateDraft(vid, { server: true }).some(i => i.code === 'video_thumb_missing' && i.severity === 'error'), 'Video ohne Vorschaubild serverseitig nicht als Fehler erkannt')
ok(S.validateDraft(vid).some(i => i.code === 'video_thumb_missing' && i.severity === 'warn'), 'Video ohne Vorschaubild im Browser nicht als Warnung erkannt')

// ── 5c. Bearbeiten: editDiff-Klassifizierung ────────────────────────────────
for (const k of S.EDIT_FIELD_KEYS) ok(!!S.fieldSpec(k), `Bearbeiten-Feld ohne FieldSpec: ${k}`)
for (const l of ['campaign', 'adset', 'ad']) for (const k of S.EDIT_LOCKS[l]) ok(!!S.fieldSpec(k), `Sperre ohne FieldSpec: ${k}`)
const ebase = JSON.parse(JSON.stringify(hb.spec))
ebase.campaign.existing_id = PLANB_CAMP; ebase.campaign.status = 'ACTIVE'; ebase.campaign.meta_status = 'ACTIVE'
ebase.campaign.start_time = '2026-09-01T08:00:00.000Z'
ebase.adsets.forEach((a, i) => {
  a.existing_id = `12024867845270${i}`; a.status = 'ACTIVE'; a.meta_status = 'ACTIVE'
  a.targeting.geo_locations.cities = [{ key: '1', name: 'Berlin', region: 'Berlin', country: 'DE', radius: 20, distance_unit: 'kilometer' }]
})
ebase.ads.forEach((a, i) => { a.existing_id = `12024900000000${i}`; a.status = 'ACTIVE'; a.meta_status = 'ACTIVE'; a.source = { creative_id: `CR${i}` } })
ebase.hp = { creative_tausch: 'neue_anzeige' }
const ed = (mut, base = ebase) => { const s2 = JSON.parse(JSON.stringify(base)); mut(s2); return S.editDiff(base, s2) }
const ch = (r, field, node) => r.changes.find(c => c.field === field && (!node || c.node === node))
eq(ed(() => {}).changes, [], 'editDiff: unveränderter Entwurf ohne Änderungen')
// Vergleich ohne Anzeigenamen, Zeit in anderer Schreibweise, Reihenfolge der Länder
eq(ed(s2 => {
  s2.adsets[0].targeting.geo_locations.cities = [{ key: '1', radius: 20, distance_unit: 'kilometer' }]
  s2.campaign.start_time = '2026-09-01T10:00:00+02:00'
  s2.adsets[1].targeting.geo_locations.countries = ['DE']
}).changes.map(c => c.field), [], 'editDiff: Stadt ohne Namen, Zeit mit Zeitzone = keine Änderung')
let er = ed(s2 => { s2.adsets[0].name = 'Kalt · Lang 2' })
ok(ch(er, 'adset.name') && !ch(er, 'adset.name').learning_reset && !ch(er, 'adset.name').blocked, 'editDiff: Name ohne Lernphase')
er = ed(s2 => { s2.adsets[0].daily_budget_cents = 7590 })
eq([ch(er, 'adset.daily_budget_cents')?.learning, ch(er, 'adset.daily_budget_cents')?.learning_reset], ['nein', false], 'editDiff: Budget +10 %')
er = ed(s2 => { s2.adsets[0].daily_budget_cents = 9000 })
ok(ch(er, 'adset.daily_budget_cents')?.learning === 'moeglich' && er.warnings.some(w => /20 %/.test(w)), 'editDiff: Budget +30 % = Lernphase möglich + Hinweis')
er = ed(s2 => { s2.adsets[0].targeting.geo_locations.countries = ['DE', 'AT'] })
ok(ch(er, 'adset.targeting.geo_locations')?.learning_reset === true, 'editDiff: Standort = Lernphase neu')
er = ed(s2 => { s2.adsets[0].placements = { mode: 'manual', publisher_platforms: ['facebook', 'instagram'] } })
ok(ch(er, 'adset.placements')?.learning_reset === true, 'editDiff: Platzierungen = Lernphase neu')
er = ed(s2 => { s2.adsets[0].targeting.targeting_automation = { advantage_audience: 0 } })
ok(ch(er, 'adset.targeting.advantage_audience')?.learning_reset === true, 'editDiff: Advantage+ Zielgruppe = Lernphase neu')
er = ed(s2 => { s2.adsets[0].user_os = ['iOS'] })
ok(er.changes.length === 0 && er.warnings.some(w => /„user_os“/.test(w)), 'editDiff: unbekanntes Feld = Hinweis statt still verwerfen')
er = ed(s2 => { s2.adsets[0].targeting.user_os = ['iOS'] })
ok(ch(er, 'adset.targeting')?.learning_reset === true, 'editDiff: übrige Targeting-Felder (user_os)')
er = ed(s2 => { s2.adsets[0].optimization_goal = 'LANDING_PAGE_VIEWS' })
ok(ch(er, 'adset.optimization_goal')?.learning_reset === true && !ch(er, 'adset.optimization_goal').blocked && er.warnings.some(w => /Performance-Ziel/.test(w)), 'editDiff: Performance-Ziel = Lernphase + Hinweis')
er = ed(s2 => { s2.adsets[0].optimization_goal = 'LEAD_GENERATION' })
ok(!!ch(er, 'adset.optimization_goal')?.blocked && !ch(er, 'adset.optimization_goal').learning_reset, 'editDiff: Performance-Ziel passt nicht zum Ort = gesperrt')
er = ed(s2 => { s2.adsets[0].promoted_object.custom_event_type = 'LEAD' })
ok(ch(er, 'adset.promoted_object.custom_event_type')?.learning_reset === true && !ch(er, 'adset.promoted_object.custom_event_type').blocked, 'editDiff: Conversion-Event bei Website-Conversions änderbar')
er = ed(s2 => { s2.adsets[0].optimization_goal = 'LANDING_PAGE_VIEWS'; s2.adsets[0].promoted_object.custom_event_type = 'LEAD' })
ok(!!ch(er, 'adset.promoted_object.custom_event_type')?.blocked, 'editDiff: Conversion-Event ohne Website-Conversions gesperrt')
er = ed(s2 => { s2.adsets[0].attribution = 'click_1d' })
ok(ch(er, 'adset.attribution')?.learning_reset === true, 'editDiff: Attribution = Lernphase neu')
for (const [f, mut] of [
  ['campaign.objective', s2 => { s2.campaign.objective = 'OUTCOME_SALES' }],
  ['campaign.special_ad_categories', s2 => { s2.campaign.special_ad_categories = [] }],
  ['adset.destination', s2 => { s2.adsets[0].destination = 'ON_AD' }],
  ['adset.billing_event', s2 => { s2.adsets[0].billing_event = 'LINK_CLICKS' }],
  ['ad.identity.page_id', s2 => { s2.ads[0].identity.page_id = '123456789' }],
]) {
  const x = ch(ed(mut), f)
  ok(!!x && x.blocked === S.EDIT_BLOCK_TEXT.lock && x.learning_reset === false, `editDiff: ${f} gesperrt`)
}
er = ed(s2 => { s2.ads[0].status = 'PAUSED'; s2.adsets[1].status = 'PAUSED' })
ok(ch(er, 'ad.status') && !ch(er, 'ad.status').blocked && !ch(er, 'ad.status').learning_reset && ch(er, 'adset.status')?.learning === 'nein', 'editDiff: Pausieren ohne Lernphase')
er = ed(s2 => { s2.ads[0].status = 'ARCHIVED' })
ok(ch(er, 'ad.status')?.blocked === S.EDIT_BLOCK_TEXT.nieLoeschen, 'editDiff: Archivieren gesperrt')
const pausiert = JSON.parse(JSON.stringify(ebase)); pausiert.adsets[0].status = 'PAUSED'
er = ed(s2 => { s2.adsets[0].status = 'ACTIVE' }, pausiert)
ok(ch(er, 'adset.status')?.learning === 'moeglich' && er.warnings.some(w => /eingeschaltet/.test(w)), 'editDiff: Einschalten = Hinweis Lernphase nach Pause')
const archiv = JSON.parse(JSON.stringify(ebase)); archiv.adsets[0].meta_status = 'ARCHIVED'; delete archiv.adsets[0].status
ok(ch(ed(s2 => { s2.adsets[0].name = 'x' }, archiv), 'adset.name')?.blocked === S.EDIT_BLOCK_TEXT.archiviert, 'editDiff: archivierte Gruppe gesperrt')
ok(ch(ed(s2 => { delete s2.adsets[0].daily_budget_cents; s2.adsets[0].lifetime_budget_cents = 100000 }), 'adset.lifetime_budget_cents')?.blocked === S.EDIT_BLOCK_TEXT.budgetart, 'editDiff: Budgetart tauschen gesperrt')
// Kampagnenbudget (CBO)
const cboBase = JSON.parse(JSON.stringify(ebase))
cboBase.campaign.budget_level = 'campaign'; cboBase.campaign.daily_budget_cents = 13800; cboBase.campaign.spend_cap_cents = 500000
cboBase.campaign.is_adset_budget_sharing_enabled = undefined
cboBase.adsets.forEach(a => { delete a.daily_budget_cents; delete a.bid_strategy })
eq(ed(() => {}, cboBase).changes, [], 'editDiff CBO: unverändert')
ok(ch(ed(s2 => { s2.adsets[0].daily_budget_cents = 5000 }, cboBase), 'adset.daily_budget_cents')?.blocked === S.EDIT_BLOCK_TEXT.budgetAufKampagne, 'editDiff CBO: Gruppenbudget gesperrt')
er = ed(s2 => { delete s2.campaign.spend_cap_cents }, cboBase)
ok(ch(er, 'campaign.spend_cap_cents')?.after === null && !ch(er, 'campaign.spend_cap_cents').blocked, 'editDiff: Ausgabenlimit entfernen erlaubt')
er = ed(s2 => { s2.campaign.spend_cap_cents = S.META_UNBEGRENZT }, cboBase)
ok(ch(er, 'campaign.spend_cap_cents')?.after === null, 'editDiff: Metas „unbegrenzt“ = kein Limit')
er = ed(s2 => { s2.adsets[0].daily_spend_cap_cents = 4000 }, cboBase)
ok(ch(er, 'adset.daily_spend_cap_cents') && !ch(er, 'adset.daily_spend_cap_cents').blocked, 'editDiff CBO: Gruppen-Ausgabenlimit erlaubt')
ok(!!ch(ed(s2 => { s2.adsets[0].daily_spend_cap_cents = 4000 }), 'adset.daily_spend_cap_cents')?.blocked, 'editDiff ohne CBO: Gruppen-Ausgabenlimit gesperrt')
ok(!!ch(ed(s2 => { s2.campaign.is_adset_budget_sharing_enabled = true }), 'campaign.is_adset_budget_sharing_enabled')?.blocked, 'editDiff: Budget teilen einschalten gesperrt')
ok(ch(ed(s2 => { s2.adsets[0].adset_schedule = [{ start_minute: 480, end_minute: 1200, days: [1, 2, 3, 4, 5] }] }), 'adset.adset_schedule')?.blocked === S.EDIT_BLOCK_TEXT.zeitplanLaufzeit, 'editDiff: Zeitplan ohne Laufzeitbudget gesperrt')
// Werbemittel
er = ed(s2 => { s2.ads[0].primary_texts = ['Immobilien auf Zypern, EU-Mitglied. Neuer Text.'] })
ok(ch(er, 'ad.primary_texts')?.creative === true && ch(er, 'ad.primary_texts').learning_reset === true && er.warnings.some(w => /neue Anzeige/.test(w)), 'editDiff: Text = Werbemittel-Tausch (neue Anzeige)')
er = ed(s2 => { s2.hp = { creative_tausch: 'ersetzen' }; delete s2.ads[0].media.story_9x16 })
ok(ch(er, 'ad.media.story_9x16')?.blocked === S.EDIT_BLOCK_TEXT.ersetzenModus, 'editDiff: Ersetzen mit Wechsel Medien je Platzierung -> Einzelmedium gesperrt')
er = ed(s2 => { delete s2.ads[0].media.story_9x16 })
ok(ch(er, 'ad.media.story_9x16') && !ch(er, 'ad.media.story_9x16').blocked, 'editDiff: neue Anzeige darf das Format wechseln')
er = ed(s2 => { s2.ads[0].media.feed_4x5 = { media_id: 'm-neu', image_hash: 'h-neu' } })
ok(ch(er, 'ad.media.feed_4x5')?.creative === true, 'editDiff: neues Bild = Werbemittel-Tausch')
er = ed(s2 => { s2.ads[0].media.feed_4x5 = { media_id: 'm-feed' } })
eq(er.changes.map(c => c.field), [], 'editDiff: Medium nur über media_id verglichen')
const beitrag = JSON.parse(JSON.stringify(ebase)); beitrag.ads[0].source = { aus_beitrag: true }
ok(ch(ed(s2 => { s2.ads[0].headlines = ['Neu'] }, beitrag), 'ad.headlines')?.blocked === S.EDIT_BLOCK_TEXT.beitrag, 'editDiff: Anzeige aus Beitrag nicht änderbar')
er = ed(s2 => { s2.ads.pop() })
ok(er.changes.length === 0 && er.warnings.some(w => /nie löschen/.test(w)), 'editDiff: entfernte Anzeige = nur Hinweis')
er = ed(s2 => { const n = JSON.parse(JSON.stringify(s2.ads[0])); delete n.existing_id; n.key = 'neu'; s2.ads.push(n) })
ok(er.changes.length === 0 && er.warnings.some(w => /Anzeigen hinzufügen/.test(w)), 'editDiff: neue Anzeige = nur Hinweis')
// Sperrliste, Prüfungen, Budgetplanung
const locks = S.editLocks(ebase)
ok(['campaign.objective', 'adset.billing_event', 'adset.destination', 'campaign.daily_budget_cents', 'adset.lifetime_budget_cents'].every(k => locks.includes(k)), `editLocks unvollständig: ${locks.join(', ')}`)
ok(!locks.includes('adset.daily_budget_cents') && !locks.includes('adset.promoted_object.custom_event_type'), 'editLocks sperrt zu viel')
const vf = JSON.parse(JSON.stringify(cboBase))
vf.adsets[0].adset_schedule = [{ start_minute: 30, end_minute: 60, days: [1] }]
vf.adsets[1].daily_min_spend_target_cents = 5000; vf.adsets[1].daily_spend_cap_cents = 4000
vf.campaign.spend_cap_cents = 20000000
vf.campaign.budget_schedule_specs = [{ time_start: '2026-11-01T10:00:00Z', time_end: '2026-11-01T11:00:00Z', budget_value: 100, budget_value_type: 'ABSOLUTE' }]
eq(S.validateEditFields(vf).map(i => i.code).sort(), ['budget_schedule_invalid', 'schedule_invalid', 'spend_cap_high', 'spend_limits_order'], 'validateEditFields')
const z1 = { time_start: '2026-11-01T10:00:00Z', time_end: '2026-11-01T16:00:00Z', budget_value: 50, budget_value_type: 'MULTIPLIER' }
const z1unix = { ...z1, time_start: Date.parse(z1.time_start) / 1000, time_end: Date.parse(z1.time_end) / 1000, id: '77' }
eq(S.neueBudgetZeitraeume([z1unix], [z1]).length, 0, 'Budgetplanung: ISO und Unix-Sekunden gleich')
eq(S.neueBudgetZeitraeume([], [z1]).length, 1, 'Budgetplanung: neuer Zeitraum erkannt')
ok(!!ch(ed(s2 => { s2.campaign.budget_schedule_specs = [] }, { ...JSON.parse(JSON.stringify(cboBase)), campaign: { ...cboBase.campaign, budget_schedule_specs: [z1unix] } }), 'campaign.budget_schedule_specs')?.blocked, 'Budgetplanung: Entfernen gesperrt')
// Verschieben in eine andere Anzeigengruppe: nichts an dieser Anzeige senden
er = ed(s2 => { s2.ads[0].adset_key = s2.adsets[1].key; s2.ads[0].headlines = ['Neu'] })
ok(!!ch(er, 'ad.headlines') && er.changes.filter(c => c.level === 'ad' && c.node === ebase.ads[0].key).every(c => c.blocked === S.EDIT_BLOCK_TEXT.verschieben) && er.warnings.some(w => /verschieben/.test(w)), 'editDiff: verschobene Anzeige gesperrt')
// Laufzeit-Ausgabenlimit entfernen (bei Meta ungeprüft) gesperrt, ändern erlaubt
const cboLz = JSON.parse(JSON.stringify(cboBase)); delete cboLz.campaign.daily_budget_cents; cboLz.campaign.lifetime_budget_cents = 300000
cboLz.campaign.stop_time = '2026-12-31T23:00:00.000Z'; cboLz.adsets[0].lifetime_spend_cap_cents = 50000
ok(ch(ed(s2 => { delete s2.adsets[0].lifetime_spend_cap_cents }, cboLz), 'adset.lifetime_spend_cap_cents')?.blocked === S.EDIT_BLOCK_TEXT.laufzeitLimitEntfernen, 'editDiff: Laufzeit-Ausgabenlimit entfernen gesperrt')
ok(!ch(ed(s2 => { s2.adsets[0].lifetime_spend_cap_cents = 60000 }, cboLz), 'adset.lifetime_spend_cap_cents')?.blocked, 'editDiff: Laufzeit-Ausgabenlimit ändern erlaubt')
// Bearbeiten-Felder an neuen Objekten: serverseitig Fehler (nie still verwerfen), im Browser und an Bestehendem nicht
const neuEdit = JSON.parse(JSON.stringify(hb.spec))
neuEdit.adsets[0].adset_schedule = [{ start_minute: 480, end_minute: 1200, days: [1] }]; neuEdit.adsets[0].daily_spend_cap_cents = 4000
neuEdit.ads[0].tracking_specs = [{ 'action.type': ['offsite_conversion'] }]
const eo = S.validateDraft(neuEdit, { server: true }).filter(i => i.code === 'edit_only').map(i => i.field).sort()
eq(eo, ['adset.adset_schedule', 'adset.daily_spend_cap_cents'], 'validateDraft: Bearbeiten-Felder an neuen Objekten (edit_only, Tracking geht seit Runde 2 auch beim Anlegen)')
ok(!S.validateDraft(neuEdit).some(i => i.code === 'edit_only'), 'validateDraft: edit_only nur serverseitig')
ok(!S.validateDraft(cboLz, { server: true }).some(i => i.code === 'edit_only'), 'validateDraft: edit_only nicht an bestehenden Objekten')
ok(S.BUILDER_MODES.includes('edit_load') && S.BUILDER_WRITE_MODES.includes('edit_apply') && S.BUILDER_WRITE_MODES.includes('bulk') && !S.BUILDER_WRITE_MODES.includes('edit_diff'), 'Bearbeiten-Modi registriert')
ok(!/[‒-―]/.test(JSON.stringify(Object.values(S.EDIT_BLOCK_TEXT))), 'EDIT_BLOCK_TEXT mit Gedankenstrich')

// ── 5d. Werbemittel komplett + Conversion-Orte (Runde 2) ────────────────────
const r2 = (mut) => { const sp = JSON.parse(JSON.stringify(hb.spec)); sp.ads = [JSON.parse(JSON.stringify(single))]; mut(sp, sp.ads[0], sp.adsets[0]); return sp }
const r2codes = (sp, opts) => S.validateDraft(sp, opts).filter(i => i.level === 'ad').map(i => `${i.severity}:${i.code}`)
const r2payload = (sp) => S.buildCreativePayload(sp.ads[0], { placements: sp.adsets.find(a => a.key === sp.ads[0].adset_key).placements })
const FBPOST = `${S.HP_PAGE_ID}_122100000000000001`
// Vorhandener Facebook-Beitrag: object_story_id statt object_story_spec, keine Texte/Medien nötig
let sp2 = r2((sp, ad) => { ad.beitrag = { quelle: 'facebook', id: FBPOST }; ad.primary_texts = []; ad.headlines = []; ad.media = {} })
// Pixel-Gruppe (Plan B): ohne Website-URL ist die Conversion-Domain Pflicht (Meta-Doku)
eq(r2codes(sp2).filter(c => c.startsWith('error')), ['error:required'], 'FB-Beitrag in Pixel-Gruppe: Conversion-Domain fehlt nicht erkannt')
ok(S.validateDraft(sp2).some(i => i.field === 'ad.tracking.conversion_domain' && i.code === 'required'), 'FB-Beitrag: Fehler an der Conversion-Domain')
eq(r2codes(r2((sp, ad) => { ad.beitrag = { quelle: 'facebook', id: FBPOST }; ad.primary_texts = []; ad.headlines = []; ad.media = {}; ad.tracking = { conversion_domain: 'happy-property.com' } })).filter(c => c.startsWith('error')), [], 'FB-Beitrag: keine Fehler ohne Texte/Medien')
let cp2 = r2payload(sp2)
eq(cp2.mode, 'beitrag', 'FB-Beitrag: Modus')
ok(cp2.payload.object_story_id === FBPOST && cp2.payload.object_story_spec === undefined && cp2.payload.instagram_user_id === IG, 'FB-Beitrag: object_story_id + instagram_user_id, ohne object_story_spec')
ok(cp2.payload.url_tags === S.URL_TAGS_STANDARD && cp2.payload.contextual_multi_ads.enroll_status === 'OPT_OUT', 'FB-Beitrag: UTM + Mehrere Werbetreibende aus')
eq(S.buildAdPayload(sp2.ads[0], 'AS', { creative_id: 'C' }).conversion_domain, undefined, 'FB-Beitrag: keine Conversion-Domain aus Formular-URL')
ok(r2codes(r2((sp, ad) => { ad.beitrag = { quelle: 'facebook', id: '123' } })).includes('error:beitrag_invalid'), 'FB-Beitrag: ungültige ID nicht erkannt')
const leadPost = r2((sp, ad, as) => { as.destination = 'ON_AD'; as.optimization_goal = 'LEAD_GENERATION'; as.promoted_object = { page_id: S.HP_PAGE_ID }; as.attribution = 'click_1d'; ad.beitrag = { quelle: 'facebook', id: FBPOST }; ad.destination = { kind: 'lead_form', form_id: 'F1' }; ad.cta_type = 'SIGN_UP' })
ok(r2codes(leadPost).includes('error:beitrag_ziel'), 'FB-Beitrag mit Sofortformular nicht abgelehnt')
// Vorhandener Instagram-Beitrag: source_instagram_media_id + object_id + CTA mit Link (Meta-Doku)
sp2 = r2((sp, ad) => { ad.beitrag = { quelle: 'instagram', id: '17900000000000001' }; ad.media = {} })
cp2 = r2payload(sp2).payload
ok(cp2.source_instagram_media_id === '17900000000000001' && cp2.object_id === S.HP_PAGE_ID && cp2.instagram_user_id === IG, 'IG-Beitrag: source_instagram_media_id + object_id + instagram_user_id')
eq(cp2.call_to_action, { type: 'BOOK_NOW', value: { link: S.PLAN_B_LP_LANG } }, 'IG-Beitrag: CTA mit Link')
eq(r2codes(sp2).filter(c => c.startsWith('error')), [], 'IG-Beitrag: keine Fehler')
// Karussell: Bild- und Videokarten, Zuschnitt, Endkarte/Reihenfolge, Video-Vorschaubild, Format-Mix
const karten = [
  { headline: 'Pool', media: { media_id: 'm1', image_hash: 'h1', aspect: '1:1', crops: { '100x100': [[0, 0], [1080, 1080]] } } },
  { headline: 'Rundgang', description: 'Video', media: { media_id: 'm2', video_id: 'V2', thumbnail_hash: 'th2', aspect: '1:1' } },
]
sp2 = r2((sp, ad) => { ad.format = 'carousel'; ad.media = { cards: karten }; ad.karussell = { endkarte: true, reihenfolge_automatisch: false } })
cp2 = r2payload(sp2)
const ldk = cp2.payload.object_story_spec.link_data
ok(cp2.mode === 'carousel' && ldk.multi_share_end_card === true && ldk.multi_share_optimized === false, 'Karussell: Schalter Endkarte/Reihenfolge')
ok(ldk.child_attachments[1].video_id === 'V2' && ldk.child_attachments[1].image_hash === 'th2' && ldk.child_attachments[0].image_crops?.['100x100'], 'Karussell: Videokarte mit Vorschaubild, Bildkarte mit Zuschnitt')
eq(r2codes(sp2).filter(c => c.startsWith('error')), [], 'Karussell mit Videokarte: keine Fehler')
const ohneEnd = r2((sp, ad) => { ad.format = 'carousel'; ad.media = { cards: karten } })
ok(r2payload(ohneEnd).payload.object_story_spec.link_data.multi_share_end_card === false && r2payload(ohneEnd).payload.object_story_spec.link_data.multi_share_optimized === true, 'Karussell: HP-Standard Endkarte aus, Reihenfolge automatisch')
const mix = r2((sp, ad) => { ad.format = 'carousel'; ad.media = { cards: [karten[0], { headline: 'X', media: { media_id: 'm3', video_id: 'V3', aspect: '9:16' } }] } })
const mixCodes = r2codes(mix, { server: true })
ok(mixCodes.includes('warn:cards_ratio') && mixCodes.includes('error:card_thumb_missing'), `Karussell: Format-Mix/Vorschaubild nicht erkannt (${mixCodes.join(', ')})`)
ok(r2codes(r2((sp, ad) => { ad.format = 'carousel'; ad.media = { cards: [{ ...karten[0], media: { ...karten[0].media, crops: { '100x100': [[0, 0], [1080, 900]] } } }, karten[1]] } })).includes('error:crop_invalid'), 'falscher Zuschnitt nicht erkannt')
// Formate 1:1 / 4:5 / 9:16 / 1.91:1: vier Platzierungsregeln, Quadrat nimmt Marketplace
sp2 = r2((sp, ad) => { ad.media = { feed_4x5: { media_id: 'f', image_hash: 'hf' }, story_9x16: { media_id: 's', image_hash: 'hs' }, square_1x1: { media_id: 'q', image_hash: 'hq' }, landscape_191x1: { media_id: 'l', image_hash: 'hl' } } })
cp2 = r2payload(sp2)
const af4 = cp2.payload.asset_feed_spec
eq(cp2.mode, 'asset_feed', '4 Formate: Medien je Platzierung')
eq(af4.images.map(i => [i.hash, i.adlabels[0].name]), [['hs', S.PAC_LABEL_STORY], ['hf', S.PAC_LABEL_FEED], ['hl', S.PAC_LABEL_QUER], ['hq', S.PAC_LABEL_QUADRAT]], '4 Formate: Bilder je Regel')
ok(af4.asset_customization_rules[1].customization_spec.facebook_positions.join() === 'feed' && af4.asset_customization_rules[3].customization_spec.facebook_positions.join() === 'marketplace', '4 Formate: Marketplace beim Quadrat, nicht im Feed')
eq(af4.asset_customization_rules[2].customization_spec.facebook_positions, ['right_hand_column', 'search'], '1.91:1 für rechte Spalte und Suche')
// Ein Foto, zwei Zuschnitte = zwei Plätze (Medien je Platzierung)
sp2 = r2((sp, ad) => { ad.media = { feed_4x5: { media_id: 'p', image_hash: 'hp', crops: { '400x500': [[0, 0], [800, 1000]] } }, story_9x16: { media_id: 'p', image_hash: 'hp', crops: { '90x160': [[100, 0], [662, 1000]] } } } })
cp2 = r2payload(sp2)
ok(cp2.mode === 'asset_feed' && cp2.payload.asset_feed_spec.images.every(i => i.hash === 'hp' && i.image_crops), 'gleiches Foto mit zwei Zuschnitten = Medien je Platzierung')
eq(S.creativeMode(r2((sp, ad) => { ad.media = { feed_4x5: { media_id: 'p', image_hash: 'hp' }, story_9x16: { media_id: 'p', image_hash: 'hp' } } }).ads[0]), 'link_data', 'gleiches Foto ohne Zuschnitt = ein Medium')
// Einzelbild mit Zuschnitt
sp2 = r2((sp, ad) => { ad.media.feed_4x5.crops = { '400x500': [[0, 0], [1440, 1800]] } })
ok(!!r2payload(sp2).payload.object_story_spec.link_data.image_crops?.['400x500'], 'Einzelbild: image_crops in link_data')
// Video: gewähltes Vorschaubild geht als image_hash mit
sp2 = r2((sp, ad) => { ad.format = 'single_video'; ad.media = { feed_4x5: { media_id: 'v', video_id: 'V9', thumbnail_hash: 'gewaehlt', thumbnail_quelle: 'meta_liste' } } })
eq(r2payload(sp2).payload.object_story_spec.video_data.image_hash, 'gewaehlt', 'Video: Vorschaubild')
ok(!r2codes(r2((sp, ad) => { ad.format = 'single_video'; ad.media = { feed_4x5: { media_id: 'v', video_id: 'V9', thumbnail_media_id: '11111111-2222-3333-4444-555555555555' } } }), { server: true }).includes('error:video_thumb_missing'), 'Video mit eigenem Vorschaubild (thumbnail_media_id) fälschlich ohne Vorschaubild')
// Mehrere Texte, ein Medium, eine Beschreibung: bewährtes Platzierungs-Creative (gleiches Bild je Regel)
sp2 = r2((sp, ad) => { ad.primary_texts = ['Eins.', 'Zwei.', 'Drei.'] })
cp2 = r2payload(sp2)
ok(cp2.mode === 'asset_feed' && cp2.payload.asset_feed_spec.optimization_type === 'PLACEMENT' && cp2.payload.asset_feed_spec.images.every(i => i.hash === 'hashfeed') && cp2.payload.asset_feed_spec.bodies.length === 3, 'Textvarianten mit einer Beschreibung: Platzierungs-Creative', cp2.payload.asset_feed_spec)
eq(S.creativeMode(sp2.ads[0], { mode: 'manual', publisher_platforms: ['facebook'], facebook_positions: ['feed'] }), 'asset_feed_text', 'Textvarianten mit nur einer Platzierungsregel: ohne Regeln')
sp2 = r2((sp, ad) => { ad.primary_texts = ['Eins.', 'Zwei.']; ad.media = { landscape_191x1: { media_id: 'l', image_hash: 'hl' } } })
ok(r2payload(sp2).payload.asset_feed_spec.images.every(i => i.hash === 'hl'), 'Textvarianten nur mit Querformat: Medium in jeder Regel')
// Textvarianten ohne Platzierungs-Medien: asset_feed ohne Regeln, bis 5 Beschreibungen
sp2 = r2((sp, ad) => { ad.primary_texts = ['Eins.', 'Zwei.', 'Drei.']; ad.descriptions = ['A', 'B'] })
cp2 = r2payload(sp2)
const aft = cp2.payload.asset_feed_spec
ok(cp2.mode === 'asset_feed_text' && aft.asset_customization_rules === undefined && aft.optimization_type === undefined, 'Textvarianten: ohne Platzierungsregeln')
ok(aft.bodies.length === 3 && aft.descriptions.length === 2 && aft.images.length === 1 && aft.titles.length === 1, 'Textvarianten: Texte + ein Bild')
eq(r2codes(sp2).filter(c => c.startsWith('error')), [], 'Textvarianten ohne Platzierungs-Medien: keine Fehler')
// Website + Sofortformular
sp2 = r2((sp, ad, as) => { as.destination = 'WEBSITE_AND_LEAD_FORM'; as.promoted_object = { pixel_id: S.HP_PIXEL_ID, custom_event_type: 'LEAD' }; ad.destination = { kind: 'website_lead_form', url: S.PLAN_B_LP_LANG, form_id: '902436082512213' }; ad.cta_type = 'SEE_DETAILS' })
eq(S.validateDraft(sp2).filter(i => i.severity === 'error').map(i => i.code), [], 'Website + Sofortformular: keine Fehler')
cp2 = r2payload(sp2).payload.object_story_spec.link_data
eq([cp2.link, cp2.call_to_action], [S.PLAN_B_LP_LANG, { type: 'SEE_DETAILS', value: { lead_gen_form_id: '902436082512213' } }], 'Website + Sofortformular: Link + Formular am Button')
eq(S.buildAdPayload(sp2.ads[0], 'AS', { creative_id: 'C' }).conversion_domain, 'steuervorteil-zypern-immobilien.com', 'Website + Sofortformular: Conversion-Domain')
ok(S.validateDraft(r2((sp, ad, as) => { as.destination = 'WEBSITE_AND_LEAD_FORM'; as.promoted_object = { pixel_id: S.HP_PIXEL_ID, custom_event_type: 'SCHEDULE' }; ad.destination = { kind: 'website_lead_form', url: S.PLAN_B_LP_LANG, form_id: 'F' } })).some(i => i.code === 'website_form_event'), 'Website + Sofortformular: Ereignis außer Lead nicht abgelehnt')
eq(S.buildAdsetPayload(sp2.adsets[0], sp2.campaign, 'C').destination_type, 'WEBSITE_AND_LEAD_FORM', 'Anzeigengruppe Website + Sofortformular')
// WhatsApp: Ziel WHATSAPP, CONVERSATIONS, Nummer, Begrüßung
sp2 = r2((sp, ad, as) => {
  as.destination = 'WHATSAPP'; as.optimization_goal = 'CONVERSATIONS'; as.attribution = 'click_1d'
  as.promoted_object = { page_id: S.HP_PAGE_ID, whatsapp_phone_number: '+357 99 123456' }
  ad.destination = { kind: 'whatsapp', begruessung: 'Hallo, schön dass du schreibst.', nachricht: 'Ich möchte mehr über Zypern wissen.' }; ad.cta_type = 'WHATSAPP_MESSAGE'
})
eq(S.validateDraft(sp2).filter(i => i.severity === 'error').map(i => `${i.field}:${i.code}`), [], 'WhatsApp: keine Fehler')
const asW = S.buildAdsetPayload(sp2.adsets[0], sp2.campaign, 'C')
eq([asW.destination_type, asW.optimization_goal, asW.promoted_object], ['WHATSAPP', 'CONVERSATIONS', { page_id: S.HP_PAGE_ID, whatsapp_phone_number: '+35799123456' }], 'WhatsApp: Anzeigengruppe (Nummer vereinheitlicht)')
eq(S.buildAdsetPayload({ ...sp2.adsets[0], promoted_object: { page_id: S.HP_PAGE_ID, whatsapp_phone_number: '0049 151 2345 6789' } }, sp2.campaign, 'C').promoted_object.whatsapp_phone_number, '+4915123456789', 'WhatsApp: 00-Nummer als +49 gesendet')
// WhatsApp-Gruppe ohne Pixel: keine Conversion-Domain nötig; mit weiterem Pixel schon
ok(!S.validateDraft(sp2).some(i => i.field === 'ad.tracking.conversion_domain'), 'WhatsApp ohne Pixel: Conversion-Domain fälschlich verlangt')
ok(S.validateDraft(r2((sp, ad, as) => {
  as.destination = 'WHATSAPP'; as.optimization_goal = 'CONVERSATIONS'; as.attribution = 'click_1d'; as.promoted_object = { page_id: S.HP_PAGE_ID }
  ad.destination = { kind: 'whatsapp' }; ad.cta_type = 'WHATSAPP_MESSAGE'; ad.tracking = { weitere_pixel: ['987745530157374'] }
})).some(i => i.field === 'ad.tracking.conversion_domain' && i.code === 'required'), 'WhatsApp mit weiterem Pixel: Conversion-Domain nicht verlangt')
// Messenger-Lead-Anzeigen (seit v24 gesperrt): Engagement + Messenger bietet kein LEAD_GENERATION mehr
ok(!S.goalsFor('OUTCOME_ENGAGEMENT', 'MESSENGER').includes('LEAD_GENERATION'), 'Messenger-Lead-Anzeige noch wählbar')
ok(S.validateDraft(r2((sp, ad, as) => { sp.campaign.objective = 'OUTCOME_ENGAGEMENT'; as.destination = 'MESSENGER'; as.optimization_goal = 'LEAD_GENERATION'; as.promoted_object = { page_id: S.HP_PAGE_ID } }))
  .some(i => i.field === 'adset.optimization_goal' && i.severity === 'error'), 'Engagement + Messenger + LEAD_GENERATION nicht abgelehnt')
ok(S.DESTINATION_OPTIONS.some(o => o.value === 'LEAD_FROM_MESSENGER' && o.unsupported && o.reasonKey), 'LEAD_FROM_MESSENGER gesperrt mit Grund')
cp2 = r2payload(sp2).payload.object_story_spec.link_data
ok(cp2.link === S.WHATSAPP_LINK && cp2.call_to_action.type === 'WHATSAPP_MESSAGE' && cp2.call_to_action.value.app_destination === 'WHATSAPP', 'WhatsApp: Link + CTA laut Meta-Doku')
ok(JSON.parse(cp2.page_welcome_message).text_format.message.autofill_message.content === 'Ich möchte mehr über Zypern wissen.', 'WhatsApp: Begrüßung')
ok(S.validateDraft(r2((sp, ad, as) => { as.destination = 'WHATSAPP'; as.optimization_goal = 'CONVERSATIONS'; as.attribution = 'click_1d'; as.promoted_object = { page_id: S.HP_PAGE_ID, whatsapp_phone_number: '0815' }; ad.destination = { kind: 'whatsapp' }; ad.cta_type = 'WHATSAPP_MESSAGE' })).some(i => i.code === 'whatsapp_invalid'), 'ungültige WhatsApp-Nummer nicht erkannt')
ok(r2codes(r2((sp, ad, as) => { as.destination = 'WHATSAPP'; as.optimization_goal = 'CONVERSATIONS'; as.attribution = 'click_1d'; as.promoted_object = { page_id: S.HP_PAGE_ID }; ad.destination = { kind: 'whatsapp', begruessung: 'Hallo – Zypern' }; ad.cta_type = 'WHATSAPP_MESSAGE' })).includes('error:dash_char'), 'Gedankenstrich in WhatsApp-Begrüßung nicht erkannt')
// Anrufe: PHONE_CALL, QUALITY_CALL, CALL_NOW mit tel:
sp2 = r2((sp, ad, as) => { as.destination = 'PHONE_CALL'; as.optimization_goal = 'QUALITY_CALL'; as.attribution = 'click_1d'; as.promoted_object = { page_id: S.HP_PAGE_ID }; ad.destination = { kind: 'phone_call', telefon: '+49 (30) 123-4567' }; ad.cta_type = 'CALL_NOW' })
eq(S.validateDraft(sp2).filter(i => i.severity === 'error').map(i => i.code), [], 'Anrufe: keine Fehler')
eq(r2payload(sp2).payload.object_story_spec.link_data.call_to_action, { type: 'CALL_NOW', value: { link: 'tel:+49301234567' } }, 'Anrufe: CALL_NOW mit tel:')
ok(r2codes(r2((sp, ad, as) => { as.destination = 'PHONE_CALL'; as.optimization_goal = 'QUALITY_CALL'; as.attribution = 'click_1d'; as.promoted_object = { page_id: S.HP_PAGE_ID }; ad.destination = { kind: 'phone_call', telefon: '030 1234' }; ad.cta_type = 'CALL_NOW' })).includes('error:phone_invalid'), 'ungültige Telefonnummer nicht erkannt')
ok(r2codes(r2((sp, ad) => { ad.destination = { kind: 'phone_call', telefon: '+49301234567' }; ad.cta_type = 'CALL_NOW' })).includes('error:destination_mismatch'), 'Anruf-Anzeige in Website-Gruppe nicht abgelehnt')
ok(r2codes(r2((sp, ad) => { ad.cta_type = 'WHATSAPP_MESSAGE' })).includes('error:cta_invalid'), 'WhatsApp-CTA bei Website nicht abgelehnt')
// Messenger-Lead gesperrt (mit Grund), Messenger-Klick erlaubt
ok(S.DESTINATION_OPTIONS.find(o => o.value === 'LEAD_FROM_MESSENGER').unsupported && !!S.DESTINATION_OPTIONS.find(o => o.value === 'LEAD_FROM_MESSENGER').reasonKey, 'Messenger-Leads: gesperrt mit Grund')
eq(['WHATSAPP', 'PHONE_CALL', 'WEBSITE_AND_LEAD_FORM'].map(d => !S.DESTINATION_OPTIONS.find(o => o.value === d).unsupported), [true, true, true], 'neue Conversion-Orte freigeschaltet')
ok(S.destinationsFor('OUTCOME_LEADS').includes('WEBSITE_AND_LEAD_FORM') && S.destinationsFor('OUTCOME_LEADS').includes('WHATSAPP'), 'Leads: neue Conversion-Orte wählbar')
// Mehrere Sprachen (LANGUAGE): Deutsch Standard, Englisch als Regel, automatische Übersetzung
sp2 = r2((sp, ad) => { ad.sprachen = { varianten: [{ sprache: 'en', primary_text: 'Property in Cyprus, EU member.', headline: 'Cyprus property', url: 'https://portal.happy-property.com/en/termin' }] } })
cp2 = r2payload(sp2)
const afl = cp2.payload.asset_feed_spec
ok(cp2.mode === 'asset_feed_language' && afl.optimization_type === 'LANGUAGE', 'Sprachen: optimization_type LANGUAGE')
eq(afl.asset_customization_rules.map(r => [r.customization_spec.locales, r.is_default, r.body_label.name]), [[S.SPRACH_LOCALES.de, true, 'hp_lang_de'], [S.SPRACH_LOCALES.en, false, 'hp_lang_en']], 'Sprachen: Regeln')
ok(afl.images.length === 1 && afl.images[0].adlabels === undefined && afl.link_urls[1].website_url === 'https://portal.happy-property.com/en/termin', 'Sprachen: ein Bild für alle, eigene URL je Sprache')
eq(r2codes(sp2).filter(c => c.startsWith('error')), [], 'Sprachen: keine Fehler')
const auto = r2((sp, ad) => { ad.sprachen = { varianten: [], automatisch_uebersetzen: ['en'] } })
eq(r2payload(auto).payload.asset_feed_spec.autotranslate, ['en_XX'], 'Sprachen: automatische Übersetzung')
ok(r2codes(r2((sp, ad) => { ad.sprachen = { varianten: [{ sprache: 'en', primary_text: 'x', headline: 'y' }], automatisch_uebersetzen: ['en'] } })).includes('error:lang_auto_conflict'), 'Sprachen: Konflikt nicht erkannt')
ok(r2codes(r2((sp, ad) => { ad.format = 'carousel'; ad.media = { cards: karten }; ad.sprachen = { varianten: [{ sprache: 'en', primary_text: 'x', headline: 'y' }] } })).includes('error:lang_format'), 'Sprachen mit Karussell nicht abgelehnt')
ok(r2codes(r2((sp, ad) => { ad.primary_texts = ['A.', 'B.']; ad.sprachen = { varianten: [{ sprache: 'en', primary_text: 'x', headline: 'y' }] } })).includes('error:lang_multi_text'), 'Sprachen mit Textvarianten nicht abgelehnt')
// Partnerschaftswerbung
sp2 = r2((sp, ad) => { ad.partnerschaft = { partner_page_id: '100000000000001', partner_ig_user_id: '17841400000000001' } })
cp2 = r2payload(sp2).payload
eq([cp2.facebook_branded_content, cp2.instagram_branded_content, cp2.object_story_spec.page_id], [{ sponsor_page_id: '100000000000001' }, { sponsor_id: '17841400000000001' }, S.HP_PAGE_ID], 'Partnerschaft: Partner als zweite Identität')
cp2 = r2payload(r2((sp, ad) => { ad.partnerschaft = { partner_page_id: '100000000000001', partner_ist_absender: true } })).payload
eq([cp2.object_story_spec.page_id, cp2.object_story_spec.instagram_user_id, cp2.facebook_branded_content, cp2.instagram_branded_content], ['100000000000001', undefined, { sponsor_page_id: S.HP_PAGE_ID }, { sponsor_id: IG }], 'Partnerschaft: Partner als Absender')
ok(r2codes(r2((sp, ad) => { ad.partnerschaft = {} })).includes('error:partner_missing'), 'Partnerschaft ohne Partner nicht erkannt')
// Tracking: weitere Pixel, eigene Conversion-Domain
sp2 = r2((sp, ad) => { ad.tracking = { weitere_pixel: ['987745530157374', S.HP_PIXEL_ID], conversion_domain: 'Happy-Property.com' }; ad.tracking_specs = [{ 'action.type': ['offsite_conversion'], fb_pixel: [S.HP_PIXEL_ID] }] })
const adT = S.buildAdPayload(sp2.ads[0], 'AS', { creative_id: 'C' })
eq(adT.tracking_specs, [{ 'action.type': ['offsite_conversion'], fb_pixel: [S.HP_PIXEL_ID] }, { 'action.type': ['offsite_conversion'], fb_pixel: ['987745530157374'] }], 'Tracking: weitere Pixel ohne Doppelte')
eq(adT.conversion_domain, 'happy-property.com', 'Tracking: eigene Conversion-Domain')
eq(r2codes(sp2).filter(c => c.startsWith('error')), [], 'Tracking an neuer Anzeige: keine Fehler')
ok(r2codes(r2((sp, ad) => { ad.tracking = { conversion_domain: 'https://x' } })).includes('error:domain_invalid'), 'ungültige Conversion-Domain nicht erkannt')
// Vorschau aller Platzierungen
const pf = S.previewFormatsFor(single, { mode: 'advantage' })
ok(pf.includes('RIGHT_COLUMN_STANDARD') && pf.includes('MARKETPLACE_MOBILE') && !pf.includes('AUDIENCE_NETWORK_OUTSTREAM_VIDEO'), 'Vorschau: Bild ohne Audience-Network-Video')
eq(S.previewFormatsFor(single, { mode: 'manual', publisher_platforms: ['instagram'], instagram_positions: ['stream', 'story'] }), ['INSTAGRAM_STANDARD', 'INSTAGRAM_STORY'], 'Vorschau: nur gewählte Platzierungen')
ok(!S.previewFormatsFor({ ...single, format: 'carousel' }, { mode: 'advantage' }).includes('FACEBOOK_STORY_MOBILE'), 'Vorschau: Karussell ohne Facebook Stories')
ok(S.PREVIEW_ALLE_FORMATS.length <= S.LIMITS.previewAlleMax && S.PREVIEW_ALLE_FORMATS.every(f => S.PREVIEW_FORMATS.includes(f)), 'Vorschau: Formatliste')
ok(!pf.includes('DESKTOP_FEED_STANDARD') && S.previewFormatsFor(single, { mode: 'advantage' }, S.PREVIEW_FORMATS).includes('DESKTOP_FEED_STANDARD'), 'Vorschau: Computer-Feed nur auf Wunsch')
// Wohnen unverändert: neue Werbemittel ändern nichts an applyHousing
const hAll = S.applyHousing(r2((sp, ad) => { ad.sprachen = { varianten: [{ sprache: 'en', primary_text: 'x', headline: 'y' }] }; ad.partnerschaft = { partner_page_id: '100000000000001' }; ad.tracking = { weitere_pixel: ['987745530157374'] } }))
eq(hAll.changes.map(c => c.code), [], 'Wohnen: keine Korrektur durch neue Werbemittel-Felder')
ok(!S.validateDraft(hAll.spec).some(i => i.code.startsWith('housing_')), 'Wohnen: keine Housing-Fehler')
// Modi
ok(['posts_list', 'preview_alle', 'ad_vorschau_link', 'video_vorschaubilder', 'video_vorschaubild', 'video_untertitel'].every(m => S.BUILDER_MODES.includes(m)), 'neue Modi registriert')
ok(['preview_alle', 'video_vorschaubild', 'video_untertitel'].every(m => S.BUILDER_WRITE_MODES.includes(m)) && !['posts_list', 'ad_vorschau_link', 'video_vorschaubilder'].some(m => S.BUILDER_WRITE_MODES.includes(m)), 'Schreib-Modi richtig eingeordnet')
// Bearbeiten: neue Felder = Werbemittel-Tausch, Tracking ohne Tausch, Zuschnitt erkannt, Wechsel Feed-Typ beim Ersetzen gesperrt
for (const [f, mut] of [
  ['ad.sprachen', a => { a.sprachen = { varianten: [{ sprache: 'en', primary_text: 'x', headline: 'y' }] } }],
  ['ad.partnerschaft', a => { a.partnerschaft = { partner_page_id: '100000000000001' } }],
  ['ad.media.landscape_191x1', a => { a.media.landscape_191x1 = { media_id: 'l' } }],
  ['ad.beitrag', a => { a.beitrag = { quelle: 'facebook', id: FBPOST } }],
  ['ad.media.feed_4x5', a => { a.media.feed_4x5 = { ...a.media.feed_4x5, crops: { '400x500': [[0, 0], [800, 1000]] } } }],
]) {
  const x = ch(ed(s2 => mut(s2.ads[0])), f)
  ok(!!x && x.creative === true && x.learning_reset === true, `editDiff: ${f} = Werbemittel-Tausch`)
}
er = ed(s2 => { s2.ads[0].tracking = { weitere_pixel: ['987745530157374'] } })
ok(ch(er, 'ad.tracking_specs') && !ch(er, 'ad.tracking_specs').creative && !ch(er, 'ad.tracking_specs').learning_reset, 'editDiff: Tracking ohne Werbemittel-Tausch')
// Mehrere Texte mit einem Medium bleiben ein Platzierungs-Creative (Runde-1-Weg): Ersetzen erlaubt
er = ed(s2 => { s2.hp = { creative_tausch: 'ersetzen' }; delete s2.ads[0].media.story_9x16; s2.ads[0].primary_texts = ['Eins.', 'Zwei.'] })
ok(ch(er, 'ad.media.story_9x16') && !ch(er, 'ad.media.story_9x16').blocked, 'editDiff: Ersetzen Medien je Platzierung -> Textvarianten (gleiches Medium) fälschlich gesperrt')
er = ed(s2 => { s2.hp = { creative_tausch: 'ersetzen' }; delete s2.ads[0].media.story_9x16; s2.ads[0].primary_texts = ['Eins.', 'Zwei.']; s2.ads[0].descriptions = ['A', 'B'] })
ok(ch(er, 'ad.media.story_9x16')?.blocked === S.EDIT_BLOCK_TEXT.ersetzenModus, 'editDiff: Ersetzen Medien je Platzierung -> Textvarianten ohne Regeln gesperrt')
// Feed-Typ aus dem Import zählt: gleiches Bild in beiden Labels (PLACEMENT) -> Einzelmedium beim Ersetzen gesperrt
{
  const b0 = JSON.parse(JSON.stringify(ebase)); b0.ads[0].media.story_9x16 = { ...b0.ads[0].media.feed_4x5 }; b0.ads[0].source = { ...(b0.ads[0].source ?? {}), creative_mode: 'asset_feed' }
  er = ed(s2 => { s2.hp = { creative_tausch: 'ersetzen' }; s2.ads[0].headlines = ['Neu'] }, b0)
  ok(ch(er, 'ad.headlines')?.blocked === S.EDIT_BLOCK_TEXT.ersetzenModus, 'editDiff: importierter Feed-Typ PLACEMENT -> Einzelmedium nicht gesperrt')
  const b1 = JSON.parse(JSON.stringify(ebase)); b1.ads[0].source = { ...(b1.ads[0].source ?? {}), partner_unbekannt: true }
  er = ed(s2 => { s2.ads[0].headlines = ['Neu'] }, b1)
  ok(ch(er, 'ad.headlines')?.blocked === S.EDIT_BLOCK_TEXT.partnerUnbekannt, 'editDiff: unbekannte Partnerschaft nicht gesperrt')
}
const r2payloads = JSON.stringify([karten, af4, aft, afl, adT])
ok(!/[‒-―]/.test(r2payloads) && !/"status":"ACTIVE"/.test(r2payloads), 'Runde-2-Payloads ohne Gedankenstrich/ACTIVE')

// ── 6. Lint ──────────────────────────────────────────────────────────────────
const ctx = {
  forbiddenNames: ['Genesis Residence', 'Kuutio', 'Emerald'],
  media: {
    'm-feed': { name: 'zypern-pool-4x5.jpg', eu_band_confirmed: true, ki_label_confirmed: true },
    'm-story': { name: 'zypern-pool-9x16.jpg', eu_band_confirmed: true, ki_label_confirmed: true },
    'm-kuutio': { name: 'kuutio-pool-4x5.jpg', eu_band_confirmed: true, ki_label_confirmed: true },
    'm-open': { name: 'zypern-meer.jpg' },
  },
}
const baseAd = {
  key: 'x', name: '08_steuer-zurueck_lang',
  primary_texts: ['Immobilien auf Zypern, EU-Mitglied. Steuer, neue Wohnung, Feuer und Abenteuer: teuer war gestern. Du kaufst auf Zypern und holst dir in Deutschland Steuern zurück. 12,5 % statt 42 % Steuersatz, der Kaufvertrag kostet 2 % Notar.'],
  headlines: ['Steuern zurückholen mit Zypern'],
  descriptions: ['30 Minuten, unverbindlich'],
  destination: { kind: 'website', url: S.PLAN_B_LP_LANG },
  media: { feed_4x5: { media_id: 'm-feed' }, story_9x16: { media_id: 'm-story' } },
}
const lintOf = patch => L.lintAd({ ...JSON.parse(JSON.stringify(baseAd)), ...patch }, ctx)
const rules = issues => issues.map(i => `${i.severity}:${i.rule}`)
const clean = lintOf({})
eq(rules(clean), [], 'sauberer Text muss ohne Befund durchgehen')
for (const ch of ['‒', '–', '—', '―']) {
  ok(rules(lintOf({ primary_texts: [`Zypern ${ch} EU-Mitglied.`] })).includes('blocker:gedankenstrich'), `Gedankenstrich U+${ch.charCodeAt(0).toString(16)} nicht erkannt`)
}
ok(rules(lintOf({ headlines: ['Zypern – EU'] })).includes('blocker:gedankenstrich'), 'Gedankenstrich in Überschrift nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Bis zu 8 % Rendite pro Jahr.'] })).includes('blocker:rendite_prozent'), '"8 % Rendite" nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Wertzuwachs von 30 Prozent in fünf Jahren.'] })).includes('blocker:rendite_prozent'), '"30 Prozent Wertzuwachs" nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Finanzierung garantiert.'] })).includes('blocker:finanzierung'), '"Finanzierung garantiert" nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Mehr Infos fuer dich.'] })).includes('blocker:umlaut'), '"fuer" nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Das Grundstueck liegt am Meer.'] })).includes('blocker:umlaut'), '"Grundstueck" nicht erkannt')
const h41 = 'A'.repeat(41), h40 = 'A'.repeat(40)
ok(rules(lintOf({ headlines: [h41] })).includes('blocker:ueberschrift_lang'), '41-Zeichen-Überschrift nicht erkannt')
ok(!rules(lintOf({ headlines: [h40] })).includes('blocker:ueberschrift_lang'), '40-Zeichen-Überschrift fälschlich bemängelt')
ok(rules(lintOf({ descriptions: ['B'.repeat(31)] })).includes('blocker:beschreibung_lang'), '31-Zeichen-Beschreibung nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Wohnen im Genesis Residence an der Küste.'] })).includes('blocker:projektname'), 'Projektname im Text nicht erkannt')
ok(rules(lintOf({ media: { feed_4x5: { media_id: 'm-kuutio' } } })).includes('blocker:projektname'), 'Projektname im Dateinamen nicht erkannt')
ok(rules(lintOf({ destination: { kind: 'website', url: 'https://steuervorteil-zypern-immobilien.com/emerald-paphos/' } })).includes('blocker:projektname'), 'Projektname in URL nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Garantiert sicher und risikolos.'] })).includes('blocker:garantie'), 'Garantieversprechen nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Als Arzt zahlst du zu viel Steuern.'] })).includes('blocker:persoenlich'), 'persönliche Eigenschaft nicht erkannt')
ok(rules(lintOf({ primary_texts: ['Raus aus Deutschland, rein nach Zypern.'] })).includes('warn:de_bashing'), 'DE-Bashing nicht erkannt')
ok(rules(lintOf({ destination: { kind: 'website', url: 'https://example.com/x' } })).includes('warn:url_host'), 'fremde Domain nicht erkannt')
const afa = 'Neubau auf Zypern mit 5 % AfA pro Jahr.'
ok(rules(lintOf({ primary_texts: [afa] })).includes('blocker:afa_pflichtsatz'), 'AfA 5 % ohne Pflichtsatz nicht erkannt')
ok(!rules(lintOf({ primary_texts: [`${afa} ${L.AFA_PFLICHTSATZ}`] })).includes('blocker:afa_pflichtsatz'), 'AfA mit Pflichtsatz fälschlich bemängelt')
const manual = rules(lintOf({ media: { feed_4x5: { media_id: 'm-open' } } }))
ok(manual.includes('manual:eu_band') && manual.includes('manual:ki_label'), 'fehlende EU-Band-/KI-Bestätigung nicht gemeldet')
ok(rules(lintOf({ primary_texts: ['x'.repeat(130)] })).includes('warn:primaertext_satz'), 'fehlender Satz in den ersten 125 Zeichen nicht erkannt')
const dl = L.lintDraft({ campaign: { name: 'Plan B – Test' }, adsets: [], ads: [] }, ctx)
ok(rules(dl).includes('blocker:gedankenstrich'), 'Gedankenstrich im Kampagnennamen nicht erkannt')
ok(L.lintHasBlockers(lintOf({ primary_texts: ['Finanzierung garantiert.'] })) && !L.lintHasBlockers(clean), 'lintHasBlockers')
// Runde 2: weitere Sprachen, WhatsApp-Texte, Website + Sofortformular, Querformat, eigenes Vorschaubild
const en = (v) => lintOf({ sprachen: { varianten: [{ sprache: 'en', primary_text: 'Property in Cyprus, EU member.', headline: 'Cyprus', ...v }] } })
eq(rules(en({})), [], 'Englische Variante ohne Befund')
ok(rules(en({ headline: 'Live at Genesis Residence' })).includes('blocker:projektname'), 'Projektname in englischer Variante nicht erkannt')
ok(rules(en({ primary_text: 'Cyprus – EU.' })).includes('blocker:gedankenstrich'), 'Gedankenstrich in englischer Variante nicht erkannt')
ok(rules(en({ primary_text: 'Up to 8 % return per year.' })).includes('blocker:rendite_prozent'), 'Rendite in englischer Variante nicht erkannt')
ok(rules(en({ headline: 'A'.repeat(41) })).includes('blocker:ueberschrift_lang'), 'Lange englische Überschrift nicht erkannt')
ok(L.lintText('Nobody got sued here.', 'x', ctx).some(i => i.rule === 'umlaut') && !rules(en({ primary_text: 'Nobody got sued here.' })).includes('blocker:umlaut'), 'Umlaut-Regel fälschlich für Englisch')
ok(rules(en({ url: 'https://steuervorteil-zypern-immobilien.com/emerald-paphos/' })).includes('blocker:projektname'), 'Projektname in URL der Sprachversion nicht erkannt')
const wa = (d) => lintOf({ destination: { kind: 'whatsapp', ...d } })
ok(rules(wa({ begruessung: 'Als Arzt zahlst du zu viel.' })).includes('blocker:persoenlich'), 'persönliche Eigenschaft in WhatsApp-Begrüßung nicht erkannt')
ok(rules(wa({ nachricht: 'Ich will ins Emerald.' })).includes('blocker:projektname'), 'Projektname in WhatsApp-Nachricht nicht erkannt')
ok(rules(wa({ begruessung: 'Schoen, dass du schreibst.' })).includes('blocker:umlaut'), 'Umlaut in WhatsApp-Begrüßung nicht erkannt')
eq(rules(wa({ begruessung: 'Schön, dass du schreibst.', nachricht: 'Ich möchte mehr über Zypern wissen.' })), [], 'WhatsApp-Texte ohne Befund')
ok(rules(lintOf({ destination: { kind: 'website_lead_form', url: 'https://steuervorteil-zypern-immobilien.com/emerald-paphos/', form_id: 'F' } })).includes('blocker:projektname'), 'Website + Sofortformular: Projektname in URL nicht erkannt')
ok(rules(lintOf({ destination: { kind: 'website_lead_form', url: 'https://example.com/x', form_id: 'F' } })).includes('warn:url_host'), 'Website + Sofortformular: fremde Domain nicht erkannt')
ok(rules(lintOf({ media: { landscape_191x1: { media_id: 'm-kuutio' } } })).includes('blocker:projektname'), 'Projektname im Querformat-Dateinamen nicht erkannt')
const thumb = lintOf({ media: { feed_4x5: { media_id: 'm-feed', thumbnail_media_id: 'm-open' } } })
ok(thumb.some(i => i.rule === 'eu_band' && i.field === 'ad.media.thumbnail' && i.params?.media_id === 'm-open'), 'eigenes Vorschaubild ohne EU-Band-Bestätigung nicht gemeldet')
ok(rules(lintOf({ media: { feed_4x5: { media_id: 'm-feed', thumbnail_media_id: 'm-kuutio' } } })).includes('blocker:projektname'), 'Projektname im Vorschaubild-Dateinamen nicht erkannt')
// Plan-B-Entwurf (aus Abschnitt 5) muss lint-sauber sein
const pbLint = L.lintDraft(hb.spec, ctx).filter(i => i.severity !== 'manual' || !['m-feed', 'm-story'].includes(i.params?.media_id))
eq(rules(pbLint), [], 'Plan-B-Entwurf lint')
// adCopy.ts nutzt dieselben Regex und verhält sich wie vorher
eq(A.checkAd({ headline: 'Zypern', message: 'Garantiert 100 % sicher.' }).filter(i => i.field === 'compliance').map(i => i.severity), ['blocker'], 'adCopy FORBIDDEN')
eq(A.checkAd({ headline: 'Zypern', message: 'Als Arzt zahlst du zu viel.' }).filter(i => i.field === 'compliance').map(i => i.severity), ['blocker'], 'adCopy PERSONAL_ATTRIBUTE')
ok(A.checkAd({ headline: 'Zypern', message: 'Ruhig planen.', copy: { hook: 'Zypern', problem: 'p', mechanism: 'm', proof: '', benefits: ['a 1', 'b 2'], cta: '30 Minuten Termin' } })
  .every(i => !/Steuersatz, Rendite/.test(i.fix)), 'adCopy schlägt noch "Rendite" als Beleg vor')

// ── Ergebnis ─────────────────────────────────────────────────────────────────
for (const w of warns) console.warn(`⚠ ${w}`)
if (fails.length) {
  console.error(`\n✗ verify:meta - ${fails.length} Fehler:\n  - ${fails.join('\n  - ')}`)
  process.exit(1)
}
console.log(`✓ verify:meta - Spiegel identisch, ${labelKeys.length} i18n-Schlüssel, ${S.FIELD_SPECS.length} Felder, Abhängigkeiten, applyHousing, Plan-B-Payload und Lint-Fälle in Ordnung.`)
