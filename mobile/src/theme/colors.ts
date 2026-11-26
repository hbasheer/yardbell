export const colors = {
  light: {
    background: '#ffffff',
    foreground: '#0a0a0a',
    muted: '#f5f5f5',
    mutedForeground: '#696969',
    border: '#e5e5e5',
    accent: '#f5f5f5',
    accentForeground: '#171717',
    idle: '#696969',
    busy: '#eab308',
    waiting: '#ea580c',
    down: '#e40014'
  },
  dark: {
    background: '#0a0a0a',
    foreground: '#f0f0f0',
    muted: '#262626',
    mutedForeground: '#acacac',
    border: 'rgba(255, 255, 255, 0.07)',
    accent: '#404040',
    accentForeground: '#f0f0f0',
    idle: '#acacac',
    busy: '#eab308',
    waiting: '#f97316',
    down: '#ff6568'
  }
}

const ansiDark = {
  black: '#1d1f21',
  red: '#e06c75',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#7f848e',
  brightRed: '#ef7a7f',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea'
}

const ansiLight = {
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#7d4e00',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f'
}

export const terminalColors = {
  light: {
    ...ansiLight,
    background: colors.light.background,
    foreground: '#1f2328',
    cursor: '#2563eb',
    cursorAccent: colors.light.background,
    selectionBackground: '#bfdbfe'
  },
  dark: {
    ...ansiDark,
    background: colors.dark.background,
    foreground: colors.dark.foreground,
    cursor: '#ffffff',
    cursorAccent: colors.dark.background,
    selectionBackground: '#5a7898',
    selectionForeground: '#ffffff'
  }
}
