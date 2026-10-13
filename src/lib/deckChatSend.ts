// ── Deck-Chat: Feinschliff starten ───────────────────────────────────────────
// Ablauf einer Chat-Anweisung: refine-deck (background) aufrufen, SOFORT melden,
// dass der Lauf läuft, dann warten, bis er fertig ist.
//
// Prüfbefund 12.10.26, Runde 5: onStarted kam erst nach dem Warten, also nach dem
// Ende des Laufs. Solange er lief, stand das Deck in der Angebots-Liste nicht auf
// „in Bearbeitung"; Panel-Knopf „Im Deck-Chat beheben" und ✏️ blieben aktiv und ein
// zweiter refine-deck-Lauf konnte den ersten samt prev_content überschreiben.
// refine-deck setzt refining=true in der Datenbank, bevor es antwortet; das
// 4-s-Polling der Angebots-Liste holt danach den fertigen Stand (neue Revision).
//
// Rein, ohne React und ohne Netz, getestet in scripts/verify-deck-autofix.mjs (T55).

export async function starteFeinschliff<R>(opts: {
  /** Ruft refine-deck mit background:true auf. */
  invoke: () => Promise<{ error: { message: string } | null }>
  /** Lauf gestartet: Deck sofort als „in Bearbeitung" markieren. */
  onStarted?: () => void
  /** Wartet, bis der Hintergrund-Lauf fertig ist. */
  warten: () => Promise<R>
}): Promise<R> {
  const { error } = await opts.invoke()
  if (error) throw new Error(error.message)
  opts.onStarted?.()
  return opts.warten()
}
