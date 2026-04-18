const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DEFAULT_THEME, normalizeThemeColor } = require('./renderer/theme');

// ===== 視窗狀態 =====
let mainWindow = null;
let readerWindow = null;

// ===== 基本工具函式 =====
/**
 * 判斷副檔名是否為支援格式
 */
function isSupportedBook(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === '.cbz' || ext === '.pdf';
}

/**
 * 由檔名生成較乾淨的書名
 */
function getBookTitle(fileName) {
  return path.basename(fileName, path.extname(fileName));
}

/**
 * 取得書籍檔案資訊
 */
function getBookFileStat(filePath) {
  const stat = fs.statSync(filePath);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
}

/**
 * 正規化主題色歷史陣列
 */
function normalizeThemeColorList(value, maxLength) {
  if (!Array.isArray(value)) {
    return [];
  }

  const result = [];

  value.forEach((item) => {
    const normalized = normalizeThemeColor(item, DEFAULT_THEME.accentColor);

    if (!result.includes(normalized)) {
      result.push(normalized);
    }
  });

  return result.slice(0, maxLength);
}

/**
 * 正規化背景模式
 */
function normalizeBackgroundMode(value) {
  return ['none', 'selectedBookCover', 'importedImage'].includes(value)
    ? value
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

// ===== 書庫索引與快取目錄 =====
/**
 * 確保 .myreader 相關資料夾與索引檔存在
 */
function ensureMyReaderDirs(folderPath) {
  const libraryMetaDir = path.join(folderPath, '.myreader');
  const coversDir = path.join(libraryMetaDir, 'covers');
  const libraryJsonPath = path.join(libraryMetaDir, 'library.json');

  if (!fs.existsSync(libraryMetaDir)) {
    fs.mkdirSync(libraryMetaDir);
  }

  if (!fs.existsSync(coversDir)) {
    fs.mkdirSync(coversDir);
  }

  if (!fs.existsSync(libraryJsonPath)) {
    fs.writeFileSync(libraryJsonPath, JSON.stringify([], null, 2), 'utf-8');
  }

  return {
    libraryMetaDir,
    coversDir,
    libraryJsonPath,
  };
}

/**
 * 讀取書庫索引檔 library.json
 */
function loadLibraryIndex(folderPath) {
  const { libraryJsonPath } = ensureMyReaderDirs(folderPath);

  try {
    const raw = fs.readFileSync(libraryJsonPath, 'utf-8');
    return JSON.parse(raw);
  } catch (error) {
    console.error('讀取 library.json 失敗:', error);
    return [];
  }
}

/**
 * 儲存書庫索引檔 library.json
 */
function saveLibraryIndex(folderPath, data) {
  const { libraryJsonPath } = ensureMyReaderDirs(folderPath);
  fs.writeFileSync(libraryJsonPath, JSON.stringify(data, null, 2), 'utf-8');
}

/**
 * 依書籍路徑與寬度取得封面檔案路徑
 */
function getCoverFilePath(filePath, width) {
  const folderPath = path.dirname(filePath);
  const { coversDir } = ensureMyReaderDirs(folderPath);

  const hash = crypto
    .createHash('md5')
    .update(filePath)
    .digest('hex');

  return path.join(coversDir, `${hash}_${width}.jpg`);
}

// ===== PDF 頁面快取 =====
/**
 * 確保 PDF 頁面快取目錄存在
 */
function ensurePdfPageCacheDir() {
  const cacheDir = path.join(app.getPath('userData'), 'page-cache', 'pdf');

  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  return cacheDir;
}

/**
 * 依檔案路徑、大小與修改時間生成 PDF 書籍快取 hash
 */
function getPdfBookHash(filePath) {
  const stat = fs.statSync(filePath);

  return crypto
    .createHash('sha1')
    .update(`${filePath}__${stat.size}__${stat.mtimeMs}`)
    .digest('hex');
}

/**
 * 取得 PDF 單頁快取檔案路徑
 */
function getPdfPageCacheFilePath({
  filePath,
  pageNumber,
  pageFitMode,
  viewerWidth,
  viewerHeight,
  dpr,
  renderScaleMultiplier,
}) {
  const rootDir = ensurePdfPageCacheDir();
  const bookHash = getPdfBookHash(filePath);

  const bookDir = path.join(rootDir, bookHash);
  if (!fs.existsSync(bookDir)) {
    fs.mkdirSync(bookDir, { recursive: true });
  }

  const safeFitMode = pageFitMode === 'width' ? 'width' : 'height';
  const safePageNumber = Number(pageNumber) || 1;
  const safeWidth = Math.round(Number(viewerWidth) || 0);
  const safeHeight = Math.round(Number(viewerHeight) || 0);
  const safeDpr = Number.isFinite(Number(dpr)) ? Number(dpr) : 1;
  const safeRenderScaleMultiplier = Number.isFinite(Number(renderScaleMultiplier))
    ? Number(renderScaleMultiplier)
    : 1;

  const fileName =
    `${safeFitMode}_${safeWidth}x${safeHeight}` +
    `_dpr${safeDpr}_rs${safeRenderScaleMultiplier}_page_${safePageNumber}.webp`;

  return path.join(bookDir, fileName);
}

// ===== App 狀態 =====
/**
 * 取得 app-state.json 路徑
 */
function getAppStateFilePath() {
  return path.join(app.getPath('userData'), 'app-state.json');
}

/**
 * 讀取 app 狀態
 */
function loadAppState() {
  const stateFilePath = getAppStateFilePath();

  if (!fs.existsSync(stateFilePath)) {
    return {
      lastLibraryFolder: '',
      lastSelectedBookPath: '',
      libraryHistory: [],
      readingProgress: {},
      bookTags: {},
      settings: {
        displayLibraryName: '',
        autoPlaySeconds: 5,
        bookSortMode: 'none',
        readingHistoryVisibility: 'hidden',
        appearanceTheme: DEFAULT_THEME.appearanceTheme,
        accentColor: DEFAULT_THEME.accentColor,
        customColorHistory: [],
        savedColorHistory: [],
        backgroundMode: 'none',
        backgroundImagePath: '',
        backgroundOpacity: 20,
        backgroundBlur: 0,
      },
      recentReading: [],
    }
  }

  try {
    const raw = fs.readFileSync(stateFilePath, 'utf-8');
    const parsed = JSON.parse(raw);

    return {
      lastLibraryFolder: parsed.lastLibraryFolder || '',
      lastSelectedBookPath:
        typeof parsed.lastSelectedBookPath === 'string'
          ? parsed.lastSelectedBookPath
          : '',
      libraryHistory: Array.isArray(parsed.libraryHistory)
        ? parsed.libraryHistory.filter((item) => typeof item === 'string')
        : [],
      readingProgress: parsed.readingProgress || {},
      bookTags: parsed.bookTags || {},
      recentReading: Array.isArray(parsed.recentReading) ? parsed.recentReading : [],
      settings: {
        displayLibraryName: parsed.settings?.displayLibraryName || '',
        autoPlaySeconds: Math.max(1, Number(parsed.settings?.autoPlaySeconds) || 5),
        bookSortMode: ['none', 'favorite', 'unread', 'completedLast'].includes(parsed.settings?.bookSortMode)
          ? parsed.settings.bookSortMode
          : 'none',
        readingHistoryVisibility: parsed.settings?.readingHistoryVisibility === 'shown'
          ? 'shown'
          : 'hidden',
        appearanceTheme: parsed.settings?.appearanceTheme === 'light'
          ? 'light'
          : DEFAULT_THEME.appearanceTheme,
        accentColor: normalizeThemeColor(
          parsed.settings?.accentColor,
          DEFAULT_THEME.accentColor
        ),
        customColorHistory: normalizeThemeColorList(parsed.settings?.customColorHistory, 5),
        savedColorHistory: normalizeThemeColorList(parsed.settings?.savedColorHistory, 6),
        backgroundMode: normalizeBackgroundMode(parsed.settings?.backgroundMode),
        backgroundImagePath:
          typeof parsed.settings?.backgroundImagePath === 'string'
            ? parsed.settings.backgroundImagePath
            : '',
        backgroundOpacity: clampNumber(parsed.settings?.backgroundOpacity, 0, 100, 16),
        backgroundBlur: clampNumber(parsed.settings?.backgroundBlur, 0, 40, 2),
      },
    };
  } catch (error) {
    console.error('讀取 app-state.json 失敗:', error);
    return {
      lastLibraryFolder: '',
      lastSelectedBookPath: '',
      readingProgress: {},
      bookTags: {},
      settings: {
        displayLibraryName: '',
        autoPlaySeconds: 5,
        bookSortMode: 'none',
        readingHistoryVisibility: 'hidden',
        appearanceTheme: DEFAULT_THEME.appearanceTheme,
        accentColor: DEFAULT_THEME.accentColor,
        customColorHistory: [],
        savedColorHistory: [],
        backgroundMode: 'none',
        backgroundImagePath: '',
        backgroundOpacity: 16,
        backgroundBlur: 2,
      },
      recentReading: [],
    };
  }
}

/**
 * 儲存 app 狀態
 */
function saveAppState(state) {
  const stateFilePath = getAppStateFilePath();
  fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
}

// ===== 廣播事件 =====
function broadcastSettingsUpdate(settings) {
  const windows = BrowserWindow.getAllWindows();

  windows.forEach((win) => {
    win.webContents.send('app-settings-updated', settings);
  });
}

function broadcastBookTagsUpdate(payload) {
  const windows = BrowserWindow.getAllWindows();

  windows.forEach((win) => {
    win.webContents.send('book-tags-updated', payload);
  });
}

function broadcastReadingProgressUpdate(payload) {
  const windows = BrowserWindow.getAllWindows();

  windows.forEach((win) => {
    win.webContents.send('reading-progress-updated', payload);
  });
}

// ===== App 狀態讀寫：書庫 / 書籍 / 設定 =====
function saveLastLibraryFolder(folderPath) {
  const state = loadAppState();
  state.lastLibraryFolder = folderPath || '';
  saveAppState(state);
}

function getLastLibraryFolder() {
  const state = loadAppState();
  return state.lastLibraryFolder || '';
}

function getLibraryHistory() {
  const state = loadAppState();
  const history = Array.isArray(state.libraryHistory) ? state.libraryHistory : [];

  return history
    .filter((folderPath) => folderPath && fs.existsSync(folderPath))
    .slice(0, 3);
}

function pushLibraryHistory(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return getLibraryHistory();
  }

  const state = loadAppState();
  const history = Array.isArray(state.libraryHistory) ? state.libraryHistory : [];

  state.libraryHistory = [
    folderPath,
    ...history.filter((item) => item !== folderPath),
  ].slice(0, 3);

  saveAppState(state);
  return state.libraryHistory;
}

function clearAllReadingProgress() {
  const state = loadAppState();
  state.readingProgress = {};
  saveAppState(state);
}

function broadcastAllReadingProgressCleared() {
  const windows = BrowserWindow.getAllWindows();

  windows.forEach((win) => {
    win.webContents.send('all-reading-progress-cleared');
  });
}

function saveLastSelectedBook(filePath) {
  const state = loadAppState();
  state.lastSelectedBookPath = typeof filePath === 'string' ? filePath : '';
  saveAppState(state);
  return state.lastSelectedBookPath;
}

function getLastSelectedBook() {
  const state = loadAppState();
  const filePath = state.lastSelectedBookPath || '';

  if (!filePath || !fs.existsSync(filePath)) {
    return '';
  }

  return filePath;
}

function getAppSettings() {
  const state = loadAppState();

  return {
    displayLibraryName: state.settings?.displayLibraryName || '',
    autoPlaySeconds: Math.max(1, Number(state.settings?.autoPlaySeconds) || 5),
    bookSortMode: ['none', 'favorite', 'unread', 'completedLast'].includes(state.settings?.bookSortMode)
      ? state.settings.bookSortMode
      : 'none',
    readingHistoryVisibility: state.settings?.readingHistoryVisibility === 'shown'
      ? 'shown'
      : 'hidden',
    appearanceTheme: state.settings?.appearanceTheme === 'light'
      ? 'light'
      : DEFAULT_THEME.appearanceTheme,
    accentColor: normalizeThemeColor(
      state.settings?.accentColor,
      DEFAULT_THEME.accentColor
    ),
    customColorHistory: normalizeThemeColorList(state.settings?.customColorHistory, 5),
    savedColorHistory: normalizeThemeColorList(state.settings?.savedColorHistory, 6),
    backgroundMode: normalizeBackgroundMode(state.settings?.backgroundMode),
    backgroundImagePath: state.settings?.backgroundImagePath || '',
    backgroundOpacity: clampNumber(state.settings?.backgroundOpacity, 0, 100, 16),
    backgroundBlur: clampNumber(state.settings?.backgroundBlur, 0, 40, 2),
  };
}

function saveAppSettings(settings = {}) {
  const state = loadAppState();

  state.settings = {
    displayLibraryName:
      typeof settings.displayLibraryName === 'string'
        ? settings.displayLibraryName
        : state.settings?.displayLibraryName || '',

    autoPlaySeconds: Math.max(
      1,
      Number(settings.autoPlaySeconds ?? state.settings?.autoPlaySeconds ?? 5) || 5
    ),

    bookSortMode: ['none', 'favorite', 'unread', 'completedLast'].includes(settings.bookSortMode)
      ? settings.bookSortMode
      : state.settings?.bookSortMode || 'none',

    readingHistoryVisibility:
      settings.readingHistoryVisibility === 'shown'
        ? 'shown'
        : 'hidden',

    appearanceTheme:
      settings.appearanceTheme === 'light'
        ? 'light'
        : DEFAULT_THEME.appearanceTheme,

    accentColor: normalizeThemeColor(
      settings.accentColor ?? state.settings?.accentColor ?? DEFAULT_THEME.accentColor,
      DEFAULT_THEME.accentColor
    ),

    customColorHistory: normalizeThemeColorList(
      settings.customColorHistory ?? state.settings?.customColorHistory ?? [],
      5
    ),

    savedColorHistory: normalizeThemeColorList(
      settings.savedColorHistory ?? state.settings?.savedColorHistory ?? [],
      6
    ),

    backgroundMode: normalizeBackgroundMode(
      settings.backgroundMode ?? state.settings?.backgroundMode ?? 'none'
    ),

    backgroundImagePath:
      typeof settings.backgroundImagePath === 'string'
        ? settings.backgroundImagePath
        : state.settings?.backgroundImagePath || '',

    backgroundOpacity: clampNumber(
      settings.backgroundOpacity ?? state.settings?.backgroundOpacity ?? 16,
      0,
      100,
      16
    ),

    backgroundBlur: clampNumber(
      settings.backgroundBlur ?? state.settings?.backgroundBlur ?? 2,
      0,
      40,
      2
    ),
  };

  saveAppState(state);
  broadcastSettingsUpdate(state.settings);
  return state.settings;
}

/**
 * 在 URL 上附加主題參數
 */
function appendThemeQuery(url, settings) {
  const safeTheme =
    settings?.appearanceTheme === 'light'
      ? 'light'
      : DEFAULT_THEME.appearanceTheme;

  const safeAccent = normalizeThemeColor(
    settings?.accentColor,
    DEFAULT_THEME.accentColor
  );

  const separator = url.includes('?') ? '&' : '?';

  return `${url}${separator}theme=${encodeURIComponent(safeTheme)}&accent=${encodeURIComponent(safeAccent)}`;
}

// ===== 閱讀進度 / 標籤 / 最近閱讀 =====
function getReadingProgress(filePath) {
  const state = loadAppState();
  const record = state.readingProgress?.[filePath];

  if (!record) {
    return null;
  }

  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    const stat = getBookFileStat(filePath);

    if (record.mtimeMs !== stat.mtimeMs || record.size !== stat.size) {
      return null;
    }

    return record;
  } catch (error) {
    console.error('讀取閱讀進度失敗:', error);
    return null;
  }
}

function saveReadingProgress(filePath, page, totalPages) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeTotalPages = Math.max(0, Number(totalPages) || 0);

  const stat = getBookFileStat(filePath);
  const state = loadAppState();

  state.readingProgress = state.readingProgress || {};
  const previousRecord = state.readingProgress[filePath] || {};

  const nextCompleted =
    previousRecord.completed === true ||
    (safeTotalPages > 0 && safePage >= safeTotalPages);

  state.readingProgress[filePath] = {
    page: safePage,
    totalPages: safeTotalPages,
    completed: nextCompleted,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    updatedAt: Date.now(),
  };

  saveAppState(state);

  broadcastReadingProgressUpdate({
    filePath,
    record: state.readingProgress[filePath],
  });

  return true;
}

function markBookAsStarted(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  const state = loadAppState();
  const stat = getBookFileStat(filePath);

  state.readingProgress = state.readingProgress || {};
  const previousRecord = state.readingProgress[filePath] || {};

  if (previousRecord && typeof previousRecord.page === 'number') {
    return true;
  }

  state.readingProgress[filePath] = {
    page: 1,
    totalPages: 0,
    completed: false,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    updatedAt: Date.now(),
  };

  saveAppState(state);

  broadcastReadingProgressUpdate({
    filePath,
    record: state.readingProgress[filePath],
  });

  return true;
}

function getBookTags(filePath) {
  if (!filePath) {
    return {};
  }

  const state = loadAppState();
  return state.bookTags?.[filePath] || {};
}

function setBookFavorite(filePath, isFavorite) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { favorite: false };
  }

  const state = loadAppState();
  state.bookTags = state.bookTags || {};

  const currentTags = state.bookTags[filePath] || {};
  const nextFavorite = Boolean(isFavorite);

  if (nextFavorite) {
    state.bookTags[filePath] = {
      ...currentTags,
      favorite: true,
    };
  } else {
    const nextTags = { ...currentTags };
    delete nextTags.favorite;

    if (Object.keys(nextTags).length === 0) {
      delete state.bookTags[filePath];
    } else {
      state.bookTags[filePath] = nextTags;
    }
  }

  saveAppState(state);

  const nextTags = state.bookTags[filePath] || {};

  broadcastBookTagsUpdate({
    filePath,
    tags: nextTags,
  });

  return nextTags;
}

function recordRecentReading(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const state = loadAppState();
  const nextList = Array.isArray(state.recentReading) ? [...state.recentReading] : [];

  const filtered = nextList.filter((item) => item !== filePath);
  filtered.unshift(filePath);

  state.recentReading = filtered.slice(0, 10);
  saveAppState(state);

  return state.recentReading;
}

function getRecentReading() {
  const state = loadAppState();
  const list = Array.isArray(state.recentReading) ? state.recentReading : [];

  return list
    .filter((filePath) => filePath && fs.existsSync(filePath))
    .slice(0, 10);
}

function clearRecentReading() {
  const state = loadAppState();
  state.recentReading = [];
  saveAppState(state);
  return true;
}

// ===== 書庫掃描 =====
/**
 * 掃描指定資料夾，回傳書籍列表
 */
async function scanLibrary(folderPath) {
  if (!fs.existsSync(folderPath)) {
    return [];
  }

  saveLastLibraryFolder(folderPath);
  pushLibraryHistory(folderPath);
  ensureMyReaderDirs(folderPath);

  const existingIndex = loadLibraryIndex(folderPath);
  const existingMap = new Map(existingIndex.map((item) => [item.filePath, item]));
  const appState = loadAppState();
  const bookTagsMap = appState.bookTags || {};

  const entries = fs.readdirSync(folderPath, { withFileTypes: true });

  const fileEntries = entries.filter(
    (entry) => entry.isFile() && isSupportedBook(entry.name)
  );

  const books = fileEntries.map((entry, index) => {
    const fullPath = path.join(folderPath, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    const title = getBookTitle(entry.name);
    const stat = getBookFileStat(fullPath);
    const oldRecord = existingMap.get(fullPath);

    let covers = {};
    if (oldRecord && oldRecord.mtimeMs === stat.mtimeMs && oldRecord.covers) {
      covers = oldRecord.covers;
    }

    return {
      id: `${index}-${entry.name}`,
      title,
      filePath: fullPath,
      type: ext === '.cbz' ? 'cbz' : 'pdf',
      pageCount: 0,
      mtimeMs: stat.mtimeMs,
      covers,
      tags: bookTagsMap[fullPath] || {},
      readingProgress: getReadingProgress(fullPath),
    };
  });

  const indexToSave = books.map((book) => ({
    filePath: book.filePath,
    title: book.title,
    type: book.type,
    mtimeMs: book.mtimeMs,
    covers: book.covers || {},
  }));

  saveLibraryIndex(folderPath, indexToSave);

  return books;
}

// ===== 視窗建立 =====
/**
 * 建立主視窗
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 750,
    autoHideMenuBar: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // ===== CSP（目前保留註解，不啟用） =====
  // mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
  //   callback({
  //     responseHeaders: {
  //       ...details.responseHeaders,
  //       'Content-Security-Policy': [
  //         `
  //         default-src 'self' data: myreader-cover: http://localhost:3000 ws://localhost:3000;
  //         script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:3000;
  //         style-src 'self' 'unsafe-inline';
  //         img-src 'self' data: myreader-cover:;
  //         connect-src 'self' http://localhost:3000 ws://localhost:3000;
  //         `,
  //       ],
  //     },
  //   });
  // });

  const currentSettings = getAppSettings();
  const mainUrl = appendThemeQuery(MAIN_WINDOW_WEBPACK_ENTRY, currentSettings);
  mainWindow.loadURL(mainUrl);

  // mainWindow.webContents.openDevTools();
}

/**
 * 建立閱讀視窗
 */
function createReaderWindow(filePath, title) {
  const encodedFilePath = encodeURIComponent(filePath);
  const encodedTitle = encodeURIComponent(title);

  readerWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 900,
    minHeight: 700,
    autoHideMenuBar: true,
    title: `My Reader - ${title}`,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const currentSettings = getAppSettings();
  const safeTheme =
    currentSettings?.appearanceTheme === 'light'
      ? 'light'
      : DEFAULT_THEME.appearanceTheme;

  const safeAccent = normalizeThemeColor(
    currentSettings?.accentColor,
    DEFAULT_THEME.accentColor
  );

  const readerUrl =
    `${READER_WINDOW_WEBPACK_ENTRY}?filePath=${encodedFilePath}` +
    `&title=${encodedTitle}` +
    `&theme=${encodeURIComponent(safeTheme)}` +
    `&accent=${encodeURIComponent(safeAccent)}`;

  readerWindow.loadURL(readerUrl);
  readerWindow.maximize();

  readerWindow.on('closed', () => {
    readerWindow = null;
  });
}

// ===== 自訂 protocol =====
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'myreader-cover',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

/**
 * 註冊 myreader-cover protocol
 */
function registerMyReaderProtocol() {
  protocol.handle('myreader-cover', async (request) => {
    try {
      const url = new URL(request.url);
      const encodedPath = url.searchParams.get('path');

      if (!encodedPath) {
        return new Response('Missing path', { status: 400 });
      }

      const filePath = decodeURIComponent(encodedPath);
      const data = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();

      const contentType =
        ext === '.png'
          ? 'image/png'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/jpeg';

      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'no-store',
        },
      });
    } catch (error) {
      console.error('myreader-cover protocol 載入失敗:', error);
      return new Response('File load failed', { status: 404 });
    }
  });
}

// ===== IPC 註冊 =====
function registerFolderIpc() {
  ipcMain.handle('pick-library-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle('get-last-library-folder', async () => {
    const folderPath = getLastLibraryFolder();

    if (!folderPath || !fs.existsSync(folderPath)) {
      return '';
    }

    return folderPath;
  });

  ipcMain.handle('scan-library', async (_event, folderPath) => {
    return await scanLibrary(folderPath);
  });

  ipcMain.handle('get-library-history', async () => {
    return getLibraryHistory();
  });

  ipcMain.handle('push-library-history', async (_event, folderPath) => {
    return pushLibraryHistory(folderPath);
  });

  ipcMain.handle('open-history-library-folder', async (_event, folderPath) => {
    if (!folderPath || !fs.existsSync(folderPath)) {
      return '';
    }

    saveLastLibraryFolder(folderPath);
    pushLibraryHistory(folderPath);
    return folderPath;
  });
}

function registerSettingsIpc() {
  ipcMain.handle('get-app-settings', async () => {
    return getAppSettings();
  });

  ipcMain.handle('save-app-settings', async (_event, settings) => {
    return saveAppSettings(settings);
  });
}

function registerBackgroundIpc() {
  ipcMain.handle('pick-background-image', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [
        {
          name: 'Images',
          extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'],
        },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return '';
    }

    return result.filePaths[0];
  });

  ipcMain.handle('get-last-selected-book', async () => {
    return getLastSelectedBook();
  });

  ipcMain.handle('save-last-selected-book', async (_event, filePath) => {
    return saveLastSelectedBook(filePath);
  });

  ipcMain.handle('read-image-data', async (_event, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        return null;
      }

      const buffer = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();

      let mimeType = 'image/jpeg';
      if (ext === '.png') mimeType = 'image/png';
      else if (ext === '.webp') mimeType = 'image/webp';
      else if (ext === '.bmp') mimeType = 'image/bmp';
      else if (ext === '.gif') mimeType = 'image/gif';

      const base64 = buffer.toString('base64');
      return `data:${mimeType};base64,${base64}`;
    } catch (error) {
      console.error('讀取背景圖片失敗:', error);
      return null;
    }
  });
}

function registerNavigationIpc() {
  ipcMain.handle('open-settings-page', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;

    const settingsUrl = appendThemeQuery(
      SETTING_WINDOW_WEBPACK_ENTRY,
      getAppSettings()
    );

    await win.loadURL(settingsUrl);
    return true;
  });

  ipcMain.handle('open-library-page', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;

    const mainUrl = appendThemeQuery(
      MAIN_WINDOW_WEBPACK_ENTRY,
      getAppSettings()
    );

    await win.loadURL(mainUrl);
    return true;
  });

  ipcMain.handle('toggle-fullscreen', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;

    const nextState = !win.isFullScreen();
    win.setFullScreen(nextState);
    return nextState;
  });
}

function registerReaderIpc() {
  ipcMain.handle('open-reader-window', async (_event, book) => {
    recordRecentReading(book.filePath);
    markBookAsStarted(book.filePath);
    createReaderWindow(book.filePath, book.title);
    return true;
  });

  ipcMain.handle('get-recent-reading', async () => {
    return getRecentReading();
  });

  ipcMain.handle('clear-recent-reading', async () => {
    return clearRecentReading();
  });
}

function registerFileReadIpc() {
  ipcMain.handle('read-pdf-file', async (_event, filePath) => {
    return fs.readFileSync(filePath);
  });

  ipcMain.handle('read-cbz-file', async (_event, filePath) => {
    return fs.readFileSync(filePath);
  });
}

function registerCoverIpc() {
  ipcMain.handle('get-cover', async (_event, { filePath, width }) => {
    const coverPath = getCoverFilePath(filePath, width);

    if (fs.existsSync(coverPath)) {
      return coverPath;
    }

    return null;
  });

  ipcMain.handle('save-cover', async (_event, { filePath, buffer, width }) => {
    const coverPath = getCoverFilePath(filePath, width);
    fs.writeFileSync(coverPath, Buffer.from(buffer));

    const folderPath = path.dirname(filePath);
    const index = loadLibraryIndex(folderPath);

    const stat = getBookFileStat(filePath);
    const title = getBookTitle(path.basename(filePath));
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.cbz' ? 'cbz' : 'pdf';

    const existing = index.find((item) => item.filePath === filePath);

    if (existing) {
      existing.title = title;
      existing.type = type;
      existing.mtimeMs = stat.mtimeMs;
      existing.covers = existing.covers || {};
      existing.covers[String(width)] = coverPath;
    } else {
      index.push({
        filePath,
        title,
        type,
        mtimeMs: stat.mtimeMs,
        covers: {
          [String(width)]: coverPath,
        },
      });
    }

    saveLibraryIndex(folderPath, index);

    return coverPath;
  });

  ipcMain.handle('read-cover-data', async (_event, { filePath, width }) => {
    try {
      const coverPath = getCoverFilePath(filePath, width);

      if (!fs.existsSync(coverPath)) {
        return null;
      }

      const buffer = fs.readFileSync(coverPath);
      const base64 = buffer.toString('base64');

      return `data:image/jpeg;base64,${base64}`;
    } catch (error) {
      console.error('讀取磁碟封面失敗:', error);
      return null;
    }
  });
}

function registerPdfCacheIpc() {
  ipcMain.handle('get-pdf-page-cache', async (_event, payload) => {
    try {
      const cachePath = getPdfPageCacheFilePath(payload);

      if (!fs.existsSync(cachePath)) {
        return { found: false, buffer: null };
      }

      const buffer = fs.readFileSync(cachePath);

      return {
        found: true,
        buffer,
      };
    } catch (error) {
      console.error('讀取 PDF 頁面快取失敗:', error);
      return { found: false, buffer: null };
    }
  });

  ipcMain.handle('save-pdf-page-cache', async (_event, payload) => {
    try {
      const { buffer } = payload;

      if (!buffer) {
        throw new Error('buffer 無效');
      }

      const cachePath = getPdfPageCacheFilePath(payload);
      const fileBuffer = Buffer.from(buffer);

      fs.writeFileSync(cachePath, fileBuffer);

      return { success: true };
    } catch (error) {
      console.error('寫入 PDF 頁面快取失敗:', error);
      return { success: false, error: error.message };
    }
  });
}

function registerProgressAndTagsIpc() {
  ipcMain.handle('get-reading-progress', async (_event, filePath) => {
    return getReadingProgress(filePath);
  });

  ipcMain.handle('save-reading-progress', async (_event, { filePath, page, totalPages }) => {
    return saveReadingProgress(filePath, page, totalPages);
  });

  ipcMain.handle('clear-all-reading-progress', async () => {
    clearAllReadingProgress();
    broadcastAllReadingProgressCleared();
    return true;
  });

  ipcMain.handle('get-book-tags', async (_event, filePath) => {
    return getBookTags(filePath);
  });

  ipcMain.handle('set-book-favorite', async (_event, { filePath, isFavorite }) => {
    return setBookFavorite(filePath, isFavorite);
  });
}

function registerAllIpcHandlers() {
  registerFolderIpc();
  registerSettingsIpc();
  registerBackgroundIpc();
  registerNavigationIpc();
  registerReaderIpc();
  registerFileReadIpc();
  registerCoverIpc();
  registerPdfCacheIpc();
  registerProgressAndTagsIpc();
}

// ===== App 生命週期 =====
app.whenReady().then(() => {
  registerMyReaderProtocol();
  createWindow();
  registerAllIpcHandlers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
