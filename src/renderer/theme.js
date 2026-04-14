const DEFAULT_THEME = {
  appearanceTheme: 'dark',
  accentColor: '#ffcc00',
};

const PRESET_THEME_COLORS = [
  '#000000',
  '#8f8f8f',
  '#ffffff',
  '#ff3b30',
  '#ff9500',  
  '#ffcc00',
  '#34c759',
  '#007aff',
  '#9c46ff',
  '#ff2dcf',
];

function normalizeThemeColor(value, fallback = DEFAULT_THEME.accentColor) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const trimmed = value.trim();

  if (/^#([0-9a-fA-F]{3})$/.test(trimmed)) {
    const hex = trimmed.slice(1);
    return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
  }

  if (/^#([0-9a-fA-F]{6})$/.test(trimmed)) {
    return trimmed.toLowerCase();
  }

  return fallback;
}

function isLightColor(hexColor) {
  const normalized = normalizeThemeColor(hexColor, DEFAULT_THEME.accentColor);
  const hex = normalized.slice(1);

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);

  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.72;
}

function resolveThemeName(themeName) {
  return themeName === 'light' ? 'light' : DEFAULT_THEME.appearanceTheme;
}

function getThemePalette(themeName, accentColor) {
  const theme = resolveThemeName(themeName);
  const accent = normalizeThemeColor(accentColor, DEFAULT_THEME.accentColor);
  const accentText = isLightColor(accent) ? '#111111' : '#ffffff';

  return {
    accent,
    textColor: theme === 'light' ? '#111111' : '#ffffff',
    mutedText: theme === 'light' ? '#4b5563' : '#d0d0d0',
    borderColor: theme === 'light' ? 'rgba(0, 0, 0, 0.10)' : 'rgba(255, 255, 255, 0.10)',
    scrollbarTrack: theme === 'light' ? 'rgba(0, 0, 0, 0.10)' : 'rgba(255, 255, 255, 0.10)',
    scrollbarTrackHover: theme === 'light' ? 'rgba(0, 0, 0, 0.16)' : 'rgba(255, 255, 255, 0.16)',
    scrollbarBorder: theme === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)',
    buttonText: accentText,

    appBg: theme === 'light' ? '#efefef' : '#202020',
    panelBg: theme === 'light' ? 'rgba(255, 255, 255, 0.65)' : 'rgba(10, 10, 10, 0.35)',
    surfaceBg: theme === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)',
    surfaceBgStrong: theme === 'light' ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.12)',
    toolbarBg: theme === 'light' ? 'rgba(255, 255, 255, 0.95)' : 'rgba(10, 10, 10, 0.95)',
    inputBg: theme === 'light' ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)',
    inputBorder: theme === 'light' ? 'rgba(0, 0, 0, 0.20)' : 'rgba(255, 255, 255, 0.20)',
  };
}

function applyThemeToRoot(root, themeName, accentColor) {
  if (!root) return;

  const palette = getThemePalette(themeName, accentColor);

  root.style.setProperty('--theme-accent', palette.accent);
  root.style.setProperty('--theme-app-bg', palette.appBg);
  root.style.setProperty('--theme-text', palette.textColor);
  root.style.setProperty('--theme-muted-text', palette.mutedText);
  root.style.setProperty('--theme-panel-bg', palette.panelBg);
  root.style.setProperty('--theme-surface-bg', palette.surfaceBg);
  root.style.setProperty('--theme-surface-bg-strong', palette.surfaceBgStrong);
  root.style.setProperty('--theme-border', palette.borderColor);
  root.style.setProperty('--theme-toolbar-bg', palette.toolbarBg);
  root.style.setProperty('--theme-input-bg', palette.inputBg);
  root.style.setProperty('--theme-input-border', palette.inputBorder);
  root.style.setProperty('--theme-button-text', palette.buttonText);
  root.style.setProperty('--myreader-scrollbar-thumb', palette.accent);
  root.style.setProperty('--myreader-scrollbar-thumb-hover', palette.accent);
  root.style.setProperty('--myreader-scrollbar-track', palette.scrollbarTrack);
  root.style.setProperty('--myreader-scrollbar-track-hover', palette.scrollbarTrackHover);
  root.style.setProperty('--myreader-scrollbar-border', palette.scrollbarBorder);
}

function applyAppTheme(root, settings) {
  applyThemeToRoot(
    root,
    settings?.appearanceTheme,
    settings?.accentColor
  );
}

function applyReaderTheme(root, settings) {
  applyThemeToRoot(
    root,
    settings?.appearanceTheme,
    settings?.accentColor
  );
}

function applySettingTheme(root, themeName, accentColor) {
  applyThemeToRoot(root, themeName, accentColor);
}

module.exports = {
  DEFAULT_THEME,
  PRESET_THEME_COLORS,
  normalizeThemeColor,
  isLightColor,
  resolveThemeName,
  getThemePalette,
  applyThemeToRoot,
  applyAppTheme,
  applyReaderTheme,
  applySettingTheme,
};