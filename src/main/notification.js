const {Notification, ipcMain, nativeImage, app} = require('electron');
const {execFile} = require('child_process');
const fs = require('fs');
const path = require('path');

// The notification daemon can't read files inside app.asar, so copy the icon out once
function resolveExternalIcon(iconPath) {
  if (!iconPath || !iconPath.includes('.asar')) return iconPath;
  try {
    const target = path.join(app.getPath('userData'), 'notification-icon' + path.extname(iconPath));
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, fs.readFileSync(iconPath));
    }
    return target;
  } catch (error) {
    console.warn('[Notification] Could not extract icon:', error.message);
    return null;
  }
}

function setupNotifications(mainWindow, iconPath) {
  const externalIconPath = resolveExternalIcon(iconPath);

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
    if (externalIconPath) {
      args.push('--icon', externalIconPath);
    }
    args.push(title, body);

    execFile('notify-send', args, (error, stdout) => {
      if (error) {
        // A non-zero exit can happen after the notification was already shown
        if (error.code === 'ENOENT') {
          console.warn('[Notification] notify-send not found, falling back to Electron');
          showElectronNotification(title, body);
        } else {
          console.warn('[Notification] notify-send exited with an error:', error.message);
        }
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