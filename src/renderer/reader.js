import './reader.css';
import * as pdfjsLib from 'pdfjs-dist';
import { unzipSync } from 'fflate';
import themeModule from './theme';

const {
  DEFAULT_THEME,
  normalizeThemeColor,
  applyReaderTheme,
} = themeModule;

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

// =========================================================
// 取得畫面元素
// =========================================================
const loadingText = document.getElementById('loading-text');
const pdfPages = document.getElementById('pdf-pages');
const backBtn = document.getElementById('back-btn');
const favoriteIconPath = document.getElementById('favorite-icon-path');
const fitIconPath = document.getElementById('fit-icon-path');
const fitIconSvg = document.getElementById('fit-icon-svg');
const modeIconPath = document.getElementById('mode-icon-path');
const autoplayIconPath = document.getElementById('autoplay-icon-path');
const fullscreenIconPath = document.getElementById('fullscreen-icon-path');
const favoriteBtn = document.getElementById('favorite-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const fitToggleBtn = document.getElementById('fit-toggle-btn');
const modeToggleBtn = document.getElementById('mode-toggle-btn');
const autoplayBtn = document.getElementById('autoplay-btn');
const pageIndicator = document.getElementById('page-indicator');
const readerContainer = document.getElementById('reader-container');
const copyPopover = document.createElement('button');
copyPopover.className = 'pdf-copy-popover';
copyPopover.type = 'button';
copyPopover.textContent = 'Copy';
document.body.appendChild(copyPopover);
const HOLD_SCROLL_STEP = 28;
const KEY_SCROLL_STEP = 28;

// =========================================================
// 閱讀器狀態
// =========================================================
let bookType = 'pdf'; // 'pdf' | 'cbz'
let currentFilePath = '';

let readerMode = 'paged'; // 'paged' | 'scroll'
let pageFitMode = 'height'; // 'height' | 'width'
let contentReadingMode = 'document'; // 'document' | 'comic'
let pageClickCommand = [];
let scrollHoldCommand = [];
let holdScrollTimer = null;
let holdScrollDirection = 0;

let currentPage = 1;
let totalPages = 0;

let pdfDoc = null;
let cbzZipEntries = null;
let cbzImageNames = [];

let pageWrappers = [];
let renderedPages = new Set();
let pageObserver = null;

let latestRenderToken = 0;
let isFullscreen = false;
let isFullscreenTransition = false;

// 用來避免 mode / fit / resize 時，scroll 事件反過來干擾 currentPage
let suppressScrollSync = false;

// paged + fit height 時，wheel 需要節流，避免一次翻很多頁
let lastPagedWheelTime = 0;

let isPagedTransitionRunning = false;
let suppressNextScrollPageSync = false;

let pagedFitWidthBoundaryArmed = false;
let pagedFitWidthBoundaryDirection = 0; // 1: 往下, -1: 往上
let pagedFitWidthBoundaryPage = 0;
let lastReaderScrollTop = 0;
let suppressPagedFitWidthScrollArrowTurn = false;

// 儲存閱讀進度用
let readingProgressSaveTimer = null;

// 自動播放
let autoPlayTimer = null;
let isAutoPlaying = false;
let autoPlayIntervalMs = 5000;

// 我的最愛
let currentBookTags = {};
let isPageIndicatorEditing = false;
let pageIndicatorDraftValue = '';

let pointerDownInfo = null;
let keyHoldTimer = null;

const STRICT_DOUBLE_CLICK_MS = 220;
const STRICT_DOUBLE_CLICK_DISTANCE = 8;

let lastStrictClickInfo = null;
let singleClickTimer = null;

// =========================================================
// 簡單記憶體快取
// =========================================================
const pdfCanvasCache = new Map();
const PDF_CACHE_LIMIT = 6;

const PDF_DISPLAY_SCALE_Y = 1.0015;
const PDF_CONTENT_SAMPLE_STEP = 2;
const PDF_CONTENT_ALPHA_THRESHOLD = 12;
const PDF_CONTENT_DIFF_THRESHOLD = 18;

const cbzBlobCache = new Map();
const CBZ_CACHE_LIMIT = 10;
const CBZ_RENDER_SCALE_MULTIPLIER = 1;

// =========================================================
// 共用工具函式
// =========================================================
function safeDecodeURIComponent(value, fallback = '') {
  if (!value) return fallback;

  try {
    return decodeURIComponent(value);
  } catch (error) {
    console.warn('decodeURIComponent 失敗:', value, error);
    return value;
  }
}

function getQueryParams() {
  const params = new URLSearchParams(window.location.search);

  return {
    filePath: safeDecodeURIComponent(params.get('filePath'), ''),
    title: safeDecodeURIComponent(params.get('title'), '未命名書籍'),
    theme:
      params.get('theme') === 'light'
        ? 'light'
        : DEFAULT_THEME.appearanceTheme,
    accent: normalizeThemeColor(
      params.get('accent'),
      DEFAULT_THEME.accentColor
    ),
  };
}

function isSelectablePdfMode() {
  return bookType === 'pdf' && contentReadingMode === 'document';
}

function showLoading(text) {
  if (!loadingText) return;
  loadingText.style.display = 'block';
  loadingText.textContent = text;
}

function hideLoading() {
  if (!loadingText) return;
  loadingText.style.display = 'none';
}

function clearViewer() {
  pdfPages.innerHTML = '';
  pageWrappers = [];
  renderedPages.clear();

  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }
}

function getViewerSize() {
  return {
    width: Math.max(1, readerContainer.clientWidth),
    height: Math.max(1, readerContainer.clientHeight),
  };
}

function clampPage(pageNumber) {
  if (totalPages <= 0) return 1;
  return Math.min(Math.max(pageNumber, 1), totalPages);
}

function queueSaveReadingProgress(delay = 200) {
  if (!currentFilePath) return;
  if (!totalPages) return;

  clearTimeout(readingProgressSaveTimer);
  readingProgressSaveTimer = setTimeout(() => {
    saveReadingProgress();
  }, delay);
}

async function saveReadingProgress() {
  if (!window.readerAPI?.saveReadingProgress) return;
  if (!currentFilePath) return;
  if (!totalPages) return;

  try {
    await window.readerAPI.saveReadingProgress(
      currentFilePath,
      clampPage(currentPage),
      totalPages
    );
  } catch (error) {
    console.error('儲存閱讀進度失敗:', error);
  }
}

async function restoreReadingProgress() {
  if (!window.readerAPI?.getReadingProgress) return;
  if (!currentFilePath) return;
  if (!totalPages) return;

  try {
    const record = await window.readerAPI.getReadingProgress(currentFilePath);
    if (!record) return;

    currentPage = clampPage(Number(record.page) || 1);
  } catch (error) {
    console.error('讀取閱讀進度失敗:', error);
  }
}

function updatePageIndicator() {
  if (!pageIndicator) {
    queueSaveReadingProgress();
    return;
  }

  if (isPageIndicatorEditing) {
    pageIndicator.value = `${pageIndicatorDraftValue} / ${totalPages || 1}`;
  } else {
    pageIndicator.value = `${clampPage(currentPage)} / ${totalPages || 1}`;
  }

  queueSaveReadingProgress();
}

function setPageIndicatorEditing(editing) {
  if (!pageIndicator) return;

  isPageIndicatorEditing = editing;
  pageIndicator.classList.toggle('editing', editing);
  pageIndicator.readOnly = !editing;

  if (editing) {
    pageIndicatorDraftValue = String(clampPage(currentPage));
    pageIndicator.value = `${pageIndicatorDraftValue} / ${totalPages || 1}`;

    requestAnimationFrame(() => {
      pageIndicator.focus();

      const endIndex = pageIndicatorDraftValue.length;
      pageIndicator.setSelectionRange(0, endIndex);
    });

    return;
  }

  pageIndicatorDraftValue = '';
  pageIndicator.value = `${clampPage(currentPage)} / ${totalPages || 1}`;
}

function extractDraftPageNumber(text) {
  const value = String(text || '').trim();
  const match = value.match(/^\s*(\d+)/);
  return match ? match[1] : '';
}

function handlePageIndicatorInput() {
  if (!isPageIndicatorEditing || !pageIndicator) return;

  const draftNumber = extractDraftPageNumber(pageIndicator.value);
  pageIndicatorDraftValue = draftNumber;

  pageIndicator.value = `${draftNumber} / ${totalPages || 1}`;

  const endIndex = draftNumber.length;
  pageIndicator.setSelectionRange(endIndex, endIndex);
}

async function commitPageIndicatorInput() {
  if (!isPageIndicatorEditing || !pageIndicator) return;

  const draftNumber = extractDraftPageNumber(pageIndicator.value);
  const nextPage = Number(draftNumber);

  const isValid =
    draftNumber !== '' &&
    Number.isInteger(nextPage) &&
    nextPage >= 1 &&
    nextPage <= totalPages;

  setPageIndicatorEditing(false);

  if (!isValid) {
    updatePageIndicator();
    return;
  }

  if (nextPage === currentPage) {
    updatePageIndicator();
    return;
  }

  await jumpToPage(nextPage, {
    updateIndicator: true,
    animatePagedTurn: readerMode === 'paged' && pageFitMode === 'width',
    forceInstant: false,
    direction: nextPage > currentPage ? 1 : -1,
  });
}

function cancelPageIndicatorInput() {
  if (!isPageIndicatorEditing) return;
  setPageIndicatorEditing(false);
  updatePageIndicator();
}

function getPageWrapper(pageNumber) {
  return pageWrappers[pageNumber - 1] || null;
}

function getInitialPagesAroundCurrent() {
  const pages = new Set();

  pages.add(clampPage(currentPage));
  if (currentPage - 1 >= 1) pages.add(currentPage - 1);
  if (currentPage + 1 <= totalPages) pages.add(currentPage + 1);

  return [...pages].sort((a, b) => a - b);
}

function setMapWithLimit(map, key, value, limit) {
  map.delete(key);
  map.set(key, value);

  while (map.size > limit) {
    const oldestKey = map.keys().next().value;
    map.delete(oldestKey);
  }
}

function getPdfCacheKey(pageNumber) {
  const { width, height } = getViewerSize();
  const dpr = window.devicePixelRatio || 1;

  return [
    currentFilePath,
    pageNumber,
    pageFitMode,
    width,
    height,
    dpr
  ].join('|');
}

function clearPdfCache() {
  pdfCanvasCache.clear();
}

function clearCbzCache() {
  cbzBlobCache.clear();
}

async function waitForViewerSizeToStabilize(maxChecks = 12) {
  let lastWidth = 0;
  let lastHeight = 0;
  let stableCount = 0;

  for (let i = 0; i < maxChecks; i += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const { width, height } = getViewerSize();

    if (width === lastWidth && height === lastHeight) {
      stableCount += 1;
    } else {
      stableCount = 0;
      lastWidth = width;
      lastHeight = height;
    }

    // 連續兩次一樣，視為穩定
    if (stableCount >= 2) {
      return;
    }
  }
}

function recordPointerDown(event) {
  pointerDownInfo = {
    button: event.button,
    x: event.clientX,
    y: event.clientY,
    time: Date.now(),
  };
}

function isValidClickRelease(event) {
  if (!pointerDownInfo) return false;
  if (pointerDownInfo.button !== event.button) return false;

  const dx = Math.abs(event.clientX - pointerDownInfo.x);
  const dy = Math.abs(event.clientY - pointerDownInfo.y);
  const dt = Date.now() - pointerDownInfo.time;

  return dx <= 6 && dy <= 6 && dt <= 350;
}

function clearPendingSingleClick() {
  clearTimeout(singleClickTimer);
  singleClickTimer = null;
}

function isStrictDoubleClick(event) {
  if (event.button !== 0) return false;

  if (!lastStrictClickInfo) return false;

  const now = Date.now();
  const dt = now - lastStrictClickInfo.time;
  const dx = Math.abs(event.clientX - lastStrictClickInfo.x);
  const dy = Math.abs(event.clientY - lastStrictClickInfo.y);

  return (
    dt <= STRICT_DOUBLE_CLICK_MS &&
    dx <= STRICT_DOUBLE_CLICK_DISTANCE &&
    dy <= STRICT_DOUBLE_CLICK_DISTANCE
  );
}

function rememberStrictClick(event) {
  lastStrictClickInfo = {
    x: event.clientX,
    y: event.clientY,
    time: Date.now(),
  };
}

function shouldIgnoreStrictFullscreenDoubleClick(event) {
  if (event.button !== 0) return true;
  if (event.target.closest?.('.reader-toolbar')) return true;
  if (event.target.closest?.('.pdf-copy-popover')) return true;
  if (event.target.closest?.('.pdf-selectable-layer')) return true;

  return false;
}

function stopKeyHoldPageTurn() {
  clearInterval(keyHoldTimer);
  keyHoldTimer = null;
}

function startKeyHoldPageTurn(direction) {
  if (readerMode !== 'paged') return;
  if (keyHoldTimer) return;

  const turn = async () => {
    if (direction > 0) {
      await nextPage();
    } else {
      await prevPage();
    }
  };

  turn();

  keyHoldTimer = setInterval(turn, 180);
}

// =========================================================
// 我的最愛
// =========================================================
function isFavoriteBook() {
  return Boolean(currentBookTags?.favorite);
}

function updateFavoriteButton() {
  if (!favoriteBtn) return;

  const favorite = isFavoriteBook();
  favoriteBtn.classList.toggle('active', favorite);

  const label = favorite ? '移除我的最愛' : '加入我的最愛';
  favoriteBtn.title = label;
  favoriteBtn.setAttribute('aria-label', label);

  if (!favoriteIconPath) return;

  if (favorite) {
    favoriteIconPath.setAttribute(
      'd',
      'm480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z'
    );
  } else {
    favoriteIconPath.setAttribute(
      'd',
      'M440-501Zm0 381L313-234q-72-65-123.5-116t-85-96q-33.5-45-49-87T40-621q0-94 63-156.5T260-840q52 0 99 22t81 62q34-40 81-62t99-22q81 0 136 45.5T831-680h-85q-18-40-53-60t-73-20q-51 0-88 27.5T463-660h-46q-31-45-70.5-72.5T260-760q-57 0-98.5 39.5T120-621q0 33 14 67t50 78.5q36 44.5 98 104T440-228q26-23 61-53t56-50l9 9 19.5 19.5L605-283l9 9q-22 20-56 49.5T498-172l-58 52Zm280-160v-120H600v-80h120v-120h80v120h120v80H800v120h-80Z'
    );
  }
}

async function loadCurrentBookTags() {
  if (!window.readerAPI?.getBookTags || !currentFilePath) {
    currentBookTags = {};
    updateFavoriteButton();
    return;
  }

  try {
    currentBookTags = await window.readerAPI.getBookTags(currentFilePath) || {};
  } catch (error) {
    console.error('讀取書籍標籤失敗:', error);
    currentBookTags = {};
  }

  updateFavoriteButton();
}

async function toggleFavorite() {
  if (!window.readerAPI?.setBookFavorite || !currentFilePath) return;

  try {
    currentBookTags = await window.readerAPI.setBookFavorite(
      currentFilePath,
      !isFavoriteBook()
    ) || {};

    updateFavoriteButton();
  } catch (error) {
    console.error('更新我的最愛失敗:', error);
  }
}

// =========================================================
// 工具列按鈕狀態
// =========================================================
function updateModeButtons() {
  if (!modeToggleBtn) return;

  const isPaged = readerMode === 'paged';

  modeToggleBtn.classList.toggle('active', !isPaged);
  modeToggleBtn.title = isPaged
    ? '目前為切換頁模式，點擊切換成捲動頁模式'
    : '目前為捲動頁模式，點擊切換成切換頁模式';
  modeToggleBtn.setAttribute(
    'aria-label',
    isPaged
      ? '目前為切換頁模式，點擊切換成捲動頁模式'
      : '目前為捲動頁模式，點擊切換成切換頁模式'
  );

  if (!modeIconPath) return;

  if (isPaged) {
    modeIconPath.setAttribute(
      'd',
      'M260-320q47 0 91.5 10.5T440-278v-394q-41-24-87-36t-93-12q-36 0-71.5 7T120-692v396q35-12 69.5-18t70.5-6Zm260 42q44-21 88.5-31.5T700-320q36 0 70.5 6t69.5 18v-396q-33-14-68.5-21t-71.5-7q-47 0-93 12t-87 36v394Zm-40 118q-48-38-104-59t-116-21q-42 0-82.5 11T100-198q-21 11-40.5-1T40-234v-482q0-11 5.5-21T62-752q46-24 96-36t102-12q58 0 113.5 15T480-740q51-30 106.5-45T700-800q52 0 102 12t96 36q11 5 16.5 15t5.5 21v482q0 23-19.5 35t-40.5 1q-37-20-77.5-31T700-240q-60 0-116 21t-104 59ZM280-494Z'
    );
  } else {
    modeIconPath.setAttribute(
      'd',
      'M240-80q-50 0-85-35t-35-85v-120h120v-560h600v680q0 50-35 85t-85 35H240Zm480-80q17 0 28.5-11.5T760-200v-600H320v480h360v120q0 17 11.5 28.5T720-160ZM360-600v-80h360v80H360Zm0 120v-80h360v80H360Z'
    );
  }
}

function updateFitButtons() {
  if (!fitToggleBtn) return;

  const isFitHeight = pageFitMode === 'height';

  fitToggleBtn.classList.toggle('active', !isFitHeight);
  fitToggleBtn.title = isFitHeight
    ? '目前為 fit height，點擊切換成 fit width'
    : '目前為 fit width，點擊切換成 fit height';
  fitToggleBtn.setAttribute(
    'aria-label',
    isFitHeight
      ? '目前為 fit height，點擊切換成 fit width'
      : '目前為 fit width，點擊切換成 fit height'
  );

  if (fitIconSvg) {
    fitIconSvg.style.transform = isFitHeight ? 'rotate(90deg)' : 'rotate(0deg)';
    fitIconSvg.style.transition = 'transform 0.2s ease';
  }

  if (fitIconPath) {
    fitIconPath.setAttribute(
      'd',
      'M280-280 80-480l200-200 56 56-103 104h494L624-624l56-56 200 200-200 200-56-56 103-104H233l103 104-56 56Z'
    );
  }
}

function updateFullscreenButton() {
  if (!fullscreenBtn || !fullscreenIconPath) return;

  const label = isFullscreen ? '離開全螢幕' : '進入全螢幕';
  fullscreenBtn.title = label;
  fullscreenBtn.setAttribute('aria-label', label);

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

function updateReaderContainerModeClass() {
  readerContainer.classList.remove('paged-fit-height', 'paged-fit-width', 'scroll-mode');

  if (readerMode === 'scroll') {
    readerContainer.classList.add('scroll-mode');
    return;
  }

  if (pageFitMode === 'height') {
    readerContainer.classList.add('paged-fit-height');
  } else {
    readerContainer.classList.add('paged-fit-width');
  }
}

// =========================================================
// 自動播放
// =========================================================
function clearAutoPlayTimer() {
  clearTimeout(autoPlayTimer);
  autoPlayTimer = null;
}

function canUseAutoPlay() {
  return readerMode === 'paged' && pageFitMode === 'height' && totalPages > 0;
}

function updateAutoPlayButton() {
  if (!autoplayBtn) return;

  const canPlay = canUseAutoPlay();

  autoplayBtn.disabled = !canPlay;
  autoplayBtn.classList.toggle('active', isAutoPlaying && canPlay);
  autoplayBtn.title = isAutoPlaying && canPlay
    ? `停止循環播放（${autoPlayIntervalMs / 1000} 秒）`
    : `循環播放（${autoPlayIntervalMs / 1000} 秒）`;

  if (!autoplayIconPath) return;

  if (isAutoPlaying && canPlay) {
    autoplayIconPath.setAttribute(
      'd',
      'M560-200v-560h160v560H560Zm-320 0v-560h160v560H240Z'
    );
  } else {
    autoplayIconPath.setAttribute(
      'd',
      'M320-200v-560l440 280-440 280Z'
    );
  }
}

function stopAutoPlay() {
  clearAutoPlayTimer();
  isAutoPlaying = false;
  updateAutoPlayButton();
}

function scheduleAutoPlayTick() {
  clearAutoPlayTimer();

  if (!isAutoPlaying || !canUseAutoPlay()) {
    updateAutoPlayButton();
    return;
  }

  autoPlayTimer = setTimeout(async () => {
    await nextPage({ wrap: true, triggeredByAutoPlay: true });
    if (isAutoPlaying) {
      scheduleAutoPlayTick();
    }
  }, autoPlayIntervalMs);
}

function startAutoPlay() {
  if (!canUseAutoPlay()) return;

  isAutoPlaying = true;
  updateAutoPlayButton();
  scheduleAutoPlayTick();
}

function toggleAutoPlay() {
  if (isAutoPlaying) {
    stopAutoPlay();
  } else {
    startAutoPlay();
  }
}

function restartAutoPlayTimerIfNeeded(pageChanged, options = {}) {
  if (!isAutoPlaying) return;
  if (!pageChanged) return;
  if (options.triggeredByAutoPlay) return;

  scheduleAutoPlayTick();
}

async function loadReaderSettings() {
  if (!window.readerAPI?.getAppSettings) return;

  try {
    const settings = await window.readerAPI.getAppSettings();

    autoPlayIntervalMs = Math.max(
      1000,
      (Number(settings?.autoPlaySeconds) || 5) * 1000
    );

    contentReadingMode =
      settings?.contentReadingMode === 'comic'
        ? 'comic'
        : 'document';

    pageClickCommand = Array.isArray(settings?.pageClickCommand)
      ? settings.pageClickCommand
      : [];

    scrollHoldCommand = Array.isArray(settings?.scrollHoldCommand)
      ? settings.scrollHoldCommand
      : [];

    applyReaderTheme(document.documentElement, settings);
  } catch (error) {
    console.error('讀取閱讀器設定失敗:', error);
    autoPlayIntervalMs = 5000;
    applyReaderTheme(document.documentElement, {
      appearanceTheme: DEFAULT_THEME.appearanceTheme,
      accentColor: DEFAULT_THEME.accentColor,
    });
  }
}

async function applyNewSettings(settings) {
  const seconds = Math.max(1, Number(settings?.autoPlaySeconds) || 5);
  autoPlayIntervalMs = seconds * 1000;

  const nextContentReadingMode =
    settings?.contentReadingMode === 'comic'
      ? 'comic'
      : 'document';

  const modeChanged = nextContentReadingMode !== contentReadingMode;
  contentReadingMode = nextContentReadingMode;
  pageClickCommand = Array.isArray(settings?.pageClickCommand)
    ? settings.pageClickCommand
    : [];

  scrollHoldCommand = Array.isArray(settings?.scrollHoldCommand)
    ? settings.scrollHoldCommand
    : [];

  applyReaderTheme(document.documentElement, settings);

  if (modeChanged && totalPages > 0) {
    const anchorPage = getCurrentAnchorPage();

    clearPdfCache();
    clearCbzCache();
    pdfTextMapByPage.clear();
    clearCustomPdfSelection();

    await renderDocumentStructure(anchorPage);
  }

  if (isAutoPlaying) {
    stopAutoPlay();
    startAutoPlay();
  }
}

// =========================================================
// currentPage 判定
// =========================================================
function getMostVisiblePageInContainer() {
  if (pageWrappers.length === 0) return clampPage(currentPage);

  const containerRect = readerContainer.getBoundingClientRect();

  let bestPage = clampPage(currentPage);
  let bestVisibleArea = -1;

  for (const wrapper of pageWrappers) {
    const rect = wrapper.getBoundingClientRect();

    const visibleTop = Math.max(rect.top, containerRect.top);
    const visibleBottom = Math.min(rect.bottom, containerRect.bottom);
    const visibleHeight = Math.max(0, visibleBottom - visibleTop);
    const visibleArea = visibleHeight * Math.max(1, rect.width);

    if (visibleArea > bestVisibleArea) {
      bestVisibleArea = visibleArea;
      bestPage = Number(wrapper.dataset.pageNumber) || bestPage;
    }
  }

  return clampPage(bestPage);
}

function getNearestPageFromScrollTop() {
  if (pageWrappers.length === 0) return clampPage(currentPage);

  const scrollTop = readerContainer.scrollTop;

  let bestPage = 1;
  let bestDistance = Infinity;

  for (const wrapper of pageWrappers) {
    const pageNumber = Number(wrapper.dataset.pageNumber) || 1;
    const distance = Math.abs(wrapper.offsetTop - scrollTop);

    if (distance < bestDistance) {
      bestDistance = distance;
      bestPage = pageNumber;
    }
  }

  return clampPage(bestPage);
}

function getCurrentAnchorPage() {
  if (readerMode === 'paged' && pageFitMode === 'height') {
    return getNearestPageFromScrollTop();
  }

  return getMostVisiblePageInContainer();
}

// =========================================================
// DOM 建立
// =========================================================
function createPagePlaceholder(pageNumber) {
  const wrapper = document.createElement('div');
  wrapper.className = 'pdf-page-wrapper';
  wrapper.dataset.pageNumber = String(pageNumber);

  const placeholder = document.createElement('div');
  placeholder.className = 'pdf-page-placeholder';
  placeholder.textContent = '載入中...';

  wrapper.appendChild(placeholder);
  return wrapper;
}

function rebuildPagePlaceholders() {
  clearViewer();

  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const wrapper = createPagePlaceholder(pageNumber);
    pageWrappers.push(wrapper);
    pdfPages.appendChild(wrapper);
  }
}

// =========================================================
// PDF 工具
// =========================================================
async function loadPdfDocument(filePath) {
  if (!filePath) {
    throw new Error('找不到 PDF 路徑');
  }

  const pdfBuffer = await window.readerAPI.readPdfFile(filePath);
  const pdfData = new Uint8Array(pdfBuffer);

  const loadingTask = pdfjsLib.getDocument({ data: pdfData });
  pdfDoc = await loadingTask.promise;
  totalPages = pdfDoc.numPages;
}

function getPdfViewportByFit(page) {
  const baseViewport = page.getViewport({ scale: 1 });
  const { width: viewerWidth, height: viewerHeight } = getViewerSize();

  const scale =
    pageFitMode === 'width'
      ? viewerWidth / baseViewport.width
      : viewerHeight / baseViewport.height;

  return page.getViewport({ scale });
}

async function buildPdfTextMap(page, viewport, pageNumber) {
  const textContent = await page.getTextContent({
    disableCombineTextItems: true,
  });

  const chars = [];
  let lineId = -1;
  let lastY = null;
  let indexInLine = 0;

  textContent.items.forEach((item) => {
    const text = item.str || '';
    if (!text) return;

    const transform = pdfjsLib.Util.transform(
      viewport.transform,
      item.transform
    );

    const x = transform[4];
    const baselineY = transform[5];

    const fontHeight = Math.max(
      4,
      Math.hypot(transform[2], transform[3])
    );

    const itemWidth = Math.max(
      1,
      (item.width || text.length * fontHeight * 0.5) * viewport.scale
    );

    const y = baselineY - fontHeight;
    const normalizedY = Math.round(y / 4) * 4;

    if (lastY === null || Math.abs(normalizedY - lastY) > fontHeight * 0.8) {
      lineId += 1;
      indexInLine = 0;
      lastY = normalizedY;
    }

    const visibleChars = [...text];
    const charWidth = itemWidth / Math.max(visibleChars.length, 1);

    visibleChars.forEach((char, charIndex) => {
      const left = x + charIndex * charWidth;
      const right = left + charWidth;

      chars.push({
        char,
        left,
        right,
        top: y,
        bottom: y + fontHeight,
        lineId,
        indexInLine,
        globalIndex: chars.length,
      });

      indexInLine += 1;
    });
  });

  pdfTextMapByPage.set(pageNumber, chars);
}

function applyCanvasDisplaySize(canvas, pixelWidth, pixelHeight) {
  const { width: viewerWidth, height: viewerHeight } = getViewerSize();

  let displayWidth;
  let displayHeight;

  if (pageFitMode === 'width') {
    displayWidth = viewerWidth;
    displayHeight = (pixelHeight / pixelWidth) * displayWidth;
  } else {
    displayHeight = viewerHeight;
    displayWidth = (pixelWidth / pixelHeight) * displayHeight;
  }

  canvas.style.width = `${displayWidth}px`;
  canvas.style.height = `${displayHeight}px`;
  canvas.style.maxWidth = 'none';
  canvas.style.maxHeight = 'none';
}

function applyPdfDisplayFix(canvas) {
  if (!canvas) return;

  canvas.style.transform = `scaleY(${PDF_DISPLAY_SCALE_Y})`;
  canvas.style.transformOrigin = 'top center';
}

function clearPdfDisplayFix(canvas) {
  if (!canvas) return;

  canvas.style.transform = '';
  canvas.style.transformOrigin = '';
}

function getRgbDiffFromWhite(r, g, b) {
  return 255 - ((r + g + b) / 3);
}

function isContentPixel(r, g, b, a) {
  if (a <= PDF_CONTENT_ALPHA_THRESHOLD) {
    return false;
  }

  return getRgbDiffFromWhite(r, g, b) >= PDF_CONTENT_DIFF_THRESHOLD;
}

function detectCanvasContentBounds(canvas) {
  if (!canvas) return null;

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const width = canvas.width;
  const height = canvas.height;

  if (width <= 0 || height <= 0) return null;

  const imageData = ctx.getImageData(0, 0, width, height);
  const data = imageData.data;
  const step = Math.max(1, PDF_CONTENT_SAMPLE_STEP);

  let top = -1;
  let bottom = -1;
  let left = width;
  let right = -1;

  for (let y = 0; y < height; y += step) {
    let rowHasContent = false;

    for (let x = 0; x < width; x += step) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];

      if (!isContentPixel(r, g, b, a)) continue;

      rowHasContent = true;

      if (top === -1) top = y;
      bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
    }

    if (!rowHasContent) continue;
  }

  if (top === -1 || bottom === -1 || right === -1) {
    return null;
  }

  // 再做一次較細的左右邊界補掃，讓 left/right 更準
  for (let y = top; y <= bottom; y += step) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];

      if (isContentPixel(r, g, b, a)) {
        if (x < left) left = x;
        break;
      }
    }

    for (let x = width - 1; x >= 0; x -= 1) {
      const index = (y * width + x) * 4;
      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const a = data[index + 3];

      if (isContentPixel(r, g, b, a)) {
        if (x > right) right = x;
        break;
      }
    }
  }

  return {
    top,
    bottom,
    left,
    right,
    width,
    height,
    topGap: top,
    bottomGap: Math.max(0, height - 1 - bottom),
    leftGap: left,
    rightGap: Math.max(0, width - 1 - right),
    contentWidth: Math.max(1, right - left + 1),
    contentHeight: Math.max(1, bottom - top + 1),
    contentWidthRatio: Math.max(1, right - left + 1) / width,
    contentHeightRatio: Math.max(1, bottom - top + 1) / height,
  };
}

function shouldApplyPdfBottomFix(bounds) {
  if (!bounds) return false;

  const {
    bottomGap,
    leftGap,
    rightGap,
    contentHeightRatio,
  } = bounds;

  return (
    bottomGap >= 1 &&
    bottomGap <= 2 &&
    contentHeightRatio >= 0.88 &&
    leftGap <= 6 &&
    rightGap <= 6
  );
}

function updateVisibleCanvasDisplaySizes() {
  const canvases = pdfPages.querySelectorAll('.pdf-canvas');

  canvases.forEach((canvas) => {
    applyCanvasDisplaySize(canvas, canvas.width, canvas.height);

    if (
      bookType === 'pdf' &&
      canvas.dataset.pdfNeedsBottomFix === '1'
    ) {
      applyPdfDisplayFix(canvas);
    } else {
      clearPdfDisplayFix(canvas);
    }
  });
}

function cloneCanvas(sourceCanvas) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);

  canvas.dataset.pdfNeedsBottomFix =
    sourceCanvas.dataset.pdfNeedsBottomFix || '0';

  applyCanvasDisplaySize(canvas, canvas.width, canvas.height);

  if (bookType === 'pdf' && canvas.dataset.pdfNeedsBottomFix === '1') {
    applyPdfDisplayFix(canvas);
  } else {
    clearPdfDisplayFix(canvas);
  }

  return canvas;
}

async function buildPdfCanvas(pageNumber) {
  const cacheKey = getPdfCacheKey(pageNumber);
  const cachedCanvas = pdfCanvasCache.get(cacheKey);

  if (cachedCanvas) {
    return cloneCanvas(cachedCanvas);
  }

  const page = await pdfDoc.getPage(pageNumber);
  const viewport = getPdfViewportByFit(page);

  const outputScale = Math.min((window.devicePixelRatio || 1) * 1.2, 2.5);

  const rawCanvas = document.createElement('canvas');
  const rawContext = rawCanvas.getContext('2d');

  rawCanvas.width = Math.round(viewport.width * outputScale);
  rawCanvas.height = Math.round(viewport.height * outputScale);

  await page.render({
    canvasContext: rawContext,
    viewport,
    transform: outputScale !== 1
      ? [outputScale, 0, 0, outputScale, 0, 0]
      : null,
  }).promise;

  rawCanvas.className = 'pdf-canvas';

  const contentBounds = detectCanvasContentBounds(rawCanvas);
  const needsBottomFix = shouldApplyPdfBottomFix(contentBounds);

  rawCanvas.dataset.pdfNeedsBottomFix = needsBottomFix ? '1' : '0';

  applyCanvasDisplaySize(rawCanvas, rawCanvas.width, rawCanvas.height);

  if (needsBottomFix) {
    applyPdfDisplayFix(rawCanvas);
  } else {
    clearPdfDisplayFix(rawCanvas);
  }

  setMapWithLimit(pdfCanvasCache, cacheKey, rawCanvas, PDF_CACHE_LIMIT);

  return cloneCanvas(rawCanvas);
}

async function buildSelectablePdfPage(pageNumber) {
  const page = await pdfDoc.getPage(pageNumber);
  const viewport = getPdfViewportByFit(page);

  const outputScale = Math.min((window.devicePixelRatio || 1) * 1.2, 2.5);

  const pageLayer = document.createElement('div');
  pageLayer.className = 'pdf-selectable-layer';
  pageLayer.dataset.pageNumber = String(pageNumber);
  pageLayer.style.width = `${viewport.width}px`;
  pageLayer.style.height = `${viewport.height}px`;

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = Math.round(viewport.width * outputScale);
  canvas.height = Math.round(viewport.height * outputScale);
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;

  const ctx = canvas.getContext('2d');

  await page.render({
    canvasContext: ctx,
    viewport,
    transform:
      outputScale !== 1
        ? [outputScale, 0, 0, outputScale, 0, 0]
        : null,
  }).promise;

  await buildPdfTextMap(page, viewport, pageNumber);

  const selectionLayer = document.createElement('div');
  selectionLayer.className = 'pdf-selection-layer';

  pageLayer.appendChild(canvas);
  pageLayer.appendChild(selectionLayer);

  pageLayer.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;

    event.preventDefault();

    clearCustomPdfSelection();

    pageLayer.classList.add('selecting');

    customPdfSelection.active = true;
    customPdfSelection.pageNumber = pageNumber;
    customPdfSelection.start = getPointInPageLayer(event, pageLayer);
    customPdfSelection.end = customPdfSelection.start;
    customPdfSelection.chars = [];
  });

  pageLayer.addEventListener('mousemove', (event) => {
    updateCustomPdfSelection(event);
  });

  pageLayer.addEventListener('mouseup', () => {
    customPdfSelection.active = false;
    pageLayer.classList.remove('selecting');
  });

  pageLayer.addEventListener('mouseleave', () => {
    if (!customPdfSelection.active) return;

    customPdfSelection.active = false;
    pageLayer.classList.remove('selecting');
  });

  return pageLayer;
}

let customPdfSelection = {
  active: false,
  pageNumber: 0,
  start: null,
  end: null,
  chars: [],
};

const pdfTextMapByPage = new Map();

function clearCustomPdfSelection() {
  customPdfSelection = {
    active: false,
    pageNumber: 0,
    start: null,
    end: null,
    chars: [],
  };

  pdfPages
    .querySelectorAll('.pdf-selection-rect')
    .forEach((rect) => rect.remove());

  hideCopyPopover();
}

function getPointInPageLayer(event, pageLayer) {
  const rect = pageLayer.getBoundingClientRect();

  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function normalizeSelectionBox(start, end) {
  return {
    left: Math.min(start.x, end.x),
    right: Math.max(start.x, end.x),
    top: Math.min(start.y, end.y),
    bottom: Math.max(start.y, end.y),
  };
}

function charIntersectsBox(charBox, box) {
  return !(
    charBox.right < box.left ||
    charBox.left > box.right ||
    charBox.bottom < box.top ||
    charBox.top > box.bottom
  );
}

function drawCustomPdfSelection(pageLayer, selectedChars) {
  const selectionLayer = pageLayer.querySelector('.pdf-selection-layer');
  if (!selectionLayer) return;

  selectionLayer.innerHTML = '';

  const lineGroups = new Map();

  selectedChars.forEach((charBox) => {
    const key = charBox.lineId;

    if (!lineGroups.has(key)) {
      lineGroups.set(key, {
        left: charBox.left,
        right: charBox.right,
        top: charBox.top,
        bottom: charBox.bottom,
      });
      return;
    }

    const group = lineGroups.get(key);
    group.left = Math.min(group.left, charBox.left);
    group.right = Math.max(group.right, charBox.right);
    group.top = Math.min(group.top, charBox.top);
    group.bottom = Math.max(group.bottom, charBox.bottom);
  });

  lineGroups.forEach((group) => {
    const rect = document.createElement('div');
    rect.className = 'pdf-selection-rect';

    rect.style.left = `${group.left}px`;
    rect.style.top = `${group.top}px`;
    rect.style.width = `${group.right - group.left}px`;
    rect.style.height = `${group.bottom - group.top}px`;

    selectionLayer.appendChild(rect);
  });
}

function findNearestCharIndex(chars, point) {
  if (!chars || chars.length === 0) return -1;

  let bestIndex = -1;
  let bestDistance = Infinity;

  chars.forEach((charBox) => {
    const centerX = (charBox.left + charBox.right) / 2;
    const centerY = (charBox.top + charBox.bottom) / 2;

    const dx = centerX - point.x;
    const dy = centerY - point.y;
    const distance = dx * dx + dy * dy * 6;

    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = charBox.globalIndex;
    }
  });

  return bestIndex;
}

function updateCustomPdfSelection(event) {
  if (!customPdfSelection.active) return;

  const pageLayer = event.target.closest?.('.pdf-selectable-layer');
  if (!pageLayer) return;

  const pageNumber = Number(pageLayer.dataset.pageNumber) || 0;
  if (pageNumber !== customPdfSelection.pageNumber) return;

  const end = getPointInPageLayer(event, pageLayer);
  customPdfSelection.end = end;

  const chars = pdfTextMapByPage.get(pageNumber) || [];

  const startIndex = findNearestCharIndex(chars, customPdfSelection.start);
  const endIndex = findNearestCharIndex(chars, end);

  if (startIndex < 0 || endIndex < 0) return;

  const fromIndex = Math.min(startIndex, endIndex);
  const toIndex = Math.max(startIndex, endIndex);

  const selectedChars = chars.filter((charBox) =>
    charBox.globalIndex >= fromIndex &&
    charBox.globalIndex <= toIndex
  );

  customPdfSelection.chars = selectedChars;
  drawCustomPdfSelection(pageLayer, selectedChars);
  showCopyPopoverNearSelection(pageLayer, selectedChars);
}

function getSelectedPdfText() {
  const chars = customPdfSelection.chars || [];
  if (chars.length === 0) return '';

  const sorted = [...chars].sort((a, b) => {
    if (a.lineId !== b.lineId) return a.lineId - b.lineId;
    return a.indexInLine - b.indexInLine;
  });

  let text = '';
  let lastLineId = sorted[0]?.lineId ?? 0;

  sorted.forEach((charBox, index) => {
    if (index > 0 && charBox.lineId !== lastLineId) {
      text += '\n';
      lastLineId = charBox.lineId;
    }

    text += charBox.char;
  });

  return text;
}

async function copyCustomPdfSelection() {
  const text = getSelectedPdfText();
  if (!text) return;

  await navigator.clipboard.writeText(text);
}

function hideCopyPopover() {
  copyPopover.classList.remove('show', 'copied');
}

function showCopyPopoverNearSelection(pageLayer, selectedChars) {
  if (!pageLayer || !selectedChars || selectedChars.length === 0) {
    hideCopyPopover();
    return;
  }

  const firstChar = selectedChars[0];
  const pageRect = pageLayer.getBoundingClientRect();

  const x = pageRect.left + firstChar.left;
  const y = pageRect.top + firstChar.top;

  copyPopover.textContent = 'Copy';
  copyPopover.classList.remove('copied');
  copyPopover.style.left = `${Math.max(12, x)}px`;
  copyPopover.style.top = `${Math.max(12, y - 42)}px`;
  copyPopover.classList.add('show');
}

async function copyFromPopover() {
  await copyCustomPdfSelection();

  copyPopover.textContent = 'Copied';
  copyPopover.classList.add('copied');

  setTimeout(() => {
    hideCopyPopover();
  }, 700);
}

// =========================================================
// CBZ 工具
// =========================================================
function getSortedCbzImageNames(zipEntries) {
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

  return Object.keys(zipEntries)
    .filter((name) => {
      const lowerName = name.toLowerCase();
      if (lowerName.endsWith('/')) return false;
      return imageExts.some((ext) => lowerName.endsWith(ext));
    })
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

async function loadCbzDocument(filePath) {
  if (!filePath) {
    throw new Error('找不到 CBZ 路徑');
  }

  const cbzBuffer = await window.readerAPI.readCbzFile(filePath);
  const cbzData = new Uint8Array(cbzBuffer);

  cbzZipEntries = unzipSync(cbzData);
  cbzImageNames = getSortedCbzImageNames(cbzZipEntries);

  if (cbzImageNames.length === 0) {
    throw new Error('CBZ 內沒有可用圖片');
  }

  totalPages = cbzImageNames.length;
}

function getCbzPageBlob(pageNumber) {
  const key = `${currentFilePath}|${pageNumber}`;
  const cachedBlob = cbzBlobCache.get(key);

  if (cachedBlob) {
    return cachedBlob;
  }

  const imageName = cbzImageNames[pageNumber - 1];
  const imageData = cbzZipEntries?.[imageName];

  if (!imageData) {
    throw new Error(`找不到 CBZ 第 ${pageNumber} 頁資料`);
  }

  const lowerName = imageName.toLowerCase();

  let mimeType = 'image/jpeg';
  if (lowerName.endsWith('.png')) mimeType = 'image/png';
  else if (lowerName.endsWith('.webp')) mimeType = 'image/webp';
  else if (lowerName.endsWith('.gif')) mimeType = 'image/gif';

  const blob = new Blob([imageData], { type: mimeType });
  setMapWithLimit(cbzBlobCache, key, blob, CBZ_CACHE_LIMIT);

  return blob;
}

async function buildCbzCanvas(pageNumber) {
  const blob = getCbzPageBlob(pageNumber);
  const bitmap = await createImageBitmap(blob);

  const { width: viewerWidth, height: viewerHeight } = getViewerSize();

  const scaleX = viewerWidth / bitmap.width;
  const scaleY = viewerHeight / bitmap.height;

  const scale =
    pageFitMode === 'width'
      ? scaleX
      : Math.min(scaleX, scaleY);

  const targetWidth = Math.max(1, Math.round(bitmap.width * scale));
  const targetHeight = Math.max(1, Math.round(bitmap.height * scale));

  const dpr = window.devicePixelRatio || 1;
  const renderScale = Math.min(dpr * CBZ_RENDER_SCALE_MULTIPLIER, 3);

  const finalPixelWidth = Math.max(1, Math.round(targetWidth * renderScale));
  const finalPixelHeight = Math.max(1, Math.round(targetHeight * renderScale));

  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = finalPixelWidth;
  canvas.height = finalPixelHeight;

  canvas.style.width = `${targetWidth}px`;
  canvas.style.height = `${targetHeight}px`;
  canvas.style.maxWidth = 'none';
  canvas.style.maxHeight = 'none';

  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const shrinkRatio = Math.max(
    bitmap.width / finalPixelWidth,
    bitmap.height / finalPixelHeight
  );

  // 大幅縮圖時，先做一次中間尺寸，再縮到最終尺寸，清晰度通常比一次縮放更好
  if (shrinkRatio > 1.8) {
    const midScale = Math.max(scale * 2, scale);
    const midWidth = Math.max(1, Math.round(bitmap.width * midScale));
    const midHeight = Math.max(1, Math.round(bitmap.height * midScale));

    const midRenderScale = Math.min(dpr * 1.15, 2.5);
    const midPixelWidth = Math.max(1, Math.round(midWidth * midRenderScale));
    const midPixelHeight = Math.max(1, Math.round(midHeight * midRenderScale));

    const midCanvas = document.createElement('canvas');
    midCanvas.width = midPixelWidth;
    midCanvas.height = midPixelHeight;

    const midCtx = midCanvas.getContext('2d');
    midCtx.imageSmoothingEnabled = true;
    midCtx.imageSmoothingQuality = 'high';

    // 第一次：原圖 -> 中間尺寸
    midCtx.drawImage(bitmap, 0, 0, midPixelWidth, midPixelHeight);

    // 第二次：中間尺寸 -> 最終尺寸
    ctx.drawImage(midCanvas, 0, 0, finalPixelWidth, finalPixelHeight);
  } else {
    // 縮放不大時，直接畫即可
    ctx.drawImage(bitmap, 0, 0, finalPixelWidth, finalPixelHeight);
  }

  bitmap.close();
  return canvas;
}

// =========================================================
// 單頁渲染
// =========================================================
async function renderPage(pageNumber) {
  if (pageNumber < 1 || pageNumber > totalPages) return;
  if (renderedPages.has(pageNumber)) return;

  const wrapper = getPageWrapper(pageNumber);
  if (!wrapper) return;

  renderedPages.add(pageNumber);

  try {
    let pageElement = null;

    if (bookType === 'pdf' && contentReadingMode === 'document') {
      pageElement = await buildSelectablePdfPage(pageNumber);
    } else if (bookType === 'pdf') {
      pageElement = await buildPdfCanvas(pageNumber);
    } else {
      pageElement = await buildCbzCanvas(pageNumber);
    }

    const placeholder = wrapper.querySelector('.pdf-page-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    wrapper.appendChild(pageElement);
  } catch (error) {
    console.error(`第 ${pageNumber} 頁渲染失敗:`, error);

    const placeholder = wrapper.querySelector('.pdf-page-placeholder');
    if (placeholder) {
      placeholder.textContent = `第 ${pageNumber} 頁載入失敗`;
    }
  }
}

function setupPageObserver() {
  if (pageObserver) {
    pageObserver.disconnect();
  }

  pageObserver = new IntersectionObserver(
    async (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;

        const wrapper = entry.target;
        const pageNumber = Number(wrapper.dataset.pageNumber) || 1;

        pageObserver.unobserve(wrapper);
        await renderPage(pageNumber);
      }
    },
    {
      root: readerContainer,
      rootMargin: '900px',
      threshold: 0.01,
    }
  );

  pageWrappers.forEach((wrapper) => {
    pageObserver.observe(wrapper);
  });
}

async function primeInitialPages() {
  const pages = getInitialPagesAroundCurrent();

  for (const pageNumber of pages) {
    await renderPage(pageNumber);
  }
}

// =========================================================
// 統一 render 主流程
// =========================================================
async function renderDocumentStructure(anchorPage = currentPage) {
  const renderToken = ++latestRenderToken;

  suppressScrollSync = true;
  setPagesVisibility(true);
  hideLoading();

  rebuildPagePlaceholders();
  setupPageObserver();
  await primeInitialPages();

  if (renderToken !== latestRenderToken) return;

  await jumpToPage(clampPage(anchorPage), {
    updateIndicator: true,
    forceInstant: true,
    animatePagedTurn: false,
  });

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      setPagesVisibility(false);
      suppressScrollSync = false;
    });
  });
}

// =========================================================
// 跳頁 / 翻頁
// =========================================================
function setPagesVisibility(hidden) {
  pdfPages.style.opacity = hidden ? '0' : '1';
  pdfPages.style.pointerEvents = hidden ? 'none' : 'auto';
}

function createPagedTransitionLayer() {
  const layer = document.createElement('div');
  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.pointerEvents = 'none';
  layer.style.overflow = 'hidden';
  layer.style.zIndex = '30';
  layer.style.background = 'transparent';
  return layer;
}

function cloneWrapperForTransition(wrapper, topPx) {
  const clone = wrapper.cloneNode(true);

  clone.style.position = 'absolute';
  clone.style.left = '0';
  clone.style.top = `${topPx}px`;
  clone.style.width = '100%';
  clone.style.margin = '0';
  clone.style.pointerEvents = 'none';
  clone.style.transform = 'translateY(0)';
  clone.style.willChange = 'transform, opacity';

  return clone;
}

async function animatePagedPageTurn(targetPage, options = {}) {
  if (isPagedTransitionRunning) return false;

  const fromPage = clampPage(currentPage);
  const toPage = clampPage(targetPage);

  if (fromPage === toPage) return false;

  const fromWrapper = getPageWrapper(fromPage);
  const toWrapper = getPageWrapper(toPage);

  if (!fromWrapper || !toWrapper) return false;

  if (!renderedPages.has(toPage)) {
    await renderPage(toPage);
  }

  const direction = options.direction || (toPage > fromPage ? 1 : -1);

  const oldScrollTop = readerContainer.scrollTop;
  let newScrollTop = toWrapper.offsetTop;

  // paged fit width 往上翻到前一頁時，應該落在前一頁底部附近
  if (readerMode === 'paged' && pageFitMode === 'width' && direction < 0) {
    newScrollTop = Math.max(
      toWrapper.offsetTop,
      toWrapper.offsetTop + toWrapper.offsetHeight - readerContainer.clientHeight
    );
  }

  const fromTopInViewport = fromWrapper.offsetTop - oldScrollTop;
  const toTopInViewport = toWrapper.offsetTop - newScrollTop;

  const viewportHeight = readerContainer.clientHeight;

  const layer = createPagedTransitionLayer();
  const fromClone = cloneWrapperForTransition(fromWrapper, fromTopInViewport);
  const toClone = cloneWrapperForTransition(toWrapper, toTopInViewport);

  const enterOffset = direction > 0 ? viewportHeight : -viewportHeight;
  const exitOffset = direction > 0 ? -viewportHeight : viewportHeight;

  toClone.style.transform = `translateY(${enterOffset}px)`;

  layer.appendChild(fromClone);
  layer.appendChild(toClone);
  readerContainer.appendChild(layer);

  isPagedTransitionRunning = true;
  suppressScrollSync = true;
  suppressNextScrollPageSync = true;

  // 真正內容先直接跳到目標位置
  readerContainer.scrollTo({
    top: newScrollTop,
    behavior: 'auto',
  });

  currentPage = toPage;
  updatePageIndicator();

  await new Promise((resolve) => {
    requestAnimationFrame(() => {
      fromClone.style.transition = 'transform 180ms ease, opacity 180ms ease';
      toClone.style.transition = 'transform 180ms ease, opacity 180ms ease';

      fromClone.style.transform = `translateY(${exitOffset}px)`;
      fromClone.style.opacity = '0.92';

      toClone.style.transform = 'translateY(0)';
      toClone.style.opacity = '1';

      const cleanup = () => {
        layer.remove();
        suppressScrollSync = false;
        isPagedTransitionRunning = false;
        resolve();
      };

      toClone.addEventListener('transitionend', cleanup, { once: true });

      setTimeout(() => {
        if (isPagedTransitionRunning) {
          layer.remove();
          suppressScrollSync = false;
          isPagedTransitionRunning = false;
          resolve();
        }
      }, 260);
    });
  });

  return true;
}

async function jumpToPage(pageNumber, options = {}) {
  const targetPage = clampPage(pageNumber);
  const targetWrapper = getPageWrapper(targetPage);

  if (!targetWrapper) return false;

  if (!renderedPages.has(targetPage)) {
    await renderPage(targetPage);
  }

  const shouldAnimatePagedTurn =
    options.animatePagedTurn === true &&
    readerMode === 'paged' &&
    !options.forceInstant;

  if (shouldAnimatePagedTurn) {
    return await animatePagedPageTurn(targetPage, {
      direction: options.direction || (targetPage > currentPage ? 1 : -1),
    });
  }

  currentPage = targetPage;

  suppressScrollSync = true;

  readerContainer.scrollTo({
    top: targetWrapper.offsetTop,
    behavior: 'auto',
  });

  if (options.updateIndicator !== false) {
    updatePageIndicator();
  }

  requestAnimationFrame(() => {
    suppressScrollSync = false;
  });

  return true;
}

async function nextPage(options = {}) {
  let targetPage = currentPage + 1;

  if (options.wrap && targetPage > totalPages) {
    targetPage = 1;
  }

  if (targetPage > totalPages || targetPage === currentPage) {
    return false;
  }

  const changed = await jumpToPage(targetPage, {
    updateIndicator: true,
    animatePagedTurn: readerMode === 'paged',
    forceInstant: false,
    direction: 1,
  });

  restartAutoPlayTimerIfNeeded(changed, options);
  return changed;
}

async function prevPage(options = {}) {
  let targetPage = currentPage - 1;

  if (options.wrap && targetPage < 1) {
    targetPage = totalPages;
  }

  if (targetPage < 1 || targetPage === currentPage) {
    return false;
  }

  const changed = await jumpToPage(targetPage, {
    updateIndicator: true,
    animatePagedTurn: readerMode === 'paged',
    forceInstant: false,
    direction: -1,
  });

  restartAutoPlayTimerIfNeeded(changed, options);
  return changed;
}

// =========================================================
// Mode / Fit 切換
// =========================================================
async function setReaderMode(nextMode, force = false) {
  if (!force && readerMode === nextMode) return;
  resetPagedFitWidthBoundaryGuard();

  const anchorPage = getCurrentAnchorPage();
  readerMode = nextMode;
  currentPage = anchorPage;

  if (isAutoPlaying && !canUseAutoPlay()) {
    stopAutoPlay();
  }

  updateReaderContainerModeClass();
  updateModeButtons();
  updateAutoPlayButton();

  await renderDocumentStructure(anchorPage);
}

async function setPageFitMode(nextFitMode, force = false) {
  if (!force && pageFitMode === nextFitMode) return;
  resetPagedFitWidthBoundaryGuard();

  const anchorPage = getCurrentAnchorPage();
  pageFitMode = nextFitMode;
  currentPage = anchorPage;

  if (isAutoPlaying && !canUseAutoPlay()) {
    stopAutoPlay();
  }

  clearPdfCache();
  clearCbzCache();

  updateReaderContainerModeClass();
  updateFitButtons();
  updateAutoPlayButton();

  await renderDocumentStructure(anchorPage);
}

function canTurnPageInPagedFitWidth(deltaY) {
  const wrapper = getPageWrapper(currentPage);
  if (!wrapper) return false;

  const pageTop = wrapper.offsetTop;
  const pageBottom = wrapper.offsetTop + wrapper.offsetHeight;

  const viewTop = readerContainer.scrollTop;
  const viewBottom = viewTop + readerContainer.clientHeight;

  // 比原本提早很多攔截，避免先出現原生 scroll 位移
  const threshold = 80;

  if (deltaY > 0) {
    return viewBottom >= pageBottom - threshold;
  }

  if (deltaY < 0) {
    return viewTop <= pageTop + threshold;
  }

  return false;
}

function resetPagedFitWidthBoundaryGuard() {
  pagedFitWidthBoundaryArmed = false;
  pagedFitWidthBoundaryDirection = 0;
  pagedFitWidthBoundaryPage = 0;
}

function clampScrollWithinCurrentPageInPagedFitWidth() {
  if (readerMode !== 'paged' || pageFitMode !== 'width') return;

  const wrapper = getPageWrapper(currentPage);
  if (!wrapper) return;

  const minTop = wrapper.offsetTop;
  const maxTop = Math.max(
    wrapper.offsetTop,
    wrapper.offsetTop + wrapper.offsetHeight - readerContainer.clientHeight
  );

  const currentTop = readerContainer.scrollTop;
  const clampedTop = Math.min(Math.max(currentTop, minTop), maxTop);

  if (Math.abs(clampedTop - currentTop) > 0.5) {
    suppressScrollSync = true;
    readerContainer.scrollTo({
      top: clampedTop,
      behavior: 'auto',
    });
    requestAnimationFrame(() => {
      suppressScrollSync = false;
    });
  }
}

async function handlePagedFitWidthBoundaryByScroll(delta) {
  if (readerMode !== 'paged' || pageFitMode !== 'width') return false;
  if (isPagedTransitionRunning) return true;
  if (suppressPagedFitWidthScrollArrowTurn) return true;

  const wrapper = getPageWrapper(currentPage);
  if (!wrapper) return false;

  const minTop = wrapper.offsetTop;
  const maxTop = Math.max(
    wrapper.offsetTop,
    wrapper.offsetTop + wrapper.offsetHeight - readerContainer.clientHeight
  );

  const currentTop = readerContainer.scrollTop;
  const direction = delta > 0 ? 1 : delta < 0 ? -1 : 0;

  if (!direction) return false;

  const hitBottom = direction > 0 && currentTop >= maxTop - 0.5;
  const hitTop = direction < 0 && currentTop <= minTop + 0.5;

  if (!hitBottom && !hitTop) {
    resetPagedFitWidthBoundaryGuard();
    return false;
  }

  // 先卡住，不讓它露出前後頁
  suppressPagedFitWidthScrollArrowTurn = true;
  readerContainer.scrollTo({
    top: direction > 0 ? maxTop : minTop,
    behavior: 'auto',
  });

  requestAnimationFrame(() => {
    suppressPagedFitWidthScrollArrowTurn = false;
  });

  const isFirstBoundaryHit =
    !pagedFitWidthBoundaryArmed ||
    pagedFitWidthBoundaryDirection !== direction ||
    pagedFitWidthBoundaryPage !== currentPage;

  if (isFirstBoundaryHit) {
    pagedFitWidthBoundaryArmed = true;
    pagedFitWidthBoundaryDirection = direction;
    pagedFitWidthBoundaryPage = currentPage;
    return true;
  }

  resetPagedFitWidthBoundaryGuard();

  if (direction > 0) {
    await nextPage();
  } else {
    await prevPage();
  }

  return true;
}

// =========================================================
// 全螢幕
// =========================================================
async function toggleFullscreen() {
  if (!window.readerAPI?.toggleFullscreen) return;
  if (isFullscreenTransition) return;

  try {
    isFullscreenTransition = true;

    const anchorPage = getCurrentAnchorPage();

    suppressScrollSync = true;

    isFullscreen = await window.readerAPI.toggleFullscreen();
    document.body.classList.toggle('fullscreen-mode', isFullscreen);
    updateFullscreenButton();

    await waitForViewerSizeToStabilize();

    if (isSelectablePdfMode()) {
      clearPdfCache();
      pdfTextMapByPage.clear();
      clearCustomPdfSelection();
      await renderDocumentStructure(anchorPage);
    } else {
      updateVisibleCanvasDisplaySizes();
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await jumpToPage(anchorPage, {
        updateIndicator: true,
        forceInstant: true,
        animatePagedTurn: false,
      });
    }

    requestAnimationFrame(() => {
      suppressScrollSync = false;
    });
  } catch (error) {
    console.error('切換全螢幕失敗:', error);
  } finally {
    setTimeout(() => {
      isFullscreenTransition = false;
    }, 120);
  }
}

// =========================================================
// 初始化
// =========================================================
async function initReader() {
  const { filePath, title, theme, accent } = getQueryParams();

  applyReaderTheme(document.documentElement, {
    appearanceTheme: theme,
    accentColor: accent,
  });

  if (!filePath) {
    showLoading('找不到檔案路徑');
    return;
  }

  currentFilePath = filePath;
  document.title = `My Reader - ${title}`;

  // 初始化狀態
  bookType = 'pdf';
  readerMode = 'paged';
  pageFitMode = 'height';
  currentPage = 1;
  totalPages = 0;
  lastReaderScrollTop = 0;

  pdfDoc = null;
  cbzZipEntries = null;
  cbzImageNames = [];

  clearPdfCache();
  clearCbzCache();
  clearViewer();

  clearTimeout(readingProgressSaveTimer);
  clearAutoPlayTimer();
  isAutoPlaying = false;

  updateFitButtons();
  updateModeButtons();
  updateFullscreenButton();
  updateAutoPlayButton();
  updatePageIndicator();
  updateFavoriteButton();
  updateReaderContainerModeClass();

  await loadReaderSettings();
  await loadCurrentBookTags();

  try {
    const lowerPath = filePath.toLowerCase();

    if (lowerPath.endsWith('.pdf')) {
      bookType = 'pdf';
      showLoading('正在載入 PDF...');
      await loadPdfDocument(filePath);
    } else if (lowerPath.endsWith('.cbz')) {
      bookType = 'cbz';
      showLoading('正在載入 CBZ...');
      await loadCbzDocument(filePath);
    } else {
      showLoading('不支援的檔案格式');
      return;
    }

    await restoreReadingProgress();

    updateFitButtons();
    updateModeButtons();
    updateAutoPlayButton();
    updatePageIndicator();
    updateReaderContainerModeClass();

    await renderDocumentStructure(currentPage);
    queueSaveReadingProgress(0);
  } catch (error) {
    console.error('initReader 失敗:', error);
    showLoading(`載入失敗：${error.message}`);
  }
}

function stopHoldScroll() {
  clearInterval(holdScrollTimer);
  holdScrollTimer = null;
  holdScrollDirection = 0;
}

function startHoldScroll(direction) {
  if (readerMode !== 'scroll') return;
  if (!Array.isArray(scrollHoldCommand) || scrollHoldCommand.length === 0) return;

  stopHoldScroll();

  holdScrollDirection = direction;

  holdScrollTimer = setInterval(() => {
    readerContainer.scrollBy({
      top: holdScrollDirection * HOLD_SCROLL_STEP,
      behavior: 'auto',
    });
  }, 16);
}

async function handleReaderClickCommand(event) {
  if (readerMode !== 'paged') return;
  if (!Array.isArray(pageClickCommand) || pageClickCommand.length === 0) return;
  if (event.target.closest?.('.reader-toolbar')) return;
  if (event.target.closest?.('.pdf-copy-popover')) return;

  const hasMouseButtonCommand = pageClickCommand.includes('cornerNextPrev');
  if (!hasMouseButtonCommand) return;

  const rect = readerContainer.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  const isLeft = x < rect.width / 2;
  const isRight = !isLeft;
  const isUp = y < rect.height / 2;
  const isDown = !isUp;

  if (pageClickCommand.includes('cornerNextPrev')) {
    if (contentReadingMode === 'document') return;

    if (event.button === 0) {
      await nextPage();
      return;
    }

    if (event.button === 2) {
      await prevPage();
      return;
    }
  }

  if (event.button !== 0) return;

  if (pageClickCommand.includes('leftNextRightPrev')) {
    if (isLeft) await nextPage();
    else await prevPage();
    return;
  }

  if (pageClickCommand.includes('leftPrevRightNext')) {
    if (isLeft) await prevPage();
    else await nextPage();
    return;
  }

  if (pageClickCommand.includes('upPrevDownNext')) {
    if (isUp) await prevPage();
    else await nextPage();
  }
}

function handleReaderHoldCommandStart(event) {
  if (readerMode !== 'scroll') return;
  if (contentReadingMode === 'document') return;
  if (!Array.isArray(scrollHoldCommand) || scrollHoldCommand.length === 0) return;
  if (event.target.closest?.('.reader-toolbar')) return;
  if (event.target.closest?.('.pdf-copy-popover')) return;
  if (event.target.closest?.('.pdf-selectable-layer')) return;

  const rect = readerContainer.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;

  if (scrollHoldCommand.includes('horizontalScroll')) {
    if (event.button === 0) startHoldScroll(1);
    if (event.button === 2) startHoldScroll(-1);
    return;
  }

  if (event.button !== 0) return;

  if (scrollHoldCommand.includes('verticalScroll')) {
    startHoldScroll(y < rect.height / 2 ? -1 : 1);
  }
}

// =========================================================
// 事件
// =========================================================
if (window.readerAPI?.onAppSettingsUpdated) {
  window.readerAPI.onAppSettingsUpdated(async (settings) => {
    await applyNewSettings(settings);
  });
}

if (window.readerAPI?.onBookTagsUpdated) {
  window.readerAPI.onBookTagsUpdated(({ filePath, tags }) => {
    if (filePath !== currentFilePath) return;

    currentBookTags = tags || {};
    updateFavoriteButton();
  });
}

readerContainer.addEventListener('contextmenu', (event) => {
  if (
    readerMode === 'scroll' &&
    Array.isArray(scrollHoldCommand) &&
    scrollHoldCommand.includes('horizontalScroll')
  ) {
    event.preventDefault();
  }
});

copyPopover.addEventListener('click', async (event) => {
  event.stopPropagation();
  await copyFromPopover();
});

document.addEventListener('mousedown', (event) => {
  if (event.target.closest?.('.pdf-copy-popover')) return;
  if (event.target.closest?.('.pdf-selectable-layer')) return;

  clearCustomPdfSelection();
});

backBtn?.addEventListener('click', async () => {
  try {
    await saveReadingProgress();
  } catch (error) {
    console.error('關閉前儲存閱讀進度失敗:', error);
  }

  window.close();
});

favoriteBtn?.addEventListener('click', async () => {
  await toggleFavorite();
});

fullscreenBtn?.addEventListener('click', async () => {
  await toggleFullscreen();
});

fitToggleBtn?.addEventListener('click', async () => {
  const nextMode = pageFitMode === 'height' ? 'width' : 'height';
  await setPageFitMode(nextMode);
});

modeToggleBtn?.addEventListener('click', async () => {
  const nextMode = readerMode === 'paged' ? 'scroll' : 'paged';
  await setReaderMode(nextMode);
});

autoplayBtn?.addEventListener('click', () => {
  if (autoplayBtn.disabled) return;
  toggleAutoPlay();
});

pageIndicator?.addEventListener('click', (event) => {
  event.stopPropagation();

  if (isPageIndicatorEditing) return;
  if (!totalPages) return;

  setPageIndicatorEditing(true);
});

pageIndicator?.addEventListener('input', () => {
  handlePageIndicatorInput();
});

pageIndicator?.addEventListener('keydown', async (event) => {
  if (!isPageIndicatorEditing) return;

  if (event.key === 'Enter') {
    event.preventDefault();
    await commitPageIndicatorInput();
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();
    cancelPageIndicatorInput();
  }
});

pageIndicator?.addEventListener('blur', async () => {
  if (!isPageIndicatorEditing) return;
  await commitPageIndicatorInput();
});

document.addEventListener('keydown', async (event) => {
  if (
    event.ctrlKey &&
    event.key.toLowerCase() === 'c' &&
    contentReadingMode === 'document'
  ) {
    const selectedText = getSelectedPdfText();

    if (selectedText) {
      event.preventDefault();
      await copyCustomPdfSelection();
      return;
    }
  }

  if (isPageIndicatorEditing) return;

  if (event.key === 'Escape' && isFullscreen) {
    await toggleFullscreen();
    return;
  }

  const isArrowOrPageKey =
    event.key === 'ArrowDown' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowRight' ||
    event.key === 'ArrowLeft' ||
    event.key === 'PageDown' ||
    event.key === 'PageUp';

  // 只要是閱讀器內的方向鍵 / PageUp / PageDown，都先禁止瀏覽器原生捲動
  if (isArrowOrPageKey) {
    event.preventDefault();
  }

  const hasUpDownPageCommand =
    Array.isArray(pageClickCommand) &&
    pageClickCommand.includes('upPrevDownNext');

  const hasLeftRightPageCommand =
    Array.isArray(pageClickCommand) &&
    (
      pageClickCommand.includes('leftNextRightPrev') ||
      pageClickCommand.includes('leftPrevRightNext')
    );

  const hasVerticalScrollCommand =
    Array.isArray(scrollHoldCommand) &&
    scrollHoldCommand.includes('verticalScroll');

  const hasHorizontalScrollCommand =
    Array.isArray(scrollHoldCommand) &&
    scrollHoldCommand.includes('horizontalScroll');

  if (event.key === 'ArrowDown') {
    if (readerMode === 'paged') {
      if (!hasUpDownPageCommand) return;
      startKeyHoldPageTurn(1);
      return;
    }

    if (!hasVerticalScrollCommand) return;
    readerContainer.scrollBy({ top: KEY_SCROLL_STEP, behavior: 'auto' });
    return;
  }

  if (event.key === 'ArrowUp') {
    if (readerMode === 'paged') {
      if (!hasUpDownPageCommand) return;
      startKeyHoldPageTurn(-1);
      return;
    }

    if (!hasVerticalScrollCommand) return;
    readerContainer.scrollBy({ top: -KEY_SCROLL_STEP, behavior: 'auto' });
    return;
  }

  if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    if (readerMode === 'paged') {
      if (!hasLeftRightPageCommand) return;

      if (pageClickCommand.includes('leftNextRightPrev')) {
        startKeyHoldPageTurn(-1);
      } else {
        startKeyHoldPageTurn(1);
      }

      return;
    }

    if (event.key === 'ArrowRight') return;

    if (!hasVerticalScrollCommand) return;

    readerContainer.scrollBy({
      top: readerContainer.clientHeight * 0.85,
      behavior: 'auto',
    });
    return;
  }

  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    if (readerMode === 'paged') {
      if (!hasLeftRightPageCommand) return;

      if (pageClickCommand.includes('leftNextRightPrev')) {
        startKeyHoldPageTurn(1);
      } else {
        startKeyHoldPageTurn(-1);
      }

      return;
    }

    if (event.key === 'ArrowLeft') return;

    if (!hasVerticalScrollCommand) return;

    readerContainer.scrollBy({
      top: -readerContainer.clientHeight * 0.85,
      behavior: 'auto',
    });
  }
});

document.addEventListener('keyup', (event) => {
  if (
    event.key === 'ArrowRight' ||
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === 'PageDown' ||
    event.key === 'PageUp'
  ) {
    stopKeyHoldPageTurn();
  }
});

window.addEventListener('blur', () => {
  stopKeyHoldPageTurn();
});

window.addEventListener(
  'wheel',
  async (event) => {
    if (readerMode !== 'paged') return;

    if (isPagedTransitionRunning) {
      event.preventDefault();
      return;
    }

    const now = Date.now();
    const cooldown = 220;

    // paged + fit height：一律切頁
    if (pageFitMode === 'height') {
      event.preventDefault();

      if (now - lastPagedWheelTime < cooldown) {
        return;
      }

      lastPagedWheelTime = now;

      if (event.deltaY > 0) {
        await nextPage();
      } else if (event.deltaY < 0) {
        await prevPage();
      }
      return;
    }

    if (pageFitMode === 'width') {
      const direction = event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0;
      const shouldTurnPage = canTurnPageInPagedFitWidth(event.deltaY);

      // 還沒碰到邊界：正常頁內捲動
      if (!shouldTurnPage) {
        resetPagedFitWidthBoundaryGuard();
        return;
      }

      // 一碰到邊界，就立刻阻止原生 scroll，避免露出前後頁
      event.preventDefault();
      clampScrollWithinCurrentPageInPagedFitWidth();

      // 第一次碰到邊界：只做邊界提示，不翻頁
      const isFirstBoundaryHit =
        !pagedFitWidthBoundaryArmed ||
        pagedFitWidthBoundaryDirection !== direction ||
        pagedFitWidthBoundaryPage !== currentPage;

      if (isFirstBoundaryHit) {
        pagedFitWidthBoundaryArmed = true;
        pagedFitWidthBoundaryDirection = direction;
        pagedFitWidthBoundaryPage = currentPage;
        return;
      }

      // 第二次同方向、同一頁、同邊界，才真的翻頁
      if (now - lastPagedWheelTime < cooldown) {
        return;
      }

      lastPagedWheelTime = now;
      resetPagedFitWidthBoundaryGuard();

      if (direction > 0) {
        await nextPage();
      } else if (direction < 0) {
        await prevPage();
      }

      return;
    }
  },
  { passive: false }
);

readerContainer.addEventListener('scroll', async () => {
  if (suppressScrollSync) {
    lastReaderScrollTop = readerContainer.scrollTop;
    return;
  }

  if (isPagedTransitionRunning) {
    lastReaderScrollTop = readerContainer.scrollTop;
    return;
  }

  const currentTop = readerContainer.scrollTop;
  const delta = currentTop - lastReaderScrollTop;
  lastReaderScrollTop = currentTop;

  if (readerMode === 'paged' && pageFitMode === 'width') {
    clampScrollWithinCurrentPageInPagedFitWidth();

    if (suppressNextScrollPageSync) {
      suppressNextScrollPageSync = false;
      return;
    }

    const handled = await handlePagedFitWidthBoundaryByScroll(delta);
    if (handled) return;
  }

  if (suppressNextScrollPageSync) {
    suppressNextScrollPageSync = false;
    return;
  }

  let nextCurrentPage = currentPage;

  if (readerMode === 'paged' && pageFitMode === 'height') {
    nextCurrentPage = getNearestPageFromScrollTop();
  } else {
    nextCurrentPage = getMostVisiblePageInContainer();
  }

  if (nextCurrentPage !== currentPage) {
    currentPage = nextCurrentPage;
    updatePageIndicator();
  }
});

readerContainer.addEventListener('mousedown', (event) => {
  recordPointerDown(event);
  handleReaderHoldCommandStart(event);
});

readerContainer.addEventListener('mouseup', async (event) => {
  stopHoldScroll();

  if (!isValidClickRelease(event)) return;

  if (!shouldIgnoreStrictFullscreenDoubleClick(event) && isStrictDoubleClick(event)) {
    clearPendingSingleClick();
    lastStrictClickInfo = null;
    await toggleFullscreen();
    return;
  }

  rememberStrictClick(event);

  clearPendingSingleClick();

  singleClickTimer = setTimeout(async () => {
    await handleReaderClickCommand(event);
    singleClickTimer = null;
  }, STRICT_DOUBLE_CLICK_MS);
});

window.addEventListener('mouseup', () => {
  stopHoldScroll();
});

window.addEventListener('mouseleave', () => {
  stopHoldScroll();
});

// resize 時保留目前 anchor page，再整體重建
let resizeTimer = null;
let isHandlingResize = false;

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);

  resizeTimer = setTimeout(async () => {
    if (isHandlingResize) return;
    if (isFullscreenTransition) return;
    if (!totalPages) return;

    isHandlingResize = true;

    try {
      const anchorPage = getCurrentAnchorPage();

      suppressScrollSync = true;

      await waitForViewerSizeToStabilize();

      if (isSelectablePdfMode()) {
        clearPdfCache();
        pdfTextMapByPage.clear();
        clearCustomPdfSelection();
        await renderDocumentStructure(anchorPage);
        return;
      }

      updateVisibleCanvasDisplaySizes();
      await new Promise((resolve) => requestAnimationFrame(resolve));

      // 若目前頁附近有尚未渲染頁，再補 render
      const pagesToEnsure = new Set([
        clampPage(anchorPage),
        clampPage(anchorPage - 1),
        clampPage(anchorPage + 1),
      ]);

      for (const pageNumber of pagesToEnsure) {
        if (pageNumber < 1 || pageNumber > totalPages) continue;

        if (!renderedPages.has(pageNumber)) {
          await renderPage(pageNumber);
        }
      }

      await jumpToPage(anchorPage, {
        updateIndicator: true,
        forceInstant: true,
        animatePagedTurn: false,
      });

      requestAnimationFrame(() => {
        suppressScrollSync = false;
      });
    } catch (error) {
      console.error('resize 處理失敗:', error);
      suppressScrollSync = false;
    } finally {
      isHandlingResize = false;
    }
  }, 120);
});

window.addEventListener('beforeunload', () => {
  clearTimeout(readingProgressSaveTimer);
  clearAutoPlayTimer();

  try {
    saveReadingProgress();
  } catch (error) {
    console.error('beforeunload 儲存閱讀進度失敗:', error);
  }
});

// =========================================================
// 啟動
// =========================================================
initReader();