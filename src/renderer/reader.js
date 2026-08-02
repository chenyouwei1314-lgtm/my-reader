import './reader.css';
import * as pdfjsLib from 'pdfjs-dist';
import { unzipSync } from 'fflate';
import themeModule from './theme';
import { createI18n } from './i18n';

const {
  DEFAULT_THEME,
  normalizeThemeColor,
  applyReaderTheme,
} = themeModule;

let i18n = createI18n('en');

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
const favoriteBtn = document.getElementById('favorite-btn');
const fitToggleBtn = document.getElementById('fit-toggle-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const zoomInBtn = document.getElementById('zoom-in-btn');
const modeToggleBtn = document.getElementById('mode-toggle-btn');
const autoplayBtn = document.getElementById('autoplay-btn');
const pageIndicator = document.getElementById('page-indicator');
const readerContainer = document.getElementById('reader-container');
const copyPopover = document.createElement('button');
copyPopover.className = 'pdf-copy-popover';
copyPopover.type = 'button';
copyPopover.textContent = i18n.t('common.copy');
document.body.appendChild(copyPopover);
const HOLD_SCROLL_STEP = 28;
const KEY_SCROLL_STEP = 28;
const backBtnLabel = backBtn?.querySelector('.toolbar-btn-label');

// =========================================================
// 閱讀器狀態
// =========================================================
let bookType = 'pdf'; // 'pdf' | 'cbz'
let currentFilePath = '';

let readerMode = 'paged'; // 'paged' | 'scroll'
let pageFitMode = 'height'; // 'height' | 'width'
let contentReadingMode = 'document'; // 'document' | 'comic'
let zoomProgress = 0;
const ZOOM_STEP = 0.1;
const ZOOM_EPSILON = 0.0001;
let customZoomReturnFitMode = 'height';
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

let bookmarkBtn = null;
let bookmarkIconPath = null;
let pageIndicatorWrap = null;
let prevBookmarkBtn = null;
let nextBookmarkBtn = null;
let bookmarkCommand = 'leftNextRightPrev';
let bookmarkPages = new Set();

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
    console.warn(i18n.t('reader.decodeUriFailed'), value, error);
    return value;
  }
}

function getQueryParams() {
  const params = new URLSearchParams(window.location.search);

  return {
    filePath: safeDecodeURIComponent(params.get('filePath'), ''),
    title: safeDecodeURIComponent(params.get('title'), i18n.t('reader.unnamedBook')),
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

function clampZoomProgress(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}

function isFitHeightZoom() {
  return zoomProgress <= ZOOM_EPSILON;
}

function isFitWidthZoom() {
  return zoomProgress >= 1 - ZOOM_EPSILON;
}

/**
 * 自訂縮放時需要允許頁內捲動，因此採用 width 行為。
 */
function syncPageFitModeWithZoom() {
  pageFitMode = isFitHeightZoom() ? 'height' : 'width';
}

/**
 * 將「佔滿高度」與「佔滿寬度」之間做線性插值。
 *
 * zoomProgress = 0：fit height
 * zoomProgress = 1：fit width
 */
function getInterpolatedViewerScale(contentWidth, contentHeight) {
  const { width: viewerWidth, height: viewerHeight } = getViewerSize();

  const safeWidth = Math.max(1, Number(contentWidth) || 1);
  const safeHeight = Math.max(1, Number(contentHeight) || 1);

  const fitHeightScale = viewerHeight / safeHeight;
  const fitWidthScale = viewerWidth / safeWidth;

  return (
    fitHeightScale +
    (fitWidthScale - fitHeightScale) * zoomProgress
  );
}

/**
 * 判斷目前頁面是 fit width 較大，還是 fit height 較大。
 * 一般直式頁面會回傳 1；橫向頁面可能回傳 -1。
 */
function getZoomEndpointDirection() {
  const wrapper = getPageWrapper(clampPage(currentPage));
  const canvas = wrapper?.querySelector('.pdf-canvas');

  if (!canvas) {
    return 1;
  }

  const pageWidth =
    Number(canvas.width) ||
    Number(canvas.clientWidth) ||
    1;

  const pageHeight =
    Number(canvas.height) ||
    Number(canvas.clientHeight) ||
    1;

  const { width: viewerWidth, height: viewerHeight } = getViewerSize();

  const viewerAspect = viewerWidth / Math.max(1, viewerHeight);
  const pageAspect = pageWidth / Math.max(1, pageHeight);

  // fit width 的實際倍率是否比 fit height 大
  return viewerAspect >= pageAspect ? 1 : -1;
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
    console.error(i18n.t('reader.saveProgressFailed'), error);
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
    console.error(i18n.t('reader.readProgressFailed'), error);
  }
}

function updatePageIndicator() {
  if (!pageIndicator) {
    updateBookmarkButton();
    queueSaveReadingProgress();
    return;
  }

  if (isPageIndicatorEditing) {
    pageIndicator.value = `${pageIndicatorDraftValue} / ${totalPages || 1}`;
  } else {
    pageIndicator.value = `${clampPage(currentPage)} / ${totalPages || 1}`;
  }

  updateBookmarkButton();
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
    zoomProgress.toFixed(3),
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

  const baseLabel = favorite
    ? i18n.t('reader.removeFavorite')
    : i18n.t('reader.addFavorite');

  const label = `${baseLabel} (Shift + F)`;

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
    console.error(i18n.t('reader.readBookTagsFailed'), error);
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
    console.error(i18n.t('reader.updateFavoriteFailed'), error);
  }
}

// =========================================================
// 書籤
// =========================================================
function getBookmarkStorageKey() {
  return `myreader-bookmarks:${currentFilePath}`;
}

function loadBookmarkPages() {
  if (!currentFilePath) {
    bookmarkPages = new Set();
    return;
  }

  try {
    const raw = localStorage.getItem(getBookmarkStorageKey());
    const list = JSON.parse(raw || '[]');

    bookmarkPages = new Set(
      Array.isArray(list)
        ? list
          .map((page) => Number(page))
          .filter((page) => Number.isInteger(page) && page >= 1)
        : []
    );
  } catch (error) {
    console.error(i18n.t('reader.readBookmarksFailed'), error);
    bookmarkPages = new Set();
  }
}

function saveBookmarkPages() {
  if (!currentFilePath) return;

  const list = [...bookmarkPages]
    .filter((page) => Number.isInteger(page) && page >= 1)
    .sort((a, b) => a - b);

  localStorage.setItem(getBookmarkStorageKey(), JSON.stringify(list));
}

function isCurrentPageBookmarked() {
  return bookmarkPages.has(clampPage(currentPage));
}

function updateBookmarkButton() {
  if (!bookmarkBtn || !bookmarkIconPath) return;

  const bookmarked = isCurrentPageBookmarked();

  bookmarkBtn.classList.toggle('active', bookmarked);
  const baseLabel = bookmarked
    ? i18n.t('reader.removeBookmark')
    : i18n.t('reader.addBookmark');

  const label = `${baseLabel} (B)`;

  bookmarkBtn.title = label;
  bookmarkBtn.setAttribute('aria-label', label);

  if (bookmarked) {
    bookmarkIconPath.setAttribute(
      'd',
      'M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Z'
    );
  } else {
    bookmarkIconPath.setAttribute(
      'd',
      'M200-120v-640q0-33 23.5-56.5T280-840h240v80H280v518l200-86 200 86v-278h80v400L480-240 200-120Zm80-640h240-240Zm400 160v-80h-80v-80h80v-80h80v80h80v80h-80v80h-80Z'
    );
  }
}

function toggleCurrentPageBookmark() {
  const page = clampPage(currentPage);

  if (bookmarkPages.has(page)) {
    bookmarkPages.delete(page);
  } else {
    bookmarkPages.add(page);
  }

  saveBookmarkPages();
  updateBookmarkButton();
}

function getSortedBookmarkPages() {
  return [...bookmarkPages]
    .filter((page) => page >= 1 && page <= totalPages)
    .sort((a, b) => a - b);
}

async function jumpToNextBookmark() {
  const pages = getSortedBookmarkPages();
  if (pages.length === 0) return;

  const current = clampPage(currentPage);
  const target = pages.find((page) => page > current) || pages[0];

  await jumpToPage(target, {
    updateIndicator: true,
    animatePagedTurn: readerMode === 'paged',
    forceInstant: false,
    direction: target > current ? 1 : -1,
  });
}

async function jumpToPrevBookmark() {
  const pages = getSortedBookmarkPages();
  if (pages.length === 0) return;

  const current = clampPage(currentPage);
  const reversed = [...pages].reverse();
  const target = reversed.find((page) => page < current) || reversed[0];

  await jumpToPage(target, {
    updateIndicator: true,
    animatePagedTurn: readerMode === 'paged',
    forceInstant: false,
    direction: target > current ? 1 : -1,
  });
}

async function handleBookmarkNav(direction) {
  const leftMeansNext = bookmarkCommand !== 'leftPrevRightNext';

  if (direction === 'left') {
    if (leftMeansNext) await jumpToNextBookmark();
    else await jumpToPrevBookmark();
    return;
  }

  if (leftMeansNext) await jumpToPrevBookmark();
  else await jumpToNextBookmark();
}

function createBookmarkToolbarButton() {
  if (bookmarkBtn || !favoriteBtn) return;

  bookmarkBtn = document.createElement('button');
  bookmarkBtn.id = 'bookmark-btn';
  bookmarkBtn.className = 'toolbar-icon-btn bookmark-toolbar-btn';
  bookmarkBtn.type = 'button';

  bookmarkBtn.innerHTML = `
    <svg class="toolbar-svg icon-bookmark" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true">
      <path id="bookmark-icon-path" fill="currentColor"></path>
    </svg>
  `;

  bookmarkIconPath = bookmarkBtn.querySelector('#bookmark-icon-path');

  favoriteBtn.parentElement?.insertBefore(bookmarkBtn, favoriteBtn.nextSibling);

  bookmarkBtn.addEventListener('click', () => {
    toggleCurrentPageBookmark();
  });

  updateBookmarkButton();
}

function createBookmarkPageIndicatorButtons() {
  if (!pageIndicator || pageIndicatorWrap) return;

  pageIndicatorWrap = document.createElement('div');
  pageIndicatorWrap.className = 'page-indicator-bookmark-wrap';

  prevBookmarkBtn = document.createElement('button');
  prevBookmarkBtn.className = 'page-bookmark-nav-btn page-bookmark-nav-left';
  prevBookmarkBtn.type = 'button';
  prevBookmarkBtn.title = '';

  nextBookmarkBtn = document.createElement('button');
  nextBookmarkBtn.className = 'page-bookmark-nav-btn page-bookmark-nav-right';
  nextBookmarkBtn.type = 'button';
  nextBookmarkBtn.title = '';

  const bookmarkSvg = `
    <svg class="page-bookmark-nav-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 -960 960 960" aria-hidden="true">
      <path fill="currentColor" d="M200-120v-640q0-33 23.5-56.5T280-840h400q33 0 56.5 23.5T760-760v640L480-240 200-120Z"/>
    </svg>
  `;

  prevBookmarkBtn.innerHTML = bookmarkSvg;
  nextBookmarkBtn.innerHTML = bookmarkSvg;

  pageIndicator.parentElement?.insertBefore(pageIndicatorWrap, pageIndicator);
  pageIndicatorWrap.appendChild(prevBookmarkBtn);
  pageIndicatorWrap.appendChild(pageIndicator);
  pageIndicatorWrap.appendChild(nextBookmarkBtn);

  prevBookmarkBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    await handleBookmarkNav('left');
  });

  nextBookmarkBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    await handleBookmarkNav('right');
  });
}

function updateBookmarkNavTitles() {
  if (!prevBookmarkBtn || !nextBookmarkBtn) return;

  const leftMeansNext = bookmarkCommand !== 'leftPrevRightNext';

  const prevLabel = leftMeansNext
    ? i18n.t('reader.nextBookmark')
    : i18n.t('reader.prevBookmark');

  const nextLabel = leftMeansNext
    ? i18n.t('reader.prevBookmark')
    : i18n.t('reader.nextBookmark');

  const leftTitle = `${prevLabel} ( [ )`;
  const rightTitle = `${nextLabel} ( ] )`;

  prevBookmarkBtn.title = leftTitle;
  prevBookmarkBtn.setAttribute('aria-label', leftTitle);

  nextBookmarkBtn.title = rightTitle;
  nextBookmarkBtn.setAttribute('aria-label', rightTitle);
}

function setupBookmarkUi() {
  createBookmarkToolbarButton();
  createBookmarkPageIndicatorButtons();
  updateBookmarkButton();
  updateBookmarkNavTitles();
}

// =========================================================
// 工具列按鈕狀態
// =========================================================
function updateModeButtons() {
  if (!modeToggleBtn) return;

  const isPaged = readerMode === 'paged';

  modeToggleBtn.classList.toggle('active', !isPaged);
  const baseLabel = isPaged
    ? i18n.t('reader.pagedMode')
    : i18n.t('reader.scrollMode');

  const label = `${baseLabel} (M)`;

  modeToggleBtn.title = label;
  modeToggleBtn.setAttribute('aria-label', label);

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

  const isFitHeight = isFitHeightZoom();
  const isFitWidth = isFitWidthZoom();

  fitToggleBtn.classList.toggle(
    'active',
    !isFitHeight && !isFitWidth
  );

  const baseLabel = isFitHeight
    ? i18n.t('reader.fitHeight')
    : isFitWidth
      ? i18n.t('reader.fitWidth')
      : i18n.t('reader.customZoom');

  const label = `${baseLabel} (F)`;

  fitToggleBtn.title = label;
  fitToggleBtn.setAttribute('aria-label', label);

  if (fitIconSvg) {
    const rotation = 90 * (1 - zoomProgress);

    fitIconSvg.style.transform = `rotate(${rotation}deg)`;
    fitIconSvg.style.transition = 'transform 0.2s ease';
  }

  if (fitIconPath) {
    fitIconPath.setAttribute(
      'd',
      'M280-280 80-480l200-200 56 56-103 104h494L624-624l56-56 200 200-200 200-56-56 103-104H233l103 104-56 56Z'
    );
  }
}

function updateZoomButtons() {
  if (!zoomInBtn || !zoomOutBtn) return;

  const endpointDirection = getZoomEndpointDirection();

  const atHeight = isFitHeightZoom();
  const atWidth = isFitWidthZoom();

  /*
   * 一般直式頁面：
   *   放大 → width
   *   縮小 → height
   *
   * 橫向頁面若 height 比 width 大，方向自動反轉。
   */
  zoomInBtn.disabled =
    endpointDirection > 0 ? atWidth : atHeight;

  zoomOutBtn.disabled =
    endpointDirection > 0 ? atHeight : atWidth;

  const zoomInLabel =
    `${i18n.t('reader.zoomIn')} (Ctrl + +)`;

  const zoomOutLabel =
    `${i18n.t('reader.zoomOut')} (Ctrl + - )`;

  zoomInBtn.title = zoomInLabel;
  zoomInBtn.setAttribute('aria-label', zoomInLabel);

  zoomOutBtn.title = zoomOutLabel;
  zoomOutBtn.setAttribute('aria-label', zoomOutLabel);
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

function updateReaderUiText() {
  updateFavoriteButton();
  updateBookmarkButton();
  updateBookmarkNavTitles();
  updateModeButtons();
  updateFitButtons();
  updateZoomButtons();
  updateAutoPlayButton();

  if (!copyPopover.classList.contains('copied')) {
    copyPopover.textContent = i18n.t('common.copy');
  }

  if (backBtn) {
    const label = i18n.t('reader.backToLibrary');
    backBtn.title = label;
    backBtn.setAttribute('aria-label', label);
  }

  if (backBtnLabel) {
    backBtnLabel.textContent = i18n.t('common.back');
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
  const baseLabel = isAutoPlaying && canPlay
    ? i18n.t('reader.pauseAutoplay')
    : i18n.t('reader.autoplayWithSeconds', {
      seconds: autoPlayIntervalMs / 1000,
    });

  const label = `${baseLabel} (P)`;

  autoplayBtn.title = label;
  autoplayBtn.setAttribute('aria-label', label);

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

    i18n = createI18n(settings?.language || 'en');

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
    bookmarkCommand =
      settings?.bookmarkCommand === 'leftPrevRightNext'
        ? 'leftPrevRightNext'
        : 'leftNextRightPrev';

    applyReaderTheme(document.documentElement, settings);
    updateReaderUiText();
  } catch (error) {
    console.error(i18n.t('reader.readSettingsFailed'), error);
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

  i18n = createI18n(settings?.language || 'en');

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
  bookmarkCommand =
    settings?.bookmarkCommand === 'leftPrevRightNext'
      ? 'leftPrevRightNext'
      : 'leftNextRightPrev';

  applyReaderTheme(document.documentElement, settings);
  updateReaderUiText();

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
  placeholder.textContent = i18n.t('common.loading');

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
    throw new Error(i18n.t('reader.pdfPathMissing'));
  }

  const pdfBuffer = await window.readerAPI.readPdfFile(filePath);
  const pdfData = new Uint8Array(pdfBuffer);

  const loadingTask = pdfjsLib.getDocument({ data: pdfData });
  pdfDoc = await loadingTask.promise;
  totalPages = pdfDoc.numPages;
}

function getPdfViewportByFit(page) {
  const baseViewport = page.getViewport({ scale: 1 });

  const scale = getInterpolatedViewerScale(
    baseViewport.width,
    baseViewport.height
  );

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
  const displayScale = getInterpolatedViewerScale(
    pixelWidth,
    pixelHeight
  );

  const displayWidth = pixelWidth * displayScale;
  const displayHeight = pixelHeight * displayScale;

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

  copyPopover.textContent = i18n.t('common.copy');
  copyPopover.classList.remove('copied');
  copyPopover.style.left = `${Math.max(12, x)}px`;
  copyPopover.style.top = `${Math.max(12, y - 42)}px`;
  copyPopover.classList.add('show');
}

async function copyFromPopover() {
  await copyCustomPdfSelection();

  copyPopover.textContent = i18n.t('common.copied');
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
    throw new Error(i18n.t('reader.cbzPathMissing'));
  }

  const cbzBuffer = await window.readerAPI.readCbzFile(filePath);
  const cbzData = new Uint8Array(cbzBuffer);

  cbzZipEntries = unzipSync(cbzData);
  cbzImageNames = getSortedCbzImageNames(cbzZipEntries);

  if (cbzImageNames.length === 0) {
    throw new Error(i18n.t('reader.cbzNoImages'));
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
    throw new Error(i18n.t('reader.cbzPageMissing', {
      page: pageNumber,
    }));
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
    scaleY +
    (scaleX - scaleY) * zoomProgress;

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
    console.error(i18n.t('reader.pageRenderFailed', {
      page: pageNumber,
    }), error);

    const placeholder = wrapper.querySelector('.pdf-page-placeholder');
    if (placeholder) {
      placeholder.textContent = i18n.t('reader.pageLoadFailed', {
        page: pageNumber,
      });
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

  updateZoomButtons();

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
  const toPage = clampPage(targetPage);

  if (toPage === currentPage) return false;

  const toWrapper = getPageWrapper(toPage);
  if (!toWrapper) return false;

  if (!renderedPages.has(toPage)) {
    await renderPage(toPage);
  }

  let newScrollTop = toWrapper.offsetTop;

  if (
    readerMode === 'paged' &&
    pageFitMode === 'width' &&
    options.direction < 0
  ) {
    newScrollTop = Math.max(
      toWrapper.offsetTop,
      toWrapper.offsetTop + toWrapper.offsetHeight - readerContainer.clientHeight
    );
  }

  suppressScrollSync = true;
  suppressNextScrollPageSync = true;

  currentPage = toPage;

  readerContainer.scrollTo({
    top: newScrollTop,
    behavior: 'auto',
  });

  updatePageIndicator();

  requestAnimationFrame(() => {
    suppressScrollSync = false;
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
async function toggleFitMode() {
  const isCustomZoom =
    !isFitHeightZoom() &&
    !isFitWidthZoom();

  // 自訂縮放時，返回進入自訂縮放前的 Fit 狀態
  if (isCustomZoom) {
    await setPageFitMode(customZoomReturnFitMode);
    return;
  }

  // 端點之間切換
  const nextMode = isFitHeightZoom()
    ? 'width'
    : 'height';

  await setPageFitMode(nextMode);
}

async function toggleReaderMode() {
  const nextMode = readerMode === 'paged'
    ? 'scroll'
    : 'paged';

  await setReaderMode(nextMode);
}

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

async function setZoomProgress(nextProgress, force = false) {
  const safeProgress = clampZoomProgress(nextProgress);

  if (
    !force &&
    Math.abs(safeProgress - zoomProgress) <= ZOOM_EPSILON
  ) {
    return;
  }

  const wasFitHeight = isFitHeightZoom();
  const wasFitWidth = isFitWidthZoom();

  const nextIsFitHeight =
    safeProgress <= ZOOM_EPSILON;

  const nextIsFitWidth =
    safeProgress >= 1 - ZOOM_EPSILON;

  const nextIsCustom =
    !nextIsFitHeight && !nextIsFitWidth;

  /*
   * 只有從 fit height / fit width 進入自訂縮放時，
   * 才記錄返回位置。
   *
   * 自訂縮放之間繼續放大或縮小時，不覆蓋紀錄。
   */
  if (nextIsCustom) {
    if (wasFitHeight) {
      customZoomReturnFitMode = 'height';
    } else if (wasFitWidth) {
      customZoomReturnFitMode = 'width';
    }
  }

  resetPagedFitWidthBoundaryGuard();

  const anchorPage = getCurrentAnchorPage();

  zoomProgress = safeProgress;
  syncPageFitModeWithZoom();
  currentPage = anchorPage;

  if (isAutoPlaying && !canUseAutoPlay()) {
    stopAutoPlay();
  }

  clearPdfCache();
  clearCbzCache();

  pdfTextMapByPage.clear();
  clearCustomPdfSelection();

  updateReaderContainerModeClass();
  updateFitButtons();
  updateZoomButtons();
  updateAutoPlayButton();

  await renderDocumentStructure(anchorPage);

  updateZoomButtons();
}

async function changeZoom(direction) {
  const endpointDirection = getZoomEndpointDirection();

  const delta =
    ZOOM_STEP *
    endpointDirection *
    (direction > 0 ? 1 : -1);

  await setZoomProgress(zoomProgress + delta);
}

async function setPageFitMode(nextFitMode, force = false) {
  const nextProgress = nextFitMode === 'width' ? 1 : 0;

  await setZoomProgress(nextProgress, force);
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
    console.error(i18n.t('reader.fullscreenFailed'), error);
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
    showLoading(i18n.t('reader.filePathMissing'));
    return;
  }

  currentFilePath = filePath;
  document.title = `AirWei Reader - ${title}`;

  // 初始化狀態
  bookType = 'pdf';
  readerMode = 'paged';
  pageFitMode = 'height';
  zoomProgress = 0;
  currentPage = 1;
  customZoomReturnFitMode = 'height';
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
  updateZoomButtons();
  updateModeButtons();
  updateAutoPlayButton();
  updatePageIndicator();
  updateFavoriteButton();
  updateReaderContainerModeClass();

  await loadReaderSettings();
  await loadCurrentBookTags();
  loadBookmarkPages();
  setupBookmarkUi();

  try {
    const lowerPath = filePath.toLowerCase();

    if (lowerPath.endsWith('.pdf')) {
      bookType = 'pdf';
      showLoading(i18n.t('reader.loadingPdf'));
      await loadPdfDocument(filePath);
    } else if (lowerPath.endsWith('.cbz')) {
      bookType = 'cbz';
      showLoading(i18n.t('reader.loadingCbz'));
      await loadCbzDocument(filePath);
    } else {
      showLoading(i18n.t('reader.unsupportedFile'));
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
    console.error(i18n.t('reader.initFailed'), error);
    showLoading(`${i18n.t('reader.loadFailed')}: ${error.message}`);
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

    if (window.readerAPI?.saveLastSelectedBook && currentFilePath) {
      await window.readerAPI.saveLastSelectedBook(currentFilePath);
    }
  } catch (error) {
    console.error(i18n.t('reader.returnBeforeSaveFailed'), error);
  }

  if (window.readerAPI?.returnToLibrary) {
    await window.readerAPI.returnToLibrary();
    return;
  }

  window.location.href = './index.html';
});

favoriteBtn?.addEventListener('click', async () => {
  await toggleFavorite();
});

fitToggleBtn?.addEventListener('click', async () => {
  await toggleFitMode();
});

zoomOutBtn?.addEventListener('click', async () => {
  if (zoomOutBtn.disabled) return;
  await changeZoom(-1);
});

zoomInBtn?.addEventListener('click', async () => {
  if (zoomInBtn.disabled) return;
  await changeZoom(1);
});

modeToggleBtn?.addEventListener('click', async () => {
  await toggleReaderMode();
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

  const keyboardTarget = event.target;

  const isTypingElement =
    (
      keyboardTarget instanceof HTMLInputElement &&
      !keyboardTarget.readOnly &&
      !keyboardTarget.disabled
    ) ||
    (
      keyboardTarget instanceof HTMLTextAreaElement &&
      !keyboardTarget.readOnly &&
      !keyboardTarget.disabled
    ) ||
    keyboardTarget instanceof HTMLSelectElement ||
    keyboardTarget?.isContentEditable;

  // =========================================================
  // 全螢幕：Space
  // =========================================================
  if (
    event.code === 'Space' &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !isTypingElement
  ) {
    event.preventDefault();

    if (event.repeat) return;

    await toggleFullscreen();
    return;
  }

  // Esc 離開全螢幕
  if (event.key === 'Escape' && isFullscreen) {
    await toggleFullscreen();
    return;
  }

  // 輸入框正在使用時，不觸發其他閱讀快捷鍵
  if (isTypingElement) return;

  // =========================================================
  // 縮放：Ctrl + / Ctrl -
  // =========================================================
  const hasZoomModifier =
    (event.ctrlKey || event.metaKey) &&
    !event.altKey;

  if (
    hasZoomModifier &&
    (
      event.code === 'Minus' ||
      event.code === 'NumpadSubtract'
    )
  ) {
    event.preventDefault();

    if (event.repeat) return;
    if (!totalPages) return;
    if (zoomOutBtn?.disabled) return;

    await changeZoom(-1);
    return;
  }

  if (
    hasZoomModifier &&
    (
      event.code === 'Equal' ||
      event.code === 'NumpadAdd'
    )
  ) {
    event.preventDefault();

    if (event.repeat) return;
    if (!totalPages) return;
    if (zoomInBtn?.disabled) return;

    // 同時支援 Ctrl+= 與 Ctrl++
    await changeZoom(1);
    return;
  }

  // =========================================================
  // 單鍵快捷鍵
  // =========================================================
  const hasNoPrimaryModifier =
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey;

  if (hasNoPrimaryModifier && !event.repeat) {
    // Shift + F：加入／移除我的最愛
    if (
      event.code === 'KeyF' &&
      event.shiftKey
    ) {
      event.preventDefault();

      await toggleFavorite();
      return;
    }

    // F：切換 Fit；自訂縮放時返回上一次 Fit 狀態
    if (
      event.code === 'KeyF' &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (!totalPages) return;

      await toggleFitMode();
      return;
    }

    // B：加入／移除目前頁書籤
    if (
      event.code === 'KeyB' &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (!totalPages) return;

      toggleCurrentPageBookmark();
      return;
    }

    // [：執行左側書籤跳轉按鈕
    if (
      event.code === 'BracketLeft' &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (!totalPages) return;

      await handleBookmarkNav('left');
      return;
    }

    // ]：執行右側書籤跳轉按鈕
    if (
      event.code === 'BracketRight' &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (!totalPages) return;

      await handleBookmarkNav('right');
      return;
    }

    // M：切換分頁／捲動模式
    if (
      event.code === 'KeyM' &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (!totalPages) return;

      await toggleReaderMode();
      return;
    }

    // P：開始／暫停循環播放
    if (
      event.code === 'KeyP' &&
      !event.shiftKey
    ) {
      event.preventDefault();

      if (!totalPages) return;
      if (!canUseAutoPlay() && !isAutoPlaying) return;

      toggleAutoPlay();
      return;
    }
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

  await handleReaderClickCommand(event);
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

      clearPdfCache();
      clearCbzCache();
      renderedPages.clear();

      if (isSelectablePdfMode()) {
        pdfTextMapByPage.clear();
        clearCustomPdfSelection();
      }

      await renderDocumentStructure(anchorPage);
      return;
    } catch (error) {
      console.error(i18n.t('reader.resizeFailed'), error);
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
    console.error(i18n.t('reader.beforeUnloadSaveFailed'), error);
  }
});

// =========================================================
// 啟動
// =========================================================
initReader();