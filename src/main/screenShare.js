// Screen sharing management extracted from main.js
const { desktopCapturer } = require('electron');
const { StreamSelector } = require('../display-capture');

let _mainWindow = null;
let _streamSelector = null;
let _getMainWindow = () => _mainWindow;

function getSelector(win) {
  if (!_streamSelector || _streamSelector.parentWindow !== win) {
    _streamSelector = new StreamSelector(win);
  }
  return _streamSelector;
}

function init(mainWindow) {
  _mainWindow = mainWindow;
  if (!_mainWindow) return;

  // Attach unified display media request handler
  _mainWindow.webContents.session.setDisplayMediaRequestHandler((request, callback) => {
    console.log('[ScreenShare] Display media request received');

    // Only forward a system-audio loopback track when the page actually asked
    // for share-audio. Otherwise the mic track and the loopback track end up
    // both being transmitted, which is heard as duplicated audio on the
    // remote side.
    const audioRequested = request && request.audioRequested === true;

    getSelector(_mainWindow).show((selectedSource) => {
      try {
        if (selectedSource) {
          console.log(`[ScreenShare] Source selected: ${selectedSource.name} (${selectedSource.id}); audioRequested=${audioRequested}`);
          global.selectedScreenShareSource = selectedSource;
          callback({ video: selectedSource, audio: audioRequested ? 'loopback' : false });
        } else {
          console.log('[ScreenShare] Selection cancelled by user');
          callback({ video: null, audio: null });
        }
      } catch (error) {
        console.error('[ScreenShare] Error during source selection:', error);
        callback({ video: null, audio: null });
      }
    });
  });
}

function setupIpcHandlers(ipcMain, getMainWindow) {
  if (getMainWindow) _getMainWindow = getMainWindow;

  ipcMain.handle('get-screen-sources-safe', async () => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['window', 'screen'],
        thumbnailSize: { width: 300, height: 300 },
        fetchWindowIcons: true
      });

      return sources
        .filter((source) => !source.name.includes('loginwindow') &&
          !source.name.includes('WindowServer') &&
          source.name.trim().length > 0)
        .map((source) => ({
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.toDataURL()
        }));
    } catch (error) {
      console.error('[ScreenShare] Error getting sources:', error);
      return [];
    }
  });

  // Trigger screen sharing from renderer
  ipcMain.on('trigger-screen-share', () => {
    console.log('[ScreenShare] Screen sharing triggered from renderer API');
    const win = _getMainWindow();
    if (!win || win.isDestroyed()) {
      console.error('[ScreenShare] Main window not available');
      return;
    }

    getSelector(win).show((selectedSource) => {
      if (win.isDestroyed()) return;
      if (selectedSource) {
        console.log(`[ScreenShare] Source selected via API: ${selectedSource.name} (${selectedSource.id})`);
        global.selectedScreenShareSource = selectedSource;
        win.webContents.send('screen-sharing-source-selected', {
          sourceId: selectedSource.id,
          sourceName: selectedSource.name,
          isActive: true,
        });
      } else {
        console.log('[ScreenShare] Selection cancelled via API');
        win.webContents.send('screen-sharing-source-selected', {
          isActive: false,
          cancelled: true,
        });
      }
    });
  });

  // Screen sharing stopped
  ipcMain.on('screen-sharing-stopped', () => {
    console.log('[ScreenShare] Screen sharing stopped');
    global.selectedScreenShareSource = null;

    const win = _getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send('screen-sharing-status-changed', { isActive: false });
    }
  });

  // Status
  ipcMain.handle('get-screen-sharing-status', () => {
    const isActive = global.selectedScreenShareSource !== null;
    console.log(`[ScreenShare] Status requested: ${isActive}`);
    return isActive;
  });

  // Provide selected stream id if still available
  ipcMain.handle('get-screen-share-stream', async () => {
    if (typeof global.selectedScreenShareSource === 'string') {
      return global.selectedScreenShareSource;
    } else if (global.selectedScreenShareSource?.id) {
      try {
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'] });
        const sourceExists = sources.find((s) => s.id === global.selectedScreenShareSource.id);
        if (!sourceExists) {
          console.warn('[ScreenShare] Selected source no longer available, clearing state');
          global.selectedScreenShareSource = null;
          return null;
        }
      } catch (error) {
        console.error('[ScreenShare] Error validating source:', error);
        return global.selectedScreenShareSource.id;
      }
      return global.selectedScreenShareSource.id;
    }
    console.log('[ScreenShare] No active screen share stream');
    return null;
  });

  // Provide screen dimensions when available
  ipcMain.handle('get-screen-share-screen', () => {
    if (global.selectedScreenShareSource && typeof global.selectedScreenShareSource === 'object') {
      const { screen } = require('electron');
      const displays = screen.getAllDisplays();
      if (global.selectedScreenShareSource?.id?.startsWith('screen:')) {
        const display = displays[0] || { size: { width: 1920, height: 1080 } };
        console.log(`[ScreenShare] Screen dimensions: ${display.size.width}x${display.size.height}`);
        return { width: display.size.width, height: display.size.height };
      }
    }
    console.log('[ScreenShare] Using default screen dimensions');
    return { width: 1920, height: 1080 };
  });

  // Legacy compatibility
  ipcMain.handle('desktop-capturer-get-sources', (_event, opts) => {
    console.log('[ScreenShare] Desktop capturer sources requested');
    return desktopCapturer.getSources(opts);
  });

  console.log('[ScreenShare] IPC handlers initialized');
}

module.exports = { init, setupIpcHandlers };
