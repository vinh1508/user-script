// ==UserScript==
// @name         AdShield – Chặn quảng cáo & hỏi trước khi mở tab mới
// @namespace    vinhtt.adshield
// @version      1.2.0
// @description  Ẩn quảng cáo, chặn script quảng cáo, mọi tab/cửa sổ mới đều phải xác nhận. Alt+Shift+A: tắt/bật cho trang. Alt+Shift+R: xoá danh sách cho phép.
// @match        *://*/*
// @run-at       document-start
// @grant        none
// @sandbox      raw
// @inject-into  page
// ==/UserScript==

(function () {
  'use strict';

  /* ========================= CẤU HÌNH ========================= */
  const CFG = {
    // 'all'   = hỏi trước MỌI tab/cửa sổ mới (kể cả cùng trang)
    // 'cross' = cùng trang thì mở luôn, sang trang khác hoặc đáng ngờ thì hỏi
    // 'off'   = không hỏi: tự chặn tab đáng ngờ, cho qua tab bình thường
    confirm: 'all',
    cosmetic: true,          // Ẩn phần tử quảng cáo bằng CSS
    blockAdRequests: true,   // Chặn script/iframe/fetch/XHR tới domain quảng cáo
    popupGuard: true,        // Kiểm soát tab/cửa sổ mới
    gestureWindowMs: 2000,   // Tab mới chỉ được xét nếu xảy ra trong khoảng này sau thao tác thật
    bigLinkRatio: 0.6,       // Link/nút chiếm >= 60% màn hình mà mở trang ngoài => nghi bẫy
    showToast: true,
    debug: true,             // Log ra Console (F12)
    extraSelectors: [],      // vd: '.banner-nha-cai'
    extraHosts: [],          // vd: 'abc-ads.xyz'
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
    'ins.adsbygoogle', '[id^="google_ads_iframe"]', '[id^="div-gpt-ad"]', '[data-google-query-id]',
    '[data-ad-slot]', '[data-ad-client]', 'iframe[id^="aswift_"]', '.google-auto-placed',
    '[id^="taboola-"]', '.trc_related_container', '.OUTBRAIN', '[id^="ScriptRoot"]', '.mgbox',
    '.adsbox', '.ad-slot', '.ad-banner', '.ad-container', '.ads-container', '.ad-wrapper',
    '.ads-wrapper', '.advertisement', '.sponsored-ads', '[id^="ad-slot"]', '[id^="ads-"]',
    '[aria-label="Advertisement"]', '[id*="catfish"]', '[class*="catfish"]',
    'a[href*="doubleclick.net"]', 'a[href*="googleadservices.com"]',
  ].concat(CFG.extraSelectors);

  /* ========================= HÀM GỐC & TIỆN ÍCH ========================= */
  const N = {
    append: Node.prototype.appendChild,
    insert: Node.prototype.insertBefore,
    open: window.open,
    addEL: EventTarget.prototype.addEventListener,
    removeEL: EventTarget.prototype.removeEventListener,
    dispatch: EventTarget.prototype.dispatchEvent,
    click: HTMLElement.prototype.click,
    submit: HTMLFormElement.prototype.submit,
    requestSubmit: HTMLFormElement.prototype.requestSubmit,
  };
  const on = (t, type, fn, cap = true) => N.addEL.call(t, type, fn, cap);
  const isTop = window.top === window;

  const toAbs = (u) => {
    try { return new URL(u == null || u === '' ? 'about:blank' : String(u), location.href).href; }
    catch (_) { return ''; }
  };
  const hostOf = (u) => { try { return new URL(String(u), location.href).hostname; } catch (_) { return ''; } };
  const baseDomain = (h) => {
    const p = (h || '').split('.');
    if (p.length > 2 && p[p.length - 1].length === 2 && p[p.length - 2].length <= 3) return p.slice(-3).join('.');
    return p.slice(-2).join('.');
  };
  const isAdUrl = (u) => { const h = u ? hostOf(u) : ''; return !!h && AD_HOSTS.some((d) => h.includes(d)); };
  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch (_) { return false; } };
  const stripHash = (u) => String(u).split('#')[0];
  const opensNewContext = (t) => { t = (t || '').toLowerCase(); return !!t && !['_self', '_parent', '_top'].includes(t); };
  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  const safe = (name, fn) => { try { fn(); } catch (e) { console.warn('[AdShield]', name, e); } };
  const log = (...a) => { if (CFG.debug) console.info('%c[AdShield]', 'color:#2f81f7;font-weight:bold', ...a); };

  /* ========================= UI: toast + hộp xác nhận (closed shadow DOM) ========================= */
  // Mọi sự kiện trên UI bị chặn ngay ở window-capture: script của trang không bao giờ thấy click vào UI.
  let UI = null, toastTimer = 0, blockedCount = 0;

  const UI_CSS = `
    [hidden]{display:none!important}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .toast{position:fixed;right:16px;bottom:16px;max-width:min(420px,calc(100vw - 32px));display:flex;gap:8px;
      align-items:center;padding:10px 12px;border-radius:8px;background:#1f2328;color:#f0f3f6;font-size:13px;
      line-height:1.4;box-shadow:0 6px 20px rgba(0,0,0,.35)}
    .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;
      justify-content:center;padding:16px}
    .dialog{width:min(460px,100%);background:#fff;color:#1f2328;border-radius:12px;padding:18px 18px 14px;
      box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:14px;line-height:1.45}
    .title{font-weight:700;font-size:15px;margin-bottom:10px}
    .host{font-size:18px;font-weight:700;word-break:break-all}
    .url{margin-top:4px;color:#59636e;font-size:12px;word-break:break-all;max-height:4.6em;overflow:auto}
    .warn{margin-top:10px;padding:8px 10px;border-radius:8px;background:#fff1e5;color:#953800;font-size:13px}
    .warn.ok{background:#ddf4ff;color:#0a3069}
    .allow{display:flex;gap:8px;align-items:center;margin-top:12px;font-size:13px;color:#59636e;cursor:pointer}
    .btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
    button{all:unset;cursor:pointer;padding:7px 14px;border-radius:7px;font-weight:600;font-size:13px}
    button:focus-visible{outline:2px solid #2f81f7;outline-offset:2px}
    .pri{background:#1f6feb;color:#fff}
    .sec{background:#eff2f5;color:#1f2328}
    .toast .pri{padding:3px 9px}
    .x{background:transparent;color:#9198a1;padding:3px 5px}
    @media (prefers-color-scheme:dark){
      .dialog{background:#1f2328;color:#f0f3f6}.url,.allow{color:#9198a1}
      .sec{background:#30363d;color:#f0f3f6}.warn{background:#3d2a12;color:#f0b072}
      .warn.ok{background:#0c2d4a;color:#9cd1ff}}`;

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k in attrs) k === 'text' ? (e.textContent = attrs[k]) : e.setAttribute(k, attrs[k]);
    kids.forEach((k) => N.append.call(e, k));
    return e;
  }

  function ensureUI() {
    if (UI) return UI;
    const host = document.createElement('adshield-ui');
    host.style.cssText = 'all:initial!important;display:block!important;position:fixed!important;top:0!important;' +
      'left:0!important;width:0!important;height:0!important;z-index:2147483647!important';
    const sr = host.attachShadow({ mode: 'closed' });

    const toastMsg = h('span');
    const toastOpen = h('button', { class: 'pri', 'data-act': 'toast-open', text: 'Mở' });
    const toast = h('div', { class: 'toast' }, toastMsg, toastOpen,
      h('button', { class: 'x', 'data-act': 'toast-close', text: '✕' }));
    toast.hidden = true;

    const mHost = h('div', { class: 'host' });
    const mUrl = h('div', { class: 'url' });
    const mWarn = h('div', { class: 'warn' });
    const mCb = h('input', { type: 'checkbox' });
    const mCbText = h('span');
    const mAllow = h('label', { class: 'allow' }, mCb, mCbText);
    const mBlock = h('button', { class: 'sec', 'data-act': 'block', text: 'Chặn' });
    const mOpen = h('button', { class: 'pri', 'data-act': 'open', text: 'Mở tab' });
    const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'data-act': 'noop' },
      h('div', { class: 'title', text: 'Trang này muốn mở tab mới' }), mHost, mUrl, mWarn, mAllow,
      h('div', { class: 'btns' }, mBlock, mOpen));
    const modal = h('div', { class: 'backdrop', 'data-act': 'block' }, dialog);
    modal.hidden = true;

    N.append.call(sr, h('style', { text: UI_CSS }));
    N.append.call(sr, toast);
    N.append.call(sr, modal);
    UI = { host, sr, toast, toastMsg, toastOpen, toastUrl: null, modal, mHost, mUrl, mWarn, mCb, mCbText,
      mAllow, mBlock, pending: null };
    return UI;
  }
  function mountUI() {
    ensureUI();
    const root = document.documentElement;
    if (!root) return false;
    if (!UI.host.isConnected) N.append.call(root, UI.host);
    return true;
  }

  function toast(msg, openUrl) {
    if (!CFG.showToast || !mountUI()) return;
    UI.toastMsg.textContent = msg;
    UI.toastUrl = openUrl || null;
    UI.toastOpen.hidden = !openUrl;
    UI.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }
  function hideToast() { if (UI) UI.toast.hidden = true; }

  // Hiện hộp xác nhận. doOpen() sẽ được gọi trong chính cú click "Mở tab" của bạn (trình duyệt cho phép mở).
  function askOpen(href, reason, doOpen) {
    if (!mountUI()) return false;
    const host = hostOf(href);
    UI.pending = { href, host, doOpen };
    UI.mHost.textContent = host || (href === 'about:blank' ? 'Trang trống (about:blank)' : href);
    UI.mUrl.textContent = href;
    UI.mWarn.className = reason ? 'warn' : 'warn ok';
    UI.mWarn.textContent = reason ? '⚠ Nghi quảng cáo: ' + reason : 'Mở từ link/nút bạn vừa bấm.';
    UI.mAllow.hidden = !host;
    UI.mCb.checked = false;
    UI.mCbText.textContent = `Luôn cho phép ${host} trên ${location.hostname} (không hỏi lại)`;
    UI.modal.hidden = false;
    setTimeout(() => UI.mBlock.focus(), 0);
    return true;
  }
  function closeModal() { if (UI) { UI.modal.hidden = true; UI.pending = null; } }
  const waitingConfirm = () => !!(UI && UI.pending);

  function uiAct(act) {
    if (act === 'toast-open') {
      const u = UI.toastUrl; hideToast();
      if (u) N.open.call(window, u, '_blank');
    } else if (act === 'toast-close') {
      hideToast();
    } else if (act === 'open' || act === 'block') {
      const p = UI.pending;
      const remember = UI.mCb.checked;
      closeModal();
      if (!p) return;
      if (act === 'open') {
        if (remember && p.host) addAllow(p.host);
        log('BẠN ĐỒNG Ý mở:', p.href);
        try { p.doOpen(); } catch (err) { console.warn('[AdShield] mở thất bại', err); }
      } else {
        blockedCount++;
        log('BẠN ĐÃ CHẶN:', p.href);
      }
    }
  }

  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'].forEach((t) => on(window, t, (e) => {
    if (!UI || realTarget(e) !== UI.host) return;
    e.stopImmediatePropagation();
    if (!e.isTrusted) return; // trang không thể "bấm hộ" nút Mở
    if (t === 'click') {
      const el = e.detail === 0 && UI.sr.activeElement ? UI.sr.activeElement : UI.sr.elementFromPoint(e.clientX, e.clientY);
      const actEl = el && el.closest ? el.closest('[data-act]') : null;
      if (actEl) uiAct(actEl.getAttribute('data-act'));
    } else if (t === 'keydown' && e.key === 'Escape' && waitingConfirm()) {
      e.preventDefault();
      uiAct('block');
    }
  }));

  /* ---------- Cài đặt theo trang ---------- */
  const KEY_OFF = '__adshield_off', KEY_ALLOW = '__adshield_allow';
  let isOff = false;
  try { isOff = localStorage.getItem(KEY_OFF) === '1'; } catch (_) {}
  let allowHosts = [];
  try { allowHosts = JSON.parse(localStorage.getItem(KEY_ALLOW) || '[]'); } catch (_) {}
  if (!Array.isArray(allowHosts)) allowHosts = [];
  const isAllowed = (host) => !!host && allowHosts.includes(host);
  function addAllow(host) {
    if (isAllowed(host)) return;
    allowHosts.push(host);
    try { localStorage.setItem(KEY_ALLOW, JSON.stringify(allowHosts)); } catch (_) {}
    toast(`Đã thêm ${host} vào danh sách cho phép của trang này`);
  }

  if (isTop) {
    on(window, 'keydown', (e) => {
      if (!e.altKey || !e.shiftKey) return;
      if (e.code === 'KeyA') {
        e.preventDefault();
        try { isOff ? localStorage.removeItem(KEY_OFF) : localStorage.setItem(KEY_OFF, '1'); } catch (_) {}
        toast(isOff ? 'AdShield: đã BẬT lại cho trang này' : 'AdShield: đã TẮT cho trang này');
        setTimeout(() => location.reload(), 700);
      } else if (e.code === 'KeyR') {
        e.preventDefault();
        allowHosts = [];
        try { localStorage.removeItem(KEY_ALLOW); } catch (_) {}
        toast('AdShield: đã xoá danh sách cho phép của trang này');
      }
    });
  }
  if (isOff) { log('đang TẮT cho trang này (Alt+Shift+A để bật)'); return; }
  if (isTop) log('đang chạy trên', location.host, '| chế độ xác nhận:', CFG.confirm);

  /* ========================= 1. ẨN QUẢNG CÁO BẰNG CSS ========================= */
  if (CFG.cosmetic) safe('cosmetic', () => {
    const iframeSel = AD_HOSTS.filter((x) => x.includes('.')).map((x) => `iframe[src*="${x}"]`);
    const st = document.createElement('style');
    st.textContent = COSMETIC.concat(iframeSel)
      .map((s) => `${s}{display:none!important;visibility:hidden!important}`).join('\n');
    const add = () => { const r = document.head || document.documentElement; if (r && !st.isConnected) N.append.call(r, st); };
    add();
    if (!st.isConnected) new MutationObserver((_, o) => { add(); if (st.isConnected) o.disconnect(); })
      .observe(document, { childList: true, subtree: true });
    on(document, 'DOMContentLoaded', add, false);
  });

  /* ========================= 2. KHOÁ window.open (kể cả trong iframe) ========================= */
  function lockOpen(w) {
    if (!CFG.popupGuard) return w;
    try {
      if (w && w.open !== guardedOpen) {
        Object.defineProperty(w, 'open', { get: () => guardedOpen, set() {}, configurable: false });
      }
    } catch (_) { /* cross-origin */ }
    return w;
  }
  function lockFramesIn(n) {
    if (!CFG.popupGuard || !n || n.nodeType !== 1) return;
    if (n.tagName === 'IFRAME' || n.tagName === 'FRAME') { lockOpen(n.contentWindow); return; }
    if (n.firstElementChild && n.getElementsByTagName) {
      for (const f of n.getElementsByTagName('iframe')) lockOpen(f.contentWindow);
    }
  }

  /* ========================= 3. CHẶN CHÈN SCRIPT/IFRAME QUẢNG CÁO ========================= */
  const isAdNode = (n) => CFG.blockAdRequests && !!n && n.nodeType === 1 &&
    (n.tagName === 'SCRIPT' || n.tagName === 'IFRAME') && isAdUrl(n.getAttribute('src') || n.src);

  safe('insert', () => {
    Node.prototype.appendChild = function (n) {
      if (isAdNode(n)) { log('chặn tải', n.src); return n; }
      const r = N.append.call(this, n); lockFramesIn(n); return r;
    };
    Node.prototype.insertBefore = function (n, ref) {
      if (isAdNode(n)) { log('chặn tải', n.src); return n; }
      const r = N.insert.call(this, n, ref); lockFramesIn(n); return r;
    };
    for (const proto of [Element.prototype, Document.prototype, DocumentFragment.prototype]) {
      for (const m of ['append', 'prepend', 'after', 'before']) {
        const orig = Object.prototype.hasOwnProperty.call(proto, m) && proto[m];
        if (typeof orig !== 'function') continue;
        proto[m] = function (...nodes) {
          const ok = nodes.filter((n) => !isAdNode(n));
          const r = orig.apply(this, ok); ok.forEach(lockFramesIn); return r;
        };
      }
    }
    const ih = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML');
    Object.defineProperty(Element.prototype, 'innerHTML', {
      configurable: true, enumerable: ih.enumerable, get: ih.get,
      set(v) { ih.set.call(this, v); lockFramesIn(this); },
    });
    const iah = Element.prototype.insertAdjacentHTML;
    Element.prototype.insertAdjacentHTML = function (pos, html) {
      const r = iah.call(this, pos, html); lockFramesIn(this.parentElement || this); return r;
    };
  });

  if (CFG.blockAdRequests) {
    safe('fetch', () => {
      const nf = window.fetch;
      if (typeof nf !== 'function') return;
      window.fetch = function (input) {
        const u = typeof input === 'string' ? input : (input && (input.url || String(input)));
        if (isAdUrl(u)) return Promise.reject(new TypeError('Blocked by AdShield'));
        return nf.apply(this, arguments);
      };
    });
    safe('xhr', () => {
      const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this.__adshield = isAdUrl(u); return xo.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () {
        if (this.__adshield) { setTimeout(() => N.dispatch.call(this, new Event('error')), 0); return; }
        return xs.apply(this, arguments);
      };
    });
  }

  /* ========================= 4. KIỂM SOÁT TAB / CỬA SỔ MỚI ========================= */
  if (!CFG.popupGuard) return;

  // 4a. Biết code mở tab đang chạy trong listener gắn ở đâu (document/window/body = popunder toàn trang)
  const CTX = [];
  const GESTURE_TYPES = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'touchstart', 'touchend', 'auxclick', 'keydown', 'keyup']);
  const wrapped = new WeakMap();
  const runInCtx = (target, fn, self, args) => {
    CTX.push(target);
    try { return fn.apply(self, args); } finally { CTX.pop(); }
  };
  safe('listeners', () => {
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (!listener || !GESTURE_TYPES.has(type)) return N.addEL.call(this, type, listener, opts);
      let w = wrapped.get(listener);
      if (!w) {
        w = function (ev) {
          const fn = typeof listener === 'function' ? listener : listener.handleEvent;
          const self = typeof listener === 'function' ? this : listener;
          return typeof fn === 'function' ? runInCtx(ev && ev.currentTarget, fn, self, arguments) : undefined;
        };
        wrapped.set(listener, w);
      }
      return N.addEL.call(this, type, w, opts);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, opts) {
      N.removeEL.call(this, type, listener, opts);
      const w = listener && wrapped.get(listener);
      if (w) N.removeEL.call(this, type, w, opts);
    };
    for (const obj of [HTMLElement.prototype, Document.prototype, window]) {
      for (const prop of ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown', 'onpointerup', 'ontouchstart', 'ontouchend']) {
        safe(prop, () => {
          const d = Object.getOwnPropertyDescriptor(obj, prop);
          if (!d || !d.set || !d.configurable) return;
          const orig = new WeakMap();
          Object.defineProperty(obj, prop, {
            configurable: true, enumerable: d.enumerable,
            get() { const w = d.get.call(this); return (w && orig.get(w)) || w; },
            set(fn) {
              if (typeof fn !== 'function') return d.set.call(this, fn);
              const w = function (ev) { return runInCtx(ev && ev.currentTarget, fn, this, arguments); };
              orig.set(w, fn);
              d.set.call(this, w);
            },
          });
        });
      }
    }
  });
  const isGlobalCtx = () => {
    const c = CTX[CTX.length - 1];
    return !!c && (c === window || c === document || c === document.documentElement || c === document.body);
  };

  // 4b. Theo dõi thao tác thật của người dùng
  const G = { t: -Infinity, target: null, used: true, link: null, linkHref: null };
  const closestLink = (el) => (el && el.closest ? el.closest('a[href],area[href]') : null);
  const startGesture = (e) => {
    if (!e.isTrusted) return;
    G.t = performance.now(); G.target = realTarget(e); G.used = false;
    G.link = closestLink(G.target);
    G.linkHref = G.link ? G.link.getAttribute('href') : null;
  };
  const contGesture = (e) => {
    if (!e.isTrusted) return;
    G.t = performance.now();
    if (e.type === 'click') G.target = realTarget(e);
  };
  on(window, 'pointerdown', startGesture);
  on(window, 'keydown', startGesture);
  ['mousedown', 'pointerup', 'mouseup', 'touchend', 'click'].forEach((t) => on(window, t, contGesture));

  const recentGesture = () => performance.now() - G.t < CFG.gestureWindowMs;
  const INTERACTIVE = 'a[href],area[href],button,input[type=button],input[type=submit],input[type=image],' +
    '[role=button],[role=link],[role=menuitem],summary,label';
  const interactiveOf = (el) => {
    if (!el || el.nodeType !== 1 || !el.closest) return null;
    const it = el.closest(INTERACTIVE);
    return it && it !== document.body && it !== document.documentElement ? it : null;
  };

  function isTransparentEmpty(el, r) {
    r = r || el.getBoundingClientRect();
    if (r.width * r.height < 10000) return false;
    const cs = getComputedStyle(el);
    const transparent = parseFloat(cs.opacity) < 0.1 ||
      (/rgba\([^)]*,\s*0\)$|^transparent$/.test(cs.backgroundColor) && cs.backgroundImage === 'none');
    if (!transparent) return false;
    if (el.querySelector('img,video,canvas,svg,picture,iframe,input,button,textarea,select')) return false;
    if ((el.innerText || '').trim().length >= 3) return false;
    const kids = el.getElementsByTagName('*');
    for (let i = 0; i < kids.length && i < 20; i++) {
      if (getComputedStyle(kids[i]).backgroundImage !== 'none') return false;
    }
    return true;
  }
  function suspiciousBox(el) {
    if (!el || el.nodeType !== 1) return '';
    const r = el.getBoundingClientRect();
    const vp = (innerWidth * innerHeight) || 1;
    if (r.width * r.height >= CFG.bigLinkRatio * vp) return 'phủ gần hết màn hình';
    if (isTransparentEmpty(el, r)) return 'trong suốt/vô hình';
    return '';
  }
  function findTransparentOverlay(el) {
    for (let i = 0; el && el.nodeType === 1 && i < 5 && el !== document.body && el !== document.documentElement; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (cs.position !== 'fixed' && cs.position !== 'absolute') continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height >= 40000 && isTransparentEmpty(el, r)) return el;
    }
    return null;
  }
  function neutralizeOverlay(el) {
    let ov = el && suspiciousBox(el) ? el : null;
    if (!ov) ov = findTransparentOverlay(G.target);
    if (ov) ov.style.setProperty('pointer-events', 'none', 'important');
    return !!ov;
  }

  function onBlocked(href, reason, el) {
    blockedCount++;
    const removed = neutralizeOverlay(el);
    const host = hostOf(href);
    const canOpen = href && href !== 'about:blank' && !isAdUrl(href);
    toast((removed ? 'Đã chặn tab mới và gỡ lớp phủ. ' : 'Đã chặn tab mới. ') +
      (host ? '→ ' + host + ' ' : '') + `(${blockedCount})`, canOpen ? href : null);
    log('CHẶN:', reason, href);
  }

  // Dấu hiệu đáng ngờ của một lần mở tab bằng script ('' = không thấy gì bất thường)
  function popupSuspicion(href) {
    if (href === 'about:blank') return 'mở trang trống (chiêu hay dùng của popunder)';
    if (stripHash(href) === stripHash(location.href)) return 'mở lại chính trang này (chiêu tab-under)';
    const cross = !sameOrigin(href);
    if (cross && isGlobalCtx()) return 'script gắn trên toàn trang tự mở, không phải link/nút bạn bấm';
    const it = interactiveOf(G.target);
    if (!it) return 'bạn click vào vùng không phải link/nút';
    if (cross) {
      const s = suspiciousBox(it);
      if (s) return 'phần tử bạn click ' + s;
      if ((it.tagName === 'A' || it.tagName === 'AREA') && stripHash(it.href) !== stripHash(href)) {
        return 'bạn click link tới ' + (hostOf(it.href) || 'trang khác') + ' nhưng lại mở ' + hostOf(href);
      }
    }
    return '';
  }

  // Quyết định cho một lần mở tab mới: allow | ask | block
  function decide(href, susp) {
    if (isAdUrl(href)) return { act: 'block', why: 'domain quảng cáo' };
    if (waitingConfirm()) return { act: 'block', why: 'đang chờ bạn xác nhận một tab khác' };
    if (!recentGesture()) return { act: 'block', why: 'không có thao tác người dùng' };
    if (G.used) return { act: 'block', why: 'tab thứ 2 trong cùng 1 click' };
    G.used = true;
    if (isAllowed(hostOf(href))) return { act: 'allow', why: 'nằm trong danh sách cho phép' };
    if (CFG.confirm === 'off') return susp ? { act: 'block', why: susp } : { act: 'allow', why: '' };
    if (CFG.confirm === 'cross' && !susp && sameOrigin(href)) return { act: 'allow', why: 'cùng trang' };
    return { act: 'ask', why: susp };
  }

  function handleNewTab(kind, href, susp, doOpen, el) {
    const d = decide(href, susp);
    if (d.act === 'allow') { log('CHO PHÉP', kind + ':', href, d.why); return 'allow'; }
    if (d.act === 'ask') {
      if (susp) neutralizeOverlay(el);
      if (askOpen(href, d.why, doOpen)) { log('HỎI', kind + ':', href, d.why); return 'ask'; }
    }
    onBlocked(href, kind + ': ' + d.why, el);
    return 'block';
  }

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
    const newCtx = target == null || target === '' || opensNewContext(target);
    if (!newCtx && !isAdUrl(href)) return N.open.call(window, url, target, features);
    const r = handleNewTab('window.open', href, popupSuspicion(href),
      () => N.open.call(window, url, target, features));
    if (r === 'allow') return N.open.call(window, url, target, features);
    return fakeWindow();
  }

  safe('window.open', () => lockOpen(window));

  safe('iframe-getters', () => {
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

  // 4c. Link do script tự tạo rồi .click() / dispatchEvent
  const isLinkEl = (el) => el instanceof HTMLAnchorElement || el instanceof HTMLAreaElement;
  const relFeatures = (a) => {
    const rel = (a.getAttribute('rel') || '').toLowerCase();
    return rel.includes('noreferrer') ? 'noreferrer' : rel.includes('noopener') ? 'noopener' : '';
  };
  function linkGuard(a, kind) {
    const href = a.href;
    if (!href || a.hasAttribute('download') || /^javascript:/i.test(href)) return 'pass';
    if (isAdUrl(href)) { onBlocked(href, kind + ': domain quảng cáo', a); return 'block'; }
    const target = a.getAttribute('target');
    if (!opensNewContext(target)) return 'pass';
    return handleNewTab(kind, href, popupSuspicion(href), () => N.open.call(window, href, target, relFeatures(a)), a);
  }
  safe('link-click', () => {
    HTMLElement.prototype.click = function () {
      if (isLinkEl(this)) {
        const r = linkGuard(this, 'a.click()');
        if (r === 'block' || r === 'ask') return;
      }
      return N.click.call(this);
    };
    EventTarget.prototype.dispatchEvent = function (ev) {
      if (ev && ev.type === 'click' && isLinkEl(this)) {
        const r = linkGuard(this, 'click giả');
        if (r === 'block' || r === 'ask') return false;
      }
      return N.dispatch.call(this, ev);
    };
  });

  // 4d. Form submit sang tab mới
  safe('form', () => {
    const guard = (form, resume) => {
      if (!opensNewContext(form.getAttribute('target'))) return true;
      const href = toAbs(form.getAttribute('action') || location.href);
      return handleNewTab('form', href, popupSuspicion(href), resume) === 'allow';
    };
    HTMLFormElement.prototype.submit = function () {
      if (guard(this, () => N.submit.call(this))) return N.submit.call(this);
    };
    if (N.requestSubmit) {
      HTMLFormElement.prototype.requestSubmit = function (...args) {
        if (guard(this, () => N.submit.call(this))) return N.requestSubmit.apply(this, args);
      };
    }
  });

  // 4e. Bạn click THẬT vào link target="_blank" (hoặc lớp phủ <a> vô hình, link bị tráo href)
  on(window, 'click', (e) => {
    if (!e.isTrusted) return;
    const a = closestLink(realTarget(e));
    if (!a) return;
    const href = a.href;
    const curAttr = a.getAttribute('href');
    const target = a.getAttribute('target');
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

    let hard = '';
    if (isAdUrl(href)) hard = 'link tới domain quảng cáo';
    else if (a === G.link && curAttr !== G.linkHref) {
      const nh = baseDomain(hostOf(href));
      if (nh !== baseDomain(location.hostname) && nh !== baseDomain(hostOf(G.linkHref || ''))) {
        hard = 'href bị tráo lúc nhấn chuột';
      }
    }
    if (hard) {
      stop();
      if (a === G.link && curAttr !== G.linkHref) {
        G.linkHref == null ? a.removeAttribute('href') : a.setAttribute('href', G.linkHref);
      }
      onBlocked(href, 'click link: ' + hard, a);
      return;
    }

    if (!opensNewContext(target) || a.hasAttribute('download') || /^javascript:/i.test(href)) return;
    const sb = sameOrigin(href) ? '' : suspiciousBox(a);
    const susp = sb ? 'link ' + sb : '';
    // Ctrl/Cmd/Shift + click = bạn chủ động muốn tab mới
    if (!susp && (e.ctrlKey || e.metaKey || e.shiftKey)) { G.used = true; return; }

    const r = handleNewTab('click link', href, susp, () => N.open.call(window, href, target, relFeatures(a)), a);
    if (r !== 'allow') stop();
  });

  // 4f. Quét chủ động: <a>/<iframe> vô hình phủ toàn trang
  function scanOverlays() {
    const vp = innerWidth * innerHeight;
    if (!vp || !document.body) return;
    const list = document.querySelectorAll(
      'body > a, body > iframe, html > a, html > iframe, body > div > a, body > div > iframe');
    for (const el of list) {
      const cs = getComputedStyle(el);
      if (cs.pointerEvents === 'none' || (cs.position !== 'fixed' && cs.position !== 'absolute')) continue;
      const r = el.getBoundingClientRect();
      if (r.width * r.height < 0.5 * vp) continue;
      const invisible = parseFloat(cs.opacity) < 0.1 || (el.tagName === 'A' && isTransparentEmpty(el, r));
      if (invisible) {
        el.style.setProperty('pointer-events', 'none', 'important');
        log('gỡ lớp phủ vô hình:', el.tagName, el.href || el.src || '');
      }
    }
  }
  let scanTimer = 0;
  const scheduleScan = () => { if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = 0; scanOverlays(); }, 250); };
  safe('observer', () => {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) lockFramesIn(n);
      scheduleScan();
    }).observe(document, { childList: true, subtree: true });
    on(window, 'load', scheduleScan, false);
  });
})();
