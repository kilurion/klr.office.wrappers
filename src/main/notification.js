const {Notification, ipcMain, nativeImage, app} = require('electron');
const {execFile} = require('child_process');
const path = require('path');

function setupNotifications(mainWindow, iconPath) {

  function focusMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  }

  // On Linux, use notify-send for reliable KDE Plasma / GNOME integration
  function showLinuxNotification(title, body) {
    const args = [
      '--app-name', app.name || 'Outlook',
      '--expire-time', '10000',
      '--action=default=Open',
    ];
    if (iconPath) {
      args.push('--icon', iconPath);
    }
    args.push(title, body);

    execFile('notify-send', args, (error, stdout) => {
      if (error) {
        console.warn('[Notification] notify-send failed, falling back to Electron:', error.message);
        showElectronNotification(title, body);
      } else {
        if (stdout && stdout.trim() === 'default') {
          console.log('[Notification] Clicked, focusing window');
          focusMainWindow();
        } else {
          console.log('[Notification] Shown via notify-send');
        }
      }
    });
  }

  function showElectronNotification(title, body) {
    const notificationIcon = iconPath ? nativeImage.createFromPath(iconPath) : null;
    const notification = new Notification({
      title: title,
      body: body,
      silent: false,
      icon: notificationIcon,
      hasReply: false
    });

    notification.on('click', () => {
      focusMainWindow();
    });

    notification.show();
    setTimeout(() => notification.close(), 10000);
  }

  function showAppNotification(title, body) {
    try {
      if (process.platform === 'linux') {
        showLinuxNotification(title, body);
      } else {
        showElectronNotification(title, body);
      }

      // Flash taskbar when window isn't focused
      if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
        mainWindow.flashFrame(true);
      }
    } catch (error) {
      console.error('Notification error:', error);
    }
  }

  ipcMain.on('new-notification', (event, data) => {
    console.log('Received notification request via IPC:', data);
    showAppNotification(data.title, data.body);
  });

  console.log('Notification event loaded!');
}

module.exports = {setupNotifications};