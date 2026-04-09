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
    }

    // ── Check-only: verify credentials without creating a meeting ────────────
    if (body.check) {
      await getZoomToken(accountId, clientId, clientSecret)
      return new Response(
        JSON.stringify({ configured: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
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

    const zoomRes = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        topic:      title,
        type:       2,
        start_time,
        duration:   duration_minutes ?? 60,
        settings: {
          host_video:        true,
          participant_video: true,
          join_before_host:  true,
          waiting_room:      false,
          auto_recording:    'none',
        },
      }),
    })

    const meeting = await zoomRes.json() as {
      id?:        number
      join_url?:  string
      start_url?: string
      password?:  string
      message?:   string
    }

    if (!zoomRes.ok) {
      return new Response(
        JSON.stringify({ error: meeting.message ?? 'Zoom API Fehler' }),
        { status: zoomRes.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    return new Response(
      JSON.stringify({
        success:    true,
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
