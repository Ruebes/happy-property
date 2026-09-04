// Stubs fuer die Remote-Imports der Edge Functions (jsr:/https:), damit tsc die
// Deck-Funktionen ueberhaupt typpruefen kann. `npm run build` deckt nur src/ ab —
// supabase/functions lief bisher komplett ungeprueft, und genau dort entstanden
// die Fehler (toter map-Block, verlorene Preiszeilen).
// Die Stubs sind bewusst grob: geprueft werden soll UNSER Code, nicht das SDK.

declare module 'jsr:@supabase/supabase-js@2' {
  export interface SupabaseQuery {
    select(cols?: string, opts?: Record<string, unknown>): SupabaseQuery
    insert(rows: unknown): SupabaseQuery
    update(patch: unknown): SupabaseQuery
    upsert(rows: unknown, opts?: Record<string, unknown>): SupabaseQuery
    delete(): SupabaseQuery
    eq(col: string, val: unknown): SupabaseQuery
    neq(col: string, val: unknown): SupabaseQuery
    in(col: string, vals: unknown[]): SupabaseQuery
    is(col: string, val: unknown): SupabaseQuery
    not(col: string, op: string, val: unknown): SupabaseQuery
    or(filter: string): SupabaseQuery
    gt(col: string, val: unknown): SupabaseQuery
    gte(col: string, val: unknown): SupabaseQuery
    lt(col: string, val: unknown): SupabaseQuery
    lte(col: string, val: unknown): SupabaseQuery
    order(col: string, opts?: Record<string, unknown>): SupabaseQuery
    limit(n: number): SupabaseQuery
    single(): Promise<{ data: any; error: any }>
    maybeSingle(): Promise<{ data: any; error: any }>
    then<R>(cb: (r: { data: any; error: any; count?: number | null }) => R): Promise<R>
  }
  export interface SupabaseClient {
    from(table: string): SupabaseQuery
    rpc(fn: string, args?: Record<string, unknown>): SupabaseQuery & Promise<{ data: any; error: any }>
    storage: any
    functions: any
    auth: any
  }
  export function createClient(url: string, key: string, opts?: unknown): SupabaseClient
}

declare module 'https://esm.sh/jsonrepair@3.8.0' {
  export function jsonrepair(text: string): string
}

declare module 'https://esm.sh/xlsx@0.18.5' {
  const x: any
  export default x
}

declare const Deno: {
  env: { get(k: string): string | undefined }
  serve(handler: (req: Request) => Response | Promise<Response>): void
}
declare const EdgeRuntime: { waitUntil?: (p: Promise<unknown>) => void } | undefined
