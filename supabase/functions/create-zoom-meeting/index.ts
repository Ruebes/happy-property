import { createClient } from 'jsr:@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// ── Zoom JWT ──────────────────────────────────────────────────────────────────
// Generates a short-lived JWT for Zoom JWT App authentication.
async function generateZoomJWT(apiKey: string, apiSecret: string): Promise<string> {
  const enc = new TextEncoder()

  const header  = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const payload = btoa(JSON.stringify({
    iss: apiKey,
    exp: Math.floor(Date.now() / 1000) + 90,
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  const key = await crypto.subtle.importKey(
    'raw', enc.encode(apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  )

  const sigRaw = await crypto.subtle.sign('HMAC', key, enc.encode(`${header}.${payload}`))

  const sig = btoa(String.fromCharCode(...new Uint8Array(sigRaw)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

  return `${header}.${payload}.${sig}`
}

// ── Handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const { title, start_time, duration_minutes } = await req.json() as {
      title:             string
      start_time:        string   // ISO 8601
      duration_minutes?: number
    }

    const zoomApiKey    = Deno.env.get('ZOOM_API_KEY')
    const zoomApiSecret = Deno.env.get('ZOOM_API_SECRET')

    if (!zoomApiKey || !zoomApiSecret) {
      return new Response(
        JSON.stringify({ error: 'Zoom API nicht konfiguriert. Bitte ZOOM_API_KEY und ZOOM_API_SECRET als Supabase Secrets setzen.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const token = await generateZoomJWT(zoomApiKey, zoomApiSecret)

    const zoomRes = await fetch('https://api.zoom.us/v2/users/me/meetings', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        topic:      title,
        type:       2,            // scheduled meeting
        start_time,
        duration:   duration_minutes ?? 60,
        settings: {
          host_video:        true,
          participant_video: true,
          join_before_host:  true,
          waiting_room:      false,
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

    // Optional: log to Supabase (fire-and-forget)
    try {
      const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      )
      await supabase.from('activities').insert({
        type:      'meeting',
        direction: 'outbound',
        subject:   `Zoom Meeting erstellt: ${title}`,
        content:   `join_url: ${meeting.join_url}`,
      })
    } catch { /* non-fatal */ }

    return new Response(
      JSON.stringify({
        meeting_id: meeting.id,
        join_url:   meeting.join_url,
        start_url:  meeting.start_url,
        password:   meeting.password,
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
