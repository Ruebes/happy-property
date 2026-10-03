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
// Fragment-Verzeichnis des Build-Workflows (Übergang bis die Fragmente in
// src/locales gemergt sind). Überschreibbar mit META_I18N_DIR.
const FRAGMENT_DIR = process.env.META_I18N_DIR
  ?? '/private/tmp/claude-502/-Users-ArPritsch-Downloads/5da4d416-b511-4540-bf49-56b4aeb8fc5c/scratchpad/ads/build/i18n'
const lookup = (obj, key) => key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
const sources = { de: [], en: [] }
for (const lang of ['de', 'en']) {
  sources[lang].push({ name: `src/locales/${lang}.json`, data: JSON.parse(readFileSync(`src/locales/${lang}.json`, 'utf8')) })
  if (existsSync(FRAGMENT_DIR)) {
    for (const f of readdirSync(FRAGMENT_DIR).filter(x => x.endsWith(`.${lang}.json`))) {
      try { sources[lang].push({ name: f, data: JSON.parse(readFileSync(join(FRAGMENT_DIR, f), 'utf8')) }) }
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
for (const kind of ['website', 'lead_form']) for (const c of S.ctaFor(kind)) ok(labelOf(S.CTA_OPTIONS, c), `CTA ohne Option: ${c}`)
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
ok(t1.geo_locations.cities[0].radius === 15 && t1.geo_locations.cities[1].radius === 20, 'applyHousing: Radius')
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
const dhIssues = S.validateDraft(dirtyHousing).map(i => i.code)
for (const c of ['housing_age', 'housing_gender', 'housing_geo_type', 'housing_exclusion', 'housing_radius', 'housing_detailed', 'housing_lookalike', 'housing_advantage_audience'])
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
