const {Notification, ipcMain, nativeImage, app} = require('electron');
const {execFile} = require('child_process');
const path = require('path');

function setupNotifications(mainWindow, iconPath) {

  // On Linux, use notify-send for reliable KDE Plasma / GNOME integration
  function showLinuxNotification(title, body) {
    const args = [
      '--app-name', app.name || 'Outlook',
      '--expire-time', '10000',
    ];
    if (iconPath) {
      args.push('--icon', iconPath);
    }
    args.push(title, body);

    execFile('notify-send', args, (error) => {
      if (error) {
        console.warn('[Notification] notify-send failed, falling back to Electron:', error.message);
        showElectronNotification(title, body);
      } else {
        console.log('[Notification] Shown via notify-send');
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
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      }
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

  // Main-process title monitoring — no IPC needed, works reliably on all platforms
  // Watches for Outlook's "(N)" unread count pattern in the page title
  if (mainWindow && mainWindow.webContents) {
    let lastUnreadCount = -1;

    mainWindow.webContents.on('page-title-updated', (event, title) => {
      const match = title.match(/\((\d+)\)/);
      const currentCount = match ? parseInt(match[1], 10) : 0;

      if (lastUnreadCount === -1) {
        lastUnreadCount = currentCount;
        console.log(`[Notification] Initial unread count: ${currentCount}`);
        return;
      }

      if (currentCount > lastUnreadCount) {
        const newMessages = currentCount - lastUnreadCount;
        console.log(`[Notification] Unread count changed: ${lastUnreadCount} → ${currentCount}`);
        showAppNotification(
          app.name || 'Microsoft Outlook',
          `You have ${newMessages} new message${newMessages !== 1 ? 's' : ''}`
        );
      }
      lastUnreadCount = currentCount;
    });

    console.log('[Notification] Main-process title observer active');
  }

  console.log('Notification event loaded!');
}

module.exports = {setupNotifications};