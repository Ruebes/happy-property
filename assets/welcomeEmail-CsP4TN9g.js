import{s as y}from"./index-DT3V1H9E.js";const c="https://portal.happy-property.com",x="37b1724c-f71c-4e8b-9116-b92d18f03915";function m(t,o,e){return`<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><title>Dein Zugang</title></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
<tr><td style="background:#ff795d;padding:28px 32px;">
  <h1 style="margin:0;color:#ffffff;font-size:22px;">Willkommen bei Happy Property</h1>
</td></tr>
<tr><td style="padding:32px;">
  <p style="margin:0 0 16px;font-size:15px;color:#374151;">Hallo ${t},</p>
  <p style="margin:0 0 24px;font-size:15px;color:#374151;">dein Zugang zum Happy Property Portal wurde eingerichtet. Hier sind deine Zugangsdaten:</p>
  <table cellpadding="0" cellspacing="0" style="background:#f3f4f6;border-radius:8px;padding:20px;margin-bottom:24px;width:100%;">
    <tr>
      <td style="padding:4px 0;font-size:14px;color:#6b7280;">E-Mail:</td>
      <td style="padding:4px 0;font-size:14px;font-weight:600;color:#111827;">${o}</td>
    </tr>
    <tr>
      <td style="padding:4px 0;font-size:14px;color:#6b7280;">Passwort:</td>
      <td style="padding:4px 0;font-size:14px;font-weight:600;color:#111827;font-family:monospace;">${e}</td>
    </tr>
  </table>
  <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;">⚠️ Bitte ändere dein Passwort direkt nach dem ersten Login.</p>
  <a href="${c}/login" style="display:inline-block;background:#ff795d;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">Zum Portal →</a>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #f3f4f6;font-size:12px;color:#9ca3af;">
  Happy Property · Cyprus Real Estate
</td></tr>
</table>
</td></tr>
</table>
</body></html>`}async function h(t,o,e){var i,d;const a={subject:"Dein Zugang zum Happy Property Portal",html:m(t,o,e)};try{const{data:g}=await y.from("email_templates").select("subject, html_body").eq("id",x).maybeSingle(),n=g,p=(i=n==null?void 0:n.html_body)==null?void 0:i.trim();if(!n||!p)return a;const b={vorname:t,name:t,email:o,password:e,login_url:`${c}/login`};let r=p,l=((d=n.subject)==null?void 0:d.trim())||a.subject;for(const[s,f]of Object.entries(b))r=r.split(`{{${s}}}`).join(f),l=l.split(`{{${s}}}`).join(f);return r.includes(e)?{subject:l,html:r}:a}catch{return a}}export{h as r};
