// Edge Function: wa-track — Web-Analytics-Ingest + Tracker-Auslieferung
// (eigenes Google Analytics + Mouseflow fuer happy-property.com,
//  happy-property.de und die steuervorteil-Landingpages).
//
//   GET  /t.js            → Tracker-Script (auf jeder Seite einbinden)
//   GET  /r.js            → rrweb-Record-Library (Proxy von jsdelivr, gecacht)
//   POST { a:'batch' }    → Session-Upsert + Events (pageview/click/move/scroll)
//   POST { a:'replay' }   → rrweb-Replay-Chunk
//
// Schreibt in: web_sessions, web_events, web_replay_chunks (Migration
// 20260827_web_analytics.sql). Kein Secret noetig ausser den Standard-Envs.
//
// ── Deployment ──
//   supabase functions deploy wa-track --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } })

const BOT_RE = /bot|crawl|spider|slurp|headless|lighthouse|pingdom|facebookexternal|preview|monitor|scanner|curl|wget/i

// ── User-Agent grob parsen (reicht fuer Geraete-/Browser-Split) ──────────────
function parseUa(ua: string): { device: string; browser: string; os: string } {
  const device = /ipad|tablet/i.test(ua) ? 'Tablet'
    : /mobi|iphone|android.*mobile/i.test(ua) ? 'Mobil' : 'Desktop'
  const browser = /edg\//i.test(ua) ? 'Edge'
    : /opr\//i.test(ua) ? 'Opera'
    : /chrome|crios/i.test(ua) ? 'Chrome'
    : /firefox|fxios/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari' : 'Sonstige'
  const os = /iphone|ipad|ios/i.test(ua) ? 'iOS'
    : /android/i.test(ua) ? 'Android'
    : /windows/i.test(ua) ? 'Windows'
    : /mac os/i.test(ua) ? 'macOS'
    : /linux/i.test(ua) ? 'Linux' : 'Sonstige'
  return { device, browser, os }
}

// ── Kundenseiten mit Token → Session an Lead haengen ─────────────────────────
async function resolveLead(
  supabase: ReturnType<typeof createClient>, path: string,
): Promise<string | null> {
  try {
    const m = path.match(/^\/(deck|rechnung|strategie)\/([A-Za-z0-9_-]{8,})/)
    if (!m) return null
    const token = m[2]
    if (m[1] === 'deck') {
      const { data } = await supabase.from('sales_decks').select('lead_id').eq('token', token).maybeSingle()
      return (data?.lead_id as string) ?? null
    }
    if (m[1] === 'rechnung') {
      const { data } = await supabase.from('property_calculations').select('lead_id').eq('token', token).maybeSingle()
      return (data?.lead_id as string) ?? null
    }
    const { data } = await supabase.from('crm_strategy_scenarios').select('lead_id').eq('token', token).maybeSingle()
    return (data?.lead_id as string) ?? null
  } catch { return null }
}

// ── Tracker-Script (wird als /t.js ausgeliefert) ─────────────────────────────
// Bewusst dependency-frei; rrweb wird zur Laufzeit von /r.js nachgeladen.
// Datenschutz: maskAllInputs (Replay zeichnet KEINE Eingaben im Klartext auf),
// keine Cookies — visitor-id in localStorage.
function trackerJs(base: string): string {
  return `(function(){
'use strict';
if (window.__hpwa) return; window.__hpwa = 1;
if (/${BOT_RE.source}/i.test(navigator.userAgent)) return;
var API='${base}';
var MAX_REPLAY_MS=20*60*1000; // Replay-Deckel pro Session
function uid(){ try { return crypto.randomUUID(); } catch(e){ return 'xxxxxxxxyxxxxyxxxyxxxxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c=='x'?r:(r&3|8)).toString(16)}) } }
function store(s,k,v){ try{ if(v===undefined) return s.getItem(k); s.setItem(k,v); }catch(e){} }
var visitor = store(localStorage,'_hpwa_v'); if(!visitor){ visitor=uid(); store(localStorage,'_hpwa_v',visitor); }
var now=Date.now();
var sid=store(sessionStorage,'_hpwa_s'), last=+(store(sessionStorage,'_hpwa_t')||0);
if(!sid || (now-last)>30*60*1000){ sid=uid(); store(sessionStorage,'_hpwa_s',sid); }
store(sessionStorage,'_hpwa_t',String(now));

var q=[], activeS=0, maxScroll=0, pageMaxScroll=0, replaySeq=0, replayBuf=[], replayStarted=0, sessionSent=false;
var path=location.pathname;

function sessionInfo(){
  var u={}; try{ new URLSearchParams(location.search).forEach(function(v,k){ if(/^utm_|^src$|^f$/.test(k)) u[k]=v.slice(0,200); }); }catch(e){}
  return { id:sid, visitor_id:visitor, site:location.hostname,
    entry_path:path, referrer:document.referrer||null, utm:u,
    screen_w:screen.width, screen_h:screen.height,
    lang:navigator.language, tz:(Intl.DateTimeFormat().resolvedOptions().timeZone||''),
    active_s:activeS, max_scroll_pct:maxScroll };
}
function push(ev){ q.push(ev); if(q.length>=60) flush(); }
function docH(){ var b=document.body,e=document.documentElement; return Math.max(b.scrollHeight,e.scrollHeight,e.clientHeight)||1; }
function flush(sync){
  if(!q.length && sessionSent && !sync) return;
  var body=JSON.stringify({ a:'batch', session:sessionInfo(), events:q.splice(0,q.length) });
  sessionSent=true;
  if(sync && navigator.sendBeacon){ navigator.sendBeacon(API, new Blob([body],{type:'text/plain'})); return; }
  try{ fetch(API,{method:'POST',headers:{'Content-Type':'text/plain'},body:body,keepalive:true}).catch(function(){}); }catch(e){}
}
function pageview(){
  path=location.pathname;
  pageMaxScroll=0;
  push({ t:'pageview', p:path, vw:innerWidth, vh:innerHeight, dh:docH() });
  flush();
}
// SPA-Navigation (History API) mittracken
var _ps=history.pushState, _rs=history.replaceState;
history.pushState=function(){ _ps.apply(this,arguments); if(location.pathname!==path) pageview(); };
history.replaceState=function(){ _rs.apply(this,arguments); if(location.pathname!==path) pageview(); };
addEventListener('popstate',function(){ if(location.pathname!==path) pageview(); });

// Klicks
function selPath(el){
  var parts=[],n=el,i=0;
  while(n && n.nodeType===1 && i<5){
    var s=n.tagName.toLowerCase();
    if(n.id){ parts.unshift(s+'#'+n.id); break; }
    var c=(typeof n.className==='string')?n.className.trim().split(/\\s+/).slice(0,2).join('.'):'';
    parts.unshift(c?s+'.'+c:s); n=n.parentElement; i++;
  }
  return parts.join('>').slice(0,300);
}
addEventListener('click',function(e){
  var el=e.target && e.target.closest ? (e.target.closest('a,button,[role=button],input,select,label')||e.target) : e.target;
  var txt=(el&&(el.innerText||el.value||'')||'').trim().slice(0,60);
  push({ t:'click', p:path, x:Math.round(e.pageX), y:Math.round(e.pageY),
    vw:innerWidth, vh:innerHeight, dh:docH(), sel:el?selPath(el):null, txt:txt||null });
},true);

// Mausbewegung (Sample alle 250ms) — Basis der Bewegungs-Heatmap
var lastMove=0;
addEventListener('mousemove',function(e){
  var n=Date.now(); if(n-lastMove<250) return; lastMove=n;
  push({ t:'move', p:path, x:Math.round(e.pageX), y:Math.round(e.pageY), vw:innerWidth, vh:innerHeight, dh:docH() });
},{passive:true});

// Scrolltiefe
var lastScrollSent=0;
addEventListener('scroll',function(){
  var pct=Math.min(100,Math.round(100*(scrollY+innerHeight)/docH()));
  if(pct>maxScroll) maxScroll=pct;
  if(pct>pageMaxScroll){ pageMaxScroll=pct;
    var n=Date.now();
    if(n-lastScrollSent>2000){ lastScrollSent=n; push({ t:'scroll', p:path, vw:innerWidth, vh:innerHeight, dh:docH(), meta:{pct:pct} }); }
  }
},{passive:true});

// Aktive Zeit: nur zaehlen, wenn Tab sichtbar
setInterval(function(){ if(!document.hidden){ activeS+=5; store(sessionStorage,'_hpwa_t',String(Date.now())); } },5000);
setInterval(function(){ flush(); },10000);
addEventListener('pagehide',function(){
  if(pageMaxScroll) q.push({ t:'scroll', p:path, meta:{pct:pageMaxScroll} });
  flush(true); flushReplay(true);
});
document.addEventListener('visibilitychange',function(){ if(document.hidden){ flush(true); flushReplay(true); } });

// Custom-Events: window.hpwa('event','booking_done')
window.hpwa=function(cmd,name,meta){ if(cmd==='event'&&name){ push({ t:'custom', p:path, txt:String(name).slice(0,60), meta:meta||null }); flush(); } };

// ── Session-Replay via rrweb (maskiert alle Eingaben) ───────────────────────
function flushReplay(sync){
  if(!replayBuf.length) return;
  var body=JSON.stringify({ a:'replay', sid:sid, seq:replaySeq++, events:replayBuf.splice(0,replayBuf.length) });
  if(sync && navigator.sendBeacon){ navigator.sendBeacon(API, new Blob([body],{type:'text/plain'})); return; }
  try{ fetch(API,{method:'POST',headers:{'Content-Type':'text/plain'},body:body,keepalive:true}).catch(function(){}); }catch(e){}
}
function startReplay(){
  if(!window.rrwebRecord) return;
  replayStarted=Date.now();
  try{
    var stop=window.rrwebRecord({
      emit:function(ev){
        if(Date.now()-replayStarted>MAX_REPLAY_MS){ if(stop) stop(); return; }
        replayBuf.push(ev);
        if(replayBuf.length>=120) flushReplay();
      },
      maskAllInputs:true,
      blockClass:'hpwa-block',
      sampling:{ mousemove:100, scroll:200, input:'last' },
      slimDOMOptions:{ script:true, comment:true }
    });
    setInterval(function(){ flushReplay(); },6000);
  }catch(e){}
}
var s=document.createElement('script'); s.src=API+'/r.js'; s.async=true; s.onload=startReplay;
document.head.appendChild(s);

pageview();
})();`
}

// rrweb-Record-Library: einmal von jsdelivr holen, im Isolate cachen.
let rrwebCache: string | null = null
async function rrwebJs(): Promise<string> {
  if (rrwebCache) return rrwebCache
  const res = await fetch('https://cdn.jsdelivr.net/npm/rrweb@1.1.3/dist/record/rrweb-record.min.js')
  if (!res.ok) throw new Error(`rrweb CDN ${res.status}`)
  rrwebCache = await res.text()
  return rrwebCache
}

// ── Ingest ───────────────────────────────────────────────────────────────────
interface TrackEvent {
  t: string; p?: string; x?: number; y?: number
  vw?: number; vh?: number; dh?: number
  sel?: string | null; txt?: string | null; meta?: Record<string, unknown> | null
}
interface SessionInfo {
  id: string; visitor_id: string; site: string
  entry_path?: string; referrer?: string | null; utm?: Record<string, string>
  screen_w?: number; screen_h?: number; lang?: string; tz?: string
  active_s?: number; max_scroll_pct?: number
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function handleBatch(session: SessionInfo, events: TrackEvent[], ua: string): Promise<void> {
  if (!session?.id || !UUID_RE.test(session.id) || !session.site) return
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  const { device, browser, os } = parseUa(ua)

  const evs = (Array.isArray(events) ? events : []).slice(0, 200)
  const newPageviews = evs.filter(e => e.t === 'pageview').length
  const newClicks = evs.filter(e => e.t === 'click').length

  // Session upsert: Zaehler inkrementell, Dauer/Scroll als Maximum.
  const { data: existing } = await supabase.from('web_sessions')
    .select('id, pageviews, clicks, duration_s, max_scroll_pct, lead_id').eq('id', session.id).maybeSingle()
  const ex = existing as { pageviews: number; clicks: number; duration_s: number; max_scroll_pct: number; lead_id: string | null } | null

  const row = {
    id: session.id,
    visitor_id: String(session.visitor_id ?? '').slice(0, 64),
    site: String(session.site).slice(0, 120),
    entry_path: (session.entry_path ?? '').slice(0, 500) || null,
    referrer: (session.referrer ?? '')?.slice(0, 500) || null,
    utm: session.utm && Object.keys(session.utm).length ? session.utm : null,
    device, browser, os,
    screen_w: session.screen_w ?? null, screen_h: session.screen_h ?? null,
    lang: (session.lang ?? '').slice(0, 20) || null,
    tz: (session.tz ?? '').slice(0, 60) || null,
    user_agent: ua.slice(0, 400),
    last_seen_at: new Date().toISOString(),
    duration_s: Math.max(ex?.duration_s ?? 0, Math.min(Number(session.active_s) || 0, 6 * 3600)),
    pageviews: (ex?.pageviews ?? 0) + newPageviews,
    clicks: (ex?.clicks ?? 0) + newClicks,
    max_scroll_pct: Math.max(ex?.max_scroll_pct ?? 0, Math.min(Number(session.max_scroll_pct) || 0, 100)),
  }
  const { error: upErr } = await supabase.from('web_sessions').upsert(row, { onConflict: 'id' })
  if (upErr) { console.error('[wa-track] session upsert:', upErr.message); return }

  if (evs.length) {
    const rows = evs
      .filter(e => ['pageview', 'click', 'move', 'scroll', 'custom'].includes(e.t))
      .map(e => ({
        session_id: session.id,
        site: row.site,
        // Custom-Events tragen ihren Namen als Typ (z.B. 'booking_done').
        type: e.t === 'custom' ? `c:${String(e.txt ?? 'custom').slice(0, 38)}` : e.t,
        path: (e.p ?? '').slice(0, 500) || null,
        x: e.x ?? null, y: e.y ?? null,
        vw: e.vw ?? null, vh: e.vh ?? null, dh: e.dh ?? null,
        selector: e.sel?.slice(0, 300) ?? null,
        txt: e.txt?.slice(0, 100) ?? null,
        meta: e.meta ?? null,
      }))
    const { error: evErr } = await supabase.from('web_events').insert(rows)
    if (evErr) console.warn('[wa-track] events insert:', evErr.message)
  }

  // Kundenseite mit Token? → Session dem Lead zuordnen (nur einmal).
  if (!ex?.lead_id) {
    for (const e of evs) {
      if (e.t !== 'pageview' || !e.p) continue
      const leadId = await resolveLead(supabase, e.p)
      if (leadId) {
        await supabase.from('web_sessions').update({ lead_id: leadId }).eq('id', session.id)
        break
      }
    }
  }
}

async function handleReplay(sid: string, seq: number, events: unknown[]): Promise<void> {
  if (!sid || !UUID_RE.test(sid) || !Array.isArray(events) || !events.length) return
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
  // Nur fuer bekannte Sessions annehmen (kein blindes Insert von Fremd-IDs).
  const { data: sess } = await supabase.from('web_sessions').select('id, has_replay').eq('id', sid).maybeSingle()
  if (!sess) return
  const { error } = await supabase.from('web_replay_chunks').insert({
    session_id: sid, seq: Number(seq) || 0, events,
  })
  if (error) { console.warn('[wa-track] replay insert:', error.message); return }
  if (!(sess as { has_replay: boolean }).has_replay) {
    await supabase.from('web_sessions').update({ has_replay: true }).eq('id', sid)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: CORS })
  const url = new URL(req.url)

  try {
    if (req.method === 'GET') {
      if (url.pathname.endsWith('/t.js')) {
        const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/wa-track`
        return new Response(trackerJs(base), {
          headers: { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
        })
      }
      if (url.pathname.endsWith('/r.js')) {
        const js = await rrwebJs()
        return new Response(js, {
          headers: { ...CORS, 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' },
        })
      }
      return json({ ok: true, service: 'wa-track' })
    }

    if (req.method === 'POST') {
      const ua = req.headers.get('user-agent') ?? ''
      if (BOT_RE.test(ua)) return new Response(null, { status: 204, headers: CORS })
      const body = await req.text()
      const data = JSON.parse(body || '{}') as {
        a?: string
        session?: SessionInfo; events?: TrackEvent[]
        sid?: string; seq?: number
      } & { events?: TrackEvent[] }
      if (data.a === 'batch' && data.session) {
        await handleBatch(data.session, data.events ?? [], ua)
        return json({ success: true })
      }
      if (data.a === 'replay' && data.sid) {
        await handleReplay(data.sid, data.seq ?? 0, (data as { events?: unknown[] }).events ?? [])
        return json({ success: true })
      }
      return json({ error: 'unknown action' }, 400)
    }

    return json({ error: 'Method Not Allowed' }, 405)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[wa-track]', msg)
    return json({ error: msg }, 500)
  }
})
