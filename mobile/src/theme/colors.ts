import { palettes, type Palette } from '../ui/theme/palette'

function legacy(p: Palette) {
  return {
    background: p.bgBase,
    foreground: p.textPrimary,
    muted: p.bgRaised,
    mutedForeground: p.textSecondary,
    border: p.borderSubtle,
    accent: p.bgRaised,
    accentForeground: p.textPrimary,
    idle: p.textSecondary,
    busy: p.statusAmber,
    waiting: p.agentQuestion,
    down: p.statusRed
  }
}

export const colors = { light: legacy(palettes.light), dark: legacy(palettes.dark) }
