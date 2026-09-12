const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Server-to-Server OAuth Token ─────────────────────────────────────────────
async function getZoomToken(accountId: string, clientId: string, clientSecret: string): Promise<string> {
  const resp = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`,
    {
      method:  'POST',
      headers: {
        'Authorization': `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    }
  )
  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`Zoom Token Fehler (${resp.status}): ${body}`)
  }
  const { access_token } = await resp.json() as { access_token: string }
  return access_token
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  const accountId    = Deno.env.get('ZOOM_ACCOUNT_ID')
  const clientId     = Deno.env.get('ZOOM_CLIENT_ID')
  const clientSecret = Deno.env.get('ZOOM_CLIENT_SECRET')

  if (!accountId || !clientId || !clientSecret) {
    return new Response(
      JSON.stringify({ error: 'Zoom nicht konfiguriert. Bitte ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID und ZOOM_CLIENT_SECRET als Supabase Secrets setzen.' }),
      { status: 503, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }

  try {
    const body = await req.json() as {
      check?:            boolean
      title?:            string
      start_time?:       string
      duration_minutes?: number
      // 'webinar' versucht zuerst ein Zoom-Webinar (braucht die Webinar-Lizenz);
      // ohne Lizenz fällt es auf ein Meeting mit Vortrags-Einstellungen zurück
      // (alle stumm beim Eintritt, Bildschirm nur für den Host).
      kind?:             'meeting' | 'webinar'
      delete_id?:        string   // Meeting löschen (Aufräumen nach Tests / Absage)
    }

    // ── Check-only: verify credentials without creating a meeting ────────────
    if (body.check) {
      await getZoomToken(accountId, clientId, clientSecret)
      return new Response(
        JSON.stringify({ configured: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // ── Delete meeting ───────────────────────────────────────────────────────
    if (body.delete_id) {
      const tok = await getZoomToken(accountId, clientId, clientSecret)
      const del = await fetch(`https://api.zoom.us/v2/meetings/${encodeURIComponent(body.delete_id)}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${tok}` } })
      return new Response(JSON.stringify({ success: del.ok || del.status === 404, status: del.status }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ── Create meeting ────────────────────────────────────────────────────────
    const { title, start_time, duration_minutes } = body

    if (!title || !start_time) {
      return new Response(
        JSON.stringify({ error: 'title und start_time sind Pflichtfelder.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const token = await getZoomToken(accountId, clientId, clientSecret)
    const authHeaders = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }

    // ── Webinar (nur mit Lizenz) ─────────────────────────────────────────────
    if (body.kind === 'webinar') {
      const webRes = await fetch('https://api.zoom.us/v2/users/me/webinars', {
        method: 'POST', headers: authHeaders,
        body: JSON.stringify({
          topic: title, type: 5, start_time, duration: duration_minutes ?? 60, timezone: 'Europe/Berlin',
          settings: { host_video: true, panelists_video: true, approval_type: 2, registration_type: 1,
            practice_session: true, hd_video: true, auto_recording: 'cloud', contact_email: 'info@happy-property.com' },
        }),
      })
      // Ohne Webinar-Lizenz antwortet Zoom hier teils mit XML statt JSON — robust parsen.
      const webText = await webRes.text()
      let web: { id?: number; join_url?: string; start_url?: string; password?: string; message?: string; code?: number } = {}
      try { web = JSON.parse(webText) } catch { web = { message: webText.slice(0, 200) } }
      if (webRes.ok) {
        return new Response(
          JSON.stringify({ success: true, kind: 'webinar', meeting_id: String(web.id), join_url: web.join_url, start_url: web.start_url, password: web.password ?? '' }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }
      console.warn('[create-zoom-meeting] Webinar nicht möglich, Fallback auf Meeting:', webRes.status, web.message)
    }

    const vortrag = body.kind === 'webinar'
    const zoomRes = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method:  'POST',
      headers: authHeaders,
      body: JSON.stringify({
        topic:      title,
        type:       2,
        start_time,
        duration:   duration_minutes ?? 60,
        timezone:   'Europe/Berlin',
        settings: vortrag ? {
          host_video: true, participant_video: false, join_before_host: true, jbh_time: 10,
          waiting_room: false, mute_upon_entry: true, auto_recording: 'cloud',
        } : {
          host_video:        true,
          participant_video: true,
          join_before_host:  true,
          waiting_room:      false,
          auto_recording:    'none',
        },
      }),
    })

    const meetText = await zoomRes.text()
    let meeting: { id?: number; join_url?: string; start_url?: string; password?: string; message?: string } = {}
    try { meeting = JSON.parse(meetText) } catch { meeting = { message: `Zoom antwortete nicht mit JSON (${zoomRes.status}): ${meetText.slice(0, 200)}` } }

    if (!zoomRes.ok) {
      return new Response(
        JSON.stringify({ error: meeting.message ?? 'Zoom API Fehler' }),
        { status: zoomRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        success:    true,
        kind:       vortrag ? 'meeting_fallback' : 'meeting',
        meeting_id: String(meeting.id),
        join_url:   meeting.join_url,
        start_url:  meeting.start_url,
        password:   meeting.password ?? '',
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
