try {
  const { contextBridge, ipcRenderer } = require('electron');

  // Allowed IPC channels (inlined — sandboxed preload can't require() custom modules)
  const allowedChannels = new Set([
    'config-file-changed', 'get-config', 'get-system-idle-state', 'get-app-version',
    'get-zoom-level', 'save-zoom-level', 'zoom-change',
    'desktop-capturer-get-sources', 'choose-desktop-media', 'cancel-desktop-media',
    'trigger-screen-share', 'screen-sharing-started', 'screen-sharing-stopped',
    'screen-sharing-source-selected', 'get-screen-sharing-status',
    'get-screen-share-stream', 'get-screen-share-screen',
    'resize-preview-window', 'minimize-preview-window', 'close-preview-window',
    'stop-screen-sharing-from-thumbnail', 'source-selected', 'selection-cancelled',
    'new-notification', 'play-notification-sound', 'show-notification',
    'user-status-changed', 'set-badge-count', 'tray-update',
    'incoming-call-created', 'incoming-call-ended', 'incoming-call-action',
    'call-connected', 'call-disconnected',
    'submitForm', 'get-custom-bg-list', 'offline-retry', 'stop-sharing',
    'preload-executed'
  ]);

  contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
      console.log(`Sending on channel: ${channel}`, data);
      const validChannels = ['new-notification'];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);

      }
    },
  });


// IPC Security: Create a safe wrapper for ipcRenderer.send
const send = (channel, data) => {
  if (allowedChannels.has(channel)) {
    ipcRenderer.send(channel, data);
  } else {
    console.error(`[IPC Security] Blocked send to unauthorized channel: ${channel}`);
  }
};

// IPC Security: Create a safe wrapper for ipcRenderer.invoke
const invoke = async (channel, data) => {
  if (allowedChannels.has(channel)) {
    return await ipcRenderer.invoke(channel, data);
  } else {
    console.error(`[IPC Security] Blocked invoke to unauthorized channel: ${channel}`);
    throw new Error(`Unauthorized IPC channel: ${channel}`);
  }
};

// IPC Security: Create a safe wrapper for ipcRenderer.on
const on = (channel, func) => {
  if (allowedChannels.has(channel)) {
    // Deliberately strip event as it includes `sender`
    const subscription = (event, ...args) => func(...args);
    ipcRenderer.on(channel, subscription);

    // Return a cleanup function
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  } else {
    console.error(`[IPC Security] Blocked listener for unauthorized channel: ${channel}`);
    return () => {}; // Return a no-op cleanup function
  }
};

contextBridge.exposeInMainWorld('electron', {
  send,
  invoke,
  on,
  zoomChange: (direction) => send('zoom-change', direction),

  // Screen sharing API
  screenShare: {
    trigger: () => invoke('trigger-screen-share'),
    stop: () => send('screen-sharing-stopped'),
    getStatus: () => invoke('get-screen-sharing-status'),
    getStreamId: () => invoke('get-screen-share-stream'),
    getScreen: () => invoke('get-screen-share-screen'),
    onSourceSelected: (callback) => on('screen-sharing-source-selected', callback),
    onStatusChanged: (callback) => on('screen-sharing-status-changed', callback),
  },

  // Notification API
  notifications: {
    onNew: (callback) => on('new-notification', callback),
  },
});

  ipcRenderer.send('preload-executed');

  function throttle(callback, delay) {
    let lastCall = 0;
    return function(...args) {
      const now = new Date().getTime();
      if (now - lastCall < delay) {
        return;
      }
      lastCall = now;
      return callback(...args);
    };
  }

  function parseNotificationHtml(htmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlString, 'text/html');

    const notificationButton = doc.querySelector('button[aria-roledescription="Notification"]');
    if (!notificationButton) return { title: '', text: '' };

    const contentWrapper = notificationButton.querySelectorAll('div[aria-hidden="true"]')[1];
    if (!contentWrapper) return { title: '', text: '' };

    const innerDivs = contentWrapper.querySelectorAll('div');

    const title = innerDivs[0]?.textContent.trim() ?? '';
    const subtitle = innerDivs[1]?.textContent.trim() ?? '';
    const message = innerDivs[2]?.textContent.trim().replace(/\s+/g, ' ') ?? '';

    const fullText = [subtitle, message].filter(Boolean).join(' - ');

    return { title, text: fullText };
  }

  const throttledSendNotification = throttle((data) => {
    console.log('[Notification IPC] Sending:', JSON.stringify(data));
    ipcRenderer.send('new-notification', data);
  }, 500);

  window.addEventListener('DOMContentLoaded', () => {

    function setupNotificationObserver() {
      // Teams-specific notification area selectors — skip for non-Teams sites
      if (!location.hostname.includes('teams.cloud.microsoft') && !location.hostname.includes('teams.microsoft')) return;

      let notificationsArea = document.querySelector('div[data-tid="app-layout-area--notifications"]')
          || document.querySelector('div[data-app-section="NotificationPane"]');

      if (!notificationsArea) {
        setTimeout(setupNotificationObserver, 100);
        return;
      }

      console.log('✅ Found notifications area, setting up targeted observer');

      const observer = new MutationObserver((mutationsList) => {
        for (const mutation of mutationsList) {
          if (mutation.type === 'childList' && mutation.addedNodes.length) {

            const notificationContainer = Array.from(mutation.addedNodes).find(
              node => node.nodeType === Node.ELEMENT_NODE &&
                    node.matches('[data-tid^="notification-container"]')
            );

            if (notificationContainer) {
              const sender = notificationContainer.querySelector('span[id^="cn-normal-notification-toast-header-"]')?.innerText.trim();
              const messagePreview = notificationContainer.querySelector('span[id^="cn-normal-notification-main-content-"]')?.innerText.trim();

              if (sender && messagePreview) {
                throttledSendNotification({
                  title: sender,
                  body: messagePreview
                });
              }
            }

            Array.from(mutation.addedNodes).forEach(node => {
              console.log(node);
              console.log(node.outerHTML);
              console.log('-----');
              console.log(node.innerText);
            });

            mutation.addedNodes.forEach(node => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const notificationButton = node.querySelector('button[aria-roledescription="Notification"]');
                if (notificationButton) {
                  console.log('✅ Notification Button found:', notificationButton);

                  const message = parseNotificationHtml(notificationButton.outerHTML);

                  throttledSendNotification({
                    title: message.title,
                    body: message.text
                  });
                }
              }
            });

          }
        }
      });

      observer.observe(notificationsArea, {
        childList: true,
        subtree: true
      });

      console.log('✅ Teams notification MutationObserver active on notifications area!');
    }

    // Outlook: detect new mail via multiple methods
    function setupOutlookNotificationObserver() {
      if (!location.hostname.includes('outlook.office') && !location.hostname.includes('outlook.live') && !location.hostname.includes('outlook.cloud.microsoft')) return;

      // Method 1: Title change observer — match "(N)" anywhere in title
      let lastUnreadCount = -1;

      function checkTitle() {
        const match = document.title.match(/\((\d+)\)/);
        const currentCount = match ? parseInt(match[1], 10) : 0;

        if (lastUnreadCount === -1) {
          lastUnreadCount = currentCount;
          return;
        }

        if (currentCount > lastUnreadCount) {
          const newMessages = currentCount - lastUnreadCount;
          console.log(`[Outlook] Title unread count changed: ${lastUnreadCount} → ${currentCount}`);
          throttledSendNotification({
            title: 'Microsoft Outlook',
            body: `You have ${newMessages} new message${newMessages !== 1 ? 's' : ''}`
          });
        }
        lastUnreadCount = currentCount;
      }

      const titleEl = document.querySelector('title');
      if (titleEl) {
        new MutationObserver(checkTitle).observe(titleEl, {
          childList: true,
          characterData: true,
          subtree: true
        });
      }
      setInterval(checkTitle, 10000);

      // Method 2: Watch for Outlook's in-page notification toasts and banners
      // Outlook shows "new message" toasts, notification banners, and aria-live alerts
      function setupBodyObserver() {
        const processedNodes = new WeakSet();

        const bodyObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE || processedNodes.has(node)) continue;
              processedNodes.add(node);

              // Debug: log all meaningful added elements to figure out Outlook's toast DOM
              const tag = node.tagName?.toLowerCase();
              const cls = typeof node.className === 'string' ? node.className : '';
              const role = node.getAttribute?.('role') || '';
              const ariaLive = node.getAttribute?.('aria-live') || '';
              const text = node.textContent?.trim()?.substring(0, 200) || '';
              
              if (text.length > 3 && (
                ariaLive === 'assertive' || ariaLive === 'polite' ||
                role === 'alert' || role === 'status' ||
                cls.match(/notif|toast/i)
              )) {
                console.log(`[Outlook DOM] tag=${tag} role=${role} aria-live=${ariaLive} class=${cls.substring(0, 100)} text=${text.substring(0, 150)}`);
              }

              // Check for aria-live announcements (Outlook uses these for new mail)
              if (ariaLive === 'assertive' || ariaLive === 'polite') {
                const text = node.textContent?.trim();
                if (text && text.length > 5 && text.length < 300) {
                  console.log(`[Outlook] aria-live announcement: ${text}`);
                  throttledSendNotification({
                    title: 'Microsoft Outlook',
                    body: text
                  });
                  continue;
                }
              }

              // Check for notification toast containers (role="alert" or role="status")
              const alertEl = node.matches?.('[role="alert"], [role="status"]')
                ? node
                : node.querySelector?.('[role="alert"], [role="status"]');
              if (alertEl) {
                const text = alertEl.textContent?.trim();
                if (text && text.length > 5 && text.length < 300) {
                  console.log(`[Outlook] Alert/status element: ${text}`);
                  throttledSendNotification({
                    title: 'Microsoft Outlook',
                    body: text
                  });
                  continue;
                }
              }

              // Check for Outlook notification popover/toast by common class patterns
              const toastEl = node.querySelector?.('[class*="notification" i], [class*="toast" i], [data-app-section*="notification" i]')
                || (node.className && typeof node.className === 'string' &&
                    (node.className.toLowerCase().includes('notification') || node.className.toLowerCase().includes('toast'))
                    ? node : null);
              if (toastEl) {
                const text = toastEl.textContent?.trim();
                if (text && text.length > 5 && text.length < 300) {
                  console.log(`[Outlook] Toast/notification element: ${text}`);
                  throttledSendNotification({
                    title: 'Microsoft Outlook',
                    body: text
                  });
                }
              }
            }
          }
        });

        bodyObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
        console.log('✅ Outlook body MutationObserver active');
      }

      // Method 3: Intercept notification sound playback
      function setupAudioInterceptor() {
        const script = document.createElement('script');
        script.textContent = `
          (function() {
            var OrigAudio = window.Audio;
            var _origPlay = HTMLAudioElement.prototype.play;
            HTMLAudioElement.prototype.play = function() {
              var src = this.src || '';
              if (src.includes('notification') || src.includes('newmail') || src.includes('alert') || src.includes('sound')) {
                try {
                  window.postMessage({
                    type: '__electron_notification_sound',
                    src: src
                  }, '*');
                } catch(e) {}
              }
              return _origPlay.apply(this, arguments);
            };
          })();
        `;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
        console.log('✅ Outlook audio interceptor injected');
      }

      if (document.body) {
        setupBodyObserver();
      } else {
        const waitBody = setInterval(() => {
          if (document.body) {
            clearInterval(waitBody);
            setupBodyObserver();
          }
        }, 100);
      }

      setupAudioInterceptor();
      console.log('✅ Outlook notification observers active (title + DOM + audio)');
    }

    // Intercept page-world Notification API calls (catch-all for any web notifications)
    function setupNotificationApiInterceptor() {
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          var OrigNotification = window.Notification;
          if (!OrigNotification) return;
          window.Notification = function(title, options) {
            try {
              window.postMessage({
                type: '__electron_notification_intercept',
                title: String(title),
                body: String((options && options.body) || '')
              }, '*');
            } catch(e) {}
            return new OrigNotification(title, options);
          };
          Object.defineProperty(window.Notification, 'permission', {
            get: function() { return OrigNotification.permission; },
            configurable: true
          });
          window.Notification.requestPermission = function() {
            return OrigNotification.requestPermission.apply(OrigNotification, arguments);
          };
        })();
      `;
      (document.head || document.documentElement).appendChild(script);
      script.remove();
      console.log('✅ Notification API interceptor injected');
    }

    setupNotificationObserver();
    setupOutlookNotificationObserver();
    setupNotificationApiInterceptor();
  });

  // Listen for intercepted Notification API calls and sound events from the page world
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === '__electron_notification_intercept') {
      throttledSendNotification({
        title: event.data.title,
        body: event.data.body
      });
    }

    if (event.data.type === '__electron_notification_sound') {
      console.log(`[Outlook] Notification sound detected: ${event.data.src}`);
      throttledSendNotification({
        title: 'Microsoft Outlook',
        body: 'You have a new message'
      });
    }
  });

} catch (error) {
  console.error('❌ Error executing preload script:', error);
}
