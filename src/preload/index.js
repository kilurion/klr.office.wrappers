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
    'user-status-changed', 'set-badge-count', 'tray-update', 'account-info-changed',
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

  // Chromium suspends an AudioContext when its output device fails (Bluetooth switch,
  // standby) and never restarts it; Teams keeps using that context, so calls stay silent.
  function installAudioOutputRecovery() {
    const NativeAudioContext = window.AudioContext;
    if (!NativeAudioContext || window.__klrAudioRecovery) return;

    const LOG = '[AudioRecovery]';
    const MAX_ATTEMPTS = 8;
    const proto = NativeAudioContext.prototype;
    const nativeSuspend = proto.suspend;
    const nativeResume = proto.resume;
    const nativeSetSinkId = proto.setSinkId;

    const contexts = new Set();
    const pageSuspended = new WeakSet();
    const failed = new WeakSet();
    const attempts = new WeakMap();
    const timers = new WeakMap();

    proto.suspend = function () {
      pageSuspended.add(this);
      return nativeSuspend.apply(this, arguments);
    };
    proto.resume = function () {
      pageSuspended.delete(this);
      return nativeResume.apply(this, arguments);
    };

    function forEachContext(fn) {
      for (const ref of contexts) {
        const ctx = ref.deref();
        if (!ctx || ctx.state === 'closed') {
          contexts.delete(ref);
        } else {
          fn(ctx);
        }
      }
    }

    async function fallbackToDefaultSinkIfGone(ctx) {
      const sinkId = ctx.sinkId;
      if (!nativeSetSinkId || typeof sinkId !== 'string' || sinkId === '' || sinkId === 'default') return;
      const outputs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
      // Without media permission device ids are blank and the check is meaningless
      if (outputs.length === 0 || outputs.some(d => !d.deviceId) || outputs.some(d => d.deviceId === sinkId)) return;
      console.info(LOG, 'selected output device is gone, falling back to the system default');
      await nativeSetSinkId.call(ctx, '');
    }

    async function recover(ctx, reason) {
      timers.delete(ctx);
      if (ctx.state !== 'suspended' || pageSuspended.has(ctx)) return;
      attempts.set(ctx, (attempts.get(ctx) || 0) + 1);
      try {
        await fallbackToDefaultSinkIfGone(ctx);
      } catch (e) {
        console.warn(LOG, 'default sink fallback failed:', e && e.message);
      }
      if (ctx.state !== 'suspended' || pageSuspended.has(ctx)) return;
      console.info(LOG, `resuming AudioContext after ${reason} (attempt ${attempts.get(ctx)})`);
      // The promise only settles once audio renders again, so it is not awaited
      nativeResume.call(ctx).catch(e => console.warn(LOG, 'resume failed:', e && e.message));
    }

    function schedule(ctx, reason, delay) {
      clearTimeout(timers.get(ctx));
      const attempt = attempts.get(ctx) || 0;
      if (attempt >= MAX_ATTEMPTS) {
        console.warn(LOG, 'output still failing, waiting for the next device change');
        return;
      }
      const wait = delay ?? Math.min(500 * 2 ** attempt, 8000);
      timers.set(ctx, setTimeout(() => recover(ctx, reason), wait));
    }

    function track(ctx) {
      contexts.add(new WeakRef(ctx));
      ctx.addEventListener('error', () => {
        failed.add(ctx);
        console.warn(LOG, `audio output device error (state: ${ctx.state})`);
        schedule(ctx, 'device error');
      });
      ctx.addEventListener('sinkchange', () => {
        if (failed.has(ctx)) {
          attempts.delete(ctx);
          schedule(ctx, 'output device change', 0);
        }
      });
      ctx.addEventListener('statechange', () => {
        if (ctx.state === 'running' && failed.has(ctx)) {
          failed.delete(ctx);
          attempts.delete(ctx);
          console.info(LOG, 'audio output recovered');
        }
      });
    }

    function onEnvironmentChange(reason, restartRunning) {
      forEachContext((ctx) => {
        if (pageSuspended.has(ctx)) return;
        if (ctx.state === 'suspended' && failed.has(ctx)) {
          attempts.delete(ctx);
          schedule(ctx, reason, 0);
        } else if (restartRunning && ctx.state === 'running') {
          // Stopping and starting the destination opens a fresh output stream
          console.info(LOG, `restarting AudioContext output after ${reason}`);
          nativeSuspend.call(ctx)
            .then(() => nativeResume.call(ctx))
            .catch(e => console.warn(LOG, 'restart failed:', e && e.message));
        }
      });
    }

    const WrappedAudioContext = new Proxy(NativeAudioContext, {
      construct(target, args, newTarget) {
        const ctx = Reflect.construct(target, args, newTarget);
        track(ctx);
        return ctx;
      }
    });
    window.AudioContext = WrappedAudioContext;
    if (window.webkitAudioContext === NativeAudioContext) {
      window.webkitAudioContext = WrappedAudioContext;
    }

    if (navigator.mediaDevices) {
      let deviceChangeTimer = null;
      navigator.mediaDevices.addEventListener('devicechange', () => {
        clearTimeout(deviceChangeTimer);
        deviceChangeTimer = setTimeout(() => onEnvironmentChange('device change', false), 1000);
      });
    }

    Object.defineProperty(window, '__klrAudioRecovery', {
      value: Object.freeze({
        // Audio devices need a moment to come back after wake-up
        systemResumed: () => setTimeout(() => onEnvironmentChange('system resume', true), 2000)
      })
    });
  }

  if (typeof contextBridge.executeInMainWorld === 'function') {
    contextBridge.executeInMainWorld({ func: installAudioOutputRecovery });
    ipcRenderer.on('system-resumed', () => {
      contextBridge.executeInMainWorld({
        func: () => window.__klrAudioRecovery && window.__klrAudioRecovery.systemResumed()
      });
    });
  }

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

      // Method 2: Watch for Outlook's in-page alert-style notification toast
      // Outlook renders: <button aria-roledescription="Notification" aria-label="New mail from ...">
      // Structure (class names are obfuscated, so we use structural selectors):
      //   button[aria-roledescription="Notification"]
      //     div (avatar, has [role="img"])
      //     div (content, aria-hidden="true")
      //       div (sender row: sender name + button[title="Close"])
      //       div (subject row: contains subject/preview text)
      function setupBodyObserver() {
        const bodyObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;

              const btn = node.matches?.('button[aria-roledescription="Notification"]')
                ? node
                : node.querySelector?.('button[aria-roledescription="Notification"]');
              if (!btn) continue;

              // Sender from aria-label (stable accessibility attribute)
              const ariaLabel = btn.getAttribute('aria-label') || '';
              const senderMatch = ariaLabel.match(/^New mail from (.+)$/i);
              const sender = senderMatch ? senderMatch[1] : '';

              // Extract subject + preview using structural navigation (no class names)
              // Button children: [avatar div (has [role="img"]), content div]
              // Content div children: [sender row, subject/preview area...]
              let subject = '';
              const contentDiv = Array.from(btn.children).find(
                el => !el.querySelector('[role="img"]') && el.getAttribute('aria-hidden') === 'true'
              );
              if (contentDiv && contentDiv.children.length > 1) {
                // Skip first child (sender row), collect text from remaining children
                const parts = [];
                for (let i = 1; i < contentDiv.children.length; i++) {
                  const t = contentDiv.children[i].textContent?.trim()
                    .replace(/[\uE000-\uF8FF\uF000-\uFFFF]/g, '') // strip icon glyphs
                    .trim();
                  if (t) parts.push(t);
                }
                subject = parts.join(' — ');
              }

              const title = sender || 'New mail';
              const body = subject || ariaLabel || 'You have a new message';

              throttledSendNotification({ title: title, body: body });
            }
          }
        });

        bodyObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
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

      // Calendar Reminder Observer — detect Outlook reminder notifications in NotificationPane
      function setupCalendarReminderObserver() {
        const notifiedReminders = new Set();

        function checkForReminders(root) {
          // Outlook renders reminders as div[remindertype] with subject/time attributes
          const reminders = root.querySelectorAll
            ? root.querySelectorAll('div[remindertype][subject]')
            : [];

          for (const reminder of reminders) {
            const subject = reminder.getAttribute('subject') || '';
            const startTime = reminder.getAttribute('starttimedisplaystring') || '';
            const timeUntil = reminder.getAttribute('timeuntildisplaystring') || '';
            const location = reminder.getAttribute('location') || '';
            const reminderType = reminder.getAttribute('remindertype') || '';

            // Build a dedup key from subject + start time
            const dedupKey = `${subject}|${startTime}`;
            if (!subject || notifiedReminders.has(dedupKey)) continue;

            notifiedReminders.add(dedupKey);
            // Clean up old entries after 2 hours
            setTimeout(() => notifiedReminders.delete(dedupKey), 7200000);

            const title = reminderType === 'Calendar'
              ? `📅 ${subject}`
              : `🔔 ${subject}`;

            const bodyParts = [];
            if (startTime) bodyParts.push(startTime);
            if (timeUntil) bodyParts.push(`(${timeUntil})`);
            if (location) bodyParts.push(`📍 ${location}`);

            throttledSendNotification({
              title,
              body: bodyParts.join(' ') || 'Reminder'
            });
          }
        }

        const reminderObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType !== Node.ELEMENT_NODE) continue;

              if (node.matches?.('div[remindertype][subject]')) {
                checkForReminders(node.parentElement || node);
              } else {
                checkForReminders(node);
              }
            }
          }
        });

        reminderObserver.observe(document.body, {
          childList: true,
          subtree: true
        });
        console.log('✅ Outlook calendar reminder observer active');
      }

      if (document.body) {
        setupCalendarReminderObserver();
      } else {
        const waitBodyReminder = setInterval(() => {
          if (document.body) {
            clearInterval(waitBodyReminder);
            setupCalendarReminderObserver();
          }
        }, 100);
      }

      setupAudioInterceptor();
      console.log('✅ Outlook notification observers active (title + DOM + audio + calendar reminders)');
    }

    // Intercept page-world Notification API calls (catch-all for any web notifications)
    function setupNotificationApiInterceptor() {
      const script = document.createElement('script');
      script.textContent = `
        (function() {
          var OrigNotification = window.Notification;
          if (!OrigNotification) return;
          function forward(title, options) {
            try {
              window.postMessage({
                type: '__electron_notification_intercept',
                title: String(title),
                body: String((options && options.body) || '')
              }, '*');
            } catch(e) {}
          }
          // Return a stub instead of a real Notification: the main process shows its own
          // (with app icon), so a native Chromium one would be a duplicate.
          window.Notification = function(title, options) {
            forward(title, options);
            var stub = new EventTarget();
            stub.title = String(title);
            stub.body = (options && options.body) || '';
            stub.tag = (options && options.tag) || '';
            stub.data = options && options.data;
            stub.onclick = stub.onclose = stub.onerror = stub.onshow = null;
            stub.close = function() {};
            return stub;
          };
          if (window.ServiceWorkerRegistration && ServiceWorkerRegistration.prototype.showNotification) {
            ServiceWorkerRegistration.prototype.showNotification = function(title, options) {
              forward(title, options);
              return Promise.resolve();
            };
          }
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

    // Detect logged-in account email and send to main process for tray tooltip
    function setupAccountDetection() {
      let lastAccountEmail = '';

      function detectAccountEmail() {
        let email = '';

        // Method 1: Me control account panel — email is shown in #mectrl_currentAccount_secondary
        const secondaryEl = document.querySelector('#mectrl_currentAccount_secondary');
        if (secondaryEl) {
          const text = secondaryEl.textContent.trim();
          if (text.includes('@')) email = text;
        }

        // Method 2: "View account" link contains login_hint=email in its href
        if (!email) {
          const viewAccount = document.querySelector('#mectrl_viewAccount');
          if (viewAccount) {
            try {
              const href = viewAccount.getAttribute('href') || '';
              const url = new URL(href);
              const hint = url.searchParams.get('login_hint') || '';
              if (hint.includes('@')) email = hint;
            } catch { /* invalid URL, skip */ }
          }
        }

        // Method 3: MSAL cache in sessionStorage / localStorage
        if (!email) {
          for (const storage of [sessionStorage, localStorage]) {
            if (email) break;
            try {
              for (let i = 0; i < storage.length; i++) {
                const key = storage.key(i);
                if (!key) continue;
                if (key.includes('account') || key.includes('login.windows.net')) {
                  try {
                    const val = JSON.parse(storage.getItem(key));
                    const candidate = val.username || val.preferred_username || val.upn || '';
                    if (candidate.includes('@')) {
                      email = candidate;
                      break;
                    }
                  } catch { /* not JSON, skip */ }
                }
              }
            } catch { /* storage access denied, skip */ }
          }
        }

        if (email && email !== lastAccountEmail) {
          lastAccountEmail = email;
          console.log(`[Account] Detected account email: ${email}`);
          send('account-info-changed', { name: email });
        }
      }

      // Check periodically until found, then less frequently
      const quickInterval = setInterval(() => {
        detectAccountEmail();
        if (lastAccountEmail) {
          clearInterval(quickInterval);
          // Re-check occasionally in case of account switch
          setInterval(detectAccountEmail, 60000);
        }
      }, 3000);
    }

    setupAccountDetection();
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
