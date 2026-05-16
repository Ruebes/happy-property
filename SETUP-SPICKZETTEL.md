# Mein Claude-Code-Setup — Spickzettel

Kurzreferenz für Sven. Liegt im Repo-Root. Was ist eingerichtet,
was passiert automatisch, was muss ich selbst tun.

---

## Was automatisch passiert (nichts zu tun)

**CLAUDE.md** (Repo-Root)
Claude Code liest diese Datei bei jedem Start automatisch. Drin:
Stack, Projektstruktur, harte Regeln, bekannte gelöste Bugs.
→ Ich muss nichts tun. Nur pflegen (siehe unten).

**Pre-Commit-Hook** (`.githooks/pre-commit`)
Läuft automatisch bei jedem `git commit`. Prüft TypeScript (`tsc`).
Bei Fehler: Commit wird blockiert, Fehler werden angezeigt.
→ Fehler beheben, dann normal nochmal committen.
→ Notfall-Bypass (selten nötig): `git commit --no-verify`

**crm-reviewer** (Subagent)
Claude ruft ihn nach größeren Codeänderungen automatisch.
Prüft auf: Supabase-Client-Verwechslung, Auth/Spinner-Bug.
Lernt neue Bug-Muster über Sessions (Gedächtnis).
→ Läuft von selbst. Kann auch manuell ausgelöst werden (siehe unten).

**Skills** (`supabase-edge-function`, `crm-page`)
Lädt Claude automatisch, wenn ich eine neue Edge Function oder
CRM-Seite bauen lasse. Sorgt für konsistenten Stil.
→ Nichts zu tun, wirkt automatisch.

---

## Was ich aktiv tun sollte

### 1. Neuen gelösten Bug in CLAUDE.md eintragen
**Das ist der wichtigste Hebel.** Immer wenn wir einen echten Bug
gelöst haben, in Claude Code sagen:

> "Trag den Bug XY mit Ursache und Regel in CLAUDE.md unter
> 'Bekannte Fallstricke' ein."

So wächst die Liste und Claude baut denselben Fehler nicht nochmal.
Aktuell steht da nur der Auth/Spinner-Bug (#1).

### 2. Reviewer bei Bedarf manuell auslösen
In Claude Code einfach sagen:

> "Lass den crm-reviewer über die letzten Änderungen laufen."

Sinnvoll vor größeren Commits oder nach Auth-/Supabase-Änderungen.

### 3. Neue Edge Function / CRM-Seite bauen lassen
Einfach normal beauftragen, z.B.:

> "Bau eine neue Edge Function 'xyz-webhook' für ..."
> "Erstell eine neue CRM-Seite für ..."

Claude zieht automatisch das passende Skill und folgt dem
Projektmuster. Kein Sonderbefehl nötig.

---

## Wartung / gut zu wissen

- **Claude-Code-Version aktuell halten:** `claude --version` prüfen,
  bei Bedarf `claude update`. Das Subagent-Gedächtnis braucht eine
  aktuelle Version.
- **Hook nach Repo-Neuklon reaktivieren:** Falls das Repo woanders
  neu geklont wird, einmal ausführen:
  `git config core.hooksPath .githooks`
  (Der Hook-Code selbst liegt im Repo, geht nicht verloren.)
- **Setup-Dateien liegen unter:**
  - `CLAUDE.md` (Root)
  - `.githooks/pre-commit`
  - `.claude/agents/crm-reviewer.md`
  - `.claude/skills/supabase-edge-function/SKILL.md`
  - `.claude/skills/crm-page/SKILL.md`

---

## Faustregel

Das Setup hilft, ist aber kein Selbstläufer. Der größte Effekt kommt
davon, gelöste Bugs konsequent in CLAUDE.md nachzutragen. Je mehr
projektspezifisches Wissen dort steht, desto weniger wiederkehrende
Bugs.
