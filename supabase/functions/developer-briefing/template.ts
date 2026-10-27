// HTML-Hülle des Bauträger-Briefings. Layout = Svens freigegebenes Briefing
// für Aaron/Eva Hahn (27.10.2026), gilt ab da als Standard für alle.
import { CI, CI_FONT } from '../_shared/brand.ts'

export const BRIEFING_CSS = `
  :root{
    --creme:${CI.cream}; --navy:${CI.navy}; --ink:${CI.ink}; --coral:${CI.coral}; --gold:${CI.gold};
    --line:${CI.line}; --muted:#7d7d86; --card:#ffffff; --soft:#f7f2e8; --coral-soft:#fff1ec; --logo:#2b333d;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:var(--creme);color:var(--ink);font-family:${CI_FONT.body},system-ui,sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
  h1,h2,h3{font-family:"${CI_FONT.heading}",Georgia,serif;color:var(--navy);margin:0;font-weight:600;letter-spacing:-.01em}
  a{color:var(--navy)}
  .wrap{max-width:980px;margin:0 auto;padding:0 16px}
  .eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--coral)}
  .muted{color:var(--muted)}

  /* Brand */
  .brand{background:var(--logo);text-align:center}
  .brand img{height:76px;width:auto;display:block;margin:0 auto}

  /* Hero */
  .hero{position:relative;color:#fff;background:#1a2332 center/cover no-repeat}
  .hero::before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(26,35,50,.35) 0%,rgba(26,35,50,.78) 62%,rgba(26,35,50,.94) 100%)}
  .hero .wrap{position:relative;padding-top:72px;padding-bottom:36px}
  .hero h1{color:#fff;font-size:44px;line-height:1.1;margin:8px 0 14px}
  .hero .lead{font-size:17px;max-width:640px;color:#f3efe6}
  .hero .eyebrow{color:#ffb4a3}
  .meta{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:22px;font-size:13px;color:#e9e4d8}
  .meta b{color:#fff;font-weight:600}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
  .chip{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:600;padding:6px 12px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);color:#fff}
  .chip i{width:7px;height:7px;border-radius:50%;background:var(--coral);display:inline-block}
  .chip.g i{background:#7ccf9b}

  /* Tabs */
  .tabs{position:sticky;top:0;z-index:5;background:rgba(255,252,246,.96);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
  .tabs .wrap{display:flex;gap:6px;align-items:stretch;padding-top:10px;padding-bottom:10px}
  .tab{flex:1;max-width:260px;font:600 14px Montserrat,sans-serif;color:var(--navy);background:transparent;border:1px solid var(--line);border-radius:12px;padding:10px 12px;cursor:pointer;text-align:left}
  .tab small{display:block;font-weight:500;font-size:11px;color:var(--muted)}
  .tab.on{background:var(--navy);border-color:var(--navy);color:#fff}
  .tab.on small{color:#c9cdd6}
  .panel{display:none}
  .panel.on{display:block}

  section.block{padding:34px 0 6px}
  section.block > h2{font-size:28px;margin:6px 0 18px}

  /* Glance tiles */
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  .tile{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 18px 16px}
  .tile .v{font-family:"Playfair Display",serif;font-size:21px;line-height:1.25;color:var(--navy);margin:6px 0 6px;font-weight:600}
  .tile p{margin:0;font-size:13.5px;color:#4a4a52}

  /* Project cards */
  .projects{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .proj{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden;display:flex;flex-direction:column}
  .proj .img{height:190px;background:#ddd center/cover no-repeat;position:relative}
  .proj .tag{position:absolute;left:14px;top:14px;background:var(--creme);color:var(--navy);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border-radius:999px}
  .proj .body{padding:18px 18px 20px;display:flex;flex-direction:column;gap:12px;flex:1}
  .proj h3{font-size:22px}
  .specs{display:flex;flex-wrap:wrap;gap:6px}
  .specs span{font-size:12px;font-weight:600;background:var(--soft);color:var(--navy);padding:4px 10px;border-radius:8px}
  .price{border-top:1px solid var(--line);padding-top:12px;display:flex;justify-content:space-between;align-items:flex-end;gap:10px;flex-wrap:wrap}
  .price .big{font-family:"Playfair Display",serif;font-size:26px;color:var(--navy);font-weight:700;line-height:1.1}
  .price s{color:var(--muted);font-size:13px}
  .price .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:700}
  .proj ul{margin:0;padding-left:18px;font-size:13.5px}
  .proj li{margin:3px 0}

  /* Key points */
  .keys{counter-reset:k;display:grid;gap:10px}
  .key{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px 14px 58px;position:relative;font-size:14px}
  .key::before{counter-increment:k;content:counter(k);position:absolute;left:16px;top:13px;width:28px;height:28px;border-radius:50%;background:var(--coral-soft);color:var(--coral);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
  .key b{color:var(--navy)}

  .note{background:var(--navy);color:#e9e4d8;border-radius:18px;padding:22px 22px;display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .note h3{color:#fff;font-size:20px;margin-bottom:6px}
  .note p{margin:0;font-size:14px}

  /* Full briefing */
  .prose{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:22px 24px;font-size:15px}
  .prose p{margin:0 0 12px}
  .prose p:last-child{margin:0}
  table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;font-size:14px}
  th,td{text-align:left;padding:11px 14px;border-bottom:1px solid var(--line);vertical-align:top}
  th{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);background:var(--soft);font-weight:700}
  tr:last-child td{border-bottom:0}
  td.n{white-space:nowrap;font-weight:600;color:var(--navy)}
  .pill{display:inline-block;font-size:11px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap}
  .pill.cur{background:#e5f5ea;color:#1f7a45}
  .pill.sold{background:#f1eeee;color:#8a6d6d}
  .pill.alt{background:#eef1f7;color:#3b4a6b}
  .pill.open{background:var(--coral-soft);color:#c4482c}

  .told{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .told .tile h3{font-size:18px;margin:4px 0 8px}
  .told ul{margin:0;padding-left:18px;font-size:13.5px}
  .told li{margin:4px 0}

  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px}
  .kpi{background:var(--navy);color:#fff;border-radius:14px;padding:16px}
  .kpi .v{font-family:"Playfair Display",serif;font-size:24px;font-weight:700;line-height:1.1}
  .kpi .l{font-size:12px;color:#c9cdd6;margin-top:4px}

  .decks{display:grid;gap:12px}
  .deck{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;display:grid;grid-template-columns:110px 1fr;gap:16px;align-items:start}
  .deck .d{font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
  .deck h3{font-size:18px;margin-bottom:4px}
  .deck p{margin:0 0 6px;font-size:13.5px}
  .deck a{font-size:13px;font-weight:600;color:var(--coral);text-decoration:none}

  /* Conversation */
  .chat{background:var(--soft);border:1px solid var(--line);border-radius:18px;padding:18px 14px}
  .day{text-align:center;margin:18px 0 10px}
  .day:first-child{margin-top:0}
  .day span{font-size:11px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);background:var(--creme);border:1px solid var(--line);padding:4px 12px;border-radius:999px}
  .msg{max-width:78%;margin:8px 0;padding:10px 14px 9px;border-radius:16px;font-size:14px;position:relative;box-shadow:0 1px 0 rgba(0,0,0,.04)}
  .msg .who{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:3px}
  .msg .ch{font-weight:500;color:var(--muted);text-transform:none;letter-spacing:0}
  .msg.c{background:#fff;border:1px solid var(--line);border-bottom-left-radius:4px}
  .msg.c .who{color:var(--navy)}
  .msg.s{background:var(--coral-soft);border:1px solid #ffd9cf;margin-left:auto;border-bottom-right-radius:4px}
  .msg.s .who{color:#c4482c}
  .msg.e{max-width:100%;margin:10px 0;background:#fff;border:1px dashed var(--line);border-radius:12px;font-size:13px;color:#4a4a52}
  .msg.e .who{color:var(--gold)}
  .msg p{margin:0 0 7px}
  .msg p:last-child{margin:0}
  details{margin-top:6px}
  summary{cursor:pointer;font-size:12.5px;font-weight:600;color:var(--coral);list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::after{content:" +";}
  details[open] summary::after{content:" \\2212";}

  .next{display:grid;gap:10px}
  .next .row{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;gap:14px;align-items:flex-start;font-size:14px}
  .next .row .pill{margin-top:2px}

  .hbtn{margin-left:auto;display:flex;flex-direction:column;justify-content:center;background:var(--coral);color:#fff;text-decoration:none;font-weight:700;font-size:14px;line-height:1.3;padding:10px 16px;border-radius:12px;white-space:nowrap;box-shadow:0 4px 14px rgba(255,121,93,.28)}
  .hbtn small{font-weight:500;font-size:11px;opacity:.92}
  footer{margin-top:44px;padding:28px 0 40px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted)}
  footer b{color:var(--navy)}

  @media (max-width:760px){
    .tab small,.hbtn small{display:none}
    .tab{padding:10px 10px;font-size:13px}
    .hbtn{padding:10px 12px;font-size:13px}
    .hero h1{font-size:34px}
    .hero .wrap{padding-top:52px}
    .grid{grid-template-columns:1fr 1fr}
    .projects,.told,.note{grid-template-columns:1fr}
    .kpis{grid-template-columns:1fr 1fr}
    .deck{grid-template-columns:1fr;gap:6px}
    .msg{max-width:92%}
    section.block > h2{font-size:24px}
    .brand img{height:60px}
    table.stack,table.stack tbody,table.stack tr,table.stack td{display:block;width:100%}
    table.stack tr.h{display:none}
    table.stack tr{border-bottom:1px solid var(--line);padding:12px 16px}
    table.stack tr:last-child{border-bottom:0}
    table.stack td{border:0;padding:1px 0}
    table.stack td.n{font-size:15px;margin-bottom:2px}
    table.stack td[data-label]::before{content:attr(data-label);display:block;font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);font-weight:700;margin-top:8px}
  }
  @media (max-width:420px){
    .grid{grid-template-columns:1fr}
    .tile .v{font-size:19px}
  }
`
