// ==UserScript==
// @name         AdShield – Chặn quảng cáo & popup bung tab
// @namespace    vinhtt.adshield
// @version      1.0.0
// @description  Ẩn quảng cáo phổ biến, chặn script quảng cáo, chặn click bị bung tab/cửa sổ quảng cáo. Alt+Shift+A để bật/tắt cho từng trang.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';

  /* ========================= CẤU HÌNH ========================= */
  const CFG = {
    cosmetic: true,          // Ẩn phần tử quảng cáo bằng CSS
    blockAdRequests: true,   // Chặn script/iframe/fetch/XHR tới domain quảng cáo
    popupGuard: true,        // Chặn bung tab/cửa sổ mới
    gestureWindowMs: 2000,   // Popup chỉ hợp lệ trong khoảng này sau thao tác thật của người dùng
    showToast: true,         // Hiện thông báo nhỏ khi chặn (có nút "Mở" nếu bạn muốn mở thật)
    extraSelectors: [],      // Selector riêng, vd: '.banner-nha-cai', '#float-left'
    extraHosts: [],          // Domain quảng cáo riêng, vd: 'abc-ads.xyz'
  };

  const AD_HOSTS = [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'adservice.google.',
    'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
    'mgid.com', 'revcontent.com', 'popads.net', 'popcash.net', 'propellerads.com', 'adsterra.com',
    'highperformanceformat.com', 'exoclick.com', 'exosrv.com', 'juicyads.com', 'hilltopads.net',
    'clickadu.com', 'onclickads.net', 'admaven.com', 'ad-maven.com', 'adcash.com', 'yllix.com',
    'a-ads.com', 'trafficjunky.net', 'trafficstars.com', 'realsrv.com', 'galaksion.com',
    'monetag.com', 'zeropark.com', 'adskeeper.com', 'richpush.co', 'popunder',
    'admicro.vn', 'eclick.vn',
  ].concat(CFG.extraHosts);

  const COSMETIC = [
    // Google Ads / GPT
    'ins.adsbygoogle', '[id^="google_ads_iframe"]', '[id^="div-gpt-ad"]', '[data-google-query-id]',
    '[data-ad-slot]', '[data-ad-client]', 'iframe[id^="aswift_"]', '.google-auto-placed',
    // Native ads
    '[id^="taboola-"]', '.trc_related_container', '.OUTBRAIN', '[id^="ScriptRoot"]', '.mgbox',
    // Generic (giữ ở mức an toàn để hạn chế ẩn nhầm)
    '.adsbox', '.ad-slot', '.ad-banner', '.ad-container', '.ads-container', '.ad-wrapper',
    '.ads-wrapper', '.advertisement', '.sponsored-ads', '[id^="ad-slot"]', '[id^="ads-"]',
    '[aria-label="Advertisement"]',
    // Banner trôi / catfish hay gặp ở site VN
    '[id*="catfish"]', '[class*="catfish"]',
    // Link trỏ thẳng tới mạng quảng cáo
    'a[href*="doubleclick.net"]', 'a[href*="googleadservices.com"]',
  ].concat(CFG.extraSelectors);

  /* ========================= TIỆN ÍCH ========================= */
  const nativeAppend = Node.prototype.appendChild;
  const nativeInsert = Node.prototype.insertBefore;
  const nativeOpen = window.open;
  const isTop = window.top === window;

  const toAbs = (u) => {
    try { return new URL(u == null || u === '' ? 'about:blank' : String(u), location.href).href; }
    catch (_) { return ''; }
  };
  const hostOf = (u) => { try { return new URL(String(u), location.href).hostname; } catch (_) { return ''; } };
  const isAdUrl = (u) => { const h = u ? hostOf(u) : ''; return !!h && AD_HOSTS.some((d) => h.includes(d)); };
  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch (_) { return false; } };
  const opensNewContext = (t) => { t = (t || '').toLowerCase(); return !!t && !['_self', '_parent', '_top'].includes(t); };
  const safe = (name, fn) => { try { fn(); } catch (e) { console.warn('[AdShield]', name, e); } };

  /* ---------- Toast (shadow DOM, không dùng innerHTML để tương thích Trusted Types) ---------- */
  let toastUI = null, toastTimer = 0;
  function hideToast() { if (toastUI) toastUI.host.remove(); }
  function toast(msg, openUrl) {
    if (!CFG.showToast || !document.documentElement) return;
    if (!toastUI) {
      const host = document.createElement('adshield-toast');
      const sr = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        '.box{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:380px;display:flex;' +
        'gap:8px;align-items:center;padding:10px 12px;border-radius:8px;background:#1f2328;color:#f0f3f6;' +
        'font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35)}' +
        'button{all:unset;cursor:pointer;padding:3px 9px;border-radius:5px;background:#2f81f7;color:#fff;font-weight:600}' +
        'button.x{background:transparent;color:#9198a1;padding:3px 5px}button.x:hover{color:#fff}';
      const box = document.createElement('div'); box.className = 'box';
      const msgEl = document.createElement('span');
      const openBtn = document.createElement('button'); openBtn.textContent = 'Mở';
      const closeBtn = document.createElement('button'); closeBtn.className = 'x'; closeBtn.textContent = '✕';
      box.append(msgEl, openBtn, closeBtn);
      sr.append(style, box);
      toastUI = { host, msgEl, openBtn, url: null };
      openBtn.addEventListener('click', () => { if (toastUI.url) nativeOpen.call(window, toastUI.url, '_blank', 'noopener'); hideToast(); });
      closeBtn.addEventListener('click', hideToast);
    }
    toastUI.msgEl.textContent = msg;
    toastUI.url = openUrl || null;
    toastUI.openBtn.style.display = openUrl ? '' : 'none';
    if (!toastUI.host.isConnected) nativeAppend.call(document.documentElement, toastUI.host);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 6000);
  }

  /* ---------- Bật/tắt theo từng trang: Alt + Shift + A ---------- */
  const OFF_KEY = '__adshield_off';
  let isOff = false;
  try { isOff = localStorage.getItem(OFF_KEY) === '1'; } catch (_) {}

  if (isTop) {
    window.addEventListener('keydown', (e) => {
      if (!(e.altKey && e.shiftKey && e.code === 'KeyA')) return;
      e.preventDefault();
      try { isOff ? localStorage.removeItem(OFF_KEY) : localStorage.setItem(OFF_KEY, '1'); } catch (_) {}
      toast(isOff ? 'AdShield: đã BẬT lại cho trang này' : 'AdShield: đã TẮT cho trang này', null);
      setTimeout(() => location.reload(), 700);
    }, true);
  }
  if (isOff) return;

  /* ========================= 1. ẨN QUẢNG CÁO BẰNG CSS ========================= */
  if (CFG.cosmetic) safe('cosmetic', () => {
    const iframeSel = AD_HOSTS.filter((h) => h.includes('.')).map((h) => `iframe[src*="${h}"]`);
    // Mỗi selector một rule riêng: 1 selector lỗi không làm hỏng cả khối
    const css = COSMETIC.concat(iframeSel)
      .map((s) => `${s}{display:none!important;visibility:hidden!important}`).join('\n');
    const st = document.createElement('style');
    st.id = 'adshield-css';
    st.textContent = css;
    const add = () => {
      const root = document.head || document.documentElement;
      if (root && !st.isConnected) nativeAppend.call(root, st);
    };
    add();
    if (!st.isConnected) {
      new MutationObserver((_, o) => { add(); if (st.isConnected) o.disconnect(); })
        .observe(document, { childList: true, subtree: true });
    }
    document.addEventListener('DOMContentLoaded', add);
  });

  /* ========================= 2. CHẶN SCRIPT / IFRAME / REQUEST QUẢNG CÁO ========================= */
  if (CFG.blockAdRequests) {
    const isAdNode = (n) => !!n && n.nodeType === 1 &&
      (n.tagName === 'SCRIPT' || n.tagName === 'IFRAME') && isAdUrl(n.getAttribute('src') || n.src);

    safe('insert', () => {
      Node.prototype.appendChild = function (n) { return isAdNode(n) ? n : nativeAppend.call(this, n); };
      Node.prototype.insertBefore = function (n, ref) { return isAdNode(n) ? n : nativeInsert.call(this, n, ref); };
      for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
        for (const m of ['append', 'prepend']) {
          const orig = proto[m];
          if (typeof orig !== 'function') continue;
          proto[m] = function (...nodes) { return orig.apply(this, nodes.filter((n) => !isAdNode(n))); };
        }
      }
    });

    safe('fetch', () => {
      const nativeFetch = window.fetch;
      if (typeof nativeFetch !== 'function') return;
      window.fetch = function (input, init) {
        const u = typeof input === 'string' ? input : (input && (input.url || String(input)));
        if (isAdUrl(u)) return Promise.reject(new TypeError('Blocked by AdShield'));
        return nativeFetch.apply(this, arguments);
      };
    });

    safe('xhr', () => {
      const xOpen = XMLHttpRequest.prototype.open;
      const xSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__adshield = isAdUrl(u); return xOpen.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        if (this.__adshield) { setTimeout(() => this.dispatchEvent(new Event('error')), 0); return; }
        return xSend.apply(this, arguments);
      };
    });
  }

  /* ========================= 3. CHẶN POPUP / TAB MỚI ========================= */
  if (!CFG.popupGuard) return;

  // Theo dõi thao tác THẬT của người dùng (isTrusted) để phân biệt với click giả do script tạo
  const G = { t: 0, target: null, used: true };
  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  const startGesture = (e) => { if (!e.isTrusted) return; G.t = performance.now(); G.target = realTarget(e); G.used = false; };
  const contGesture = (e) => { if (!e.isTrusted) return; G.t = performance.now(); if (e.type === 'click') G.target = realTarget(e); };
  ['pointerdown', 'keydown'].forEach((t) => window.addEventListener(t, startGesture, true));
  ['mousedown', 'pointerup', 'mouseup', 'touchend', 'click'].forEach((t) => window.addEventListener(t, contGesture, true));

  const recentGesture = () => performance.now() - G.t < CFG.gestureWindowMs;
  const INTERACTIVE = 'a[href],button,input[type=button],input[type=submit],input[type=image],' +
    '[role=button],[role=link],[role=menuitem],summary,label';
  const interactiveOf = (el) => {
    if (!el || el.nodeType !== 1 || !el.closest) return null;
    const it = el.closest(INTERACTIVE);
    return it && it !== document.body && it !== document.documentElement ? it : null;
  };

  // Lớp phủ trong suốt che trang/video để "bẫy" click
  function findTransparentOverlay(el) {
    for (let i = 0; el && el.nodeType === 1 && i < 5 && el !== document.body && el !== document.documentElement; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 40000) continue; // nhỏ hơn ~200x200 thì bỏ qua
      const transparent = parseFloat(cs.opacity) < 0.1 ||
        (/rgba\([^)]*,\s*0\)$|^transparent$/.test(cs.backgroundColor) && cs.backgroundImage === 'none');
      const empty = !el.querySelector('img,video,canvas,svg,iframe,input,button,textarea,select') &&
        (el.innerText || '').trim().length < 3;
      if (transparent && empty) return el;
    }
    return null;
  }

  let blockedCount = 0;
  function onBlocked(href, reason) {
    blockedCount++;
    const ov = findTransparentOverlay(G.target);
    if (ov) ov.style.setProperty('pointer-events', 'none', 'important');
    const host = hostOf(href);
    const canOpen = href && href !== 'about:blank' && !isAdUrl(href);
    const msg = ov
      ? `Đã chặn popup${host ? ' → ' + host : ''} và gỡ lớp phủ vô hình. Hãy click lại. (${blockedCount})`
      : `Đã chặn popup/tab mới${host ? ' → ' + host : ''} (${blockedCount})`;
    toast(msg, canOpen ? href : null);
    console.info('[AdShield] blocked:', reason, href);
  }

  // Quyết định một lần mở tab/cửa sổ mới có hợp lệ không. Trả về lý do chặn, hoặc null nếu cho phép.
  function popupVerdict(href) {
    if (isAdUrl(href)) return 'ad-host';
    if (!recentGesture()) return 'no-user-gesture';
    if (G.used) return 'second-popup-same-click';
    const it = interactiveOf(G.target);
    if (!it) return 'click-on-non-interactive-element';
    if (it.tagName === 'A' && !sameOrigin(href) && toAbs(it.href) !== toAbs(href)) return 'link-hijack';
    return null;
  }

  // Trả về "cửa sổ giả" để script quảng cáo tưởng đã mở được, tránh chuyển sang chiêu dự phòng
  function fakeWindow() {
    let p;
    const fn = function () {};
    p = new Proxy(fn, {
      get(_, k) {
        if (k === 'closed') return false;
        if (k === 'then') return undefined;
        if (k === Symbol.toPrimitive) return () => '';
        if (k === 'toString') return () => '[object Window]';
        return p;
      },
      set() { return true; },
      apply() { return p; },
    });
    return p;
  }

  function guardedOpen(url, target, features) {
    const href = toAbs(url);
    if (!opensNewContext(target == null ? '_blank' : target) && !isAdUrl(href)) {
      return nativeOpen.call(window, url, target, features);
    }
    const v = popupVerdict(href);
    if (v) { onBlocked(href, v); return fakeWindow(); }
    G.used = true;
    return nativeOpen.call(window, url, target, features);
  }

  const lockOpen = (w) => {
    try {
      if (w && w.open !== guardedOpen) {
        Object.defineProperty(w, 'open', { get: () => guardedOpen, set() {}, configurable: false });
      }
    } catch (_) { /* cross-origin hoặc đã bị khoá */ }
    return w;
  };

  safe('window.open', () => lockOpen(window));

  // Chặn lách qua iframe about:blank: iframe.contentWindow.open(...)
  safe('iframe', () => {
    const P = HTMLIFrameElement.prototype;
    const dw = Object.getOwnPropertyDescriptor(P, 'contentWindow');
    const dd = Object.getOwnPropertyDescriptor(P, 'contentDocument');
    Object.defineProperty(P, 'contentWindow', {
      configurable: true, enumerable: dw.enumerable,
      get() { return lockOpen(dw.get.call(this)); },
    });
    Object.defineProperty(P, 'contentDocument', {
      configurable: true, enumerable: dd.enumerable,
      get() { const d = dd.get.call(this); if (d) lockOpen(d.defaultView); return d; },
    });
  });

  // Chặn script tự tạo <a target="_blank"> rồi gọi .click() / dispatchEvent(click)
  function anchorVerdict(a) {
    const href = a.href;
    if (!href || a.hasAttribute('download') || /^javascript:/i.test(href)) return null;
    if (isAdUrl(href)) return 'ad-host';
    if (!opensNewContext(a.getAttribute('target'))) return null;
    return popupVerdict(href);
  }

  safe('anchor-click', () => {
    const nativeClick = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (this instanceof HTMLAnchorElement) {
        const v = anchorVerdict(this);
        if (v) { onBlocked(this.href, 'programmatic-click:' + v); return; }
        if (opensNewContext(this.getAttribute('target'))) G.used = true;
      }
      return nativeClick.call(this);
    };

    const nativeDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (ev) {
      if (ev && ev.type === 'click' && this instanceof HTMLAnchorElement) {
        const v = anchorVerdict(this);
        if (v) { onBlocked(this.href, 'synthetic-click:' + v); return false; }
      }
      return nativeDispatch.call(this, ev);
    };
  });

  // Chặn form tự submit sang tab mới
  safe('form-submit', () => {
    const nativeSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      if (opensNewContext(this.getAttribute('target'))) {
        const href = toAbs(this.getAttribute('action') || location.href);
        const v = popupVerdict(href);
        if (v) { onBlocked(href, 'form:' + v); return; }
        G.used = true;
      }
      return nativeSubmit.call(this);
    };
  });

  // Người dùng click thật vào link dẫn tới mạng quảng cáo
  window.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
    const t = realTarget(e);
    const a = t && t.closest && t.closest('a[href]');
    if (a && isAdUrl(a.href)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      onBlocked(a.href, 'ad-link');
    }
  }, true);
})();
