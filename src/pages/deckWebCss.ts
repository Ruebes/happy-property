// Website-Stil der Projektseiten (steuervorteil-zypern-immobilien.com/top-projekte/...), 1:1 aus
// ~/Claude/website-projekte (pj_style.css + pj-gr-* aus golfresort.py). Nur pj-* Klassen, kollidiert nicht mit Tailwind.
export const WEB_CSS = `.pj-hero{position:relative;min-height:640px;background-color:#1a2332;overflow:hidden;display:flex;align-items:flex-end}
.pj-hero-img{position:absolute;top:0;left:0;width:100%;height:100%;object-fit:cover}
.pj-hero-shade{position:absolute;top:0;left:0;right:0;bottom:0;background-image:linear-gradient(90deg,rgba(26,35,50,.82) 0%,rgba(26,35,50,.62) 38%,rgba(26,35,50,.18) 72%,rgba(26,35,50,0) 100%),linear-gradient(180deg,rgba(26,35,50,.15) 0%,rgba(26,35,50,.1) 35%,rgba(26,35,50,.85) 100%)}
.pj-hero-in{position:relative;max-width:1160px;width:100%;margin:0 auto;padding:0 24px 64px}
.pj-kicker{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;color:#ff795d;margin:0}
.pj-kicker-gold{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;color:#c2a15e;margin:0}
.pj-back{display:inline-block;color:#dcdfe5;font-size:13px;text-decoration:none;margin-bottom:18px}
.pj-h1{font-family:'Playfair Display',serif;color:#fff;font-size:54px;font-weight:600;line-height:1.08;margin:14px 0 18px;max-width:760px;text-wrap:balance}
.pj-lead{color:#eef0f3;font-size:19px;line-height:1.6;margin:0 0 26px;max-width:640px}
.pj-btn{display:inline-block;background-color:#ff795d;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:15px 30px;border-radius:8px;text-align:center}
.pj-btn-ghost{display:inline-block;color:#fff;text-decoration:none;font-weight:600;font-size:16px;padding:14px 28px;border-radius:8px;border:1.5px solid rgba(255,255,255,.7);margin-left:10px;text-align:center}
.pj-facts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));background-color:#1a2332;border-top:1px solid #2c3850}
.pj-fact{padding:22px 20px;border-right:1px solid #2c3850}
.pj-fact-v{font-family:'Playfair Display',serif;color:#fff;font-size:24px;line-height:1.15;margin:0}
.pj-fact-k{color:#aab2c0;font-size:12px;line-height:1.45;margin:6px 0 0}
.pj-sec{padding:76px 24px 0}
.pj-wrap{max-width:1160px;margin:0 auto}
.pj-narrow{max-width:800px;margin:0 auto}
.pj-rule{width:48px;height:3px;background-color:#ff795d;margin:14px 0 20px}
.pj-h2{font-family:'Playfair Display',serif;color:#1a2332;font-size:36px;font-weight:600;line-height:1.18;margin:0 0 16px;text-wrap:balance}
.pj-p{font-size:17px;line-height:1.7;color:#2a2a2a;margin:0 0 16px}
.pj-split{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:48px;align-items:center}
.pj-split-img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:12px;display:block}
.pj-reasons{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:26px}
.pj-card{background-color:#fff;border:1px solid #e6dfd0;border-radius:12px;padding:24px}
.pj-card-n{font-family:'Playfair Display',serif;color:#ff795d;font-size:28px;line-height:1;margin:0 0 10px}
.pj-card-t{font-size:16px;font-weight:700;color:#1a2332;margin:0 0 6px}
.pj-card-p{font-size:15px;line-height:1.6;color:#4a4a4a;margin:0}
.pj-units{margin-top:26px;border:1px solid #e6dfd0;border-radius:12px;overflow:hidden;background-color:#fff}
.pj-urow{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.9fr);gap:12px;padding:16px 20px;border-bottom:1px solid #efe9dc;align-items:center}
.pj-uhead{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) minmax(0,.9fr);gap:12px;padding:12px 20px;background-color:#f5efe3}
.pj-uh{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6f6a60;font-weight:700;margin:0}
.pj-ut{font-family:'Playfair Display',serif;font-size:19px;color:#1a2332;font-weight:600;margin:0}
.pj-uc{font-size:15px;color:#2a2a2a;margin:0}
.pj-up{font-size:16px;color:#1a2332;font-weight:700;margin:0}
.pj-free{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border-radius:20px;background-color:#e7f0e9;color:#2f6b43;margin:0}
.pj-gone{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;padding:5px 10px;border-radius:20px;background-color:#eee9df;color:#7a7366;margin:0}
.pj-note{font-size:13px;color:#6f6a60;line-height:1.6;margin:12px 0 0}
.pj-gal{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:26px}
.pj-gal-a{display:block;border-radius:8px;overflow:hidden;aspect-ratio:4/3;background-color:#eee9df}
.pj-gal-img{width:100%;height:100%;object-fit:cover;display:block}
.pj-spec{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px 28px;margin-top:26px}
.pj-spec-i{border-top:2px solid #ff795d;padding-top:12px}
.pj-poi{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:22px}
.pj-poi-i{background-color:#fff;border:1px solid #e6dfd0;border-radius:10px;padding:16px 18px}
.pj-poi-v{font-family:'Playfair Display',serif;font-size:24px;color:#1a2332;margin:0;line-height:1.1}
.pj-poi-k{font-size:13px;color:#6f6a60;margin:4px 0 0}
.pj-steps{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin-top:26px}
.pj-step{background-color:#fff;border:1px solid #e6dfd0;border-radius:10px;padding:20px 18px}
.pj-step-last{background-color:#1a2332;border-radius:10px;padding:20px 18px}
.pj-step-v{font-family:'Playfair Display',serif;font-size:28px;color:#1a2332;margin:0;line-height:1.1}
.pj-step-vl{font-family:'Playfair Display',serif;font-size:28px;color:#ff795d;margin:0;line-height:1.1}
.pj-step-k{font-size:14px;line-height:1.5;color:#4a4a4a;margin:8px 0 0}
.pj-step-kl{font-size:14px;line-height:1.5;color:#dcdfe5;margin:8px 0 0}
.pj-why{background-color:#1a2332;padding:76px 24px;margin-top:80px}
.pj-h2w{font-family:'Playfair Display',serif;color:#fff;font-size:34px;font-weight:600;line-height:1.2;margin:12px 0 12px;text-wrap:balance}
.pj-whygrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:30px}
.pj-whyi{background-color:#243044;border:1px solid #33415a;border-radius:12px;padding:22px}
.pj-whyt{color:#fff;font-size:16px;font-weight:700;margin:0 0 6px}
.pj-whyp{color:#c9ccd3;font-size:14px;line-height:1.6;margin:0}
.pj-cta{padding:72px 24px;text-align:center;background-color:#fffcf6}
.pj-small{font-size:12px;color:#8a857b;line-height:1.6;margin:26px auto 0;max-width:760px}
.pj-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:22px;margin-top:34px}
.pj-lcard{display:block;background-color:#fff;border:1px solid #e6dfd0;border-radius:14px;overflow:hidden;text-decoration:none}
.pj-limg{width:100%;aspect-ratio:16/10;object-fit:cover;display:block}
.pj-lbody{padding:22px 24px 26px}
.pj-lt{font-family:'Playfair Display',serif;font-size:24px;line-height:1.25;color:#1a2332;margin:8px 0 6px}
.pj-lloc{font-size:14px;color:#6f6a60;margin:0 0 12px}
.pj-lprice{font-size:16px;color:#ff795d;font-weight:700;margin:0 0 14px}
.pj-lmore{font-size:14px;font-weight:700;color:#1a2332;margin:0}
@media (max-width: 1023px){
.pj-h1{font-size:42px}
.pj-facts{grid-template-columns:repeat(3,minmax(0,1fr))}
.pj-split{grid-template-columns:minmax(0,1fr);gap:26px}
.pj-spec{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-steps{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-whygrid{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-gal{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (max-width: 767px){
.pj-hero-shade{background-image:linear-gradient(180deg,rgba(26,35,50,.45) 0%,rgba(26,35,50,.6) 40%,rgba(26,35,50,.93) 100%)}
.pj-hero{min-height:560px}
.pj-hero-in{padding:0 20px 44px}
.pj-h1{font-size:33px}
.pj-lead{font-size:16px}
.pj-btn{display:block}
.pj-btn-ghost{display:block;margin:10px 0 0}
.pj-facts{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-fact{border-bottom:1px solid #2c3850}
.pj-sec{padding:56px 20px 0}
.pj-h2{font-size:28px}
.pj-h2w{font-size:27px}
.pj-reasons{grid-template-columns:minmax(0,1fr)}
.pj-uhead{display:none}
.pj-urow{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px}
.pj-gal{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-spec{grid-template-columns:minmax(0,1fr)}
.pj-poi{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-why{padding:56px 20px}
.pj-whygrid{grid-template-columns:minmax(0,1fr)}
}


.pj-gr-day{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px;margin-top:30px}
.pj-gr-dcard{background-color:#fff;border:1px solid #e6dfd0;border-radius:14px;overflow:hidden}
.pj-gr-media{position:relative;aspect-ratio:16/9;background-color:#1a2332;overflow:hidden}
.pj-gr-dbody{padding:18px 20px 22px}
.pj-gr-time{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:700;color:#ff795d;margin:0 0 6px}
.pj-gr-dt{font-family:'Playfair Display',serif;font-size:21px;line-height:1.25;color:#1a2332;margin:0 0 8px}
.pj-gr-dp{font-size:15px;line-height:1.6;color:#4a4a4a;margin:0}
.pj-gr-film{position:relative;margin-top:30px;border-radius:14px;overflow:hidden;background-color:#1a2332}
.pj-gr-dark{background-color:#1a2332;padding:84px 24px;margin-top:84px}
.pj-gr-cream{background-color:#f5efe3;padding:84px 24px;margin-top:84px}
.pj-gr-pw{font-size:17px;line-height:1.7;color:#dcdfe5;margin:0 0 16px}
.pj-gr-split{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.15fr);gap:48px;align-items:center}
.pj-gr-big{position:relative;aspect-ratio:16/9;border-radius:14px;overflow:hidden;background-color:#243044}
.pj-gr-badge{display:inline-block;background-color:#c2a15e;color:#1a2332;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:8px 14px;border-radius:30px;margin:0 0 18px}
.pj-gr-stats{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 18px;margin:24px 0 6px;max-width:420px}
.pj-gr-stat{border-left:2px solid #c2a15e;padding:4px 0 4px 14px}
.pj-gr-sv{font-family:'Playfair Display',serif;font-size:28px;color:#fff;margin:0;line-height:1.1}
.pj-gr-sk{font-size:12px;color:#aab2c0;margin:4px 0 0;line-height:1.4}
.pj-gr-svd{font-family:'Playfair Display',serif;font-size:28px;color:#1a2332;margin:0;line-height:1.1}
.pj-gr-skd{font-size:12px;color:#6f6a60;margin:4px 0 0;line-height:1.4}
.pj-gr-clips{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:30px}
.pj-gr-clip{position:relative;aspect-ratio:16/9;border-radius:10px;overflow:hidden;background-color:#243044}
.pj-gr-ph{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-top:12px}
.pj-gr-noted{font-size:13px;color:#8f98a8;line-height:1.6;margin:18px 0 0}
.pj-gr-perks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-top:28px}
.pj-gr-perk{background-color:#fff;border:1px solid #e6dfd0;border-top:3px solid #c2a15e;border-radius:12px;padding:24px}
.pj-gr-pv{font-family:'Playfair Display',serif;font-size:30px;color:#1a2332;margin:0 0 8px;line-height:1.1}
@media (max-width: 1023px){
.pj-gr-day{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-gr-split{grid-template-columns:minmax(0,1fr);gap:28px}
.pj-gr-clips{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-gr-stats{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-gr-perks{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-gr-ph{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@media (max-width: 767px){
.pj-gr-day{grid-template-columns:minmax(0,1fr)}
.pj-gr-dark{padding:56px 20px;margin-top:56px}
.pj-gr-cream{padding:56px 20px;margin-top:56px}
.pj-gr-perks{grid-template-columns:minmax(0,1fr)}
.pj-gr-ph{grid-template-columns:repeat(2,minmax(0,1fr))}
.pj-gr-sv{font-size:24px}
.pj-gr-svd{font-size:24px}
}

.pj-gr-herousp{display:inline-block;background-color:rgba(255,121,93,.16);border:1px solid rgba(255,121,93,.55);border-left:4px solid #ff795d;border-radius:10px;padding:14px 20px;margin:0 0 22px;max-width:640px}
.pj-gr-heroust{font-family:'Playfair Display',serif;font-size:30px;line-height:1.15;color:#ffffff;font-weight:600;margin:0}
.pj-gr-herousk{font-size:14px;line-height:1.5;color:#eef0f3;margin:6px 0 0}
@media (max-width: 767px){
.pj-gr-heroust{font-size:24px}
.pj-gr-herousk{font-size:13px}
}
.pj-gal-big{grid-row:span 2;grid-column:span 2;aspect-ratio:auto}
.pj-text{max-width:820px}
.pj-whylink{display:inline-block;color:#ff795d;font-weight:700;font-size:14px;text-decoration:none;margin-top:12px}
.hpweb{background-color:#fff}
.hpweb .pj-hero-in{padding-top:72px}
.hpweb-deck > .relative > section{padding-left:max(20px,calc((100% - 1160px) / 2))!important;padding-right:max(20px,calc((100% - 1160px) / 2))!important}
.hpweb .pj-sec{padding-bottom:12px}
.hpweb .pj-wrap > .pj-sec:last-child{padding-bottom:64px}
`
