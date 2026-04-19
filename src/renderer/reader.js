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

// =========================================================
// 閱讀器狀態
// =========================================================
let bookType = 'pdf'; // 'pdf' | 'cbz'
let currentFilePath = '';

let readerMode = 'paged'; // 'paged' | 'scroll'
let pageFitMode = 'height'; // 'height' | 'width'

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

// =========================================================
// 簡單記憶體快取
// =========================================================
const pdfCanvasCache = new Map();
const PDF_CACHE_LIMIT = 6;

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

function applyNewSettings(settings) {
  const seconds = Math.max(1, Number(settings?.autoPlaySeconds) || 5);
  autoPlayIntervalMs = seconds * 1000;

  applyReaderTheme(document.documentElement, settings);

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

function cloneCanvas(sourceCanvas) {
  const canvas = document.createElement('canvas');
  canvas.className = 'pdf-canvas';
  canvas.width = sourceCanvas.width;
  canvas.height = sourceCanvas.height;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(sourceCanvas, 0, 0);

  applyCanvasDisplaySize(canvas, canvas.width, canvas.height);
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

  // 保留你原本的微裁切習慣，只裁上方 1px
  const cropTop = 1;
  const cropRight = 0;
  const cropBottom = 0;
  const cropLeft = 0;

  const finalWidth = rawCanvas.width - cropLeft - cropRight;
  const finalHeight = rawCanvas.height - cropTop - cropBottom;

  const finalCanvas = document.createElement('canvas');
  finalCanvas.className = 'pdf-canvas';
  finalCanvas.width = finalWidth;
  finalCanvas.height = finalHeight;

  const finalContext = finalCanvas.getContext('2d');
  finalContext.drawImage(
    rawCanvas,
    cropLeft,
    cropTop,
    finalWidth,
    finalHeight,
    0,
    0,
    finalWidth,
    finalHeight
  );

  applyCanvasDisplaySize(finalCanvas, finalWidth, finalHeight);

  setMapWithLimit(pdfCanvasCache, cacheKey, finalCanvas, PDF_CACHE_LIMIT);

  return cloneCanvas(finalCanvas);
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
    let canvas = null;

    if (bookType === 'pdf') {
      canvas = await buildPdfCanvas(pageNumber);
    } else {
      canvas = await buildCbzCanvas(pageNumber);
    }

    const placeholder = wrapper.querySelector('.pdf-page-placeholder');
    if (placeholder) {
      placeholder.remove();
    }

    wrapper.appendChild(canvas);
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
  pdfPages.style.visibility = hidden ? 'hidden' : 'visible';
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
    animatePagedTurn: readerMode === 'paged' && pageFitMode === 'width',
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
    animatePagedTurn: readerMode === 'paged' && pageFitMode === 'width',
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

  try {
    isFullscreen = await window.readerAPI.toggleFullscreen();
    document.body.classList.toggle('fullscreen-mode', isFullscreen);
    updateFullscreenButton();

    const anchorPage = getCurrentAnchorPage();
    clearPdfCache();
    clearCbzCache();
    await renderDocumentStructure(anchorPage);
  } catch (error) {
    console.error('切換全螢幕失敗:', error);
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

// =========================================================
// 事件
// =========================================================
if (window.readerAPI?.onAppSettingsUpdated) {
  window.readerAPI.onAppSettingsUpdated((settings) => {
    applyNewSettings(settings);
  });
}

if (window.readerAPI?.onBookTagsUpdated) {
  window.readerAPI.onBookTagsUpdated(({ filePath, tags }) => {
    if (filePath !== currentFilePath) return;

    currentBookTags = tags || {};
    updateFavoriteButton();
  });
}

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
  if (isPageIndicatorEditing) return;

  if (event.key === 'Escape' && isFullscreen) {
    await toggleFullscreen();
    return;
  }

  // PageDown / PageUp / 左右鍵，在 paged mode 都保留翻頁感
  if (readerMode !== 'paged') return;

  if (event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault();
    await nextPage();
  }

  if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
    event.preventDefault();
    await prevPage();
  }
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

readerContainer.addEventListener('dblclick', async (event) => {
  if (event.button !== 0) return;
  await toggleFullscreen();
});

// resize 時保留目前 anchor page，再整體重建
let resizeTimer = null;
let isHandlingResize = false;

window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);

  resizeTimer = setTimeout(async () => {
    if (isHandlingResize) return;
    if (!totalPages) return;

    isHandlingResize = true;

    try {
      const anchorPage = getCurrentAnchorPage();
      clearPdfCache();
      clearCbzCache();
      await renderDocumentStructure(anchorPage);
    } catch (error) {
      console.error('resize 重建失敗:', error);
    } finally {
      isHandlingResize = false;
    }
  }, 160);
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