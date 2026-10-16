// ==UserScript==
// @name         AdShield – Chặn quảng cáo & popup bung tab
// @namespace    vinhtt.adshield
// @version      1.1.0
// @description  Ẩn quảng cáo, chặn script quảng cáo, chặn click bị bung tab/cửa sổ. Alt+Shift+A: tắt/bật cho trang. Alt+Shift+S: chế độ nghiêm ngặt.
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
    cosmetic: true,          // Ẩn phần tử quảng cáo bằng CSS
    blockAdRequests: true,   // Chặn script/iframe/fetch/XHR tới domain quảng cáo
    popupGuard: true,        // Chặn bung tab/cửa sổ mới
    gestureWindowMs: 2000,   // Popup chỉ hợp lệ trong khoảng này sau thao tác thật
    bigLinkRatio: 0.6,       // Link/nút chiếm >= 60% màn hình mà mở trang ngoài => coi là bẫy
    showToast: true,
    debug: true,             // Log ra Console (F12) mọi lần mở tab mới: CHO PHÉP hay CHẶN
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
  const safe = (name, fn) => { try { fn(); } catch (e) { console.warn('[AdShield]', name, e); } };
  const log = (...a) => { if (CFG.debug) console.info('%c[AdShield]', 'color:#2f81f7;font-weight:bold', ...a); };

  /* ---------- Toast ---------- */
  let toastUI = null, toastTimer = 0;
  function hideToast() { if (toastUI) toastUI.host.remove(); }
  function toast(msg, openUrl) {
    if (!CFG.showToast || !document.documentElement) return;
    if (!toastUI) {
      const host = document.createElement('adshield-toast');
      const sr = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent =
        '.box{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:400px;display:flex;' +
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
      on(openBtn, 'click', () => { if (toastUI.url) N.open.call(window, toastUI.url, '_blank', 'noopener'); hideToast(); }, false);
      on(closeBtn, 'click', hideToast, false);
    }
    toastUI.msgEl.textContent = msg;
    toastUI.url = openUrl || null;
    toastUI.openBtn.style.display = openUrl ? '' : 'none';
    if (!toastUI.host.isConnected) N.append.call(document.documentElement, toastUI.host);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }

  /* ---------- Cài đặt theo trang ---------- */
  const KEY_OFF = '__adshield_off', KEY_STRICT = '__adshield_strict';
  const lsGet = (k) => { try { return localStorage.getItem(k) === '1'; } catch (_) { return false; } };
  const lsSet = (k, v) => { try { v ? localStorage.setItem(k, '1') : localStorage.removeItem(k); } catch (_) {} };
  const isOff = lsGet(KEY_OFF);
  let strict = lsGet(KEY_STRICT);

  if (isTop) {
    on(window, 'keydown', (e) => {
      if (!e.altKey || !e.shiftKey) return;
      if (e.code === 'KeyA') {
        e.preventDefault();
        lsSet(KEY_OFF, !isOff);
        toast(isOff ? 'AdShield: đã BẬT lại cho trang này' : 'AdShield: đã TẮT cho trang này');
        setTimeout(() => location.reload(), 700);
      } else if (e.code === 'KeyS' && !isOff) {
        e.preventDefault();
        strict = !strict;
        lsSet(KEY_STRICT, strict);
        toast(strict
          ? 'AdShield: BẬT nghiêm ngặt — mọi tab mới sang trang khác đều bị chặn (bấm "Mở" nếu cần)'
          : 'AdShield: TẮT chế độ nghiêm ngặt');
      }
    });
  }
  if (isOff) { log('đang TẮT cho trang này (Alt+Shift+A để bật)'); return; }
  if (isTop) log('đang chạy trên', location.host, strict ? '(nghiêm ngặt)' : '');

  /* ========================= 1. ẨN QUẢNG CÁO BẰNG CSS ========================= */
  if (CFG.cosmetic) safe('cosmetic', () => {
    const iframeSel = AD_HOSTS.filter((h) => h.includes('.')).map((h) => `iframe[src*="${h}"]`);
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

  /* ========================= 4. CHẶN POPUP / TAB MỚI ========================= */
  if (!CFG.popupGuard) return;

  // 4a. Biết code đang chạy trong listener gắn ở đâu (document/window/body = kiểu popunder toàn trang)
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
    // document.onclick = ..., window.onmousedown = ...
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
  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
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

  let blockedCount = 0;
  function onBlocked(href, reason, el) {
    blockedCount++;
    let ov = el && suspiciousBox(el) ? el : null;
    if (!ov) ov = findTransparentOverlay(G.target);
    if (ov) ov.style.setProperty('pointer-events', 'none', 'important');
    const host = hostOf(href);
    const canOpen = href && href !== 'about:blank' && !isAdUrl(href);
    toast((ov ? 'Đã chặn tab mới và gỡ lớp phủ. Hãy click lại. ' : 'Đã chặn tab mới. ') +
      (host ? '→ ' + host + ' ' : '') + `(${blockedCount})`, canOpen ? href : null);
    log('CHẶN:', reason, href);
  }

  // Quyết định: trả về lý do chặn, hoặc '' nếu cho phép
  function popupVerdict(href) {
    if (isAdUrl(href)) return 'domain quảng cáo';
    if (!recentGesture()) return 'không có thao tác người dùng';
    if (G.used) return 'tab thứ 2 trong cùng 1 click';
    if (stripHash(href) === stripHash(location.href)) return 'tab-under (mở lại chính trang này)';
    const cross = href === 'about:blank' || !sameOrigin(href);
    if (strict && cross) return 'chế độ nghiêm ngặt';
    if (cross && isGlobalCtx()) return 'listener gắn ở document/window/body';
    const it = interactiveOf(G.target);
    if (!it) return 'click vào vùng không phải link/nút';
    if (cross) {
      const s = suspiciousBox(it);
      if (s) return 'phần tử được click ' + s;
      if ((it.tagName === 'A' || it.tagName === 'AREA') && stripHash(it.href) !== stripHash(href)) return 'link bị chiếm quyền';
    }
    return '';
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
    const v = popupVerdict(href);
    if (v) { onBlocked(href, 'window.open: ' + v); return fakeWindow(); }
    G.used = true;
    log('CHO PHÉP window.open:', href, '\n', new Error().stack);
    return N.open.call(window, url, target, features);
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
  function linkVerdict(a) {
    const href = a.href;
    if (!href || a.hasAttribute('download') || /^javascript:/i.test(href)) return '';
    if (isAdUrl(href)) return 'domain quảng cáo';
    if (!opensNewContext(a.getAttribute('target'))) return '';
    return popupVerdict(href);
  }
  safe('link-click', () => {
    HTMLElement.prototype.click = function () {
      if (isLinkEl(this)) {
        const v = linkVerdict(this);
        if (v) { onBlocked(this.href, 'a.click(): ' + v); return; }
        if (opensNewContext(this.getAttribute('target'))) { G.used = true; log('CHO PHÉP a.click():', this.href); }
      }
      return N.click.call(this);
    };
    EventTarget.prototype.dispatchEvent = function (ev) {
      if (ev && ev.type === 'click' && isLinkEl(this)) {
        const v = linkVerdict(this);
        if (v) { onBlocked(this.href, 'click giả: ' + v); return false; }
      }
      return N.dispatch.call(this, ev);
    };
  });

  // 4d. Form tự submit sang tab mới
  safe('form', () => {
    const guard = (form) => {
      if (!opensNewContext(form.getAttribute('target'))) return true;
      const href = toAbs(form.getAttribute('action') || location.href);
      const v = popupVerdict(href);
      if (v) { onBlocked(href, 'form: ' + v); return false; }
      G.used = true; return true;
    };
    HTMLFormElement.prototype.submit = function () { if (guard(this)) return N.submit.call(this); };
    if (N.requestSubmit) {
      HTMLFormElement.prototype.requestSubmit = function () { if (guard(this)) return N.requestSubmit.apply(this, arguments); };
    }
  });

  // 4e. Click THẬT vào link: lớp phủ <a> vô hình/khổng lồ, link bị tráo href, link quảng cáo
  on(window, 'click', (e) => {
    if (!e.isTrusted) return;
    const a = closestLink(realTarget(e));
    if (!a) return;
    const href = a.href;
    const curAttr = a.getAttribute('href');
    const newCtx = opensNewContext(a.getAttribute('target'));
    let reason = '';

    if (isAdUrl(href)) reason = 'link tới domain quảng cáo';
    else if (a === G.link && curAttr !== G.linkHref) {
      const h = baseDomain(hostOf(href));
      const oldH = baseDomain(hostOf(G.linkHref || ''));
      if (h !== baseDomain(location.hostname) && h !== oldH) reason = 'href bị tráo lúc nhấn chuột';
    }
    if (!reason && newCtx && !a.hasAttribute('download') && !sameOrigin(href)) {
      const s = suspiciousBox(a);
      if (s) reason = 'link ' + s;
      else if (strict) reason = 'chế độ nghiêm ngặt';
    }

    if (reason) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (a === G.link && curAttr !== G.linkHref) {
        G.linkHref == null ? a.removeAttribute('href') : a.setAttribute('href', G.linkHref);
      }
      onBlocked(href, 'click link: ' + reason, a);
      return;
    }
    if (newCtx) { G.used = true; log('CHO PHÉP link tab mới:', href); }
  });

  // 4f. Quét chủ động: <a>/<iframe> vô hình phủ toàn trang (không bao giờ là nội dung thật)
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
