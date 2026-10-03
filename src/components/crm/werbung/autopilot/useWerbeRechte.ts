import { useAuth } from '../../../../lib/auth'

// ── Wer darf im Autopiloten was (Anzeige; die Datenbank prüft selbst) ───────
// Spiegel der Schutz-Trigger und RPCs aus 20261003110000_werbe_autopilot.sql:
//   istAdmin        profiles.role = 'admin': Modus, Leitplanken, Regelstufen,
//                   Vorrats-Automatik hochstellen
//   darfEntscheiden current_user_has_perm('werbung') = Admin, Verwalter oder
//                   Mitarbeiter mit Recht werbung (Sven und Giona): Vorschläge
//                   freigeben/ablehnen, Schatten bewerten, Senken, Rückgängig
//   darfStoppen     werbung oder werbung_meta: roter Knopf
// Die Knöpfe richten sich danach; ein Umgehen scheitert an der Datenbank (42501).
export interface WerbeRechte {
  istAdmin: boolean
  darfEntscheiden: boolean
  darfStoppen: boolean
}

export function useWerbeRechte(): WerbeRechte {
  const { profile } = useAuth()
  const rolle = profile?.role
  const perms = profile?.permissions ?? {}
  const istAdmin = rolle === 'admin'
  const leitung = rolle === 'admin' || rolle === 'verwalter'
  const darfEntscheiden = leitung || (rolle === 'mitarbeiter' && !!perms.werbung)
  const darfStoppen = darfEntscheiden || (rolle === 'mitarbeiter' && !!perms.werbung_meta)
  return { istAdmin, darfEntscheiden, darfStoppen }
}
