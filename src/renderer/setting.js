import './setting.css';
import themeModule from './theme';
import { createI18n, normalizeLanguage } from './i18n';

const {
  DEFAULT_THEME,
  PRESET_THEME_COLORS,
  normalizeThemeColor,
  isLightColor,
  applySettingTheme,
} = themeModule;

// ===== 初始主題 =====
/**
 * 從網址參數取得初始主題設定
 * 讓設定頁在載入時就先套用正確主題，避免閃爍
 */
function getInitialThemeFromQuery() {
  const params = new URLSearchParams(window.location.search);

  return {
    appearanceTheme:
      params.get('theme') === 'light'
        ? 'light'
        : DEFAULT_THEME.appearanceTheme,

    accentColor: normalizeThemeColor(
      params.get('accent'),
      DEFAULT_THEME.accentColor
    ),
  };
}

const initialTheme = getInitialThemeFromQuery();

applySettingTheme(
  document.documentElement,
  initialTheme.appearanceTheme,
  initialTheme.accentColor
);

// ===== DOM 元素 =====
const backBtn = document.getElementById('back-btn');
const backBtnLabel = backBtn?.querySelector('.toolbar-btn-label');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const settingsMenu = document.getElementById('settings-menu');
const settingsContent = document.getElementById('settings-content');
const fullscreenIconPath = document.getElementById('fullscreen-icon-path');

// ===== 設定頁狀態 =====
let currentLibraryPath = '';
let isFullscreen = false;
let activeSection = 'library';
let libraryHistoryPaths = [];
let pendingHistoryLibraryPath = '';
let clearReadingProgressChecked = false;
let systemLanguageDraft = '';

let settings = {
  displayLibraryName: '',
  autoPlaySeconds: 5,
  bookSortMode: 'none',
  readingHistoryVisibility: 'hidden',
  language: 'en',
  appearanceTheme: DEFAULT_THEME.appearanceTheme,
  accentColor: DEFAULT_THEME.accentColor,
  customColorHistory: [],
  savedColorHistory: [],
  backgroundMode: 'none',
  backgroundImagePath: '',
  backgroundOpacity: 16,
  backgroundBlur: 2,
  contentReadingMode: 'document',
  pageClickCommand: [],
  scrollHoldCommand: [],
  bookmarkCommand: 'leftNextRightPrev',
  bookCardCoverOnly: false,
  bookCardSquareCorner: false,
};

let i18n = createI18n(settings.language);

function t(path, params = {}) {
  return i18n.t(path, params);
}

function getHtmlLang(language) {
  const safeLanguage = normalizeLanguage(language);
  return safeLanguage === 'zh-TW' ? 'zh-Hant' : safeLanguage;
}

function applyDocumentLanguage(language) {
  document.documentElement.lang = getHtmlLang(language);
}

function applySystemContentLanguage(language) {
  if (!settingsContent) return;
  settingsContent.lang = getHtmlLang(language);
}

function clearSystemContentLanguage() {
  if (!settingsContent) return;
  settingsContent.removeAttribute('lang');
}

function getSystemPreviewLanguage() {
  return normalizeLanguage(systemLanguageDraft || settings.language);
}

function cancelSystemLanguagePreview() {
  if (!systemLanguageDraft) return;

  systemLanguageDraft = '';
  i18n = createI18n(settings.language);
  applyDocumentLanguage(settings.language);
}

// ===== 個人主題暫存狀態 =====
let appearancePreviewTheme = null;
let appearancePreviewAccentColor = null;
let appearanceDraftCustomColor = null;
let appearanceCustomHistory = [];
let appearancePendingAccentColor = null;
let appearanceSavedColorHistory = [];
let appearanceSelectedCustomSlotIndex = -1;
let appearanceSelectedSavedSlotIndex = -1;
let appearanceSelectionSource = 'classic';

// ===== 基本工具函式 =====
function finishBooting() {
  requestAnimationFrame(() => {
    document.documentElement.classList.remove('booting');
  });
}

/**
 * 取得目前書庫顯示名稱
 * 優先使用自訂名稱，否則顯示書庫路徑
 */
function getDisplayLibraryName() {
  const customName = (settings.displayLibraryName || '').trim();
  return customName || currentLibraryPath || t('settings.noLibraryFolder');
}

/**
 * 更新左側選單 active 狀態
 */
function renderMenuState() {
  const items = settingsMenu?.querySelectorAll('.settings-item') || [];

  items.forEach((item) => {
    item.classList.toggle('active', item.dataset.section === activeSection);
  });
}

function updateSettingsStaticText() {
  const menuLabels = {
    library: t('settings.titleLibrary'),
    autoplay: t('settings.titleReading'),
    appearance: t('settings.titleAppearance'),
    history: t('settings.titleHistory'),
    system: t('settings.titleSystem'),
  };

  Object.entries(menuLabels).forEach(([section, label]) => {
    const labelEl = settingsMenu?.querySelector(
      `.settings-item[data-section="${section}"] .settings-item-label`
    );

    if (labelEl) {
      labelEl.textContent = label;
    }
  });

  if (backBtn) {
    const label = t('reader.backToLibrary');

    backBtn.title = label;
    backBtn.setAttribute('aria-label', label);
  }

  if (backBtnLabel) {
    backBtnLabel.textContent = t('common.back');
  }

  updateFullscreenButton();
}

/**
 * 正規化背景模式
 */
function normalizeBackgroundMode(mode) {
  return ['none', 'selectedBookCover', 'importedImage'].includes(mode)
    ? mode
    : 'none';
}

/**
 * 數值夾取工具
 */
function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numberValue));
}

/**
 * 重設「紀錄」區塊的暫存點選狀態
 */
function resetHistoryDraftState() {
  pendingHistoryLibraryPath = '';
  clearReadingProgressChecked = false;
}

/**
 * 更新 range 數值泡泡的位置與文字
 */
function updateRangeTooltip(rangeInput, tooltipEl) {
  if (!rangeInput || !tooltipEl) return;

  const min = Number(rangeInput.min) || 0;
  const max = Number(rangeInput.max) || 100;
  const value = Number(rangeInput.value) || 0;

  const percent = max === min ? 0 : (value - min) / (max - min);
  tooltipEl.textContent = String(value);

  const thumbSize = 18;
  const inputWidth = rangeInput.offsetWidth;
  const offsetX = percent * (inputWidth - thumbSize) + thumbSize / 2;

  tooltipEl.style.left = `${offsetX}px`;
}

/**
 * 綁定 range 的拖曳數值泡泡
 */
function bindRangeTooltip(rangeInput, tooltipEl) {
  if (!rangeInput || !tooltipEl) return;

  const showTooltip = () => {
    updateRangeTooltip(rangeInput, tooltipEl);
    tooltipEl.classList.add('show');
  };

  const hideTooltip = () => {
    tooltipEl.classList.remove('show');
  };

  rangeInput.addEventListener('input', showTooltip);
  rangeInput.addEventListener('pointerdown', showTooltip);
  rangeInput.addEventListener('mousedown', showTooltip);
  rangeInput.addEventListener('touchstart', showTooltip, { passive: true });

  rangeInput.addEventListener('pointerup', hideTooltip);
  rangeInput.addEventListener('mouseup', hideTooltip);
  rangeInput.addEventListener('touchend', hideTooltip);
  rangeInput.addEventListener('blur', hideTooltip);

  window.addEventListener('resize', () => updateRangeTooltip(rangeInput, tooltipEl));

  updateRangeTooltip(rangeInput, tooltipEl);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };

    return map[char] || char;
  });
}

function showConfirmDialog({
  title = t('common.confirm'),
  message = '',
  detail = '',
  note = '',
  confirmText = t('common.confirm'),
  cancelText = t('common.cancel'),
} = {}) {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'settings-dialog-backdrop';

    backdrop.innerHTML = `
      <div class="settings-dialog" role="dialog" aria-modal="true">
      <div class="settings-dialog-title">${escapeHtml(title)}</div>

      <div class="settings-dialog-message">
        ${escapeHtml(message)}
      </div>

      <div class="settings-dialog-control-row">
        ${detail
        ? `<div class="settings-dialog-detail">${escapeHtml(detail)}</div>`
        : '<div class="settings-dialog-detail-spacer"></div>'
      }

        <button
          class="settings-dialog-button settings-dialog-cancel"
          type="button">
          ${escapeHtml(cancelText)}
        </button>

        <button
          class="settings-dialog-button settings-dialog-confirm"
          type="button">
          ${escapeHtml(confirmText)}
        </button>
      </div>

      ${note
        ? `<div class="settings-dialog-note">${escapeHtml(note)}</div>`
        : ''
      }
    </div>
  `;

    document.body.appendChild(backdrop);

    const cancelBtn = backdrop.querySelector('.settings-dialog-cancel');
    const confirmBtn = backdrop.querySelector('.settings-dialog-confirm');

    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };

    cancelBtn?.addEventListener('click', () => close(false));
    confirmBtn?.addEventListener('click', () => close(true));

    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) {
        close(false);
      }
    });

    const handleKeydown = (event) => {
      if (event.key === 'Escape') {
        document.removeEventListener('keydown', handleKeydown);
        close(false);
      }

      if (event.key === 'Enter') {
        document.removeEventListener('keydown', handleKeydown);
        close(true);
      }
    };

    document.addEventListener('keydown', handleKeydown);
    confirmBtn?.focus();
  });
}

// ===== 主題工具 =====
/**
 * 取得目前應顯示的系統主題
 * 若有預覽中的主題則優先使用預覽值
 */
function getEffectiveAppearanceTheme() {
  return appearancePreviewTheme || settings.appearanceTheme || DEFAULT_THEME.appearanceTheme;
}

/**
 * 取得目前應顯示的主題色
 * 若有預覽中的顏色則優先使用預覽值
 */
function getEffectiveAccentColor() {
  return normalizeThemeColor(
    appearancePreviewAccentColor || settings.accentColor || DEFAULT_THEME.accentColor,
    DEFAULT_THEME.accentColor
  );
}

/**
 * 套用主題預覽
 */
function applyThemePreview(themeName, accentColor) {
  applySettingTheme(
    document.documentElement,
    themeName,
    accentColor
  );

  document.body.classList.toggle('light-theme', themeName === 'light');
  document.body.classList.toggle('dark-theme', themeName !== 'light');
}

/**
 * 套用目前已儲存的主題
 */
function applySavedTheme() {
  applyThemePreview(
    settings.appearanceTheme || DEFAULT_THEME.appearanceTheme,
    settings.accentColor || DEFAULT_THEME.accentColor
  );
}

/**
 * 重設個人主題的草稿狀態
 */
function resetAppearanceDraftState() {
  appearancePreviewTheme = null;
  appearancePreviewAccentColor = null;
  appearanceDraftCustomColor = null;
  appearancePendingAccentColor = null;
  appearanceSelectedCustomSlotIndex = -1;
  appearanceSelectedSavedSlotIndex = -1;
  appearanceSelectionSource = 'classic';
}

/**
 * 取消個人主題預覽
 */
function cancelAppearancePreview() {
  resetAppearanceDraftState();
  applySavedTheme();
}

/**
 * 依顏色明暗決定按鈕文字顏色
 */
function getAppearanceButtonTextColor(color) {
  return isLightColor(color) ? '#111111' : '#ffffff';
}

/**
 * 取得目前已套用的主題色
 */
function getCurrentAppliedAccentColor() {
  return normalizeThemeColor(
    settings.accentColor,
    DEFAULT_THEME.accentColor
  );
}

/**
 * 取得保存按鈕目前顯示的顏色
 */
function getCurrentSavedButtonColor() {
  return normalizeThemeColor(
    settings.accentColor,
    DEFAULT_THEME.accentColor
  );
}

/**
 * 將顏色加入自訂顏色歷史
 */
function pushCustomColorToHistory(color) {
  const normalized = normalizeThemeColor(color, DEFAULT_THEME.accentColor);

  appearanceCustomHistory = [
    normalized,
    ...appearanceCustomHistory.filter((item) => item !== normalized),
  ].slice(0, 5);
}

/**
 * 將顏色加入保存顏色歷史
 */
function pushColorToSavedHistory(color) {
  const normalized = normalizeThemeColor(color, DEFAULT_THEME.accentColor);

  appearanceSavedColorHistory = [
    normalized,
    ...appearanceSavedColorHistory.filter((item) => item !== normalized),
  ].slice(0, 6);
}

/**
 * 取得目前被選中的自訂顏色格
 */
function getSelectedCustomSlotColor() {
  return appearanceCustomHistory[appearanceSelectedCustomSlotIndex] || null;
}

/**
 * 將個人主題歷史同步回 settings
 */
function syncAppearanceHistoryToSettings() {
  settings.customColorHistory = [...appearanceCustomHistory];
  settings.savedColorHistory = [...appearanceSavedColorHistory];
}

// ===== 背景工具 =====
/**
 * 套用設定頁背景樣式
 * 這裡只負責把 CSS 變數寫進 root
 */
function applySettingsBackgroundStyle(imageUrl, opacityValue, blurValue) {
  const root = document.documentElement;

  root.style.setProperty(
    '--page-background-image',
    imageUrl ? `url("${imageUrl}")` : 'none'
  );

  root.style.setProperty(
    '--page-background-opacity',
    String(clampNumber(opacityValue, 0, 100, 16) / 100)
  );

  root.style.setProperty(
    '--page-background-blur',
    `${clampNumber(blurValue, 0, 40, 2)}px`
  );
}

/**
 * 依目前設定套用設定頁背景
 */
async function applySettingsPageBackground() {
  const mode = normalizeBackgroundMode(settings.backgroundMode);

  if (mode === 'none') {
    applySettingsBackgroundStyle(
      '',
      settings.backgroundOpacity,
      settings.backgroundBlur
    );
    return;
  }

  if (mode === 'importedImage') {
    if (!settings.backgroundImagePath) {
      applySettingsBackgroundStyle(
        '',
        settings.backgroundOpacity,
        settings.backgroundBlur
      );
      return;
    }

    const imageDataUrl = await window.readerAPI.readImageData(
      settings.backgroundImagePath
    );

    applySettingsBackgroundStyle(
      imageDataUrl || '',
      settings.backgroundOpacity,
      settings.backgroundBlur
    );
    return;
  }

  if (mode === 'selectedBookCover') {
    const lastSelectedBookPath = await window.readerAPI.getLastSelectedBook();

    if (!lastSelectedBookPath) {
      applySettingsBackgroundStyle(
        '',
        settings.backgroundOpacity,
        settings.backgroundBlur
      );
      return;
    }

    const coverDataUrl = await window.readerAPI.readCoverData(
      lastSelectedBookPath,
      750
    );

    applySettingsBackgroundStyle(
      coverDataUrl || '',
      settings.backgroundOpacity,
      settings.backgroundBlur
    );
  }
}

/**
 * 套用新的書庫路徑，並同步更新第一本書與背景
 */
async function applyLibraryChange(folderPath) {
  if (!folderPath) return;

  currentLibraryPath = folderPath;

  libraryHistoryPaths = await window.readerAPI.getLibraryHistory?.() || [];

  const scannedBooks = await window.readerAPI.scanLibrary(folderPath);
  const firstBook = Array.isArray(scannedBooks) && scannedBooks.length > 0
    ? scannedBooks[0]
    : null;

  await window.readerAPI.saveLastSelectedBook(firstBook?.filePath || '');

  if (settings.backgroundMode === 'selectedBookCover') {
    await applySettingsPageBackground();
  }
}

// ===== 各區塊渲染：書庫 =====
/**
 * 渲染「書庫」區塊
 */
function renderLibrarySection() {
  const currentSortMode = ['none', 'favorite', 'unread', 'completedLast'].includes(settings.bookSortMode)
    ? settings.bookSortMode
    : 'none';

  const canClearCurrentLibrary = Boolean(currentLibraryPath);

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">${t('settings.titleLibrary')}</h1>

    <div class="settings-group">
      <div class="settings-label">${t('settings.libraryFolder')}</div>
      <div class="settings-block">
        <button id="pick-folder-btn" class="settings-control" type="button">
          ${t('settings.pickLibraryFolder')}
        </button>
      </div>
      <div class="settings-block">
      <button
      id="clear-current-library-btn"
      class="settings-action-button settings-control danger-button"
      type="button"
      ${canClearCurrentLibrary ? '' : 'disabled'}>
      ${t('settings.clearCurrentLibraryFolder')}
      </button>
      </div>
      <div class="settings-hint">${t('settings.libraryFolderHint')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.libraryName')}</div>
      <div class="settings-block">
        <input
          id="display-library-name-input"
          class="settings-input settings-control"
          type="text"
          maxlength="120"
          placeholder="${t('settings.libraryNamePlaceholder')}"
          value="${escapeHtml(settings.displayLibraryName || '')}"
        >
      </div>
      <div class="settings-hint" id="display-library-name-hint">
        ${t('settings.libraryNameHint', { name: getDisplayLibraryName() })}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.libraryPath')}</div>
      <div class="settings-block">
        <div class="settings-value settings-control">
        ${escapeHtml(currentLibraryPath || t('settings.noLibraryFolder'))}
        </div>
      </div>
      <div class="settings-hint">
        ${t('settings.libraryPathHint')}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.bookSort')}</div>
      <div class="settings-check-list" id="book-sort-options">
        <button class="settings-check-option" data-sort-mode="none" type="button">
          <span class="settings-checkbox ${currentSortMode === 'none' ? 'checked' : ''}">
            ${currentSortMode === 'none' ? '✓' : ''}
          </span>
          <span>${t('settings.sortNone')}</span>
        </button>

        <button class="settings-check-option" data-sort-mode="favorite" type="button">
          <span class="settings-checkbox ${currentSortMode === 'favorite' ? 'checked' : ''}">
            ${currentSortMode === 'favorite' ? '✓' : ''}
          </span>
          <span>${t('settings.sortFavorite')}</span>
        </button>

        <button class="settings-check-option" data-sort-mode="unread" type="button">
          <span class="settings-checkbox ${currentSortMode === 'unread' ? 'checked' : ''}">
            ${currentSortMode === 'unread' ? '✓' : ''}
          </span>
          <span>${t('settings.sortUnread')}</span>
        </button>

        <button class="settings-check-option" data-sort-mode="completedLast" type="button">
          <span class="settings-checkbox ${currentSortMode === 'completedLast' ? 'checked' : ''}">
            ${currentSortMode === 'completedLast' ? '✓' : ''}
          </span>
          <span>${t('settings.sortCompletedLast')}</span>
        </button>
      </div>
      <div class="settings-hint">${t('settings.bookSortHint')}</div>
    </div>
  `;

  document.getElementById('pick-folder-btn')?.addEventListener('click', async () => {
    const folderPath = await window.readerAPI.pickLibraryFolder();
    if (!folderPath) return;

    await window.readerAPI.pushLibraryHistory?.(folderPath);
    await applyLibraryChange(folderPath);

    renderSection();
  });

  document.getElementById('clear-current-library-btn')?.addEventListener('click', async () => {
    if (!currentLibraryPath) return;

    const targetLibraryPath = currentLibraryPath;

    const confirmed = await showConfirmDialog({
      title: t('settings.clearCurrentLibrary'),
      message: t('settings.clearHistoryLibraryMessage'),
      detail: targetLibraryPath,
      note: t('settings.clearHistoryLibraryNote'),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    });

    if (!confirmed) return;

    const result = await window.readerAPI.clearCurrentLibrary?.(
      targetLibraryPath
    );

    if (!result?.cleared) return;

    currentLibraryPath = '';
    pendingHistoryLibraryPath = '';

    libraryHistoryPaths = Array.isArray(result.history)
      ? result.history
      : [];

    settings.displayLibraryName = '';

    await window.readerAPI.openLibraryPage();
  });

  const input = document.getElementById('display-library-name-input');
  const hint = document.getElementById('display-library-name-hint');

  input?.addEventListener('input', (event) => {
    settings.displayLibraryName = event.target.value;

    if (hint) {
      hint.textContent = t('settings.currentLibraryNameHint', {
        name: getDisplayLibraryName(),
      });
    }
  });

  input?.addEventListener('change', async (event) => {
    settings.displayLibraryName = event.target.value;
    settings = await window.readerAPI.saveAppSettings(settings);
    renderSection();
  });

  input?.addEventListener('keydown', async (event) => {
    if (event.key !== 'Enter') return;

    event.preventDefault();

    settings.displayLibraryName = event.target.value;
    settings = await window.readerAPI.saveAppSettings(settings);
    renderSection();
  });

  document.getElementById('book-sort-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-sort-mode]');
    if (!option) return;

    settings.bookSortMode = option.dataset.sortMode || 'none';
    settings = await window.readerAPI.saveAppSettings(settings);
    renderSection();
  });
}

// ===== 各區塊渲染：個人化 =====
/**
 * 渲染「個人化」區塊
 */
function renderAppearanceSection() {
  const effectiveTheme = getEffectiveAppearanceTheme();
  const effectiveAccentColor = getEffectiveAccentColor();
  const appliedAccentColor = getCurrentAppliedAccentColor();
  const savedButtonColor = getCurrentSavedButtonColor();
  const previewAccentColor = appearancePendingAccentColor || effectiveAccentColor;
  const bookCardCoverOnly = Boolean(settings.bookCardCoverOnly);
  const bookCardSquareCorner = Boolean(settings.bookCardSquareCorner);
  const isDefaultBookCardStyle = !bookCardCoverOnly && !bookCardSquareCorner;

  const customSlots = Array.from(
    { length: 5 },
    (_, index) => appearanceCustomHistory[index] || null
  );

  const savedSlots = Array.from(
    { length: 6 },
    (_, index) => appearanceSavedColorHistory[index] || null
  );

  const PALETTE_ICON = `
    <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" aria-hidden="true">
      <path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80ZM303-457q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120-160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm200 0q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120 160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Z" fill="currentColor"/>
    </svg>
  `;

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">${t('settings.titleAppearance')}</h1>

    <div class="settings-group">
      <div class="settings-label">${t('settings.personalTheme')}</div>

      <div class="appearance-row">
        <div class="appearance-row-controls appearance-row-controls-classic">
          ${PRESET_THEME_COLORS.map((color) => {
    const normalizedColor = normalizeThemeColor(color, DEFAULT_THEME.accentColor);
    const isSelected =
      appearanceSelectionSource === 'classic' &&
      normalizedColor === effectiveAccentColor;

    return `
              <button
                class="appearance-color-option ${isSelected ? 'selected' : ''}"
                type="button"
                data-accent-color="${color}"
                style="background:${color}; color:${getAppearanceButtonTextColor(color)};"
                title="${color}">
              </button>
            `;
  }).join('')}
        </div>
      </div>

      <div class="appearance-row">
        <div class="appearance-row-label">${t('settings.customColor')}</div>
        <div class="appearance-row-controls appearance-row-controls-fixed">
          <label class="appearance-picker-trigger" for="appearance-color-picker" title="${t('settings.chooseCustomColor')}">
            <span class="appearance-picker-icon">${PALETTE_ICON}</span>
          </label>

          ${customSlots.map((color, index) => `
            <button
              class="appearance-custom-history-btn ${color ? 'has-color' : ''} ${appearanceSelectionSource === 'custom' && index === appearanceSelectedCustomSlotIndex ? 'selected' : ''}"
              type="button"
              data-custom-history-index="${index}"
              ${color ? `style="background:${color}; color:${getAppearanceButtonTextColor(color)}; border-color:${color};"` : ''}
              title="${color || t('settings.noCustomColor')}">
            </button>
          `).join('')}

          <button
            id="appearance-save-btn"
            class="appearance-save-btn"
            type="button"
            style="background:${savedButtonColor}; color:${getAppearanceButtonTextColor(savedButtonColor)};">
            ${t('common.save')}
          </button>

          <input
            id="appearance-color-picker"
            class="appearance-color-picker-input"
            type="color"
            value="${normalizeThemeColor(previewAccentColor, DEFAULT_THEME.accentColor)}"
          >
        </div>
      </div>

      <div class="appearance-row">
        <div class="appearance-row-label">${t('settings.savedColor')}</div>
        <div class="appearance-row-controls appearance-row-controls-fixed">
          ${savedSlots.map((color, index) => `
            <button
              class="appearance-saved-history-btn ${color ? 'has-color' : ''} ${appearanceSelectionSource === 'saved' && index === appearanceSelectedSavedSlotIndex ? 'selected' : ''}"
              type="button"
              data-saved-history-index="${index}"
              ${color ? `style="background:${color}; color:${getAppearanceButtonTextColor(color)}; border-color:${color};"` : ''}
              title="${color || t('settings.noSavedColor')}">
            </button>
          `).join('')}

          <button
            id="appearance-apply-btn"
            class="appearance-apply-btn"
            type="button"
            style="background:${appliedAccentColor}; color:${getAppearanceButtonTextColor(appliedAccentColor)};">
            ${t('common.confirm')}
          </button>
        </div>
      </div>

      <div class="settings-hint">
        ${t('settings.appearanceHint')}
      </div>
    </div>
    
    <div class="settings-group">
  <div class="settings-label">${t('settings.bookCardStyle')}</div>

  <div class="settings-check-list" id="book-card-options">
    <button class="settings-check-option" data-book-card-option="normal" type="button">
      <span class="settings-checkbox ${isDefaultBookCardStyle ? 'checked' : ''}">
        ${isDefaultBookCardStyle ? '✓' : ''}
      </span>
      <span>${t('settings.bookCardNormal')}</span>
    </button>

    <button class="settings-check-option" data-book-card-option="coverOnly" type="button">
      <span class="settings-checkbox ${bookCardCoverOnly ? 'checked' : ''}">
        ${bookCardCoverOnly ? '✓' : ''}
      </span>
      <span>${t('settings.bookCardCoverOnly')}</span>
    </button>

    <button class="settings-check-option" data-book-card-option="squareCorner" type="button">
      <span class="settings-checkbox ${bookCardSquareCorner ? 'checked' : ''}">
        ${bookCardSquareCorner ? '✓' : ''}
      </span>
      <span>${t('settings.bookCardSquareCorner')}</span>
    </button>
  </div>

  <div class="settings-hint">
    ${t('settings.bookCardHint')}
  </div>
</div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.background')}</div>

      <div class="settings-check-list" id="background-mode-options">
        <button class="settings-check-option" data-background-mode="none" type="button">
          <span class="settings-checkbox ${settings.backgroundMode === 'none' ? 'checked' : ''}">
            ${settings.backgroundMode === 'none' ? '✓' : ''}
          </span>
          <span>${t('settings.backgroundNone')}</span>
        </button>

        <button class="settings-check-option" data-background-mode="selectedBookCover" type="button">
          <span class="settings-checkbox ${settings.backgroundMode === 'selectedBookCover' ? 'checked' : ''}">
            ${settings.backgroundMode === 'selectedBookCover' ? '✓' : ''}
          </span>
          <span>${t('settings.backgroundSelectedBookCover')}</span>
        </button>

        <button class="settings-check-option" data-background-mode="importedImage" type="button">
          <span class="settings-checkbox ${settings.backgroundMode === 'importedImage' ? 'checked' : ''}">
            ${settings.backgroundMode === 'importedImage' ? '✓' : ''}
          </span>
          <span>${t('settings.backgroundImportedImage')}</span>
        </button>
      </div>

      <div class="background-image-picker-block">
        <button id="pick-background-image-btn" class="settings-control" type="button">
        ${t('settings.pickBackgroundImage')}
        </button>
        <div class="settings-hint background-image-path">
          ${t('settings.backgroundImagePath', {
    path: settings.backgroundImagePath || t('settings.backgroundImageNotSelected'),
  })}
        </div>
      </div>

      <div class="background-slider-row">
        <div class="background-slider-label">${t('settings.opacity')}</div>
        <div class="background-range-wrap">
          <input
          id="background-opacity-range"
          class="background-range"
          type="range"
          min="0"
          max="100"
          step="1"
          value="${clampNumber(settings.backgroundOpacity, 0, 100, 20)}"
          >
          <div id="background-opacity-tooltip" class="range-value-tooltip">
            ${clampNumber(settings.backgroundOpacity, 0, 100, 20)}
          </div>
        </div>
      </div>

      <div class="background-slider-row">
        <div class="background-slider-label">${t('settings.blur')}</div>
        <div class="background-range-wrap">
          <input
          id="background-blur-range"
          class="background-range"
          type="range"
          min="0"
          max="40"
          step="1"
          value="${clampNumber(settings.backgroundBlur, 0, 40, 0)}"
          >
          <div id="background-blur-tooltip" class="range-value-tooltip">
          ${clampNumber(settings.backgroundBlur, 0, 40, 0)}
          </div>
        </div>
      </div>
    </div>
  `;

  bindAppearanceSectionEvents();
}

/**
 * 綁定「個人化」區塊事件
 */
function bindAppearanceSectionEvents() {
  const colorButtons = settingsContent.querySelectorAll('[data-accent-color]');
  const customHistoryButtons = settingsContent.querySelectorAll('[data-custom-history-index]');
  const savedHistoryButtons = settingsContent.querySelectorAll('[data-saved-history-index]');
  const colorPicker = document.getElementById('appearance-color-picker');
  const saveBtn = document.getElementById('appearance-save-btn');
  const applyBtn = document.getElementById('appearance-apply-btn');
  const opacityRange = document.getElementById('background-opacity-range');
  const blurRange = document.getElementById('background-blur-range');
  const opacityTooltip = document.getElementById('background-opacity-tooltip');
  const blurTooltip = document.getElementById('background-blur-tooltip');

  colorButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const color = normalizeThemeColor(
        button.dataset.accentColor,
        DEFAULT_THEME.accentColor
      );

      appearanceSelectionSource = 'classic';
      appearanceSelectedCustomSlotIndex = -1;
      appearanceSelectedSavedSlotIndex = -1;
      appearancePreviewAccentColor = color;
      appearancePendingAccentColor = color;

      applyThemePreview(getEffectiveAppearanceTheme(), color);
      renderAppearanceSection();
    });
  });

  colorPicker?.addEventListener('input', (event) => {
    const color = normalizeThemeColor(
      event.target.value,
      DEFAULT_THEME.accentColor
    );

    appearancePreviewAccentColor = color;
    appearancePendingAccentColor = color;
    applyThemePreview(getEffectiveAppearanceTheme(), color);
  });

  colorPicker?.addEventListener('change', async (event) => {
    const color = normalizeThemeColor(
      event.target.value,
      DEFAULT_THEME.accentColor
    );

    appearanceDraftCustomColor = color;
    appearancePreviewAccentColor = color;
    appearancePendingAccentColor = color;
    pushCustomColorToHistory(color);

    appearanceSelectionSource = 'classic';
    appearanceSelectedCustomSlotIndex = -1;
    appearanceSelectedSavedSlotIndex = -1;

    syncAppearanceHistoryToSettings();
    settings = await window.readerAPI.saveAppSettings(settings);

    applyThemePreview(getEffectiveAppearanceTheme(), color);
    renderAppearanceSection();
  });

  customHistoryButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.customHistoryIndex);
      const color = appearanceCustomHistory[index];
      if (!color) return;

      appearanceSelectionSource = 'custom';
      appearanceSelectedCustomSlotIndex = index;
      appearanceSelectedSavedSlotIndex = -1;
      appearanceDraftCustomColor = color;
      appearancePreviewAccentColor = color;
      appearancePendingAccentColor = color;

      applyThemePreview(getEffectiveAppearanceTheme(), color);
      renderAppearanceSection();
    });
  });

  saveBtn?.addEventListener('click', async () => {
    const selectedColor = getSelectedCustomSlotColor();
    if (!selectedColor) return;

    pushColorToSavedHistory(selectedColor);
    appearanceSelectedSavedSlotIndex = 0;

    syncAppearanceHistoryToSettings();
    settings = await window.readerAPI.saveAppSettings(settings);

    renderAppearanceSection();
  });

  savedHistoryButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const index = Number(button.dataset.savedHistoryIndex);
      const color = appearanceSavedColorHistory[index];
      if (!color) return;

      appearanceSelectionSource = 'saved';
      appearanceSelectedSavedSlotIndex = index;
      appearanceSelectedCustomSlotIndex = -1;
      appearancePreviewAccentColor = color;
      appearancePendingAccentColor = color;

      applyThemePreview(getEffectiveAppearanceTheme(), color);
      renderAppearanceSection();
    });
  });

  applyBtn?.addEventListener('click', async () => {
    const nextAccentColor = normalizeThemeColor(
      appearancePendingAccentColor || getEffectiveAccentColor(),
      DEFAULT_THEME.accentColor
    );

    settings.accentColor = nextAccentColor;
    syncAppearanceHistoryToSettings();
    settings = await window.readerAPI.saveAppSettings(settings);

    resetAppearanceDraftState();
    applySavedTheme();
    renderAppearanceSection();
  });

  document.getElementById('book-card-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-book-card-option]');
    if (!option) return;

    const value = option.dataset.bookCardOption || 'normal';

    if (value === 'normal') {
      settings.bookCardCoverOnly = false;
      settings.bookCardSquareCorner = false;
    }

    if (value === 'coverOnly') {
      settings.bookCardCoverOnly = !settings.bookCardCoverOnly;
    }

    if (value === 'squareCorner') {
      settings.bookCardSquareCorner = !settings.bookCardSquareCorner;
    }

    settings = await window.readerAPI.saveAppSettings(settings);
    renderAppearanceSection();
  });

  document.getElementById('background-mode-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-background-mode]');
    if (!option) return;

    settings.backgroundMode = normalizeBackgroundMode(option.dataset.backgroundMode);
    settings = await window.readerAPI.saveAppSettings(settings);

    await applySettingsPageBackground();
    renderAppearanceSection();
  });

  document.getElementById('pick-background-image-btn')?.addEventListener('click', async () => {
    const imagePath = await window.readerAPI.pickBackgroundImage();
    if (!imagePath) return;

    settings.backgroundImagePath = imagePath;
    settings.backgroundMode = 'importedImage';
    settings = await window.readerAPI.saveAppSettings(settings);

    await applySettingsPageBackground();
    renderAppearanceSection();
  });

  document.getElementById('background-opacity-range')?.addEventListener('input', async (event) => {
    settings.backgroundOpacity = clampNumber(event.target.value, 0, 100, 20);
    await applySettingsPageBackground();
  });

  document.getElementById('background-opacity-range')?.addEventListener('change', async (event) => {
    settings.backgroundOpacity = clampNumber(event.target.value, 0, 100, 20);
    settings = await window.readerAPI.saveAppSettings(settings);
  });

  document.getElementById('background-blur-range')?.addEventListener('input', async (event) => {
    settings.backgroundBlur = clampNumber(event.target.value, 0, 40, 0);
    await applySettingsPageBackground();
  });

  document.getElementById('background-blur-range')?.addEventListener('change', async (event) => {
    settings.backgroundBlur = clampNumber(event.target.value, 0, 40, 0);
    settings = await window.readerAPI.saveAppSettings(settings);
  });

  bindRangeTooltip(opacityRange, opacityTooltip);
  bindRangeTooltip(blurRange, blurTooltip);
}

// ===== 各區塊渲染：紀錄 =====
/**
 * 渲染「紀錄」區塊
 */
function renderHistorySection() {
  const currentVisibility = settings.readingHistoryVisibility === 'shown'
    ? 'shown'
    : 'hidden';

  const visibleHistoryPaths = libraryHistoryPaths
    .filter((path) => path && path !== currentLibraryPath)
    .slice(0, 3);

  const historyPath1 = visibleHistoryPaths[0] || t('settings.noRecord');
  const historyPath2 = visibleHistoryPaths[1] || t('settings.noRecord');
  const historyPath3 = visibleHistoryPaths[2] || t('settings.noRecord');

  const canOpenHistoryFolder = Boolean(pendingHistoryLibraryPath);
  const canClearHistoryLibraryMeta = Boolean(pendingHistoryLibraryPath);
  const canClearReadingProgress = Boolean(clearReadingProgressChecked);

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">${t('settings.titleHistory')}</h1>

    <div class="settings-group">
      <div class="settings-label">${t('settings.historyLibrary')}</div>

      <div class="settings-block">
  <button
    class="settings-value-button settings-control ${pendingHistoryLibraryPath === visibleHistoryPaths[0] ? 'selected' : ''}"
    id="history-library-path-1"
    type="button"
    ${visibleHistoryPaths[0] ? '' : 'disabled'}
    title="${historyPath1}">
    ${historyPath1}
  </button>
</div>

<div class="settings-block">
  <button
    class="settings-value-button settings-control ${pendingHistoryLibraryPath === visibleHistoryPaths[1] ? 'selected' : ''}"
    id="history-library-path-2"
    type="button"
    ${visibleHistoryPaths[1] ? '' : 'disabled'}
    title="${historyPath2}">
    ${historyPath2}
  </button>
</div>

<div class="settings-block">
  <button
    class="settings-value-button settings-control ${pendingHistoryLibraryPath === visibleHistoryPaths[2] ? 'selected' : ''}"
    id="history-library-path-3"
    type="button"
    ${visibleHistoryPaths[2] ? '' : 'disabled'}
    title="${historyPath3}">
    ${historyPath3}
  </button>
</div>

      <div class="settings-block">
        <button
          id="open-history-library-btn"
          class="settings-action-button settings-control"
          type="button"
          ${canOpenHistoryFolder ? '' : 'disabled'}>
          ${t('settings.openHistoryLibraryFolder')}
        </button>
      </div>
      
      <div class="settings-block">
        <button
        id="clear-history-library-meta-btn"
        class="settings-action-button settings-control danger-button"
        type="button"
        ${canClearHistoryLibraryMeta ? '' : 'disabled'}>
        ${t('settings.clearHistoryLibraryFolder')}
        </button>
      </div>

      <div class="settings-hint">${t('settings.historyLibraryHint')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.recentReading')}</div>

      <div class="settings-check-list" id="reading-history-visibility-options">
        <button class="settings-check-option" data-history-visibility="hidden" type="button">
          <span class="settings-checkbox ${currentVisibility === 'hidden' ? 'checked' : ''}">
            ${currentVisibility === 'hidden' ? '✓' : ''}
          </span>
          <span>${t('settings.readingHistoryHidden')}</span>
        </button>

        <button class="settings-check-option" data-history-visibility="shown" type="button">
          <span class="settings-checkbox ${currentVisibility === 'shown' ? 'checked' : ''}">
            ${currentVisibility === 'shown' ? '✓' : ''}
          </span>
          <span>${t('settings.readingHistoryShown')}</span>
        </button>
      </div>
      <div class="settings-hint">${t('settings.readingHistoryHint')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.readingProgress')}</div>

      <button
        id="clear-reading-progress-check"
        class="settings-check-option"
        type="button">
        <span class="settings-checkbox ${clearReadingProgressChecked ? 'checked' : ''}">
          ${clearReadingProgressChecked ? '✓' : ''}
        </span>
        <span>${t('settings.clearAllReadingProgress')}</span>
      </button>

      <div class="settings-block">
        <button
          id="confirm-clear-reading-progress-btn"
          class="settings-action-button settings-control danger-button"
          type="button"
          ${canClearReadingProgress ? '' : 'disabled'}>
          ${t('settings.confirmClearAllReadingProgress')}
        </button>
      </div>
      <div class="settings-hint">
      ${t('settings.clearReadingProgressHint')}
      </div>
    </div>
  `;

  document.getElementById('reading-history-visibility-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-history-visibility]');
    if (!option) return;

    settings.readingHistoryVisibility =
      option.dataset.historyVisibility === 'shown'
        ? 'shown'
        : 'hidden';

    settings = await window.readerAPI.saveAppSettings(settings);
    renderSection();
  });

  const historyButtons = [
    { id: 'history-library-path-1', path: visibleHistoryPaths[0] || '' },
    { id: 'history-library-path-2', path: visibleHistoryPaths[1] || '' },
    { id: 'history-library-path-3', path: visibleHistoryPaths[2] || '' },
  ];

  historyButtons.forEach(({ id, path }) => {
    document.getElementById(id)?.addEventListener('click', () => {
      if (!path) return;

      pendingHistoryLibraryPath =
        pendingHistoryLibraryPath === path ? '' : path;

      renderSection();
    });
  });

  document.getElementById('open-history-library-btn')?.addEventListener('click', async () => {
    if (!pendingHistoryLibraryPath) return;

    const openedPath = await window.readerAPI.openHistoryLibraryFolder?.(pendingHistoryLibraryPath);
    if (!openedPath) return;

    await applyLibraryChange(openedPath);

    resetHistoryDraftState();
    renderSection();
  });

  document.getElementById('clear-history-library-meta-btn')?.addEventListener('click', async () => {
    if (!pendingHistoryLibraryPath) return;

    const confirmed = await showConfirmDialog({
      title: t('settings.clearHistoryLibrary'),
      message: t('settings.clearHistoryLibraryMessage'),
      detail: pendingHistoryLibraryPath,
      note: t('settings.clearHistoryLibraryNote'),
      confirmText: t('common.confirm'),
      cancelText: t('common.cancel'),
    });

    if (!confirmed) return;

    const result = await window.readerAPI.clearHistoryLibraryMeta?.(pendingHistoryLibraryPath);

    if (!result?.cleared) return;

    libraryHistoryPaths = Array.isArray(result.history)
      ? result.history
      : await window.readerAPI.getLibraryHistory?.() || [];

    pendingHistoryLibraryPath = '';
    renderSection();
  });

  document.getElementById('clear-reading-progress-check')?.addEventListener('click', () => {
    clearReadingProgressChecked = !clearReadingProgressChecked;
    renderSection();
  });

  document.getElementById('confirm-clear-reading-progress-btn')?.addEventListener('click', async () => {
    if (!clearReadingProgressChecked) return;

    await window.readerAPI.clearAllReadingProgress?.();
    await window.readerAPI.clearRecentReading?.();
    clearReadingProgressChecked = false;
    renderSection();
  });
}

// ===== 各區塊渲染：閱讀功能 =====
/**
 * 渲染「閱讀功能細項」區塊
 */
function renderAutoplaySection() {
  const currentContentReadingMode =
    settings.contentReadingMode === 'document'
      ? 'document'
      : 'comic';
  const isDocumentMode = currentContentReadingMode === 'document';
  const CLICK_NEXT_ICON = `<svg class="command-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M468-240q-96-5-162-74t-66-166q0-100 70-170t170-70q97 0 166 66t74 162l-84-25q-13-54-56-88.5T480-640q-66 0-113 47t-47 113q0 57 34.5 100t88.5 56l25 84ZM821-60 650-231 600-80 480-480l400 120-151 50 171 171-79 79Z"/></svg>`;
  const CLICK_PREV_ICON = `<svg class="command-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m492-240 25-84q54-13 88.5-56T640-480q0-66-47-113t-113-47q-57 0-100 34.5T324-517l-84 25q5-96 74-162t166-66q100 0 170 70t70 170q0 97-66 166t-162 74ZM139-60l-79-79 171-171-151-50 400-120L360-80l-50-151L139-60Z"/></svg>`;
  const LEFT_ICON = `<svg class="command-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M400-240 160-480l240-240 56 58-142 142h486v80H314l142 142-56 58Z"/></svg>`;
  const RIGHT_ICON = `<svg class="command-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="m560-240-56-58 142-142H160v-80h486L504-662l56-58 240 240-240 240Z"/></svg>`;
  const UP_ICON = `<svg class="command-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M440-240v-368L296-464l-56-56 240-240 240 240-56 56-144-144v368h-80Z"/></svg>`;
  const DOWN_ICON = `<svg class="command-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M480-240 240-480l56-56 144 144v-368h80v368l144-144 56 56-240 240Z"/></svg>`;
  const BOOKMARK_ICON = `<svg class="command-icon bookmark-command-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960"><path d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Z"/></svg>`;

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">${t('settings.titleReading')}</h1>

    <div class="settings-group">
      <div class="settings-label">${t('settings.readingMode')}</div>

      <div class="settings-check-list" id="content-reading-mode-options">
        <button class="settings-check-option" data-content-reading-mode="document" type="button">
          <span class="settings-checkbox ${currentContentReadingMode === 'document' ? 'checked' : ''}">
            ${currentContentReadingMode === 'document' ? '✓' : ''}
          </span>
          <span>${t('settings.documentMode')}</span>
        </button>

        <button class="settings-check-option" data-content-reading-mode="comic" type="button">
          <span class="settings-checkbox ${currentContentReadingMode === 'comic' ? 'checked' : ''}">
            ${currentContentReadingMode === 'comic' ? '✓' : ''}
          </span>
          <span>${t('settings.comicMode')}</span>
        </button>
      </div>

      <div class="settings-hint">
        ${t('settings.readingModeHint')}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.turnPageCommand')}</div>

      <div class="settings-check-list command-option-list" id="turn-page-command-options">
        <button class="settings-check-option command-option" data-turn-command="none" type="button">
          <span class="settings-checkbox ${settings.pageClickCommand.length === 0 &&
      settings.scrollHoldCommand.length === 0
      ? 'checked'
      : ''
    }">
            ${settings.pageClickCommand.length === 0 &&
      settings.scrollHoldCommand.length === 0
      ? '✓'
      : ''
    }
          </span>
          <span>${t('settings.noExtraCommand')}</span>
        </button>

        <button
          class="settings-check-option command-option ${isDocumentMode ? 'disabled' : ''}"
          data-turn-command="mouseNextPrev"
          type="button"
          ${isDocumentMode ? 'disabled' : ''}>
          <span class="settings-checkbox ${settings.pageClickCommand.includes('cornerNextPrev') ||
      settings.scrollHoldCommand.includes('horizontalScroll')
      ? 'checked'
      : ''
    }">
            ${settings.pageClickCommand.includes('cornerNextPrev') ||
      settings.scrollHoldCommand.includes('horizontalScroll')
      ? '✓'
      : ''
    }
          </span>
          ${CLICK_NEXT_ICON}
          <span>${t('settings.nextPageScrollDown')}</span>
          ${CLICK_PREV_ICON}
          <span>${t('settings.prevPageScrollUp')}</span>
        </button>

        <button class="settings-check-option command-option" data-turn-command="leftNextRightPrev" type="button">
          <span class="settings-checkbox ${settings.pageClickCommand.includes('leftNextRightPrev') ? 'checked' : ''
    }">
            ${settings.pageClickCommand.includes('leftNextRightPrev') ? '✓' : ''}
          </span>
          ${LEFT_ICON}
          <span>${t('settings.nextPage')}</span>
          ${RIGHT_ICON}
          <span>${t('settings.prevPage')}</span>
        </button>

        <button class="settings-check-option command-option" data-turn-command="leftPrevRightNext" type="button">
          <span class="settings-checkbox ${settings.pageClickCommand.includes('leftPrevRightNext') ? 'checked' : ''
    }">
            ${settings.pageClickCommand.includes('leftPrevRightNext') ? '✓' : ''}
          </span>
          ${LEFT_ICON}
          <span>${t('settings.prevPage')}</span>
          ${RIGHT_ICON}
          <span>${t('settings.nextPage')}</span>
        </button>

        <button class="settings-check-option command-option" data-turn-command="upPrevDownNext" type="button">
          <span class="settings-checkbox ${settings.pageClickCommand.includes('upPrevDownNext') ||
      settings.scrollHoldCommand.includes('verticalScroll')
      ? 'checked'
      : ''
    }">
            ${settings.pageClickCommand.includes('upPrevDownNext') ||
      settings.scrollHoldCommand.includes('verticalScroll')
      ? '✓'
      : ''
    }
          </span>
          ${UP_ICON}
          <span>${t('settings.prevPageScrollUp')}</span>
          ${DOWN_ICON}
          <span>${t('settings.nextPageScrollDown')}</span>
        </button>
      </div>

      <div class="settings-hint">${t('settings.turnPageCommandHint')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.bookmarkJump')}</div>

      <div class="settings-check-list command-option-list" id="bookmark-command-options">
        <button class="settings-check-option command-option" data-bookmark-command="leftNextRightPrev" type="button">
          <span class="settings-checkbox ${settings.bookmarkCommand !== 'leftPrevRightNext' ? 'checked' : ''}">
            ${settings.bookmarkCommand !== 'leftPrevRightNext' ? '✓' : ''}
          </span>
          <span class="bookmark-command-left">${BOOKMARK_ICON}</span>
          <span>${t('settings.nextBookmark')}</span>
          <span class="bookmark-command-right">${BOOKMARK_ICON}</span>
          <span>${t('settings.prevBookmark')}</span>
        </button>

        <button class="settings-check-option command-option" data-bookmark-command="leftPrevRightNext" type="button">
          <span class="settings-checkbox ${settings.bookmarkCommand === 'leftPrevRightNext' ? 'checked' : ''}">
            ${settings.bookmarkCommand === 'leftPrevRightNext' ? '✓' : ''}
          </span>
          <span class="bookmark-command-left">${BOOKMARK_ICON}</span>
          <span>${t('settings.prevBookmark')}</span>
          <span class="bookmark-command-right">${BOOKMARK_ICON}</span>
          <span>${t('settings.nextBookmark')}</span>
        </button>
      </div>
      <div class="settings-hint">${t('settings.bookmarkJumpHint')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.autoplayInterval')}</div>
      <div class="settings-row">
        <input
          id="autoplay-seconds-input"
          class="settings-input settings-number-input"
          type="number"
          min="1"
          step="1"
          value="${settings.autoPlaySeconds}"
        >
        <span class="settings-unit">${t('common.seconds')}</span>
      </div>
      <div class="settings-hint">${t('settings.autoplayIntervalHint')}</div>
    </div>
  `;

  document.getElementById('content-reading-mode-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-content-reading-mode]');
    if (!option) return;

    settings.contentReadingMode =
      option.dataset.contentReadingMode === 'document'
        ? 'document'
        : 'comic';

    settings = await window.readerAPI.saveAppSettings(settings);
    renderAutoplaySection();
  });

  document.getElementById('turn-page-command-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-turn-command]');
    if (!option) return;

    const value = option.dataset.turnCommand || 'none';

    if (value === 'none') {
      settings.pageClickCommand = [];
      settings.scrollHoldCommand = [];
    }

    if (value === 'mouseNextPrev') {
      if (settings.contentReadingMode === 'document') return;

      const hasMouseCommand =
        settings.pageClickCommand.includes('cornerNextPrev') ||
        settings.scrollHoldCommand.includes('horizontalScroll');

      if (hasMouseCommand) {
        settings.pageClickCommand = settings.pageClickCommand.filter(
          (item) => item !== 'cornerNextPrev'
        );
        settings.scrollHoldCommand = settings.scrollHoldCommand.filter(
          (item) => item !== 'horizontalScroll'
        );
      } else {
        settings.pageClickCommand = [...settings.pageClickCommand, 'cornerNextPrev'];
        settings.scrollHoldCommand = [...settings.scrollHoldCommand, 'horizontalScroll'];
      }
    }

    if (value === 'leftNextRightPrev' || value === 'leftPrevRightNext') {
      const current = Array.isArray(settings.pageClickCommand)
        ? [...settings.pageClickCommand]
        : [];

      if (current.includes(value)) {
        settings.pageClickCommand = current.filter((item) => item !== value);
      } else {
        settings.pageClickCommand = [
          ...current.filter(
            (item) => item !== 'leftNextRightPrev' && item !== 'leftPrevRightNext'
          ),
          value,
        ];
      }
    }

    if (value === 'upPrevDownNext') {
      const hasUpDownCommand =
        settings.pageClickCommand.includes('upPrevDownNext') ||
        settings.scrollHoldCommand.includes('verticalScroll');

      if (hasUpDownCommand) {
        settings.pageClickCommand = settings.pageClickCommand.filter(
          (item) => item !== 'upPrevDownNext'
        );
        settings.scrollHoldCommand = settings.scrollHoldCommand.filter(
          (item) => item !== 'verticalScroll'
        );
      } else {
        settings.pageClickCommand = [...settings.pageClickCommand, 'upPrevDownNext'];
        settings.scrollHoldCommand = [...settings.scrollHoldCommand, 'verticalScroll'];
      }
    }

    if (settings.contentReadingMode === 'document') {
      settings.pageClickCommand = settings.pageClickCommand.filter(
        (item) => item !== 'cornerNextPrev'
      );
      settings.scrollHoldCommand = settings.scrollHoldCommand.filter(
        (item) => item !== 'horizontalScroll'
      );
    }

    settings = await window.readerAPI.saveAppSettings(settings);
    renderAutoplaySection();
  });

  document.getElementById('bookmark-command-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-bookmark-command]');
    if (!option) return;

    settings.bookmarkCommand =
      option.dataset.bookmarkCommand === 'leftPrevRightNext'
        ? 'leftPrevRightNext'
        : 'leftNextRightPrev';

    settings = await window.readerAPI.saveAppSettings(settings);
    renderAutoplaySection();
  });

  document.getElementById('autoplay-seconds-input')?.addEventListener('input', async (event) => {
    const value = Math.max(1, Number(event.target.value) || 1);
    settings.autoPlaySeconds = value;
    settings = await window.readerAPI.saveAppSettings(settings);
    event.target.value = String(settings.autoPlaySeconds);
  });
}

// ===== 各區塊渲染：系統 =====
/**
 * 渲染「系統」區塊
 */
function renderSystemSection() {
  const effectiveTheme = getEffectiveAppearanceTheme();
  const currentLanguage = getSystemPreviewLanguage();
  applySystemContentLanguage(currentLanguage);

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">${t('settings.titleSystem')}</h1>

    <div class="settings-group">
      <div class="settings-label">${t('settings.systemTheme')}</div>

      <div class="appearance-theme-grid">
        <button
          class="appearance-theme-option ${effectiveTheme === 'light' ? 'selected' : ''}"
          id="system-theme-light-btn"
          type="button">
          <span class="appearance-theme-preview appearance-light-preview">A</span>
          <span>${t('settings.lightTheme')}</span>
        </button>

        <button
          class="appearance-theme-option ${effectiveTheme === 'dark' ? 'selected' : ''}"
          id="system-theme-dark-btn"
          type="button">
          <span class="appearance-theme-preview appearance-dark-preview">A</span>
          <span>${t('settings.darkTheme')}</span>
        </button>
      </div>

      <div class="settings-hint">${t('settings.systemThemeHint')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.preferredLanguage')}</div>

      <div class="system-language-row">
        <select id="preferred-language-select" class="settings-input settings-select">
          <option value="zh-TW" ${currentLanguage === 'zh-TW' ? 'selected' : ''}>繁體中文</option>
          <option value="ja" ${currentLanguage === 'ja' ? 'selected' : ''}>日本語</option>
          <option value="en" ${currentLanguage === 'en' ? 'selected' : ''}>English</option>
        </select>

        <button id="preferred-language-apply-btn" class="settings-action-button system-apply-button" type="button">
          ${t('common.confirm')}
        </button>
      </div>

      <div class="settings-hint">${t('settings.preferredLanguageHint')}</div>
    </div>

    <div class="settings-group">
      <div class="settings-label">${t('settings.softwareInfo')}</div>
      <p class="settings-hint">${t('settings.softwareName')}</p>
      <p class="settings-hint">${t('settings.softwareAuthor')}</p>
      <p class="settings-hint">${t('settings.softwareDescription')}</p>
    </div>
  `;

  bindSystemSectionEvents();
}

/**
 * 綁定「系統」區塊事件
 */
function bindSystemSectionEvents() {
  const languageSelect = document.getElementById('preferred-language-select');

  languageSelect?.addEventListener('change', (event) => {
    const nextLanguage = normalizeLanguage(event.target.value);

    systemLanguageDraft = nextLanguage;
    i18n = createI18n(nextLanguage);

    renderSystemSection();
  });
  document.getElementById('system-theme-light-btn')?.addEventListener('click', async () => {
    settings.appearanceTheme = 'light';
    settings = await window.readerAPI.saveAppSettings(settings);
    resetAppearanceDraftState();
    applySavedTheme();
    renderSystemSection();
  });

  document.getElementById('system-theme-dark-btn')?.addEventListener('click', async () => {
    settings.appearanceTheme = 'dark';
    settings = await window.readerAPI.saveAppSettings(settings);
    resetAppearanceDraftState();
    applySavedTheme();
    renderSystemSection();
  });

  document.getElementById('preferred-language-apply-btn')?.addEventListener('click', async () => {
    const select = document.getElementById('preferred-language-select');
    const nextLanguage = normalizeLanguage(systemLanguageDraft || select?.value);

    settings.language = nextLanguage;
    systemLanguageDraft = '';

    i18n = createI18n(nextLanguage);
    applyDocumentLanguage(nextLanguage);

    settings = await window.readerAPI.saveAppSettings(settings);

    updateSettingsStaticText();
    renderSection();
  });
}

/**
 * 依目前選單渲染右側內容
 */
function renderSection() {
  updateSettingsStaticText();
  renderMenuState();

  if (activeSection !== 'system') {
    clearSystemContentLanguage();
  }

  if (activeSection === 'library') {
    renderLibrarySection();
    return;
  }

  if (activeSection === 'appearance') {
    renderAppearanceSection();
    return;
  }

  if (activeSection === 'history') {
    renderHistorySection();
    return;
  }

  if (activeSection === 'autoplay') {
    renderAutoplaySection();
    return;
  }

  if (activeSection === 'system') {
    renderSystemSection();
    return;
  }

  activeSection = 'library';
  renderLibrarySection();
}

// ===== 初始化資料 =====
/**
 * 載入設定頁初始狀態
 */
async function loadInitialState() {
  const [folderPath, appSettings, historyPaths] = await Promise.all([
    window.readerAPI.getLastLibraryFolder(),
    window.readerAPI.getAppSettings(),
    window.readerAPI.getLibraryHistory?.() || [],
  ]);

  currentLibraryPath = folderPath || '';
  libraryHistoryPaths = Array.isArray(historyPaths) ? historyPaths.slice(0, 3) : [];
  pendingHistoryLibraryPath = '';
  clearReadingProgressChecked = false;

  settings = {
    displayLibraryName: appSettings?.displayLibraryName || '',
    autoPlaySeconds: Math.max(1, Number(appSettings?.autoPlaySeconds) || 5),
    bookSortMode: ['none', 'favorite', 'unread', 'completedLast'].includes(appSettings?.bookSortMode)
      ? appSettings.bookSortMode
      : 'none',
    readingHistoryVisibility: appSettings?.readingHistoryVisibility === 'shown'
      ? 'shown'
      : 'hidden',
    language: normalizeLanguage(appSettings?.language),
    appearanceTheme: appSettings?.appearanceTheme === 'light'
      ? 'light'
      : DEFAULT_THEME.appearanceTheme,
    accentColor: normalizeThemeColor(
      appSettings?.accentColor,
      DEFAULT_THEME.accentColor
    ),
    customColorHistory: Array.isArray(appSettings?.customColorHistory)
      ? appSettings.customColorHistory
        .map((color) => normalizeThemeColor(color, DEFAULT_THEME.accentColor))
        .slice(0, 5)
      : [],
    savedColorHistory: Array.isArray(appSettings?.savedColorHistory)
      ? appSettings.savedColorHistory
        .map((color) => normalizeThemeColor(color, DEFAULT_THEME.accentColor))
        .slice(0, 6)
      : [],
    backgroundMode: normalizeBackgroundMode(appSettings?.backgroundMode),
    backgroundImagePath: appSettings?.backgroundImagePath || '',
    backgroundOpacity: clampNumber(appSettings?.backgroundOpacity, 0, 100, 16),
    backgroundBlur: clampNumber(appSettings?.backgroundBlur, 0, 40, 2),
    contentReadingMode:
      appSettings?.contentReadingMode === 'comic'
        ? 'comic'
        : 'document',
    pageClickCommand: Array.isArray(appSettings?.pageClickCommand)
      ? appSettings.pageClickCommand
      : [],

    scrollHoldCommand: Array.isArray(appSettings?.scrollHoldCommand)
      ? appSettings.scrollHoldCommand
      : [],
    bookmarkCommand:
      appSettings?.bookmarkCommand === 'leftPrevRightNext'
        ? 'leftPrevRightNext'
        : 'leftNextRightPrev',
    bookCardCoverOnly: Boolean(appSettings?.bookCardCoverOnly),
    bookCardSquareCorner: Boolean(appSettings?.bookCardSquareCorner),
  };

  appearanceCustomHistory = [...settings.customColorHistory];
  appearanceSavedColorHistory = [...settings.savedColorHistory];
  i18n = createI18n(settings.language);
  applyDocumentLanguage(settings.language);
}

// ===== 全螢幕工具 =====
/**
 * 按 Esc 時離開全螢幕
 */
async function leaveFullscreenIfNeeded(event) {
  if (event.key !== 'Escape' || !isFullscreen) return;

  event.preventDefault();
  isFullscreen = await window.readerAPI.toggleFullscreen();
  updateFullscreenButton();
}

/**
 * 更新右上角全螢幕按鈕狀態
 */
function updateFullscreenButton() {
  if (!fullscreenBtn) return;

  const label = isFullscreen
    ? t('common.fullscreenExit')
    : t('common.fullscreenEnter');
  fullscreenBtn.title = label;
  fullscreenBtn.setAttribute('aria-label', label);

  if (!fullscreenIconPath) return;

  if (isFullscreen) {
    fullscreenIconPath.setAttribute(
      'd',
      'M240-120v-120H120v-80h200v200h-80Zm400 0v-200h200v80H720v120h-80ZM120-640v-80h120v-120h80v200H120Zm520 0v-200h80v120h120v80H640Z'
    );
  } else {
    fullscreenIconPath.setAttribute(
      'd',
      'M120-120v-200h80v120h120v80H120Zm520 0v-80h120v-120h80v200H640ZM120-640v-200h200v80H200v120h-80Zm640 0v-120H640v-80h200v200h-80Z'
    );
  }
}

// ===== 頁面事件 =====
backBtn?.addEventListener('click', async () => {
  if (activeSection === 'appearance') {
    cancelAppearancePreview();
  }

  if (activeSection === 'history') {
    resetHistoryDraftState();
  }

  if (activeSection === 'system') {
    cancelSystemLanguagePreview();
  }

  await window.readerAPI.openLibraryPage();
});

fullscreenBtn?.addEventListener('click', async () => {
  isFullscreen = await window.readerAPI.toggleFullscreen();
  updateFullscreenButton();
});

settingsMenu?.addEventListener('click', (event) => {
  const button = event.target.closest('.settings-item');
  if (!button) return;

  const nextSection = button.dataset.section || 'library';

  if (activeSection === 'appearance' && nextSection !== 'appearance') {
    cancelAppearancePreview();
  }

  if (activeSection === 'history' && nextSection !== 'history') {
    resetHistoryDraftState();
  }

  if (activeSection === 'system' && nextSection !== 'system') {
    cancelSystemLanguagePreview();
  }

  activeSection = nextSection;
  renderSection();
});

window.addEventListener('keydown', leaveFullscreenIfNeeded);

// ===== 啟動設定頁 =====
/**
 * 初始化設定頁
 */
async function initSettingsPage() {
  try {
    await loadInitialState();
    resetAppearanceDraftState();
    applySavedTheme();
    await applySettingsPageBackground();

    activeSection = 'library';
    updateFullscreenButton();
    renderSection();
  } finally {
    finishBooting();
  }
}

initSettingsPage();


