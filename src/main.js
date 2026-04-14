const { app, BrowserWindow, ipcMain, dialog, protocol } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { DEFAULT_THEME, normalizeThemeColor } = require('./renderer/theme');

// ===== 視窗狀態 =====
let mainWindow = null;
let readerWindow = null;

// ===== 視窗建立 =====
/**
 * 建立主視窗
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    autoHideMenuBar: true,
    webPreferences: {
      preload: MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // ===== CSP（目前保留註解，不啟用） =====
  // 在視窗建立後、loadURL 前，注入 CSP
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

  // ===== DevTools（正式使用先關閉） =====
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
      nodeIntegration: false
    }
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

  readerWindow.on('closed', () => {
    readerWindow = null;
  });
}

// ===== 書籍工具函式 =====
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

// ===== 書庫資料夾與索引 =====
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

// ===== 封面快取工具 =====
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

// ===== PDF 頁面快取工具 =====
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
  const safeRenderScaleMultiplier =
  Number.isFinite(Number(renderScaleMultiplier))
    ? Number(renderScaleMultiplier)
    : 1;

  const fileName =
  `${safeFitMode}_${safeWidth}x${safeHeight}_dpr${safeDpr}_rs${safeRenderScaleMultiplier}_page_${safePageNumber}.webp`;

  return path.join(bookDir, fileName);
}

// ===== App 狀態工具 =====
/**
 * 取得 app-state.json 路徑
 */
function getAppStateFilePath() {
  return path.join(app.getPath('userData'), 'app-state.json');
}

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
 * 讀取 app 狀態
 * 目前包含：
 * 1. 上次開啟的書庫資料夾
 * 2. 各書籍的閱讀進度
 */
function loadAppState() {
  const stateFilePath = getAppStateFilePath();

  if (!fs.existsSync(stateFilePath)) {
    return {
      lastLibraryFolder: '',
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
      },
      recentReading: [],
    };
  }

  try {
    const raw = fs.readFileSync(stateFilePath, 'utf-8');
    const parsed = JSON.parse(raw);

    return {
      lastLibraryFolder: parsed.lastLibraryFolder || '',
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
      },
    };
  } catch (error) {
    console.error('讀取 app-state.json 失敗:', error);
    return {
      lastLibraryFolder: '',
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

/**
 * 儲存上次開啟的書庫資料夾
 */
function saveLastLibraryFolder(folderPath) {
  const state = loadAppState();
  state.lastLibraryFolder = folderPath || '';
  saveAppState(state);
}

/**
 * 取得上次開啟的書庫資料夾
 */
function getLastLibraryFolder() {
  const state = loadAppState();
  return state.lastLibraryFolder || '';
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
  };
}

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
    readingHistoryVisibility: settings.readingHistoryVisibility === 'shown'
    ? 'shown'
    : 'hidden',
    appearanceTheme: settings.appearanceTheme === 'light'
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
  };

  saveAppState(state);
  broadcastSettingsUpdate(state.settings);
  return state.settings;
}

/**
 * 讀取指定書籍的閱讀進度
 * 若檔案不存在，或大小 / 修改時間對不上，就視為無效
 */
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

/**
 * 儲存指定書籍的閱讀進度
 */
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

  // 若本來就有閱讀紀錄，就不覆蓋既有頁碼
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

  return list.filter((filePath) => filePath && fs.existsSync(filePath)).slice(0, 10);
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

// ===== 自訂 protocol 註冊 =====
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

// ===== App 初始化 =====
app.whenReady().then(() => {
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
        ext === '.png' ? 'image/png' :
        ext === '.webp' ? 'image/webp' :
        'image/jpeg';

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

  createWindow();

  // ===== IPC：選擇書庫資料夾 =====
  ipcMain.handle('pick-library-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  // ===== IPC：掃描書庫 =====
  ipcMain.handle('scan-library', async (_event, folderPath) => {
    return await scanLibrary(folderPath);
  });

  // ===== IPC：App 設定 =====
  ipcMain.handle('get-app-settings', async () => {
    return getAppSettings();
  });

  ipcMain.handle('save-app-settings', async (_event, settings) => {
    return saveAppSettings(settings);
  });

  // ===== IPC：取得上次書庫 =====
  ipcMain.handle('get-last-library-folder', async () => {
    const folderPath = getLastLibraryFolder();

    if (!folderPath || !fs.existsSync(folderPath)) {
      return '';
    }

    return folderPath;
  });

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

  // ===== IPC：切換全螢幕 =====
  ipcMain.handle('toggle-fullscreen', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;

    const nextState = !win.isFullScreen();
    win.setFullScreen(nextState);
    return nextState;
  });

  // ===== IPC：開啟閱讀視窗 =====
  ipcMain.handle('open-reader-window', async (_event, book) => {
  recordRecentReading(book.filePath);

  markBookAsStarted(book.filePath);

  createReaderWindow(book.filePath, book.title);
  return true;
  });

  ipcMain.handle('get-recent-reading', async () => {
  return getRecentReading();
  });

  // ===== IPC：讀取 PDF / CBZ 原始檔 =====
  ipcMain.handle('read-pdf-file', async (_event, filePath) => {
    const buffer = fs.readFileSync(filePath);
    return buffer;
  });

  ipcMain.handle('read-cbz-file', async (_event, filePath) => {
    const buffer = fs.readFileSync(filePath);
    return buffer;
  });

  // ===== IPC：封面快取 =====
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

  // ===== IPC：PDF 頁面快取 =====
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

  // ===== IPC：閱讀進度 =====
  ipcMain.handle('get-reading-progress', async (_event, filePath) => {
  return getReadingProgress(filePath);
  });

  ipcMain.handle('save-reading-progress', async (_event, { filePath, page, totalPages }) => {
  return saveReadingProgress(filePath, page, totalPages);
  });

  ipcMain.handle('get-book-tags', async (_event, filePath) => {
  return getBookTags(filePath);
  });

  ipcMain.handle('set-book-favorite', async (_event, { filePath, isFavorite }) => {
  return setBookFavorite(filePath, isFavorite);
  });

  // ===== macOS：重新啟用 app 時補建主視窗 =====
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

// ===== App 關閉 =====
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
