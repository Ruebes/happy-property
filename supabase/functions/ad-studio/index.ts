// Edge Function: ad-studio — NUR NOCH SHIM.
//
// Die echte Implementierung lebt in ../studio/index.ts. Grund für den Umzug:
// Werbeblocker filtern URLs mit „ad-"-Mustern, der Aufruf von
// /functions/v1/ad-studio kam bei Sven nie am Server an (22.7.).
// Dieser Slug bleibt deployt, damit ALTE gecachte Frontend-Bundles (PWA!)
// weiterhin funktionieren, solange kein Werbeblocker dazwischenfunkt.
// Neue Frontend-Aufrufe gehen auf „studio".
//
// ── Deployment ──  supabase functions deploy ad-studio --no-verify-jwt
import '../studio/index.ts'
