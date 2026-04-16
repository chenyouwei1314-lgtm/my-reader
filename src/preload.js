const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('readerAPI', {
  pickLibraryFolder: () => ipcRenderer.invoke('pick-library-folder'),
  scanLibrary: (folderPath) => ipcRenderer.invoke('scan-library', folderPath),
  getLastLibraryFolder: () => ipcRenderer.invoke('get-last-library-folder'),

  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  saveAppSettings: (settings) => ipcRenderer.invoke('save-app-settings', settings),

  pickBackgroundImage: () => ipcRenderer.invoke('pick-background-image'),
  getLastSelectedBook: () => ipcRenderer.invoke('get-last-selected-book'),
  saveLastSelectedBook: (filePath) => ipcRenderer.invoke('save-last-selected-book', filePath),

  onAppSettingsUpdated: (callback) => {
    ipcRenderer.on('app-settings-updated', (_event, settings) => {
      callback(settings);
    });
  },

  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  openSettingsPage: () => ipcRenderer.invoke('open-settings-page'),
  openLibraryPage: () => ipcRenderer.invoke('open-library-page'),
  openReaderWindow: (book) => ipcRenderer.invoke('open-reader-window', book),

  readPdfFile: (filePath) => ipcRenderer.invoke('read-pdf-file', filePath),
  readCbzFile: (filePath) => ipcRenderer.invoke('read-cbz-file', filePath),

  getCover: (filePath, width) => ipcRenderer.invoke('get-cover', { filePath, width }),
  saveCover: (filePath, buffer, width) =>
    ipcRenderer.invoke('save-cover', { filePath, buffer, width }),
  readCoverData: (filePath, width) =>
    ipcRenderer.invoke('read-cover-data', { filePath, width }),
  readImageData: (filePath) =>
  ipcRenderer.invoke('read-image-data', filePath),

  getPdfPageCache: (payload) => ipcRenderer.invoke('get-pdf-page-cache', payload),
  savePdfPageCache: (payload) => ipcRenderer.invoke('save-pdf-page-cache', payload),

  getReadingProgress: (filePath) => ipcRenderer.invoke('get-reading-progress', filePath),
  saveReadingProgress: (filePath, page, totalPages) =>
    ipcRenderer.invoke('save-reading-progress', { filePath, page, totalPages }),

  onBookTagsUpdated: (callback) => {
    ipcRenderer.on('book-tags-updated', (_event, payload) => {
      callback(payload);
    });
  },

  onReadingProgressUpdated: (callback) => {
    ipcRenderer.on('reading-progress-updated', (_event, payload) => {
      callback(payload);
    });
  },

  getBookTags: (filePath) => ipcRenderer.invoke('get-book-tags', filePath),
  setBookFavorite: (filePath, isFavorite) =>
    ipcRenderer.invoke('set-book-favorite', { filePath, isFavorite }),

  getRecentReading: () => ipcRenderer.invoke('get-recent-reading'),
});
