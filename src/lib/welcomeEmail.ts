/**
 * Gemeinsames Welcome-Email-Template für alle Nutzertypen.
 * Wird verwendet in: Users.tsx, Objekte.tsx (Owner-Anlage)
 */

export const PORTAL_URL = 'https://portal.happy-property.com'

export function buildWelcomeEmail(
  firstName: string,
  email: string,
  password: string,
): string {
  return `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><title>Dein Zugang</title></head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;padding:32px 0;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08);">
<tr><td style="background:#ff795d;padding:28px 32px;">
  <h1 style="margin:0;color:#ffffff;font-size:22px;">Willkommen bei Happy Property</h1>
</td></tr>
<tr><td style="padding:32px;">
  <p style="margin:0 0 16px;font-size:15px;color:#374151;">Hallo ${firstName},</p>
  <p style="margin:0 0 24px;font-size:15px;color:#374151;">dein Zugang zum Happy Property Portal wurde eingerichtet. Hier sind deine Zugangsdaten:</p>
  <table cellpadding="0" cellspacing="0" style="background:#f3f4f6;border-radius:8px;padding:20px;margin-bottom:24px;width:100%;">
    <tr>
      <td style="padding:4px 0;font-size:14px;color:#6b7280;">E-Mail:</td>
      <td style="padding:4px 0;font-size:14px;font-weight:600;color:#111827;">${email}</td>
    </tr>
    <tr>
      <td style="padding:4px 0;font-size:14px;color:#6b7280;">Passwort:</td>
      <td style="padding:4px 0;font-size:14px;font-weight:600;color:#111827;font-family:monospace;">${password}</td>
    </tr>
  </table>
  <p style="margin:0 0 24px;font-size:13px;color:#9ca3af;">⚠️ Bitte ändere dein Passwort direkt nach dem ersten Login.</p>
  <a href="${PORTAL_URL}/login" style="display:inline-block;background:#ff795d;color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">Zum Portal →</a>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #f3f4f6;font-size:12px;color:#9ca3af;">
  Happy Property · Cyprus Real Estate
</td></tr>
</table>
</td></tr>
</table>
</body></html>`
}
