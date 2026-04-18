import './app.css';
import * as pdfjsLib from 'pdfjs-dist';
import { unzipSync } from 'fflate';
import themeModule from './theme';

const {
  DEFAULT_THEME,
  normalizeThemeColor,
  applyAppTheme,
} = themeModule;

// ===== 初始主題 =====
/**
 * 從網址參數取得初始主題
 * 讓頁面在載入時先套用正確主題，避免閃爍
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

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

const initialTheme = getInitialThemeFromQuery();
applyAppTheme(document.documentElement, initialTheme);

// ===== DOM 元素 =====
const settingsBtn = document.getElementById('settings-btn');
const fullscreenBtn = document.getElementById('fullscreen-btn');
const libraryPathText = document.getElementById('library-path-text');
const librarySection = document.querySelector('.library-section');
const bookGrid = document.getElementById('book-grid');
const detailPanel = document.getElementById('detail-panel');

// ===== App 狀態 =====
let currentLibraryPath = '';
let books = [];
let selectedBookId = null;
let isFullscreen = false;
let visibleCoverLoadTimer = null;

let appSettings = {
  displayLibraryName: '',
  autoPlaySeconds: 5,
  bookSortMode: 'none',
  readingHistoryVisibility: 'hidden',
  appearanceTheme: DEFAULT_THEME.appearanceTheme,
  accentColor: DEFAULT_THEME.accentColor,
  backgroundMode: 'none',
  backgroundImagePath: '',
  backgroundOpacity: 16,
  backgroundBlur: 2,
};

// ===== 封面尺寸設定 =====
const GRID_COVER_WIDTH = 600;
const RECENT_COVER_WIDTH = 450;
const DETAIL_COVER_WIDTH = 750;

// ===== 封面快取與工作佇列 =====
const coverUrlCache = new Map();
const coverJobQueue = [];
let activeCoverJobs = 0;
const MAX_CONCURRENT_COVER_JOBS = 2;

// ===== 基本工具函式 =====
function getBookById(bookId) {
  return books.find((book) => book.id === bookId);
}

function getBookTags(book) {
  return book?.tags || {};
}

function isFavoriteBook(book) {
  return Boolean(getBookTags(book).favorite);
}

function isUnreadBook(book) {
  return !book?.readingProgress;
}

function isCompletedBook(book) {
  const progress = book?.readingProgress;

  if (!progress) {
    return false;
  }

  if (progress.completed === true) {
    return true;
  }

  const currentPage = Number(progress.page) || 0;
  const totalPages = Number(progress.totalPages) || 0;

  return totalPages > 0 && currentPage >= totalPages;
}

function normalizeBackgroundMode(mode) {
  return ['none', 'selectedBookCover', 'importedImage'].includes(mode)
    ? mode
    : 'none';
}

function clampNumber(value, min, max, fallback) {
  const numberValue = Number(value);

  if (!Number.isFinite(numberValue)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, numberValue));
}

// ===== 書名排序工具 =====
function getFirstMeaningfulChar(text) {
  const value = (text || '').trim();
  if (!value) return '';

  return value[0];
}

function getSymbolRank(char) {
  const symbolOrder = [
    '!', '#', '$', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
    ':', ';', '<', '=', '>', '?', '@',
    '[', '\\', ']', '^', '_', '`',
    '{', '|', '}', '~',
    '「', '」', '『', '』', '（', '）', '［', '］', '【', '】', '〈', '〉', '《', '》',
  ];

  const index = symbolOrder.indexOf(char);
  return index === -1 ? 999 : index;
}

function getTitleSortInfo(text) {
  const value = (text || '').trim();
  const firstChar = getFirstMeaningfulChar(value);

  if (!firstChar) {
    return { group: 99, symbolRank: 999, normalized: '' };
  }

  if (/[^0-9A-Za-zＡ-Ｚａ-ｚ０-９\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\u4E00-\u9FFF]/.test(firstChar)) {
    return {
      group: 0,
      symbolRank: getSymbolRank(firstChar),
      normalized: value,
    };
  }

  if (/[0-9０-９]/.test(firstChar)) {
    return {
      group: 1,
      symbolRank: 999,
      normalized: value,
    };
  }

  if (/[A-Za-zＡ-Ｚａ-ｚ]/.test(firstChar)) {
    return {
      group: 2,
      symbolRank: 999,
      normalized: value,
    };
  }

  if (/[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF]/.test(firstChar)) {
    return {
      group: 3,
      symbolRank: 999,
      normalized: value,
    };
  }

  if (/[\u4E00-\u9FFF]/.test(firstChar)) {
    return {
      group: 4,
      symbolRank: 999,
      normalized: value,
    };
  }

  return {
    group: 5,
    symbolRank: 999,
    normalized: value,
  };
}

function compareBookTitle(a, b) {
  const titleA = (a.title || '').trim();
  const titleB = (b.title || '').trim();

  const infoA = getTitleSortInfo(titleA);
  const infoB = getTitleSortInfo(titleB);

  if (infoA.group !== infoB.group) {
    return infoA.group - infoB.group;
  }

  if (infoA.group === 0 && infoA.symbolRank !== infoB.symbolRank) {
    return infoA.symbolRank - infoB.symbolRank;
  }

  return infoA.normalized.localeCompare(infoB.normalized, 'ja', {
    numeric: true,
    sensitivity: 'base',
  });
}

function getBookSortWeight(book) {
  if (appSettings.bookSortMode === 'favorite') {
    return isFavoriteBook(book) ? 0 : 1;
  }

  if (appSettings.bookSortMode === 'unread') {
    return isUnreadBook(book) ? 0 : 1;
  }

  if (appSettings.bookSortMode === 'completedLast') {
    return isCompletedBook(book) ? 1 : 0;
  }

  return 0;
}

function getSortedBooks() {
  return [...books].sort((a, b) => {
    const weightDiff = getBookSortWeight(a) - getBookSortWeight(b);

    if (weightDiff !== 0) {
      return weightDiff;
    }

    return compareBookTitle(a, b);
  });
}

// ===== 背景工具 =====
/**
 * 將背景樣式寫入 CSS 變數
 */
function applyBackgroundStyle(imageUrl, opacityValue, blurValue) {
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
 * 取得目前選中書籍封面作為背景圖
 */
async function resolveSelectedBookBackgroundUrl() {
  const selectedBook = getBookById(selectedBookId);
  if (!selectedBook) {
    return '';
  }

  const cachedCoverDataUrl = await window.readerAPI.readCoverData(
    selectedBook.filePath,
    DETAIL_COVER_WIDTH
  );

  if (cachedCoverDataUrl) {
    return cachedCoverDataUrl;
  }

  return '';
}

/**
 * 依目前設定套用背景
 */
async function applyPageBackground() {
  const mode = normalizeBackgroundMode(appSettings.backgroundMode);

  if (mode === 'none') {
    applyBackgroundStyle(
      '',
      appSettings.backgroundOpacity,
      appSettings.backgroundBlur
    );
    return;
  }

  if (mode === 'importedImage') {
    const imagePath = appSettings.backgroundImagePath || '';

    if (!imagePath) {
      applyBackgroundStyle(
        '',
        appSettings.backgroundOpacity,
        appSettings.backgroundBlur
      );
      return;
    }

    const imageDataUrl = await window.readerAPI.readImageData(imagePath);

    applyBackgroundStyle(
      imageDataUrl || '',
      appSettings.backgroundOpacity,
      appSettings.backgroundBlur
    );
    return;
  }

  if (mode === 'selectedBookCover') {
    const backgroundUrl = await resolveSelectedBookBackgroundUrl();

    applyBackgroundStyle(
      backgroundUrl,
      appSettings.backgroundOpacity,
      appSettings.backgroundBlur
    );
  }
}

// ===== 最近閱讀工具 =====
async function getRecentReadingBooks() {
  if (!window.readerAPI?.getRecentReading) {
    return [];
  }

  try {
    const recentReadingPaths = await window.readerAPI.getRecentReading();

    if (!Array.isArray(recentReadingPaths) || recentReadingPaths.length === 0) {
      return [];
    }

    const bookMap = new Map(books.map((book) => [book.filePath, book]));

    return recentReadingPaths
      .map((filePath) => bookMap.get(filePath))
      .filter(Boolean)
      .slice(0, 10);
  } catch (error) {
    console.error('讀取最近閱讀失敗:', error);
    return [];
  }
}

function getVisibleRecentBooks(recentBooks) {
  if (!librarySection || !Array.isArray(recentBooks) || recentBooks.length === 0) {
    return [];
  }

  const sectionWidth = librarySection.clientWidth || 0;
  const minCardWidth = 205;
  const gap = 30;

  const visibleCount = Math.max(
    1,
    Math.floor((sectionWidth + gap) / (minCardWidth + gap))
  );

  return recentBooks.slice(0, visibleCount);
}

function getRecentReadingMarkup(recentBooks) {
  if (!recentBooks.length) {
    return '';
  }

  return `
    <section class="recent-reading-section">
      <div class="recent-reading-header">
        <svg class="recent-reading-icon" viewBox="0 -960 960 960" aria-hidden="true">
          <path d="M480-120q-138 0-240.5-91.5T122-440h82q14 104 92.5 172T480-200q117 0 198.5-81.5T760-480q0-117-81.5-198.5T480-760q-69 0-129 32t-101 88h110v80H120v-240h80v94q51-64 124.5-99T480-840q75 0 140.5 28.5t114 77q48.5 48.5 77 114T840-480q0 75-28.5 140.5t-77 114q-48.5 48.5-114 77T480-120Zm112-192L440-464v-216h80v184l128 128-56 56Z" fill="currentColor"></path>
        </svg>
        <span>最近閱讀</span>
      </div>

      <div class="recent-reading-row">
        ${recentBooks.map((book) => `
          <button
            class="recent-book-card ${book.id === selectedBookId ? 'selected' : ''} ${isFavoriteBook(book) ? 'favorite' : ''}"
            data-recent-book-id="${book.id}"
            type="button"
            title="${book.title}">
            <div class="recent-book-cover">
              <img class="recent-book-cover-img" data-recent-cover-book-id="${book.id}" alt="${book.title}">
            </div>
            <div class="recent-book-title">${book.title}</div>
          </button>
        `).join('')}
      </div>

      <div class="recent-reading-divider"></div>
    </section>
  `;
}

/**
 * 渲染最近閱讀列
 */
async function renderRecentReadingSection() {
  const oldSection = document.querySelector('.recent-reading-section');
  oldSection?.remove();

  if (appSettings.readingHistoryVisibility !== 'shown') {
    return;
  }

  const recentBooks = await getRecentReadingBooks();

  if (!recentBooks.length || !librarySection || !bookGrid) {
    return;
  }

  const visibleRecentBooks = getVisibleRecentBooks(recentBooks);

  if (!visibleRecentBooks.length) {
    return;
  }

  bookGrid.insertAdjacentHTML(
    'beforebegin',
    getRecentReadingMarkup(visibleRecentBooks)
  );

  visibleRecentBooks.forEach((book) => {
    const button = document.querySelector(`[data-recent-book-id="${book.id}"]`);
    if (!button) return;

    button.addEventListener('click', async () => {
      selectedBookId = book.id;

      if (book?.filePath) {
        await window.readerAPI.saveLastSelectedBook(book.filePath);
      }

      updateSelectedBookCard();
      updateRecentReadingSelectedState();
      renderDetailPanel();
      await applyPageBackground();

      const img = document.querySelector(
        `[data-recent-cover-book-id="${book.id}"]`
      );

      if (img && !img.src && img.dataset.coverFailed !== 'true') {
        loadCover(book, img, RECENT_COVER_WIDTH);
      }
    });

    button.addEventListener('dblclick', () => {
      openReader(book.id);
    });

    const img = document.querySelector(`[data-recent-cover-book-id="${book.id}"]`);
    if (img) {
      loadCover(book, img, RECENT_COVER_WIDTH);
    }
  });
}

// ===== 封面工具：CBZ / PDF =====
function uint8ArrayToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * 生成 PDF 第一頁封面 canvas
 */
async function generatePdfCoverCanvas(filePath, width = GRID_COVER_WIDTH) {
  const pdfBuffer = await window.readerAPI.readPdfFile(filePath);
  const pdfData = new Uint8Array(pdfBuffer);

  const loadingTask = pdfjsLib.getDocument({ data: pdfData });
  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(1);

  const baseViewport = page.getViewport({ scale: 1 });
  const scale = width / baseViewport.width;
  const viewport = page.getViewport({ scale });

  const outputScale = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;

  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  return canvas;
}

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

/**
 * 從 CBZ 生成封面 dataURL
 */
async function generateCbzCoverDataUrl(filePath, width = GRID_COVER_WIDTH) {
  const cbzBuffer = await window.readerAPI.readCbzFile(filePath);
  const cbzData = new Uint8Array(cbzBuffer);

  const zipEntries = unzipSync(cbzData);
  const imageNames = getSortedCbzImageNames(zipEntries);

  if (imageNames.length === 0) {
    throw new Error('CBZ 內沒有可用圖片');
  }

  const firstImageName = imageNames[0];
  const firstImageData = zipEntries[firstImageName];

  const lowerName = firstImageName.toLowerCase();
  let mimeType = 'image/jpeg';

  if (lowerName.endsWith('.png')) mimeType = 'image/png';
  else if (lowerName.endsWith('.webp')) mimeType = 'image/webp';
  else if (lowerName.endsWith('.gif')) mimeType = 'image/gif';

  const base64 = uint8ArrayToBase64(firstImageData);
  const sourceDataUrl = `data:${mimeType};base64,${base64}`;

  const image = await new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('CBZ 封面圖片載入失敗'));

    img.src = sourceDataUrl;
  });

  const scale = width / image.width;
  const targetWidth = Math.floor(image.width * scale);
  const targetHeight = Math.floor(image.height * scale);

  const outputScale = window.devicePixelRatio || 1;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  canvas.width = Math.floor(targetWidth * outputScale);
  canvas.height = Math.floor(targetHeight * outputScale);
  canvas.style.width = `${targetWidth}px`;
  canvas.style.height = `${targetHeight}px`;

  context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  return canvas.toDataURL('image/jpeg', 0.85);
}

// ===== 封面工具：工作佇列 =====
function runNextCoverJob() {
  if (activeCoverJobs >= MAX_CONCURRENT_COVER_JOBS) return;

  const job = coverJobQueue.shift();
  if (!job) return;

  activeCoverJobs++;

  job()
    .catch((err) => {
      console.error('封面工作執行失敗:', err);
    })
    .finally(() => {
      activeCoverJobs--;
      runNextCoverJob();
    });
}

function enqueueCoverJob(job) {
  coverJobQueue.push(job);
  runNextCoverJob();
}

// ===== 封面工具：載入 =====
/**
 * 立即載入封面
 * 先記憶體快取，再磁碟快取，最後才現場生成
 */
async function loadCoverNow(book, imgElement, width = 400) {
  if (!book || !imgElement) return;
  if (imgElement.src) return;
  if (imgElement.dataset.coverFailed === 'true') return;

  if (book.type !== 'pdf' && book.type !== 'cbz') {
    imgElement.removeAttribute('src');
    imgElement.alt = '不支援的格式';
    return;
  }

  try {
    const cacheKey = `${book.filePath}__${width}`;

    if (coverUrlCache.has(cacheKey)) {
      imgElement.src = coverUrlCache.get(cacheKey);
      return;
    }

    const diskCoverDataUrl = await window.readerAPI.readCoverData(
      book.filePath,
      width
    );

    if (diskCoverDataUrl) {
      coverUrlCache.set(cacheKey, diskCoverDataUrl);
      imgElement.src = diskCoverDataUrl;
      return;
    }

    if (book.type === 'pdf') {
      const canvas = await generatePdfCoverCanvas(book.filePath, width);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

      coverUrlCache.set(cacheKey, dataUrl);
      imgElement.src = dataUrl;

      try {
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b) {
              resolve(b);
            } else {
              reject(new Error('toBlob 失敗'));
            }
          }, 'image/jpeg', 0.8);
        });

        const buffer = new Uint8Array(await blob.arrayBuffer());
        await window.readerAPI.saveCover(book.filePath, buffer, width);
      } catch (saveErr) {
        console.warn('PDF 封面存檔失敗（不影響顯示）:', saveErr);
      }

      return;
    }

    if (book.type === 'cbz') {
      const dataUrl = await generateCbzCoverDataUrl(book.filePath, width);

      coverUrlCache.set(cacheKey, dataUrl);
      imgElement.src = dataUrl;

      try {
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const buffer = new Uint8Array(await blob.arrayBuffer());

        await window.readerAPI.saveCover(book.filePath, buffer, width);
      } catch (saveErr) {
        console.warn('CBZ 封面存檔失敗（不影響顯示）:', saveErr);
      }
    }
  } catch (err) {
    console.error('封面生成失敗:', book.filePath, err);
    imgElement.dataset.coverFailed = 'true';
    imgElement.removeAttribute('src');
    imgElement.alt = '封面生成失敗';
  }
}

/**
 * 封面載入入口
 */
function loadCover(book, imgElement, width = GRID_COVER_WIDTH) {
  if (!book || !imgElement) return;
  if (imgElement.src) return;
  if (imgElement.dataset.coverFailed === 'true') return;
  if (imgElement.dataset.coverQueued === 'true') return;

  imgElement.dataset.coverQueued = 'true';

  enqueueCoverJob(async () => {
    try {
      await loadCoverNow(book, imgElement, width);
    } finally {
      imgElement.dataset.coverQueued = 'false';
    }
  });
}

// ===== 視圖更新：閱讀器 / 詳細欄 =====
function openReader(bookId) {
  const book = getBookById(bookId);
  if (!book) return;

  window.readerAPI.openReaderWindow(book);
}

function getFavoriteButtonMarkup(book) {
  const isFavorite = isFavoriteBook(book);
  const label = isFavorite ? '移除我的最愛' : '加入我的最愛';
  const activeClass = isFavorite ? ' active' : '';

  const favoritePath = isFavorite
    ? 'm480-120-58-52q-101-91-167-157T150-447.5Q111-500 95.5-544T80-634q0-94 63-157t157-63q52 0 99 22t81 62q34-40 81-62t99-22q94 0 157 63t63 157q0 46-15.5 90T810-447.5Q771-395 705-329T538-172l-58 52Z'
    : 'M440-501Zm0 381L313-234q-72-65-123.5-116t-85-96q-33.5-45-49-87T40-621q0-94 63-156.5T260-840q52 0 99 22t81 62q34-40 81-62t99-22q81 0 136 45.5T831-680h-85q-18-40-53-60t-73-20q-51 0-88 27.5T463-660h-46q-31-45-70.5-72.5T260-760q-57 0-98.5 39.5T120-621q0 33 14 67t50 78.5q36 44.5 98 104T440-228q26-23 61-53t56-50l9 9 19.5 19.5L605-283l9 9q-22 20-56 49.5T498-172l-58 52Zm280-160v-120H600v-80h120v-120h80v120h120v80H800v120h-80Z';

  return `
    <button class="favorite-btn${activeClass}" id="favorite-btn" aria-label="${label}" title="${label}">
      <svg class="detail-action-svg icon-favorite" viewBox="0 -960 960 960" aria-hidden="true">
        <path d="${favoritePath}" fill="currentColor"></path>
      </svg>
    </button>
  `;
}

/**
 * 渲染右側詳細欄
 */
function renderDetailPanel() {
  const selectedBook = getBookById(selectedBookId);

  if (!selectedBook) {
    detailPanel.innerHTML = `<div class="detail-empty">請先選擇一本書</div>`;
    return;
  }

  detailPanel.innerHTML = `   
    <div class="detail-cover">
        <img class="detail-cover-img" id="detail-cover-preview" alt="封面預覽">
      </div>
    <div class="detail-group">
      <div class="detail-title">${selectedBook.title}</div>
      <div class="detail-text">類型：${selectedBook.type.toUpperCase()}</div>
      <div class="detail-text" id="progress-text">進度：讀取中...</div>  
    </div>
    <div class="detail-actions">
      <button class="read-btn" id="read-btn">Read</button>
      ${getFavoriteButtonMarkup(selectedBook)}
    </div>
  `;

  const readBtn = document.getElementById('read-btn');
  readBtn.addEventListener('click', () => {
    openReader(selectedBook.id);
  });

  const favoriteBtn = document.getElementById('favorite-btn');
  favoriteBtn?.addEventListener('click', async () => {
    await setBookFavorite(selectedBook.id, !isFavoriteBook(selectedBook));
  });

  const detailCoverImg = document.getElementById('detail-cover-preview');
  loadCover(selectedBook, detailCoverImg, DETAIL_COVER_WIDTH);
  bindBackgroundToDetailCover(detailCoverImg);
  updateReadingProgressText(selectedBook);
}

/**
 * 當背景模式為 selectedBookCover 時，
 * 直接使用 detail-panel 的封面同步背景，
 * 避免第一次渲染時還要另外等快取讀取。
 */
function syncBackgroundFromDetailCover(imgElement) {
  if (!imgElement) return;
  if (appSettings.backgroundMode !== 'selectedBookCover') return;

  const currentSrc = imgElement.currentSrc || imgElement.src || '';
  if (!currentSrc) return;

  applyBackgroundStyle(
    currentSrc,
    appSettings.backgroundOpacity,
    appSettings.backgroundBlur
  );
}

/**
 * 綁定 detail 封面載入完成後同步背景
 */
function bindBackgroundToDetailCover(imgElement) {
  if (!imgElement) return;
  if (appSettings.backgroundMode !== 'selectedBookCover') return;

  const trySync = () => {
    syncBackgroundFromDetailCover(imgElement);
  };

  if (imgElement.complete && imgElement.src) {
    trySync();
    return;
  }

  imgElement.addEventListener('load', trySync, { once: true });
}

/**
 * 更新右側閱讀進度文字
 */
async function updateReadingProgressText(book) {
  if (!book) return;

  const progressText = document.getElementById('progress-text');
  if (!progressText) return;

  if (!window.readerAPI?.getReadingProgress) {
    progressText.textContent = '進度：未知';
    return;
  }

  try {
    const record = await window.readerAPI.getReadingProgress(book.filePath);

    if (!record) {
      progressText.textContent = '進度：未開始';
      return;
    }

    const currentPage = Number(record.page) || 1;
    const totalPages = Number(record.totalPages) || '?';

    const completedText =
      record.completed === true ||
      (Number(totalPages) > 0 && Number(currentPage) >= Number(totalPages))
        ? '（已看完）'
        : '';

    progressText.textContent = `進度：# ${currentPage} / ${totalPages} pages ${completedText}`;
  } catch (error) {
    console.error('讀取閱讀進度失敗:', error);
    progressText.textContent = '進度：讀取失敗';
  }
}

// ===== 視圖更新：選取 / 最愛狀態 =====
function updateSelectedBookCard() {
  const cards = document.querySelectorAll('.book-card');

  cards.forEach((card) => {
    card.classList.toggle('selected', card.dataset.bookId === selectedBookId);
  });
}

function updateRecentReadingSelectedState() {
  const cards = document.querySelectorAll('.recent-book-card');

  cards.forEach((card) => {
    card.classList.toggle('selected', card.dataset.recentBookId === selectedBookId);
  });
}

function updateBookCardFavoriteState(bookId) {
  const book = getBookById(bookId);
  if (!book) return;

  const card = document.querySelector(`.book-card[data-book-id="${bookId}"]`);
  if (!card) return;

  card.classList.toggle('favorite', isFavoriteBook(book));
}

function updateRecentReadingFavoriteState(bookId) {
  const book = getBookById(bookId);
  if (!book) return;

  const card = document.querySelector(
    `.recent-book-card[data-recent-book-id="${bookId}"]`
  );

  if (!card) return;

  card.classList.toggle('favorite', isFavoriteBook(book));
}

// ===== 視圖更新：最愛操作 =====
async function setBookFavorite(bookId, isFavorite) {
  const book = getBookById(bookId);

  if (!book || !window.readerAPI?.setBookFavorite) {
    return;
  }

  try {
    const tags = await window.readerAPI.setBookFavorite(
      book.filePath,
      isFavorite
    );

    book.tags = tags || {};
    updateBookCardFavoriteState(book.id);
    updateRecentReadingFavoriteState(book.id);
    await rerenderBookGridIfSortAffected();
  } catch (error) {
    console.error('更新我的最愛狀態失敗:', error);
  }
}

// ===== 視圖更新：書牆 =====
/**
 * 渲染整個書牆
 * 這個函式只在重新掃描或排序可能改變時重建
 */
async function renderBookGrid() {
  const sortedBooks = getSortedBooks();

  if (sortedBooks.length === 0) {
    bookGrid.innerHTML = `<div>此資料夾內沒有 cbz 或 pdf</div>`;
    renderDetailPanel();
    return;
  }

  bookGrid.innerHTML = sortedBooks.map((book) => `
    <div class="book-card ${book.id === selectedBookId ? 'selected' : ''} ${isFavoriteBook(book) ? 'favorite' : ''}" data-book-id="${book.id}">
      <div class="book-cover">
        <img class="book-cover-img" data-cover-book-id="${book.id}" alt="${book.title}">
      </div>
      <div class="book-title">${book.title}</div>
    </div>
  `).join('');

  const cards = document.querySelectorAll('.book-card');

  cards.forEach((card) => {
    const bookId = card.dataset.bookId;

    card.addEventListener('click', async () => {
      selectedBookId = bookId;

      const selectedBook = getBookById(bookId);
      if (selectedBook?.filePath) {
        await window.readerAPI.saveLastSelectedBook(selectedBook.filePath);
      }

      updateSelectedBookCard();
      updateRecentReadingSelectedState();
      renderDetailPanel();
      await applyPageBackground();

      const book = getBookById(bookId);
      const img = document.querySelector(`[data-cover-book-id="${bookId}"]`);

      if (book && img && !img.src && img.dataset.coverFailed !== 'true') {
        loadCover(book, img, GRID_COVER_WIDTH);
      }
    });

    card.addEventListener('dblclick', () => {
      openReader(bookId);
    });
  });
  
  renderDetailPanel();
  await renderRecentReadingSection();

  // 先優先載入 selected book 封面
  const selectedBook = getBookById(selectedBookId);
  if (selectedBook) {
    const selectedImg = document.querySelector(
      `[data-cover-book-id="${selectedBook.id}"]`
    );
  
    if (selectedImg) {
      loadCover(selectedBook, selectedImg, GRID_COVER_WIDTH);
    }
  }

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      loadVisibleCovers(GRID_COVER_WIDTH);
    });
  });

  lazyLoadRemainingCovers();
}

async function rerenderBookGridIfSortAffected() {
  if (
    appSettings.bookSortMode === 'favorite' ||
    appSettings.bookSortMode === 'unread' ||
    appSettings.bookSortMode === 'completedLast'
  ) {
    await renderBookGrid();
    return;
  }

  renderDetailPanel();
}

/**
 * 取得目前 library-section 視窗內可見的書卡
 * 可加一點 buffer，讓即將出現的下一排也先載入
 */
function getVisibleBookCards(buffer = 200) {
  if (!librarySection) return [];

  const containerTop = librarySection.scrollTop;
  const containerBottom = containerTop + librarySection.clientHeight;

  const cards = Array.from(document.querySelectorAll('.book-card'));

  return cards.filter((card) => {
    const cardTop = card.offsetTop;
    const cardBottom = cardTop + card.offsetHeight;

    return (
      cardBottom >= containerTop - buffer &&
      cardTop <= containerBottom + buffer
    );
  });
}

/**
 * 優先載入目前視窗可見範圍內的所有書籍封面
 */
function loadVisibleCovers(width = GRID_COVER_WIDTH) {
  const visibleCards = getVisibleBookCards(200);

  visibleCards.forEach((card) => {
    const bookId = card.dataset.bookId;
    const book = getBookById(bookId);
    if (!book) return;

    const img = card.querySelector('.book-cover-img');
    if (!img) return;

    loadCover(book, img, width);
  });
}

/**
 * 將目前選中的書卡捲到 library-section 上方
 * 讓該書所在列成為第一排，並與上邊界保留 30px
 */
function scrollSelectedBookToTop() {
  if (!librarySection) return;
  if (!selectedBookId) return;

  const selectedCard = document.querySelector(
    `.book-card[data-book-id="${selectedBookId}"]`
  );

  if (!selectedCard) return;

  const targetTop = Math.max(0, selectedCard.offsetTop - 30);
  librarySection.scrollTop = targetTop;
}

function scrollSelectedBookToTopAfterLayout() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      scrollSelectedBookToTop();
    });
  });
}

/**
 * 延後載入剩餘封面
 */
function lazyLoadRemainingCovers() {
  const sortedBooks = getSortedBooks();
  let index = 0;

  function processNext() {
    if (index >= sortedBooks.length) return;

    const book = sortedBooks[index];
    const img = document.querySelector(`[data-cover-book-id="${book.id}"]`);

    if (book && img && !img.src && img.dataset.coverFailed !== 'true') {
      loadCover(book, img, GRID_COVER_WIDTH);
    }

    index += 1;
    setTimeout(processNext, 120);
  }

  processNext();
}

// ===== 書庫流程 =====
function getLibraryDisplayLabel() {
  const customName = (appSettings.displayLibraryName || '').trim();

  if (customName) {
    return customName;
  }

  return currentLibraryPath || '尚未選擇書庫';
}

function renderLibraryTitle() {
  if (!libraryPathText) return;

  libraryPathText.textContent = getLibraryDisplayLabel();
  libraryPathText.title = currentLibraryPath || getLibraryDisplayLabel();
}

/**
 * 重新掃描書庫並刷新畫面
 */
async function refreshLibrary({ scrollToSelected = false } = {}) {
  if (!currentLibraryPath) return;

  books = await window.readerAPI.scanLibrary(currentLibraryPath);

  const lastSelectedBookPath = await window.readerAPI.getLastSelectedBook();
  const matchedBook = books.find((book) => book.filePath === lastSelectedBookPath);

  if (matchedBook) {
    selectedBookId = matchedBook.id;
  } else if (books.length > 0 && !books.find((book) => book.id === selectedBookId)) {
    selectedBookId = books[0].id;
  }

  if (!selectedBookId && books.length > 0) {
    selectedBookId = books[0].id;
  }

  await renderBookGrid();
  await applyPageBackground();

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (scrollToSelected) {
        scrollSelectedBookToTop();
      }

      loadVisibleCovers(GRID_COVER_WIDTH);
      lazyLoadRemainingCovers();
    });
  });
}

/**
 * 載入 app 設定
 */
async function loadAppSettings() {
  if (!window.readerAPI?.getAppSettings) {
    renderLibraryTitle();
    return;
  }

  try {
    const settings = await window.readerAPI.getAppSettings();

    appSettings = {
      displayLibraryName: settings?.displayLibraryName || '',
      autoPlaySeconds: Math.max(1, Number(settings?.autoPlaySeconds) || 5),
      bookSortMode: ['none', 'favorite', 'unread', 'completedLast'].includes(settings?.bookSortMode)
        ? settings.bookSortMode
        : 'none',
      readingHistoryVisibility: settings?.readingHistoryVisibility === 'shown'
        ? 'shown'
        : 'hidden',
      appearanceTheme: settings?.appearanceTheme === 'light'
        ? 'light'
        : DEFAULT_THEME.appearanceTheme,
      accentColor: normalizeThemeColor(
        settings?.accentColor,
        DEFAULT_THEME.accentColor
      ),
      backgroundMode: normalizeBackgroundMode(settings?.backgroundMode),
      backgroundImagePath: settings?.backgroundImagePath || '',
      backgroundOpacity: clampNumber(settings?.backgroundOpacity, 0, 100, 16),
      backgroundBlur: clampNumber(settings?.backgroundBlur, 0, 40, 2),
    };
  } catch (error) {
    console.error('讀取設定失敗:', error);
  }

  renderLibraryTitle();
  applyAppTheme(document.documentElement, appSettings);
}

/**
 * 還原上次開啟的書庫
 */
async function restoreLastLibrary() {
  if (!window.readerAPI?.getLastLibraryFolder) return;

  const folderPath = await window.readerAPI.getLastLibraryFolder();
  if (!folderPath) return;

  currentLibraryPath = folderPath;
  renderLibraryTitle();
  await refreshLibrary({ scrollToSelected: true });
}

// ===== 全螢幕工具 =====
function updateFullscreenButton() {
  if (!fullscreenBtn) return;

  const label = isFullscreen ? '離開全螢幕' : '進入全螢幕';
  fullscreenBtn.title = label;
  fullscreenBtn.setAttribute('aria-label', label);

  const fullscreenIconPath = document.getElementById('fullscreen-icon-path');
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

async function leaveFullscreenIfNeeded(event) {
  if (event.key !== 'Escape' || !isFullscreen) return;

  event.preventDefault();
  isFullscreen = await window.readerAPI.toggleFullscreen();
  updateFullscreenButton();
}

// ===== 事件 =====
window.readerAPI?.onAppSettingsUpdated?.(async (nextSettings) => {
  appSettings = {
    ...appSettings,
    ...nextSettings,
    appearanceTheme: nextSettings?.appearanceTheme === 'light'
      ? 'light'
      : DEFAULT_THEME.appearanceTheme,
    accentColor: normalizeThemeColor(
      nextSettings?.accentColor,
      DEFAULT_THEME.accentColor
    ),
    backgroundMode: normalizeBackgroundMode(nextSettings?.backgroundMode),
    backgroundImagePath: nextSettings?.backgroundImagePath || '',
    backgroundOpacity: clampNumber(nextSettings?.backgroundOpacity, 0, 100, 16),
    backgroundBlur: clampNumber(nextSettings?.backgroundBlur, 0, 40, 2),
  };

  applyAppTheme(document.documentElement, appSettings);
  renderLibraryTitle();
  await renderBookGrid();
  await applyPageBackground();
});

settingsBtn?.addEventListener('click', async () => {
  await window.readerAPI.openSettingsPage();
});

fullscreenBtn?.addEventListener('click', async () => {
  isFullscreen = await window.readerAPI.toggleFullscreen();
  updateFullscreenButton();
});

window.addEventListener('keydown', leaveFullscreenIfNeeded);

window.addEventListener('focus', async () => {
  const selectedBook = getBookById(selectedBookId);
  if (!selectedBook) return;

  updateReadingProgressText(selectedBook);

  if (!window.readerAPI?.getBookTags) return;

  try {
    const latestTags = await window.readerAPI.getBookTags(selectedBook.filePath);
    selectedBook.tags = latestTags || {};
    updateBookCardFavoriteState(selectedBook.id);
    renderDetailPanel();
  } catch (error) {
    console.error('focus 時同步最愛狀態失敗:', error);
  }
});

window.readerAPI?.onBookTagsUpdated?.(async ({ filePath, tags }) => {
  const targetBook = books.find((book) => book.filePath === filePath);
  if (!targetBook) return;

  targetBook.tags = tags || {};

  updateBookCardFavoriteState(targetBook.id);
  updateRecentReadingFavoriteState(targetBook.id);

  await rerenderBookGridIfSortAffected();
});

window.readerAPI?.onReadingProgressUpdated?.(async ({ filePath, record }) => {
  const targetBook = books.find((book) => book.filePath === filePath);
  if (!targetBook) return;

  targetBook.readingProgress = record || null;

  if (selectedBookId === targetBook.id) {
    updateReadingProgressText(targetBook);
  }

  await rerenderBookGridIfSortAffected();
});

window.readerAPI?.onAllReadingProgressCleared?.(async () => {
  books = books.map((book) => ({
    ...book,
    readingProgress: null,
  }));

  if (selectedBookId) {
    const selectedBook = getBookById(selectedBookId);
    if (selectedBook) {
      updateReadingProgressText(selectedBook);
    }
  }

  await renderBookGrid();
});

librarySection?.addEventListener('scroll', () => {
  if (visibleCoverLoadTimer) {
    clearTimeout(visibleCoverLoadTimer);
  }

  visibleCoverLoadTimer = setTimeout(() => {
    loadVisibleCovers(GRID_COVER_WIDTH);
  }, 60);
});

// ===== 初始化 =====
async function initApp() {
  updateFullscreenButton();
  await loadAppSettings();
  await restoreLastLibrary();
  await applyPageBackground();
}

initApp();
