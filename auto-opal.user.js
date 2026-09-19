// ==UserScript==
// @name         Opal Auto Run
// @namespace    opal-auto-run
// @version      2026-09-19.4
// @description  Auto run queued text inputs in an Opal app.
// @author       You
// @match        https://opal.google/app/*
// @icon         https://opal.google/images/favicon.png
// @run-at       document-idle
// @grant        GM_download
// @grant        unsafeWindow
// ==/UserScript==

(async function () {
  "use strict";

  if (window.top !== window.self) return;
  if (!location.pathname.startsWith("/app/")) return;

  const config = {
    textQueue: [
      // Optional fallback queue when IndexedDB has no imported chapters.
      // "First text",
      // "Second text",
    ],
    automationStepDelayMs: 1000,
    actionCooldownMs: 800,
    automationPollMs: 1000,
    downloadInterceptionTimeoutMs: 10000,
    missingOutputRetryDelayMs: 5000,
  };

  const selectors = {
    iframe: "#opal-app",
    reloadButton: "#replay",
    startButton: "#run",
    textInput: "#text-input",
    submitButton: "#continue",
    progress: "#progress",
    errorSection: "section.error",
    exportButton: "#export-output-button",
    errorClose: '#close',
  };

  const appKey = getAppKey();
  const dbName = `opal-auto-run:${appKey}`;
  const currentIndexKey = `opal-auto-run-current-index:${appKey}`;

  const state = {
    db: null,
    queueSize: 0,
    usesIndexedDbQueue: false,
    isAutoRunEnabled: false,
    lastActionAt: 0,
    clickedReload: false,
    clickedStart: false,
    exportedCurrentText: false,
    isAdvancingToNextText: false,
    isRunning: false,
    submittedAt: 0,
    submittedText: null,
    frameObserver: null,
    observedFrameDocument: null,
    lastStep: "Idle",
    autoRunButton: null,
    statusElement: null,
  };

  function getAppKey() {
    const pathParts = location.pathname.split("/").filter(Boolean);
    const appId = pathParts[0] === "app" ? pathParts[1] : location.pathname;

    return String(appId || "unknown").replace(/[^a-zA-Z0-9_-]+/g, "-");
  }

  function getFrame() {
    const pageWindow = typeof unsafeWindow === "undefined" ? window : unsafeWindow;
    return pageWindow.document.querySelector(selectors.iframe);
  }

  function getFrameDocument() {
    const frame = getFrame();

    try {
      return frame?.contentDocument || frame?.contentWindow?.document || null;
    } catch {
      return null;
    }
  }

  function deepQuerySelector(root, selector) {
    if (!root) return null;

    const directMatch = root.querySelector?.(selector);
    if (directMatch) return directMatch;

    const elements = root.querySelectorAll?.("*") || [];

    for (const element of elements) {
      if (!element.shadowRoot) continue;

      const shadowMatch = deepQuerySelector(element.shadowRoot, selector);
      if (shadowMatch) return shadowMatch;
    }

    return null;
  }

  function getElement(selector) {
    return deepQuerySelector(getFrameDocument(), selector);
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(dbName, 1);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains("chapters")) {
          db.createObjectStore("chapters", { keyPath: "index" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function databaseRequest(storeName, mode, callback) {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = callback(store);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      transaction.onerror = () => reject(transaction.error);
    });
  }

  async function getImportedChapterCount() {
    return databaseRequest("chapters", "readonly", (store) => store.count());
  }

  async function getImportedChapter(index) {
    return databaseRequest("chapters", "readonly", (store) => store.get(index));
  }

  function replaceImportedChapters(chapters) {
    return new Promise((resolve, reject) => {
      const transaction = state.db.transaction("chapters", "readwrite");
      const store = transaction.objectStore("chapters");

      store.clear();
      chapters.forEach((chapter, index) => {
        store.put({
          index,
          name: chapter.name,
          text: chapter.text,
        });
      });

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function getCurrentIndex() {
    const value = Number(window.localStorage.getItem(currentIndexKey) || "0");
    return Number.isInteger(value) && value >= 0 ? value : 0;
  }

  function setCurrentIndex(index) {
    window.localStorage.setItem(currentIndexKey, String(index));
  }

  function isAutoRunEnabled() {
    return state.isAutoRunEnabled;
  }

  function setAutoRunEnabled(isEnabled) {
    state.isAutoRunEnabled = isEnabled;
    updateAutoRunButton();
    renderStatus();
  }

  function updateAutoRunButton() {
    if (!state.autoRunButton) return;

    state.autoRunButton.textContent = isAutoRunEnabled() ? "Stop" : "Auto Run";
  }

  async function refreshQueueState() {
    const importedCount = await getImportedChapterCount();

    state.usesIndexedDbQueue = importedCount > 0;
    state.queueSize = state.usesIndexedDbQueue
      ? importedCount
      : config.textQueue.length;

    if (getCurrentIndex() > state.queueSize) {
      setCurrentIndex(0);
    }

    renderStatus();
  }

  async function getCurrentText() {
    const currentIndex = getCurrentIndex();

    if (!state.usesIndexedDbQueue) {
      return config.textQueue[currentIndex] || "";
    }

    const chapter = await getImportedChapter(currentIndex);
    return chapter?.text || "";
  }

  async function getCurrentImportedFileName() {
    if (!state.usesIndexedDbQueue) return null;

    const chapter = await getImportedChapter(getCurrentIndex());
    return chapter?.name || null;
  }

  function sanitizePathSegment(value, fallback) {
    const sanitized = String(value || "")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+$/, "");

    return sanitized || fallback;
  }

  function getStoryFolderName() {
    return sanitizePathSegment(document.title, "opal-output");
  }

  function buildDownloadPath(folderName, fileName) {
    return `${folderName}/${fileName}`;
  }

  function hasNextText() {
    return getCurrentIndex() < state.queueSize;
  }

  function isVisible(element) {
    if (!element) return false;

    const view = element.ownerDocument.defaultView || window;
    const style = view.getComputedStyle(element);
    const rect = element.getBoundingClientRect();

    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function isDisabled(element) {
    return (
      !element ||
      element.disabled ||
      element.getAttribute("aria-disabled") === "true"
    );
  }

  function canAct() {
    return Date.now() - state.lastActionAt >= config.actionCooldownMs;
  }

  function markAction() {
    state.lastActionAt = Date.now();
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  async function waitForNextAutomationStep() {
    await wait(config.automationStepDelayMs);
    return isAutoRunEnabled();
  }

  function clickElement(element) {
    if (!isVisible(element) || isDisabled(element) || !canAct()) return false;

    element.click();
    markAction();
    return true;
  }

  function describeElementState(selector) {
    const element = getElement(selector);

    if (!element) return `${selector} not found`;

    return `${selector} found visible=${isVisible(element)} disabled=${isDisabled(element)}`;
  }

  function setInputValue(element, value) {
    const view = element.ownerDocument.defaultView || window;
    const descriptor =
      Object.getOwnPropertyDescriptor(element.constructor.prototype, "value") ||
      Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, "value");

    if (descriptor?.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }

    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function hasProgress() {
    return isVisible(getElement(selectors.progress));
  }

  function hasCompletedOutput() {
    return isVisible(getElement(selectors.exportButton));
  }

  function interceptNextDownload(ownerDocument, folderName, fileName) {
    if (!fileName) {
      return {
        completion: Promise.resolve({ usedStoryFolder: false }),
        restore: () => {},
      };
    }

    const frame = getFrame();
    const view = frame?.contentWindow || ownerDocument.defaultView;
    const anchorPrototype = view?.HTMLAnchorElement?.prototype;
    const originalClick = anchorPrototype?.click;
    const originalRevokeObjectUrl = view?.URL?.revokeObjectURL;

    if (
      !anchorPrototype ||
      typeof originalClick !== "function" ||
      typeof originalRevokeObjectUrl !== "function"
    ) {
      return {
        completion: Promise.resolve({ usedStoryFolder: false }),
        restore: () => {},
      };
    }

    let timeoutId = null;
    let isCompleted = false;
    let isRestored = false;
    let pendingObjectUrl = null;
    let downloadAnchor = null;
    let resolveCompletion;
    let rejectCompletion;

    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const restore = () => {
      if (isRestored) return;

      isRestored = true;
      if (anchorPrototype.click === interceptedClick) {
        anchorPrototype.click = originalClick;
      }
      if (view.URL.revokeObjectURL === interceptedRevokeObjectUrl) {
        view.URL.revokeObjectURL = originalRevokeObjectUrl;
      }
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };

    const releaseObjectUrl = () => {
      if (!pendingObjectUrl) return;

      originalRevokeObjectUrl.call(view.URL, pendingObjectUrl);
      pendingObjectUrl = null;
    };

    const complete = (usedStoryFolder) => {
      if (isCompleted) return;

      isCompleted = true;
      releaseObjectUrl();
      restore();
      resolveCompletion({ usedStoryFolder });
    };

    const fallbackToAnchorDownload = (error) => {
      if (isCompleted) return;

      console.warn(
        "GM_download failed, falling back to the browser download:",
        error
      );

      if (!downloadAnchor) {
        isCompleted = true;
        releaseObjectUrl();
        restore();
        rejectCompletion(error);
        return;
      }

      downloadAnchor.download = fileName;
      ownerDocument.body.appendChild(downloadAnchor);
      originalClick.call(downloadAnchor);
      downloadAnchor.remove();
      complete(false);
    };

    const interceptedRevokeObjectUrl = function (url) {
      if (url === pendingObjectUrl) return;

      return originalRevokeObjectUrl.call(this, url);
    };

    const interceptedClick = function (...args) {
      const href = this.href || "";
      const isDownload =
        this.hasAttribute("download") ||
        href.startsWith("blob:") ||
        href.startsWith("data:");

      if (isDownload) {
        this.download = fileName;
        downloadAnchor = this;
        if (timeoutId !== null) {
          window.clearTimeout(timeoutId);
          timeoutId = null;
        }

        if (typeof GM_download !== "function") {
          const result = originalClick.apply(this, args);
          complete(false);
          return result;
        }

        pendingObjectUrl = href;

        try {
          GM_download({
            url: href,
            name: buildDownloadPath(folderName, fileName),
            saveAs: false,
            onload: () => complete(true),
            onerror: fallbackToAnchorDownload,
            ontimeout: () => {
              fallbackToAnchorDownload(new Error("Download timed out"));
            },
          });
          return undefined;
        } catch (error) {
          pendingObjectUrl = null;
          const result = originalClick.apply(this, args);
          complete(false);
          console.warn(
            "Unable to start GM_download, using the browser download:",
            error
          );
          return result;
        }
      }

      return originalClick.apply(this, args);
    };

    anchorPrototype.click = interceptedClick;
    view.URL.revokeObjectURL = interceptedRevokeObjectUrl;
    timeoutId = window.setTimeout(
      () => {
        if (isCompleted) return;

        isCompleted = true;
        restore();
        rejectCompletion(new Error("Download link was not created in time"));
      },
      config.downloadInterceptionTimeoutMs
    );

    return { completion, restore };
  }

  async function exportOutputIfAvailable() {
    const exportButton = getElement(selectors.exportButton);

    if (!exportButton) return true;

    const importedFileName = await getCurrentImportedFileName();
    const storyFolderName = getStoryFolderName();
    const downloadInterceptor = interceptNextDownload(
      exportButton.ownerDocument,
      storyFolderName,
      importedFileName
    );

    if (!clickElement(exportButton)) {
      downloadInterceptor.restore();
      state.lastStep = describeElementState(selectors.exportButton);
      renderStatus();
      return false;
    }

    try {
      const { usedStoryFolder } = await downloadInterceptor.completion;
      state.lastStep = importedFileName
        ? usedStoryFolder
          ? `Exported to ${storyFolderName}/${importedFileName}`
          : `Exported output as ${importedFileName}`
        : "Exported output";
      renderStatus();
      return true;
    } catch (error) {
      downloadInterceptor.restore();
      state.lastStep = `Export failed: ${error.message}`;
      console.error("Unable to export output:", error);
      renderStatus();
      return false;
    }
  }

  function hasErrorOutput() {
    const errorSection = getElement(selectors.errorSection);
    const text = errorSection?.textContent || "";

    return (
      isVisible(errorSection) &&
      text.toLowerCase().includes("oops, something went wrong")
    );
  }

  async function fillInputIfNeeded(input) {
    const currentText = await getCurrentText();
    if (!currentText) return;
    if (input.value === currentText) return;

    setInputValue(input, currentText);
  }

  async function submitIfReady(input) {
    let text = input.value.trim();
    let currentText = (await getCurrentText()).trim();

    if (!text) return false;
    if (text !== currentText) return false;
    if (state.submittedText === text) return false;

    if (!(await waitForNextAutomationStep())) return false;

    text = input.value.trim();
    currentText = (await getCurrentText()).trim();
    const submitButton = getElement(selectors.submitButton);

    if (!text || text !== currentText) return false;
    if (state.submittedText === text) return false;
    if (!clickElement(submitButton)) return false;

    state.submittedAt = Date.now();
    state.submittedText = text;
    renderStatus();
    setTimeout(()=>{
      clickElement(getElement(selectors.errorClose));
    }, 3000)


    return true;
  }

  function resetRunState() {
    state.clickedReload = false;
    state.clickedStart = false;
    state.exportedCurrentText = false;
    state.isAdvancingToNextText = false;
    state.submittedAt = 0;
    state.submittedText = null;
  }

  function shouldRetryCurrentText() {
    if (!state.submittedText || state.submittedAt === 0) return false;
    if (hasProgress() || hasCompletedOutput()) return false;

    return Date.now() - state.submittedAt >= config.missingOutputRetryDelayMs;
  }

  async function reloadCurrentText(reason, options = {}) {
    if (state.clickedReload && !options.force) return false;

    if (!(await waitForNextAutomationStep())) return false;
    if (state.clickedReload && !options.force) return false;

    const reloadButton = getElement(selectors.reloadButton);

    if (!clickElement(reloadButton)) {
      state.lastStep = describeElementState(selectors.reloadButton);
      renderStatus();
      return false;
    }

    resetRunState();
    state.clickedReload = true;
    state.lastStep = reason;
    renderStatus();
    return true;
  }

  function reloadForNextText() {
    if (state.isAdvancingToNextText) return false;

    state.isAdvancingToNextText = true;
    renderStatus();

    window.setTimeout(() => {
      if (!isAutoRunEnabled()) {
        state.isAdvancingToNextText = false;
        renderStatus();
        return;
      }

      const nextIndex = getCurrentIndex() + 1;

      if (nextIndex >= state.queueSize) {
        setCurrentIndex(nextIndex);
        setAutoRunEnabled(false);
        return;
      }

      const reloadButton = getElement(selectors.reloadButton);

      if (!clickElement(reloadButton)) {
        state.isAdvancingToNextText = false;
        state.lastStep = describeElementState(selectors.reloadButton);
        renderStatus();
        return;
      }

      setCurrentIndex(nextIndex);
      state.clickedReload = true;
      state.lastStep = "Reloading for next text";
      renderStatus();
    }, config.automationStepDelayMs);

    return true;
  }

  async function runAutomation() {
    if (!isAutoRunEnabled()) return;
    if (state.isRunning) return;

    state.isRunning = true;

    try {
      if (!hasNextText()) {
        state.lastStep = "No next text";
        renderStatus();
        return;
      }

      const frameDocument = getFrameDocument();
      if (!frameDocument) {
        state.lastStep = "Waiting for iframe document";
        setStatus("Running. Waiting for iframe...");
        return;
      }

      observeFrameDocument();

      if (state.isAdvancingToNextText) {
        if (!state.clickedReload || hasCompletedOutput()) {
          state.lastStep = "Waiting for next text";
          renderStatus();
          return;
        }

        resetRunState();
        state.clickedReload = true;
      }

      if (hasErrorOutput()) {
        state.lastStep = "Detected error output";
        await reloadCurrentText("Retrying current text after error", { force: true });
        return;
      }

      if (hasProgress()) {
        state.lastStep = "Waiting for progress";
        renderStatus();
        return;
      }

      if (hasCompletedOutput()) {
        state.lastStep = "Output completed";
        if (!state.exportedCurrentText) {
          if (!(await exportOutputIfAvailable())) return;
          state.exportedCurrentText = true;
        }
        reloadForNextText();
        return;
      }

      if (shouldRetryCurrentText()) {
        await reloadCurrentText("Retrying current text after missing output");
        return;
      }

      const input = getElement(selectors.textInput);
      if (isVisible(input)) {
        state.clickedStart = true;
        state.lastStep = "Filling input";
        await fillInputIfNeeded(input);
        if (await submitIfReady(input)) {
          state.lastStep = "Submitted input";
          renderStatus();
          return;
        }
      }

      if (!state.clickedStart) {
        if (!(await waitForNextAutomationStep())) return;

        if (clickElement(getElement(selectors.startButton))) {
          state.clickedStart = true;
          state.lastStep = "Clicked #run";
          renderStatus();
          return;
        }

        state.lastStep = describeElementState(selectors.startButton);
      }

      if (!state.clickedReload) {
        if (!(await waitForNextAutomationStep())) return;

        if (clickElement(getElement(selectors.reloadButton))) {
          state.clickedReload = true;
          state.lastStep = "Clicked #replay";
          renderStatus();
          return;
        }

        if (!state.clickedStart) return;

        state.lastStep = describeElementState(selectors.reloadButton);
        renderStatus();
      }
    } finally {
      state.isRunning = false;
    }
  }

  function pickTextFiles() {
    const input = document.createElement("input");

    input.type = "file";
    input.accept = ".txt,text/plain";
    input.multiple = true;
    input.style.display = "none";

    input.addEventListener("change", async () => {
      const files = [...input.files].sort((left, right) =>
        left.name.localeCompare(right.name, undefined, { numeric: true })
      );

      if (files.length === 0) return;

      setStatus(`Importing ${files.length} file(s)...`);

      const chapters = await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          text: await file.text(),
        }))
      );

      await replaceImportedChapters(chapters);
      setCurrentIndex(0);
      resetRunState();
      await refreshQueueState();
      setStatus(`Imported ${chapters.length} file(s).`);
      input.remove();
    });

    document.body.append(input);
    input.click();
  }

  function resetProgress() {
    setCurrentIndex(0);
    resetRunState();
    renderStatus();
  }

  function setStatus(message) {
    if (!state.statusElement) return;

    state.statusElement.textContent = message;
  }

  function renderStatus() {
    const currentIndex = getCurrentIndex();
    const currentDisplay = Math.min(currentIndex + 1, state.queueSize);
    const source = state.usesIndexedDbQueue ? "IndexedDB" : "inline";

    if (state.queueSize === 0) {
      setStatus("No queue. Import .txt files first.");
      return;
    }

    if (!hasNextText()) {
      setStatus(`Done ${state.queueSize}/${state.queueSize} (${source}).`);
      return;
    }

    const mode = isAutoRunEnabled() ? "Running" : "Paused";
    const target = getFrameDocument() ? "iframe ready" : "waiting iframe";

    setStatus(
      `${mode} ${currentDisplay}/${state.queueSize} (${source}, ${target}) - ${state.lastStep}.`
    );
  }

  function toggleAutoRun() {
    const nextEnabled = !isAutoRunEnabled();

    setAutoRunEnabled(nextEnabled);

    if (nextEnabled) {
      resetRunState();
      runAutomation();
    }
  }

  function createControlPanel() {
    const panel = document.createElement("div");
    const autoRunButton = document.createElement("button");
    const importButton = document.createElement("button");
    const resetButton = document.createElement("button");
    const status = document.createElement("span");

    panel.style.position = "fixed";
    panel.style.right = "12px";
    panel.style.bottom = "12px";
    panel.style.zIndex = "2147483647";
    panel.style.display = "flex";
    panel.style.alignItems = "center";
    panel.style.gap = "8px";
    panel.style.padding = "8px";
    panel.style.border = "1px solid rgba(0, 0, 0, 0.2)";
    panel.style.borderRadius = "8px";
    panel.style.background = "rgba(255, 255, 255, 0.94)";
    panel.style.color = "#111";
    panel.style.font = "12px system-ui, sans-serif";
    panel.style.boxShadow = "0 4px 16px rgba(0, 0, 0, 0.16)";

    autoRunButton.type = "button";
    autoRunButton.textContent = "Auto Run";
    autoRunButton.addEventListener("click", toggleAutoRun);
    state.autoRunButton = autoRunButton;

    importButton.type = "button";
    importButton.textContent = "Import .txt";
    importButton.addEventListener("click", pickTextFiles);

    resetButton.type = "button";
    resetButton.textContent = "Reset";
    resetButton.addEventListener("click", resetProgress);

    [autoRunButton, importButton, resetButton].forEach((button) => {
      button.style.border = "1px solid rgba(0, 0, 0, 0.25)";
      button.style.borderRadius = "6px";
      button.style.background = "#fff";
      button.style.color = "#111";
      button.style.cursor = "pointer";
      button.style.font = "12px system-ui, sans-serif";
      button.style.padding = "4px 8px";
    });

    status.textContent = "Loading queue...";
    state.statusElement = status;

    panel.append(autoRunButton, importButton, resetButton, status);
    document.body.append(panel);
    updateAutoRunButton();
  }

  function observeFrameDocument() {
    const frameDocument = getFrameDocument();

    if (!frameDocument || state.observedFrameDocument === frameDocument) return;

    state.frameObserver?.disconnect();
    state.observedFrameDocument = frameDocument;
    state.frameObserver = new MutationObserver(() => {
      runAutomation();
    });

    state.frameObserver.observe(frameDocument.documentElement || frameDocument, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    renderStatus();
  }

  function watchFrameLoad() {
    const frame = getFrame();

    if (!frame) {
      window.setTimeout(watchFrameLoad, 500);
      return;
    }

    frame.addEventListener("load", () => {
      resetRunState();
      observeFrameDocument();
      runAutomation();
    });

    observeFrameDocument();
  }

  state.db = await openDatabase();
  createControlPanel();
  watchFrameLoad();
  await refreshQueueState();

  window.setInterval(() => {
    observeFrameDocument();
    runAutomation();
  }, config.automationPollMs);

  if (isAutoRunEnabled()) {
    runAutomation();
  }
})();
