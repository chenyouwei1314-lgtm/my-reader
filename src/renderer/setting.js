import './setting.css';
import themeModule from './theme';

const {
  DEFAULT_THEME,
  PRESET_THEME_COLORS,
  normalizeThemeColor,
  isLightColor,
  applySettingTheme,
} = themeModule;

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

// ===== 取得畫面元素 =====
const backBtn = document.getElementById('back-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const settingsMenu = document.getElementById('settings-menu');
const settingsContent = document.getElementById('settings-content');
const fullscreenIconPath = document.getElementById('fullscreen-icon-path');

// ===== 設定頁狀態 =====
let currentLibraryPath = '';
let isFullscreen = false;
let activeSection = 'library';
let settings = {
  displayLibraryName: '',
  autoPlaySeconds: 5,
  bookSortMode: 'none',
  readingHistoryVisibility: 'hidden',
  appearanceTheme: DEFAULT_THEME.appearanceTheme,
  accentColor: DEFAULT_THEME.accentColor,
  customColorHistory: [],
  savedColorHistory: [],
};

// ===== 共用工具函式 =====
/**
 * 取得目前書庫顯示名稱
 * 若有自訂名稱，優先顯示自訂名稱
 * 否則顯示完整書庫路徑
 */
function getDisplayLibraryName() {
  const customName = (settings.displayLibraryName || '').trim();
  return customName || currentLibraryPath || '尚未選擇書庫';
}

/**
 * 更新左側選單的 active 狀態
 */
function renderMenuState() {
  const items = settingsMenu?.querySelectorAll('.settings-item') || [];

  items.forEach((item) => {
    item.classList.toggle('active', item.dataset.section === activeSection);
  });
}

// ===== 主題工具 =====
let appearancePreviewTheme = null;
let appearancePreviewAccentColor = null;
let appearanceDraftCustomColor = null;
let appearanceCustomHistory = [];
let appearancePendingAccentColor = null;
let appearanceSavedColorHistory = [];
let appearanceSelectedCustomSlotIndex = -1;
let appearanceSelectedSavedSlotIndex = -1;
let appearanceSelectionSource = 'classic';

function getEffectiveAppearanceTheme() {
  return appearancePreviewTheme || settings.appearanceTheme || DEFAULT_THEME.appearanceTheme;
}

function getEffectiveAccentColor() {
  return normalizeThemeColor(
    appearancePreviewAccentColor || settings.accentColor || DEFAULT_THEME.accentColor,
    DEFAULT_THEME.accentColor
  );
}

function applyThemePreview(themeName, accentColor) {
  applySettingTheme(
    document.documentElement,
    themeName,
    accentColor
  );

  document.body.classList.toggle('light-theme', themeName === 'light');
  document.body.classList.toggle('dark-theme', themeName !== 'light');
}

function applySavedTheme() {
  applyThemePreview(
    settings.appearanceTheme || DEFAULT_THEME.appearanceTheme,
    settings.accentColor || DEFAULT_THEME.accentColor
  );
}

function resetAppearanceDraftState() {
  appearancePreviewTheme = null;
  appearancePreviewAccentColor = null;
  appearanceDraftCustomColor = null;
  appearancePendingAccentColor = null;
  appearanceSelectedCustomSlotIndex = -1;
  appearanceSelectedSavedSlotIndex = -1;
  appearanceSelectionSource = 'classic';
}

function cancelAppearancePreview() {
  resetAppearanceDraftState();
  applySavedTheme();
}

function getAppearanceButtonTextColor(color) {
  return isLightColor(color) ? '#111111' : '#ffffff';
}

function getCurrentAppliedAccentColor() {
  return normalizeThemeColor(
    settings.accentColor,
    DEFAULT_THEME.accentColor
  );
}

function pushCustomColorToHistory(color) {
  const normalized = normalizeThemeColor(color, DEFAULT_THEME.accentColor);

  appearanceCustomHistory = [
    normalized,
    ...appearanceCustomHistory.filter((item) => item !== normalized),
  ].slice(0, 5);
}

function pushColorToSavedHistory(color) {
  const normalized = normalizeThemeColor(color, DEFAULT_THEME.accentColor);

  appearanceSavedColorHistory = [
    normalized,
    ...appearanceSavedColorHistory.filter((item) => item !== normalized),
  ].slice(0, 6);
}

function getSelectedCustomSlotColor() {
  return appearanceCustomHistory[appearanceSelectedCustomSlotIndex] || null;
}

function getCurrentSavedButtonColor() {
  return normalizeThemeColor(
    settings.accentColor,
    DEFAULT_THEME.accentColor
  );
}

function syncAppearanceHistoryToSettings() {
  settings.customColorHistory = [...appearanceCustomHistory];
  settings.savedColorHistory = [...appearanceSavedColorHistory];
}

// ===== 各區塊渲染 =====
/**
 * 渲染「書庫」區塊
 */
function renderLibrarySection() {
  const currentSortMode = ['none', 'favorite', 'unread', 'completedLast'].includes(settings.bookSortMode)
  ? settings.bookSortMode
  : 'none';

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">書庫</h1>

    <div class="settings-group">
      <div class="settings-label">書庫資料夾</div>
      <button id="pick-folder-btn">選取書庫資料夾</button>
      <div class="settings-hint" id="display-library-name-hint">
        從本機選擇欲瀏覽的資料夾並匯入
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-label">書庫名稱</div>
      <input
        id="display-library-name-input"
        class="settings-input"
        type="text"
        maxlength="120"
        placeholder="未填寫時顯示完整路徑"
        value="${settings.displayLibraryName || ''}"
      >
      <div class="settings-hint" id="display-library-name-hint">
        輸入書庫名稱，於書庫左上角顯示：${getDisplayLibraryName()}
      </div>
    </div>

    <div class="settings-group">
      <div class="settings-label">書庫路徑</div>
      <div class="settings-value">${currentLibraryPath || '尚未選擇書庫資料夾'}</div>
      <div class="settings-hint" id="display-library-name-hint">
        未輸入書庫名稱時，於書庫左上角顯示路徑
      </div>
    </div>

        <div class="settings-group">
      <div class="settings-label">書籍排序方式</div>
      <div class="settings-check-list" id="book-sort-options">
        <button class="settings-check-option" data-sort-mode="none" type="button">
          <span class="settings-checkbox ${currentSortMode === 'none' ? 'checked' : ''}">${currentSortMode === 'none' ? '✓' : ''}</span>
          <span>無優先排序的書籍</span>
        </button>

        <button class="settings-check-option" data-sort-mode="favorite" type="button">
          <span class="settings-checkbox ${currentSortMode === 'favorite' ? 'checked' : ''}">${currentSortMode === 'favorite' ? '✓' : ''}</span>
          <span>" 我的最愛 " 書籍優先</span>
        </button>

        <button class="settings-check-option" data-sort-mode="unread" type="button">
          <span class="settings-checkbox ${currentSortMode === 'unread' ? 'checked' : ''}">${currentSortMode === 'unread' ? '✓' : ''}</span>
          <span>未閱讀的書籍優先</span>
        </button>

        <button class="settings-check-option" data-sort-mode="completedLast" type="button">
          <span class="settings-checkbox ${currentSortMode === 'completedLast' ? 'checked' : ''}">${currentSortMode === 'completedLast' ? '✓' : ''}</span>
          <span>已看完的書籍墊後</span>
        </button>
      </div>
      <div class="settings-hint">選擇一般書籍與特定書籍的排序方式</div>
    </div>
  `;

  document.getElementById('pick-folder-btn')?.addEventListener('click', async () => {
    const folderPath = await window.readerAPI.pickLibraryFolder();
    if (!folderPath) return;

    currentLibraryPath = folderPath;
    await window.readerAPI.scanLibrary(folderPath);
    renderSection();
  });

  const input = document.getElementById('display-library-name-input');
  const hint = document.getElementById('display-library-name-hint');

  input?.addEventListener('input', (event) => {
    settings.displayLibraryName = event.target.value;

    if (hint) {
      hint.textContent = `目前書庫左上角顯示：${getDisplayLibraryName()}`;
    }
  });

  input?.addEventListener('change', async (event) => {
    settings.displayLibraryName = event.target.value;
    settings = await window.readerAPI.saveAppSettings(settings);
    renderSection();
  });
  
  document.getElementById('book-sort-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-sort-mode]');
    if (!option) return;

    const selectedMode = option.dataset.sortMode || 'none';

    settings.bookSortMode = selectedMode;
    settings = await window.readerAPI.saveAppSettings(settings);
    renderSection();
  });
}

/**
 * 渲染「個人化介面」區塊
 */
function renderAppearanceSection() {
  const effectiveTheme = getEffectiveAppearanceTheme();
  const effectiveAccentColor = getEffectiveAccentColor();
  const appliedAccentColor = getCurrentAppliedAccentColor();
  const savedButtonColor = getCurrentSavedButtonColor();
  const previewAccentColor = appearancePendingAccentColor || effectiveAccentColor;

  const customSlots = Array.from({ length: 5 }, (_, index) => appearanceCustomHistory[index] || null);
  const savedSlots = Array.from({ length: 6 }, (_, index) => appearanceSavedColorHistory[index] || null);

  const PALETTE_ICON = `
    <svg xmlns="http://www.w3.org/2000/svg" height="24px" viewBox="0 -960 960 960" width="24px" aria-hidden="true">
      <path d="M480-80q-82 0-155-31.5t-127.5-86Q143-252 111.5-325T80-480q0-83 32.5-156t88-127Q256-817 330-848.5T488-880q80 0 151 27.5t124.5 76q53.5 48.5 85 115T880-518q0 115-70 176.5T640-280h-74q-9 0-12.5 5t-3.5 11q0 12 15 34.5t15 51.5q0 50-27.5 74T480-80ZM303-457q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120-160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm200 0q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Zm120 160q17-17 17-43t-17-43q-17-17-43-17t-43 17q-17 17-17 43t17 43q17 17 43 17t43-17Z" fill="currentColor"/>
    </svg>
  `;

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">個人化</h1>

    <div class="settings-group">
      <div class="settings-label">系統主題</div>

      <div class="appearance-theme-grid">
        <button
          class="appearance-theme-option ${effectiveTheme === 'light' ? 'selected' : ''}"
          id="appearance-theme-light-btn"
          type="button">
          <span class="appearance-theme-preview appearance-light-preview">A</span>
          <span>淺色調</span>
        </button>

        <button
          class="appearance-theme-option ${effectiveTheme === 'dark' ? 'selected' : ''}"
          id="appearance-theme-dark-btn"
          type="button">
          <span class="appearance-theme-preview appearance-dark-preview">A</span>
          <span>深色調</span>
        </button>
      </div>
      <div class="settings-hint">
        選擇系統的主題色調
        </div>
    </div>

    <div class="settings-group">
      <div class="settings-label">個人主題</div>

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
        <div class="appearance-row-label">自訂顏色</div>
        <div class="appearance-row-controls appearance-row-controls-fixed">
          <label class="appearance-picker-trigger" for="appearance-color-picker" title="選擇自訂顏色">
            <span class="appearance-picker-icon">${PALETTE_ICON}</span>
          </label>

          ${customSlots.map((color, index) => `
            <button
              class="appearance-custom-history-btn ${color ? 'has-color' : ''} ${appearanceSelectionSource === 'custom' && index === appearanceSelectedCustomSlotIndex ? 'selected' : ''}"
              type="button"
              data-custom-history-index="${index}"
              ${color ? `style="background:${color}; color:${getAppearanceButtonTextColor(color)}; border-color:${color};"` : ''}
              title="${color || '尚未儲存顏色'}">
            </button>
          `).join('')}

          <button
          id="appearance-save-btn"
          class="appearance-save-btn"
          type="button"
          style="background:${savedButtonColor}; color:${getAppearanceButtonTextColor(savedButtonColor)};">
          保存
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
        <div class="appearance-row-label">保存顏色</div>
        <div class="appearance-row-controls appearance-row-controls-fixed">
          ${savedSlots.map((color, index) => `
            <button
            class="appearance-saved-history-btn ${color ? 'has-color' : ''} ${appearanceSelectionSource === 'saved' && index === appearanceSelectedSavedSlotIndex ? 'selected' : ''}"
            type="button"
            data-saved-history-index="${index}"
            ${color ? `style="background:${color}; color:${getAppearanceButtonTextColor(color)}; border-color:${color};"` : ''}
            title="${color || '尚未保存顏色'}">
            </button>
          `).join('')}

          <button
            id="appearance-apply-btn"
            class="appearance-apply-btn"
            type="button"
            style="background:${appliedAccentColor}; color:${getAppearanceButtonTextColor(appliedAccentColor)};">
            套用
          </button>
        </div>
      </div>

      <div class="settings-hint">
        選擇個人主題顏色，可以自訂與保存顏色，須按下「套用」才會生效
      </div>
    </div>
  `;

  const lightBtn = document.getElementById('appearance-theme-light-btn');
  const darkBtn = document.getElementById('appearance-theme-dark-btn');
  const colorButtons = settingsContent.querySelectorAll('[data-accent-color]');
  const customHistoryButtons = settingsContent.querySelectorAll('[data-custom-history-index]');
  const savedHistoryButtons = settingsContent.querySelectorAll('[data-saved-history-index]');
  const colorPicker = document.getElementById('appearance-color-picker');
  const saveBtn = document.getElementById('appearance-save-btn');
  const applyBtn = document.getElementById('appearance-apply-btn');

  lightBtn?.addEventListener('click', async () => {
    settings.appearanceTheme = 'light';
    settings = await window.readerAPI.saveAppSettings(settings);
    resetAppearanceDraftState();
    applySavedTheme();
    renderAppearanceSection();
  });

  darkBtn?.addEventListener('click', async () => {
    settings.appearanceTheme = 'dark';
    settings = await window.readerAPI.saveAppSettings(settings);
    resetAppearanceDraftState();
    applySavedTheme();
    renderAppearanceSection();
  });

  colorButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const color = normalizeThemeColor(button.dataset.accentColor, DEFAULT_THEME.accentColor);
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
    const color = normalizeThemeColor(event.target.value, DEFAULT_THEME.accentColor);
    appearancePreviewAccentColor = color;
    appearancePendingAccentColor = color;
    applyThemePreview(getEffectiveAppearanceTheme(), color);
  });

  colorPicker?.addEventListener('change', async (event) => {
    const color = normalizeThemeColor(event.target.value, DEFAULT_THEME.accentColor);
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
      appearancePendingAccentColor || effectiveAccentColor,
      DEFAULT_THEME.accentColor
    );

    settings.accentColor = nextAccentColor;
    syncAppearanceHistoryToSettings();
    settings = await window.readerAPI.saveAppSettings(settings);

    resetAppearanceDraftState();
    applySavedTheme();
    renderAppearanceSection();
  });
}

function renderHistorySection() {
  const currentVisibility = settings.readingHistoryVisibility === 'shown'
    ? 'shown'
    : 'hidden';

  settingsContent.innerHTML = `
    <h1 class="settings-section-title">紀錄</h1>

    <div class="settings-group">
      <div class="settings-label">瀏覽紀錄介面</div>

      <div class="settings-check-list" id="reading-history-visibility-options">
        <button class="settings-check-option" data-history-visibility="hidden" type="button">
          <span class="settings-checkbox ${currentVisibility === 'hidden' ? 'checked' : ''}">${currentVisibility === 'hidden' ? '✓' : ''}</span>
          <span>不顯示</span>
        </button>

        <button class="settings-check-option" data-history-visibility="shown" type="button">
          <span class="settings-checkbox ${currentVisibility === 'shown' ? 'checked' : ''}">${currentVisibility === 'shown' ? '✓' : ''}</span>
          <span>顯示</span>
        </button>
      </div>
    </div>
  `;

  document.getElementById('reading-history-visibility-options')?.addEventListener('click', async (event) => {
    const option = event.target.closest('[data-history-visibility]');
    if (!option) return;

    const nextValue = option.dataset.historyVisibility === 'shown' ? 'shown' : 'hidden';
    settings.readingHistoryVisibility = nextValue;

    settings = await window.readerAPI.saveAppSettings(settings);
    renderSection();
  });
}

/**
 * 渲染「循環播放」區塊
 */
function renderAutoplaySection() {
  settingsContent.innerHTML = `
    <h1 class="settings-section-title">循環播放</h1>
    <p class="settings-hint">設定閱讀器切換頁模式的循環播放秒數。</p>

    <div class="settings-group">
      <div class="settings-label">循環播放秒數</div>
      <div class="settings-inline">
        <input
          id="autoplay-seconds-input"
          class="settings-input settings-number-input"
          type="number"
          min="1"
          step="1"
          value="${settings.autoPlaySeconds}"
        >
        <span class="settings-unit">秒</span>
      </div>
    </div>
  `;

  document.getElementById('autoplay-seconds-input')?.addEventListener('input', async (event) => {
    const value = Math.max(1, Number(event.target.value) || 1);
    settings.autoPlaySeconds = value;
    settings = await window.readerAPI.saveAppSettings(settings);
    event.target.value = String(settings.autoPlaySeconds);
  });
}

/**
 * 渲染「全螢幕」區塊
 */
function renderFullscreenSection() {
  settingsContent.innerHTML = `
    <h1 class="settings-section-title">全螢幕</h1>
    <p class="settings-hint">書庫頁與設定頁右上角的全螢幕按鈕功能一致。進入全螢幕後，按鍵盤 Esc 可以離開全螢幕。</p>
    <div class="settings-empty">目前這個項目先提供操作說明，之後可再加入更多全螢幕細項。</div>
  `;
}

/**
 * 依目前選中的項目渲染右側內容
 */
function renderSection() {
  renderMenuState();

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

  renderFullscreenSection();
}

// ===== 初始化 =====
/**
 * 載入設定頁初始狀態
 */
async function loadInitialState() {
  const [folderPath, appSettings] = await Promise.all([
    window.readerAPI.getLastLibraryFolder(),
    window.readerAPI.getAppSettings(),
  ]);

  currentLibraryPath = folderPath || '';
  settings = {
    displayLibraryName: appSettings?.displayLibraryName || '',
    autoPlaySeconds: Math.max(1, Number(appSettings?.autoPlaySeconds) || 5),
    bookSortMode: ['none', 'favorite', 'unread', 'completedLast'].includes(appSettings?.bookSortMode)
    ? appSettings.bookSortMode
    : 'none',
    readingHistoryVisibility: appSettings?.readingHistoryVisibility === 'shown'
    ? 'shown'
    : 'hidden',
    appearanceTheme: appSettings?.appearanceTheme === 'light'
    ? 'light'
    : DEFAULT_THEME.appearanceTheme,
    accentColor: normalizeThemeColor(
      appSettings?.accentColor,
      DEFAULT_THEME.accentColor
    ),
    customColorHistory: Array.isArray(appSettings?.customColorHistory)
    ? appSettings.customColorHistory.map((color) => normalizeThemeColor(color, DEFAULT_THEME.accentColor)).slice(0, 5)
    : [],
  savedColorHistory: Array.isArray(appSettings?.savedColorHistory)
    ? appSettings.savedColorHistory.map((color) => normalizeThemeColor(color, DEFAULT_THEME.accentColor)).slice(0, 6)
    : [],
  };
  appearanceCustomHistory = [...settings.customColorHistory];
  appearanceSavedColorHistory = [...settings.savedColorHistory];
}

// ===== 全螢幕工具 =====
/**
 * 按下 Esc 時離開全螢幕
 */
async function leaveFullscreenIfNeeded(event) {
  if (event.key !== 'Escape' || !isFullscreen) return;

  event.preventDefault();
  isFullscreen = await window.readerAPI.toggleFullscreen();
  updateFullscreenButton();
}

/**
 * 更新全螢幕按鈕顯示
 */
function updateFullscreenButton() {
  if (!fullscreenBtn) return;

  const label = isFullscreen ? '離開全螢幕' : '進入全螢幕';
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

// ===== 事件 =====
backBtn?.addEventListener('click', async () => {
  if (activeSection === 'appearance') {
    cancelAppearancePreview();
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

  activeSection = nextSection;
  renderSection();
});

window.addEventListener('keydown', leaveFullscreenIfNeeded);

// ===== 啟動設定頁 =====
async function initSettingsPage() {
  await loadInitialState();
  resetAppearanceDraftState();
  applySavedTheme();
  activeSection = 'library';
  updateFullscreenButton();
  renderSection();
}

initSettingsPage();


