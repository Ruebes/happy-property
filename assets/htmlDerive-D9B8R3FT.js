const c={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",uuml:"ü",ouml:"ö",auml:"ä",Uuml:"Ü",Ouml:"Ö",Auml:"Ä",szlig:"ß",euro:"€",pound:"£",cent:"¢",copy:"©",reg:"®",trade:"™",deg:"°",middot:"·",bull:"•",ndash:"–",mdash:"—",hellip:"…",laquo:"«",raquo:"»",bdquo:"„",ldquo:"“",rdquo:"”",lsquo:"‘",rsquo:"’",sbquo:"‚",rarr:"→",larr:"←",harr:"↔",uarr:"↑",darr:"↓",times:"×",divide:"÷",plusmn:"±",frac12:"½",frac14:"¼",hyphen:"-",shy:"",eacute:"é",egrave:"è",agrave:"à",uacute:"ú",oacute:"ó",aacute:"á",ntilde:"ñ",ccedil:"ç"};function n(e){try{return e===9||e===10||e>=32&&e!==127&&e<=1114111?String.fromCodePoint(e):""}catch{return""}}function s(e){return e.replace(/&#x([0-9a-fA-F]+);/g,(r,a)=>n(parseInt(a,16))).replace(/&#(\d+);/g,(r,a)=>n(parseInt(a,10))).replace(/&([a-zA-Z][a-zA-Z0-9]*);/g,(r,a)=>a in c?c[a]:r)}function g(e){if(!e)return"";const r=e.replace(/<head[\s\S]*?<\/head>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(a,t,l)=>{const i=String(l).replace(/<[^>]+>/g,"").trim();return/^(mailto:|tel:)/i.test(t)?i||t.replace(/^(mailto:|tel:)/i,""):!i||i===t?t:`${i}: ${t}`}).replace(/<img\b[^>]*>/gi,"").replace(/<br\s*\/?>/gi,`
`).replace(/<\/(p|div|tr|h[1-6]|li|table|blockquote)>/gi,`
`).replace(/<\/td>/gi,"  ").replace(/<[^>]+>/g,"");return s(r).replace(/[ \t]{2,}/g," ").replace(/[ \t]+\n/g,`
`).replace(/\n{3,}/g,`

`).trim()}const p=3800;function o(e){if(!e)return"";let r=e.replace(/<head[\s\S]*?<\/head>/gi,"").replace(/<style[\s\S]*?<\/style>/gi,"").replace(/<script[\s\S]*?<\/script>/gi,"").replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi,(a,t,l)=>`*${String(l).replace(/<[^>]+>/g,"").trim()}*`).replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi,(a,t,l)=>`_${String(l).replace(/<[^>]+>/g,"").trim()}_`).replace(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,(a,t,l)=>{const i=String(l).replace(/<[^>]+>/g,"").replace(/\s*(→|&rarr;)\s*$/,"").trim();return/^(mailto:|tel:)/i.test(t)?i||t.replace(/^(mailto:|tel:)/i,""):!i||i===t?t:`${i}: ${t}`}).replace(/<img\b[^>]*>/gi,"").replace(/<li\b[^>]*>/gi,"• ").replace(/<br\s*\/?>/gi,`
`).replace(/<\/(li|tr)>/gi,`
`).replace(/<\/t[dh]>/gi," ").replace(/<\/(p|div|h[1-6]|ul|ol|table|blockquote)>/gi,`

`).replace(/<[^>]+>/g,"");return r=s(r).replace(/[ \t]{2,}/g," ").replace(/[ \t]+\n/g,`
`).replace(/\n[ \t]+/g,`
`).replace(/\n{3,}/g,`

`).trim(),r.length>p&&(r=r.slice(0,p).replace(/\s+\S*$/,"")+" …"),r}const u=1900;function m(e){return String(e??"").replace(/\r\n?/g,`
`).split(/^[ \t]*-{3,}[ \t]*$/m).map(r=>r.trim()).filter(Boolean)}export{u as W,g as a,o as h,m as s};
