(function () {
  'use strict';

  var config = window.__MATH_E2E__ || {};
  if (config.scenario !== 'retry-after-reload') return;

  var RETRY_PROMPT =
    'E2E ponovni pokušaj: reši jednačinu 2x + 3 = 11.';
  var CHAT_STORAGE = 'gemini_mobile_chats_v1';
  var IMAGE_DB_NAME = 'matematika_chat_images_v1';
  var IMAGE_DB_STORE = 'images';
  var stageKey = 'math-e2e-retry-stage:' + config.runId;
  var requestCountKey =
    'math-e2e-retry-request-count:' + config.runId;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  async function waitFor(find, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      var value = find();
      if (value) return value;
      await sleep(40);
    }
    throw new Error('Retry E2E driver timed out waiting for the app UI.');
  }

  function readChats() {
    try {
      var value = JSON.parse(localStorage.getItem(CHAT_STORAGE) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) {
      return [];
    }
  }

  function targetChat() {
    return readChats().find(function (chat) {
      return Array.isArray(chat && chat.messages) &&
        chat.messages.some(function (message) {
          return message &&
            message.role === 'user' &&
            message.text === RETRY_PROMPT;
        });
    }) || null;
  }

  function readSavedImage(imageId) {
    if (!imageId || !('indexedDB' in window)) {
      return Promise.resolve(null);
    }

    return new Promise(function (resolve) {
      var open = indexedDB.open(IMAGE_DB_NAME, 1);
      open.onerror = function () { resolve(null); };
      open.onupgradeneeded = function () {
        try { open.transaction.abort(); } catch (_) {}
        resolve(null);
      };
      open.onsuccess = function () {
        var db = open.result;
        try {
          if (!db.objectStoreNames.contains(IMAGE_DB_STORE)) {
            db.close();
            resolve(null);
            return;
          }
          var tx = db.transaction(IMAGE_DB_STORE, 'readonly');
          var request = tx.objectStore(IMAGE_DB_STORE).get(imageId);
          request.onerror = function () {
            db.close();
            resolve(null);
          };
          request.onsuccess = function () {
            var blob = request.result && request.result.blob;
            db.close();
            resolve(blob || null);
          };
        } catch (_) {
          db.close();
          resolve(null);
        }
      };
    });
  }

  function matchingDomUserCount() {
    return Array.from(
      document.querySelectorAll('#chat .msg.user .bubble')
    ).filter(function (bubble) {
      return String(bubble.textContent || '').includes(RETRY_PROMPT);
    }).length;
  }

  async function snapshot(label) {
    var chat = targetChat();
    var messages = Array.isArray(chat && chat.messages)
      ? chat.messages
      : [];
    var matchingUsers = messages.filter(function (message) {
      return message &&
        message.role === 'user' &&
        message.text === RETRY_PROMPT;
    });
    var models = messages.filter(function (message) {
      return message && message.role === 'model';
    });
    var savedUser = matchingUsers[0] || null;
    var blob = await readSavedImage(savedUser && savedUser.imageId);

    var evidence = {
      label: label,
      stage: sessionStorage.getItem(stageKey) || '',
      loadOrdinal: Number(
        sessionStorage.getItem('math-e2e-load-count:' + config.runId) || 0
      ),
      storage: {
        chatFound: Boolean(chat),
        roles: messages.map(function (message) { return message.role || ''; }),
        totalMessages: messages.length,
        matchingUserMessages: matchingUsers.length,
        modelMessages: models.length,
        lastRole: messages.length
          ? String(messages[messages.length - 1].role || '')
          : '',
        savedPrompt: savedUser ? String(savedUser.text || '') : '',
        hadImage: Boolean(savedUser && savedUser.hadImage),
        imageIdPresent: Boolean(savedUser && savedUser.imageId),
        completedModels: models.filter(function (message) {
          return message.completionState === 'completed';
        }).length
      },
      indexedImage: {
        found: Boolean(blob),
        mimeType: blob ? String(blob.type || '') : '',
        bytes: blob ? Number(blob.size || 0) : 0
      },
      dom: {
        userBubbles: document.querySelectorAll('#chat .msg.user').length,
        matchingUserBubbles: matchingDomUserCount(),
        modelBubbles: document.querySelectorAll('#chat .msg.model').length,
        completedModels:
          document.querySelectorAll('#chat .completionMeta.completed').length,
        promptValue: String(
          (document.getElementById('prompt') || {}).value || ''
        ),
        sendDisabled: Boolean(
          (document.getElementById('send') || {}).disabled
        )
      }
    };

    try {
      await fetch(
        '/__harness__/client-evidence?scenario=' +
          encodeURIComponent(config.scenario) +
          '&run=' + encodeURIComponent(config.runId),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(evidence)
        }
      );
    } catch (_) {}

    return evidence;
  }

  async function openPendingChat() {
    if (matchingDomUserCount() === 1) return;

    var historyButton = await waitFor(function () {
      return document.getElementById('historyBtn');
    });
    historyButton.click();

    var openButton = await waitFor(function () {
      return document.querySelector('#historyList .historyOpen');
    });
    openButton.click();

    await waitFor(function () {
      return matchingDomUserCount() === 1;
    });
  }

  async function prepareAndSendFirstAttempt() {
    sessionStorage.setItem(stageKey, 'preparing-first-send');

    var input = await waitFor(function () {
      return document.getElementById('galleryInput');
    });
    var response = await fetch(
      '/tests/e2e/fixtures/linear-equation.png',
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error('Retry fixture could not be loaded.');

    var blob = await response.blob();
    var file = new File([blob], 'linear-equation.png', {
      type: 'image/png'
    });
    var transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));

    await waitFor(function () {
      return document.getElementById('previewWrap')
        ?.classList.contains('show');
    });

    var prompt = document.getElementById('prompt');
    prompt.value = RETRY_PROMPT;
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    await snapshot('before-first-send');

    sessionStorage.setItem(stageKey, 'first-send-clicked');
    document.getElementById('send').click();
  }

  async function resumeAfterReload() {
    sessionStorage.setItem(stageKey, 'opening-pending-chat');
    await waitFor(function () { return document.getElementById('send'); });
    await snapshot('after-reload-before-open');
    await openPendingChat();
    await snapshot('after-reload-pending-open');

    var prompt = document.getElementById('prompt');
    if (prompt) {
      prompt.value = '';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }

    sessionStorage.setItem(stageKey, 'retry-send-clicked');
    document.getElementById('send').click();
  }

  async function afterRetryCompletes() {
    await sleep(900);
    await snapshot('after-retry-completed');

    var prompt = document.getElementById('prompt');
    if (prompt) {
      prompt.value = '';
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    }

    document.getElementById('send').click();
    await sleep(350);
    sessionStorage.setItem(stageKey, 'done');
    await snapshot('after-completed-empty-send');
  }

  function onGeminiRequest() {
    var count = Number(sessionStorage.getItem(requestCountKey) || 0) + 1;
    sessionStorage.setItem(requestCountKey, String(count));

    if (count === 1) {
      sessionStorage.setItem(stageKey, 'first-request-started');
      var reloadStarted = false;
      var reloadOnce = function () {
        if (reloadStarted) return;
        reloadStarted = true;
        sessionStorage.setItem(stageKey, 'reloading');
        location.reload();
      };
      setTimeout(reloadOnce, 2500);
      void snapshot('first-request-started').finally(function () {
        setTimeout(reloadOnce, 250);
      });
      return;
    }

    if (count === 2) {
      sessionStorage.setItem(stageKey, 'retry-request-started');
      void snapshot('retry-request-started');
      void afterRetryCompletes();
    }
  }

  window.__MATH_E2E_RETRY__ = {
    prompt: RETRY_PROMPT,
    onGeminiRequest: onGeminiRequest,
    snapshot: snapshot
  };

  var loadCountKey = 'math-e2e-load-count:' + config.runId;
  var loadCount = Number(sessionStorage.getItem(loadCountKey) || 0) + 1;
  sessionStorage.setItem(loadCountKey, String(loadCount));

  setTimeout(function () {
    var stage = sessionStorage.getItem(stageKey) || '';
    var action = stage === 'reloading'
      ? resumeAfterReload()
      : stage === 'done'
        ? Promise.resolve()
        : prepareAndSendFirstAttempt();

    action.catch(function (error) {
      console.error('[Math E2E retry driver]', error);
      void snapshot('driver-error');
    });
  }, 0);
})();
