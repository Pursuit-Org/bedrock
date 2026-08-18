import type { AccountStatus } from "@/types/salesforce";

/**
 * Playbook Account Status → Tag color variant.
 *
 *   Prospect       default (neutral — untouched)
 *   Activating     sky     (we've made contact, but no opportunity yet)
 *   Pursuing       accent  (purple — active hunt)
 *   Stewarding     green   (healthy delivery in flight)
 *   Re-activating  amber   (recent touch, but no open opp / award)
 *   Dormant        red     (needs renewed effort)
 *
 * Kept in /lib so every page that renders an accounts table picks
 * up the same colors without duplicating the switch.
 */
export function accountStatusVariant(
  s: AccountStatus,
): "default" | "accent" | "green" | "amber" | "red" | "sky" | "zinc" {
  switch (s) {
    case "Deprioritized": return "zinc";
    case "Activating": return "sky";
    case "Pursuing": return "accent";
    case "Stewarding": return "green";
    case "Re-activating": return "amber";
    case "Dormant": return "red";
    default: return "default";
  }
}
