// ==UserScript==
// @name         AdShield – Chặn quảng cáo & hỏi trước khi mở tab / chuyển trang
// @namespace    vinhtt.adshield
// @version      1.4.0
// @description  Ẩn quảng cáo, chặn script quảng cáo, mọi tab mới hoặc chuyển trang sang domain khác đều phải xác nhận; blacklist theo domain/query/URL có wildcard. Alt+Shift+A: tắt/bật cho trang. Alt+Shift+B: quản lý blacklist. Alt+Shift+R: xoá danh sách cho phép.
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
    // Tab/cửa sổ mới:
    // 'all'   = hỏi trước MỌI tab/cửa sổ mới (kể cả cùng trang)
    // 'cross' = cùng trang thì mở luôn, sang trang khác hoặc đáng ngờ thì hỏi
    // 'off'   = không hỏi: tự chặn tab đáng ngờ, cho qua tab bình thường
    confirm: 'all',
    // Khi click mà trang HIỆN TẠI bị chuyển sang domain khác:
    // 'all'    = hỏi mọi lần (kể cả click link thường sang trang khác)
    // 'script' = chỉ hỏi khi do script tự chuyển, hoặc link có dấu hiệu bẫy
    // 'off'    = không kiểm tra
    confirmNavigate: 'all',
    navGestureMs: 5000,          // chuyển trang trong khoảng này sau click được coi là "do click gây ra"
    confirmAutoRedirect: false,  // true = hỏi cả khi trang tự chuyển hướng mà không có click nào
    // Blacklist dùng chung cho MỌI trang. Dạng 'loại:mẫu', hỗ trợ wildcard *:
    //   'host:popads.xyz'   'host:*.adnet.*'   'query:zoneid=*'   'url:*://*/go.php?*'
    // Blacklist thêm từ hộp xác nhận được lưu riêng cho từng trang; Alt+Shift+B để xem/xoá/sao chép.
    blacklist: [],
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
  const isAdUrl = (u) => { const x = u ? hostOf(u) : ''; return !!x && AD_HOSTS.some((d) => x.includes(d)); };
  const sameOrigin = (u) => { try { return new URL(u, location.href).origin === location.origin; } catch (_) { return false; } };
  const stripHash = (u) => String(u).split('#')[0];
  const sameSite = (u) => { const x = hostOf(u); return !x || baseDomain(x) === baseDomain(location.hostname); };
  const opensNewContext = (t) => { t = (t || '').toLowerCase(); return !!t && !['_self', '_parent', '_top'].includes(t); };
  const realTarget = (e) => (e.composedPath && e.composedPath()[0]) || e.target;
  const safe = (name, fn) => { try { fn(); } catch (e) { console.warn('[AdShield]', name, e); } };
  const log = (...a) => { if (CFG.debug) console.info('%c[AdShield]', 'color:#2f81f7;font-weight:bold', ...a); };

  /* ========================= LƯU TRỮ THEO TRANG ========================= */
  const KEY_OFF = '__adshield_off', KEY_ALLOW = '__adshield_allow', KEY_BLOCK = '__adshield_block';
  const lsList = (k) => { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch (_) { return []; } };
  const lsSave = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (_) {} };

  let isOff = false;
  try { isOff = localStorage.getItem(KEY_OFF) === '1'; } catch (_) {}

  let allowHosts = lsList(KEY_ALLOW).filter((x) => typeof x === 'string');
  const isAllowed = (host) => !!host && allowHosts.includes(host);

  /* ========================= BLACKLIST (wildcard *) ========================= */
  const BL_TYPES = { host: 'Domain/host', query: 'Query string', url: 'Cả URL' };
  const BL_HINTS = {
    host: 'Hỗ trợ *. VD: ads.com (gồm cả subdomain), *.ads.com, pop*.xyz, *ads*.*',
    query: 'Nhiều điều kiện nối bằng &, hỗ trợ *. VD: zoneid=*, utm_source=pop*, *=*popunder*, aff_id&sub=*',
    url: 'So khớp toàn bộ URL, hỗ trợ *. VD: *://*/go.php?*, https://site.com/out/*',
  };
  const wild = (p) => new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  const safeDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (_) { return s; } };

  function compileRule(t, p) {
    p = String(p == null ? '' : p).trim();
    if (!p || !BL_TYPES[t]) return null;
    try {
      if (t === 'host') {
        p = p.toLowerCase().replace(/^[a-z*]+:\/\//, '').replace(/[/:?#].*$/, '');
        if (!p) return null;
        const re = wild(p);
        const bare = p.replace(/^\*\./, '');
        const plain = bare.includes('*') ? null : bare; // "ads.com" / "*.ads.com" => ads.com và mọi subdomain
        return { t, p, test: (u) => { const x = u.hostname.toLowerCase(); return re.test(x) || (!!plain && (x === plain || x.endsWith('.' + plain))); } };
      }
      if (t === 'query') {
        p = p.replace(/^\?/, '');
        const parts = p.split('&').filter(Boolean).map((part) => ({ re: wild(part), kv: part.includes('=') }));
        if (!parts.length) return null;
        return {
          t, p, test: (u) => {
            const pairs = u.search.replace(/^\?/, '').split('&').filter(Boolean);
            if (!pairs.length) return false;
            const cands = pairs.flatMap((x) => [x, safeDecode(x)]);
            return parts.every((pt) => cands.some((kv) => pt.re.test(pt.kv ? kv : kv.split('=')[0])));
          },
        };
      }
      const re = wild(p);
      return { t, p, test: (u) => re.test(u.href.split('#')[0]) || re.test(u.href) };
    } catch (_) { return null; }
  }
  const ruleLabel = (r) => `${r.t}:${r.p}`;

  const GLOBAL_RULES = CFG.blacklist.map((s) => {
    const m = /^(host|query|url):(.*)$/i.exec(String(s));
    return m ? compileRule(m[1].toLowerCase(), m[2]) : compileRule('host', s);
  }).filter(Boolean);
  let siteRules = lsList(KEY_BLOCK).map((e) => e && compileRule(e.t, e.p)).filter(Boolean);
  const saveSiteRules = () => lsSave(KEY_BLOCK, siteRules.map(({ t, p }) => ({ t, p })));

  function blacklistHit(href) {
    if (!siteRules.length && !GLOBAL_RULES.length) return null;
    let u;
    try { u = new URL(href, location.href); } catch (_) { return null; }
    if (!/^https?:$/.test(u.protocol)) return null;
    return siteRules.find((r) => r.test(u)) || GLOBAL_RULES.find((r) => r.test(u)) || null;
  }
  // Lý do chặn thẳng (không hỏi) cho tab mới / chuyển trang / click link
  function blockReason(href) {
    if (!href) return '';
    if (isAdUrl(href)) return 'domain quảng cáo';
    const r = blacklistHit(href);
    return r ? 'blacklist ' + ruleLabel(r) : '';
  }

  /* ========================= UI: toast, hộp xác nhận, bảng quản lý (closed shadow DOM) ========================= */
  // Mọi sự kiện trên UI bị chặn ngay ở window-capture: script của trang không thấy và không "bấm hộ" được.
  let UI = null, toastTimer = 0, blockedCount = 0;
  let navBypassUntil = 0; // cho qua lần chuyển trang do chính bạn vừa đồng ý
  const bypassNav = () => { navBypassUntil = performance.now() + 1500; };
  function navTo(href) { bypassNav(); location.assign(href); }

  const MONO = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const UI_CSS = `
    [hidden]{display:none!important}
    *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .toast{position:fixed;right:16px;bottom:16px;max-width:min(440px,calc(100vw - 32px));display:flex;gap:8px;
      align-items:center;padding:10px 12px;border-radius:8px;background:#1f2328;color:#f0f3f6;font-size:13px;
      line-height:1.4;box-shadow:0 6px 20px rgba(0,0,0,.35);word-break:break-word}
    .backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;
      justify-content:center;padding:16px}
    .dialog{width:min(480px,100%);max-height:calc(100vh - 32px);overflow:auto;background:#fff;color:#1f2328;
      border-radius:12px;padding:18px 18px 14px;box-shadow:0 12px 40px rgba(0,0,0,.35);font-size:14px;line-height:1.45}
    .panel .dialog{width:min(560px,100%)}
    .title{font-weight:700;font-size:15px;margin-bottom:10px}
    .host{font-size:18px;font-weight:700;word-break:break-all}
    .url{margin-top:4px;color:#59636e;font-size:12px;word-break:break-all;max-height:4.6em;overflow:auto}
    .warn{margin-top:10px;padding:8px 10px;border-radius:8px;background:#fff1e5;color:#953800;font-size:13px}
    .warn.ok{background:#ddf4ff;color:#0a3069}
    .allow{display:flex;gap:8px;align-items:center;margin-top:12px;font-size:13px;color:#59636e;cursor:pointer}
    .btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:14px}
    button{all:unset;cursor:pointer;padding:7px 14px;border-radius:7px;font-weight:600;font-size:13px}
    button:focus-visible{outline:2px solid #2f81f7;outline-offset:2px}
    .pri{background:#1f6feb;color:#fff}
    .sec{background:#eff2f5;color:#1f2328}
    .danger{background:#cf222e;color:#fff}
    .toast .pri{padding:3px 9px}
    .x{background:transparent;color:#9198a1;padding:3px 6px}
    .blbtn{margin-top:10px;padding:2px 0;font-size:12px;color:#cf222e}
    .bl{margin-top:8px;padding:10px;border-radius:8px;background:#f6f8fa;border:1px solid #d1d9e0}
    .seg{display:flex;gap:4px;flex-wrap:wrap}
    .seg button{padding:4px 10px;font-size:12px;background:#eff2f5;color:#1f2328;border-radius:6px}
    .seg button.on{background:#1f2328;color:#fff}
    input.pat{display:block;width:100%;margin:8px 0 0;padding:6px 8px;border:1px solid #d1d9e0;border-radius:6px;
      background:#fff;color:#1f2328;font:12px/1.4 ${MONO};outline:none}
    input.pat:focus{border-color:#1f6feb;box-shadow:0 0 0 2px rgba(31,111,235,.25)}
    .chips{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
    .chips button{padding:2px 8px;font:11px/1.5 ${MONO};background:#ddf4ff;color:#0a3069;border-radius:10px;
      max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .match{margin-top:6px;font-size:12px;font-weight:600}
    .match.yes{color:#1a7f37}.match.no{color:#cf222e}
    .hint{margin-top:4px;font-size:11px;color:#59636e}
    .bl .btns{margin-top:8px}
    .sect{margin-top:14px;font-weight:700;font-size:13px}
    .row{display:flex;gap:8px;align-items:center;justify-content:space-between;padding:5px 0;
      border-bottom:1px solid #eaeef2;font:12px/1.4 ${MONO};word-break:break-all}
    .tag{font:10px system-ui,sans-serif;padding:1px 6px;border-radius:8px;background:#eff2f5;color:#59636e;margin-right:6px}
    .empty{font-size:12px;color:#59636e;padding:4px 0}
    @media (prefers-color-scheme:dark){
      .dialog{background:#1f2328;color:#f0f3f6}.url,.allow,.hint,.empty{color:#9198a1}
      .sec,.seg button{background:#30363d;color:#f0f3f6}.seg button.on{background:#f0f3f6;color:#1f2328}
      .warn{background:#3d2a12;color:#f0b072}.warn.ok{background:#0c2d4a;color:#9cd1ff}
      .bl{background:#161b22;border-color:#30363d}input.pat{background:#0d1117;color:#f0f3f6;border-color:#30363d}
      .chips button{background:#0c2d4a;color:#9cd1ff}.row{border-color:#30363d}.tag{background:#30363d;color:#9198a1}
      .blbtn{color:#ff7b72}.match.yes{color:#3fb950}.match.no{color:#ff7b72}}`;

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

    // Toast
    const toastMsg = h('span');
    const toastOpen = h('button', { class: 'pri', 'data-act': 'toast-open', text: 'Mở' });
    const toast = h('div', { class: 'toast' }, toastMsg, toastOpen,
      h('button', { class: 'x', 'data-act': 'toast-close', text: '✕' }));
    toast.hidden = true;

    // Hộp xác nhận
    const mTitle = h('div', { class: 'title' });
    const mHost = h('div', { class: 'host' });
    const mUrl = h('div', { class: 'url' });
    const mWarn = h('div', { class: 'warn' });
    const mCb = h('input', { type: 'checkbox' });
    const mCbText = h('span');
    const mAllow = h('label', { class: 'allow' }, mCb, mCbText);
    const blToggle = h('button', { class: 'blbtn', 'data-act': 'bl-toggle', text: '🚫 Thêm vào blacklist (lần sau tự chặn, không hỏi)…' });
    const segBtns = {};
    const seg = h('div', { class: 'seg' }, ...Object.keys(BL_TYPES).map((t) =>
      (segBtns[t] = h('button', { 'data-act': 'bl-type:' + t, text: BL_TYPES[t] }))));
    const blInput = h('input', { class: 'pat', type: 'text', spellcheck: 'false', autocomplete: 'off' });
    const blChips = h('div', { class: 'chips' });
    const blMatch = h('div', { class: 'match' });
    const blHint = h('div', { class: 'hint' });
    const blScope = h('div', { class: 'hint' });
    const blSection = h('div', { class: 'bl' }, seg, blInput, blChips, blMatch, blHint, blScope,
      h('div', { class: 'btns' }, h('button', { class: 'danger', 'data-act': 'bl-add', text: 'Chặn & thêm vào blacklist' })));
    blSection.hidden = true;
    N.addEL.call(blInput, 'input', () => updateBlMatch(), false);
    const mBlock = h('button', { class: 'sec', 'data-act': 'block', text: 'Chặn' });
    const mOpen = h('button', { class: 'pri', 'data-act': 'open', text: 'Mở tab' });
    const modal = h('div', { class: 'backdrop', 'data-act': 'block' },
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'data-act': 'noop' },
        mTitle, mHost, mUrl, mWarn, mAllow, blToggle, blSection, h('div', { class: 'btns' }, mBlock, mOpen)));
    modal.hidden = true;

    // Bảng quản lý (Alt+Shift+B)
    const pList = h('div');
    const panel = h('div', { class: 'backdrop panel', 'data-act': 'panel-close' },
      h('div', { class: 'dialog', role: 'dialog', 'data-act': 'noop' },
        h('div', { class: 'title', text: 'AdShield – blacklist & danh sách cho phép' }), pList,
        h('div', { class: 'btns' },
          h('button', { class: 'sec', 'data-act': 'copy-bl', text: 'Sao chép blacklist dạng CFG' }),
          h('button', { class: 'pri', 'data-act': 'panel-close', text: 'Đóng' }))));
    panel.hidden = true;

    N.append.call(sr, h('style', { text: UI_CSS }));
    N.append.call(sr, modal);
    N.append.call(sr, panel);
    N.append.call(sr, toast);
    UI = { host, sr, toast, toastMsg, toastOpen, toastUrl: null, toastNav: false,
      modal, mTitle, mHost, mUrl, mWarn, mCb, mCbText, mAllow, mBlock, mOpen,
      blToggle, blSection, segBtns, blInput, blChips, blMatch, blHint, blScope, blType: 'host', blSugg: [],
      panel, pList, pending: null };
    return UI;
  }
  function mountUI() {
    ensureUI();
    const root = document.documentElement;
    if (!root) return false;
    if (!UI.host.isConnected) N.append.call(root, UI.host);
    return true;
  }

  function toast(msg, openUrl, nav = false) {
    if (!CFG.showToast || !mountUI()) return;
    UI.toastMsg.textContent = msg;
    UI.toastUrl = openUrl || null;
    UI.toastNav = nav;
    UI.toastOpen.textContent = nav ? 'Đi tới' : 'Mở';
    UI.toastOpen.hidden = !openUrl;
    UI.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }
  function hideToast() { if (UI) UI.toast.hidden = true; }

  // Hiện hộp xác nhận. doOpen() chạy trong chính cú click đồng ý của bạn (trình duyệt cho phép mở).
  // kind: 'tab' = mở tab/cửa sổ mới, 'nav' = chuyển trang hiện tại sang domain khác
  function askOpen(href, reason, doOpen, kind = 'tab') {
    if (!mountUI()) return false;
    const host = hostOf(href);
    const nav = kind === 'nav';
    UI.pending = { href, host, doOpen, kind };
    UI.mTitle.textContent = nav ? `Trang này muốn chuyển từ ${location.hostname} sang:` : 'Trang này muốn mở tab mới:';
    UI.mOpen.textContent = nav ? 'Chuyển trang' : 'Mở tab';
    UI.mHost.textContent = host || (href === 'about:blank' ? 'Trang trống (about:blank)' : href);
    UI.mUrl.textContent = href;
    UI.mWarn.className = reason ? 'warn' : 'warn ok';
    UI.mWarn.textContent = reason ? '⚠ Nghi quảng cáo: ' + reason
      : (nav ? 'Chuyển từ link/nút bạn vừa bấm.' : 'Mở từ link/nút bạn vừa bấm.');
    UI.mAllow.hidden = !host;
    UI.mCb.checked = false;
    UI.mCbText.textContent = `Luôn cho phép ${host} trên ${location.hostname} (không hỏi lại)`;
    UI.blToggle.hidden = !/^https?:/i.test(href);
    UI.blSection.hidden = true;
    UI.blType = 'host';
    UI.modal.hidden = false;
    setTimeout(() => UI.mBlock.focus(), 0);
    return true;
  }
  function closeModal() { if (UI) { UI.modal.hidden = true; UI.pending = null; } }
  const waitingConfirm = () => !!(UI && UI.pending);

  function resolvePending(act) {
    const p = UI.pending;
    const remember = UI.mCb.checked;
    closeModal();
    if (!p) return;
    if (act === 'open') {
      if (remember && p.host && !isAllowed(p.host)) {
        allowHosts.push(p.host);
        lsSave(KEY_ALLOW, allowHosts);
        toast(`Đã thêm ${p.host} vào danh sách cho phép của trang này`);
      }
      log('BẠN ĐỒNG Ý:', p.href);
      try { p.doOpen(); } catch (err) { console.warn('[AdShield] mở thất bại', err); }
    } else {
      blockedCount++;
      log('BẠN ĐÃ CHẶN:', p.href);
    }
  }

  /* ---------- Blacklist trong hộp xác nhận ---------- */
  function blSuggestions(href, t) {
    let u;
    try { u = new URL(href); } catch (_) { return []; }
    const out = [];
    if (t === 'host') {
      out.push(baseDomain(u.hostname), u.hostname);
    } else if (t === 'query') {
      const q = u.search.replace(/^\?/, '');
      const keys = [...new Set(q.split('&').filter(Boolean).map((x) => x.split('=')[0]).filter(Boolean))];
      keys.slice(0, 6).forEach((k) => out.push(k + '=*'));
      if (keys.length > 1 && q.length <= 200) out.push(q);
    } else {
      out.push(`*://${u.hostname}${u.pathname}*`, `*://${u.hostname}/*`);
      if (u.pathname.length > 1) out.push(`*${u.pathname}*`);
    }
    return [...new Set(out.filter(Boolean))];
  }
  function setBlType(t) {
    if (!BL_TYPES[t]) return;
    UI.blType = t;
    for (const k in UI.segBtns) UI.segBtns[k].className = k === t ? 'on' : '';
    const sugg = UI.pending ? blSuggestions(UI.pending.href, t) : [];
    UI.blSugg = sugg;
    UI.blChips.textContent = '';
    sugg.forEach((s, i) => N.append.call(UI.blChips, h('button', { 'data-act': 'bl-fill:' + i, title: s, text: s })));
    UI.blInput.value = sugg[0] || '';
    UI.blInput.placeholder = t === 'host' ? 'vd: *.adnet.xyz' : t === 'query' ? 'vd: zoneid=*' : 'vd: *://*/go.php?*';
    UI.blHint.textContent = BL_HINTS[t] + (t === 'query' && !sugg.length ? ' — URL này không có query string.' : '');
    UI.blScope.textContent = `Lưu cho ${location.hostname}. Muốn áp dụng mọi trang: Alt+Shift+B → sao chép vào CFG.blacklist.`;
    updateBlMatch();
  }
  function updateBlMatch() {
    if (!UI) return null;
    const r = compileRule(UI.blType, UI.blInput.value);
    if (!r) {
      UI.blMatch.className = 'match no';
      UI.blMatch.textContent = 'Mẫu trống hoặc không hợp lệ';
      return null;
    }
    let ok = false;
    try { ok = !!UI.pending && r.test(new URL(UI.pending.href)); } catch (_) {}
    UI.blMatch.className = ok ? 'match yes' : 'match no';
    UI.blMatch.textContent = ok ? '✓ Khớp với URL đang yêu cầu' : '✗ Không khớp URL đang yêu cầu (vẫn lưu được)';
    return r;
  }
  function addBlacklist() {
    const r = updateBlMatch();
    if (!r) { UI.blInput.focus(); return; }
    const p = UI.pending;
    if (!siteRules.some((x) => x.t === r.t && x.p === r.p)) { siteRules.push(r); saveSiteRules(); }
    // Bỏ khỏi danh sách cho phép những host khớp luật mới (blacklist luôn thắng)
    const n = allowHosts.length;
    allowHosts = allowHosts.filter((x) => { try { return !r.test(new URL('https://' + x + '/')); } catch (_) { return true; } });
    if (allowHosts.length !== n) lsSave(KEY_ALLOW, allowHosts);
    closeModal();
    blockedCount++;
    log('THÊM BLACKLIST:', ruleLabel(r), '| đã chặn:', p && p.href);
    toast('Đã chặn và thêm vào blacklist: ' + ruleLabel(r));
  }

  /* ---------- Bảng quản lý ---------- */
  function renderPanel() {
    const L = UI.pList;
    L.textContent = '';
    const sect = (t) => N.append.call(L, h('div', { class: 'sect', text: t }));
    const empty = (t) => N.append.call(L, h('div', { class: 'empty', text: t }));
    const row = (tag, text, act) => {
      const r = h('div', { class: 'row' }, h('span', null, h('span', { class: 'tag', text: tag }), document.createTextNode(text)));
      if (act) N.append.call(r, h('button', { class: 'x', 'data-act': act, title: 'Xoá', text: '✕' }));
      N.append.call(L, r);
    };
    sect(`Blacklist của ${location.hostname} (${siteRules.length})`);
    siteRules.length ? siteRules.forEach((r, i) => row(r.t, r.p, 'rm-bl:' + i)) : empty('Chưa có mục nào.');
    sect(`Blacklist chung – CFG.blacklist (${GLOBAL_RULES.length})`);
    GLOBAL_RULES.length ? GLOBAL_RULES.forEach((r) => row(r.t, r.p)) : empty('Trống. Sửa CFG.blacklist trong code để áp dụng cho mọi trang.');
    sect(`Danh sách cho phép của ${location.hostname} (${allowHosts.length})`);
    allowHosts.length ? allowHosts.forEach((x, i) => row('allow', x, 'rm-al:' + i)) : empty('Chưa có mục nào.');
  }
  function openPanel() {
    if (!mountUI()) return;
    renderPanel();
    UI.panel.hidden = false;
  }
  function copyBlacklist() {
    const txt = siteRules.map((r) => `    '${ruleLabel(r).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`).join('\n');
    if (!txt) { toast('Blacklist của trang này đang trống.'); return; }
    console.log('[AdShield] Dán vào CFG.blacklist:\n' + txt);
    const fail = () => toast('Không sao chép được, đã in ra Console (F12).');
    try {
      navigator.clipboard.writeText(txt).then(
        () => toast('Đã sao chép. Dán vào CFG.blacklist để áp dụng cho mọi trang.'), fail);
    } catch (_) { fail(); }
  }

  function uiAct(act) {
    const i = act.indexOf(':');
    const name = i < 0 ? act : act.slice(0, i);
    const arg = i < 0 ? '' : act.slice(i + 1);
    switch (name) {
      case 'toast-open': {
        const u = UI.toastUrl, nav = UI.toastNav;
        hideToast();
        if (u) nav ? navTo(u) : N.open.call(window, u, '_blank');
        break;
      }
      case 'toast-close': hideToast(); break;
      case 'open': case 'block': resolvePending(name); break;
      case 'bl-toggle':
        UI.blSection.hidden = !UI.blSection.hidden;
        if (!UI.blSection.hidden) { setBlType(UI.blType); setTimeout(() => UI.blInput.focus(), 0); }
        break;
      case 'bl-type': setBlType(arg); UI.blInput.focus(); break;
      case 'bl-fill': UI.blInput.value = UI.blSugg[+arg] || ''; updateBlMatch(); UI.blInput.focus(); break;
      case 'bl-add': addBlacklist(); break;
      case 'panel-close': UI.panel.hidden = true; break;
      case 'copy-bl': copyBlacklist(); break;
      case 'rm-bl': siteRules.splice(+arg, 1); saveSiteRules(); renderPanel(); break;
      case 'rm-al': allowHosts.splice(+arg, 1); lsSave(KEY_ALLOW, allowHosts); renderPanel(); break;
      default: break;
    }
  }

  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu',
    'touchstart', 'touchend', 'keydown', 'keyup', 'keypress'].forEach((t) => on(window, t, (e) => {
    if (!UI || realTarget(e) !== UI.host) return;
    e.stopImmediatePropagation();
    if (!e.isTrusted) return; // trang không thể "bấm hộ" nút trong UI
    if (t === 'click') {
      const el = e.detail === 0 && UI.sr.activeElement ? UI.sr.activeElement : UI.sr.elementFromPoint(e.clientX, e.clientY);
      const actEl = el && el.closest ? el.closest('[data-act]') : null;
      if (actEl) uiAct(actEl.getAttribute('data-act'));
    } else if (t === 'keydown') {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!UI.panel.hidden) uiAct('panel-close');
        else if (waitingConfirm()) uiAct('block');
      } else if (e.key === 'Enter' && UI.sr.activeElement === UI.blInput) {
        e.preventDefault();
        uiAct('bl-add');
      }
    }
  }));

  /* ---------- Phím tắt ---------- */
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
        lsSave(KEY_ALLOW, allowHosts);
        toast('AdShield: đã xoá danh sách cho phép của trang này');
      } else if (e.code === 'KeyB') {
        e.preventDefault();
        openPanel();
      }
    });
  }
  if (isOff) { log('đang TẮT cho trang này (Alt+Shift+A để bật)'); return; }
  if (isTop) {
    log('đang chạy trên', location.host, '| tab mới:', CFG.confirm, '| chuyển trang:', CFG.confirmNavigate,
      '| blacklist trang này:', siteRules.length, '| chung:', GLOBAL_RULES.length);
  }

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

  /* ========================= 4. KIỂM SOÁT TAB MỚI & CHUYỂN TRANG ========================= */
  if (!CFG.popupGuard) return;

  // 4a. Biết code đang chạy trong listener gắn ở đâu (document/window/body = popunder toàn trang)
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
  const recentNavGesture = () => performance.now() - G.t < CFG.navGestureMs;
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

  function onBlocked(href, reason, el, kind = 'tab') {
    blockedCount++;
    const removed = neutralizeOverlay(el);
    const host = hostOf(href);
    const canOpen = href && href !== 'about:blank' && !blockReason(href);
    const what = kind === 'nav' ? 'Đã chặn chuyển trang' : 'Đã chặn tab mới';
    const why = /^blacklist /.test(reason.split(': ').pop()) ? ' (blacklist)' : '';
    toast(what + why + (removed ? ' và gỡ lớp phủ. ' : '. ') +
      (host ? '→ ' + host + ' ' : '') + `(${blockedCount})`, canOpen ? href : null, kind === 'nav');
    log('CHẶN:', reason, href);
  }

  /* ---------- Tab / cửa sổ mới ---------- */
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
  function decide(href, susp) {
    const br = blockReason(href);
    if (br) return { act: 'block', why: br };
    if (waitingConfirm()) return { act: 'block', why: 'đang chờ bạn xác nhận một yêu cầu khác' };
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
      if (askOpen(href, d.why, doOpen, 'tab')) { log('HỎI', kind + ':', href, d.why); return 'ask'; }
    }
    onBlocked(href, kind + ': ' + d.why, el, 'tab');
    return 'block';
  }

  /* ---------- Chuyển trang hiện tại sang domain khác ---------- */
  // Chỉ kiểm soát việc chuyển trang của tab chính (không đụng iframe tự chuyển trang bên trong)
  const isSelfTarget = (t) => {
    if (!isTop || CFG.confirmNavigate === 'off') return false;
    t = (t || '').toLowerCase();
    return t === '' || t === '_self' || t === '_top' || t === '_parent';
  };
  function navSuspicion(href) {
    const to = hostOf(href);
    if (isGlobalCtx()) return 'script gắn trên toàn trang tự chuyển sang ' + to;
    const it = interactiveOf(G.target);
    if (!it) return 'bạn click vào vùng không phải link/nút nhưng trang lại chuyển sang ' + to;
    if ((it.tagName === 'A' || it.tagName === 'AREA') && baseDomain(hostOf(it.href)) !== baseDomain(to)) {
      return 'bạn click link tới ' + (hostOf(it.href) || 'trang khác') + ' nhưng trang lại chuyển sang ' + to;
    }
    const s = suspiciousBox(it);
    return s ? 'phần tử bạn click ' + s : '';
  }
  function decideNav(href, susp, byUserLink) {
    if (CFG.confirmNavigate === 'off') return { act: 'allow', why: '' };
    const br = blockReason(href);
    if (br) return { act: 'block', why: br };
    if (sameSite(href)) return { act: 'allow', why: '' };
    if (isAllowed(hostOf(href))) return { act: 'allow', why: 'nằm trong danh sách cho phép' };
    if (!byUserLink && !recentNavGesture() && !CFG.confirmAutoRedirect) {
      return { act: 'allow', why: 'trang tự chuyển hướng, không do click' };
    }
    if (waitingConfirm()) return { act: 'block', why: 'đang chờ bạn xác nhận một yêu cầu khác' };
    if (CFG.confirmNavigate === 'script' && byUserLink && !susp) return { act: 'allow', why: 'bạn click link' };
    return { act: 'ask', why: susp };
  }
  function handleNav(kind, href, d, doNav, el) {
    if (d.act === 'allow') { if (!sameSite(href)) log('CHO PHÉP chuyển trang', kind + ':', href, d.why); return 'allow'; }
    if (d.act === 'ask') {
      if (d.why) neutralizeOverlay(el);
      if (askOpen(href, d.why, doNav, 'nav')) { log('HỎI chuyển trang', kind + ':', href, d.why); return 'ask'; }
    }
    onBlocked(href, kind + ': ' + d.why, el, 'nav');
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
    if (!newCtx) {
      if (isSelfTarget(target)) { // window.open(url, '_self') = chuyển trang hiện tại
        const r = handleNav('window.open(_self)', href, decideNav(href, navSuspicion(href), false), () => navTo(href));
        return r === 'allow' ? N.open.call(window, url, target, features) : fakeWindow();
      }
      if (!blockReason(href)) return N.open.call(window, url, target, features);
    }
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
    const target = a.getAttribute('target');
    if (!opensNewContext(target)) {
      if (!isSelfTarget(target)) {
        const br = blockReason(href);
        if (br) { onBlocked(href, kind + ': ' + br, a, 'nav'); return 'block'; }
        return 'pass';
      }
      return handleNav(kind, href, decideNav(href, navSuspicion(href), false), () => navTo(href), a);
    }
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

  // 4d. Form submit (tab mới hoặc chuyển trang)
  safe('form', () => {
    const guard = (form, resume) => {
      const target = form.getAttribute('target');
      const href = toAbs(form.getAttribute('action') || location.href);
      if (!opensNewContext(target)) {
        if (!isSelfTarget(target)) return true;
        return handleNav('form', href, decideNav(href, navSuspicion(href), false), () => { bypassNav(); resume(); }) === 'allow';
      }
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

  // 4e. Bạn click THẬT vào link
  on(window, 'click', (e) => {
    if (!e.isTrusted) return;
    const a = closestLink(realTarget(e));
    if (!a) return;
    const href = a.href;
    const curAttr = a.getAttribute('href');
    const target = a.getAttribute('target');
    const newCtx = opensNewContext(target);
    const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

    let hard = blockReason(href);
    if (!hard && a === G.link && curAttr !== G.linkHref) {
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
      onBlocked(href, 'click link: ' + hard, a, newCtx ? 'tab' : 'nav');
      return;
    }
    if (a.hasAttribute('download') || /^javascript:/i.test(href)) return;

    // Link mở ngay trong tab hiện tại, sang domain khác
    if (!newCtx) {
      if (!isSelfTarget(target) || e.ctrlKey || e.metaKey || e.shiftKey || sameSite(href)) return;
      const sbn = suspiciousBox(a);
      const r = handleNav('click link', href, decideNav(href, sbn ? 'link ' + sbn : '', true), () => navTo(href), a);
      if (r !== 'allow') stop();
      return;
    }

    // Link mở tab mới
    const sb = sameOrigin(href) ? '' : suspiciousBox(a);
    const susp = sb ? 'link ' + sb : '';
    if (!susp && (e.ctrlKey || e.metaKey || e.shiftKey)) { G.used = true; return; } // bạn chủ động muốn tab mới
    const r = handleNewTab('click link', href, susp, () => N.open.call(window, href, target, relFeatures(a)), a);
    if (r !== 'allow') stop();
  });

  // 4f. Bắt mọi kiểu chuyển trang còn lại: location.href = ..., location.assign/replace, meta refresh...
  //     (cần Navigation API: Chrome/Edge/Opera)
  if (isTop && CFG.confirmNavigate !== 'off' && window.navigation) safe('navigation-api', () => {
    on(window.navigation, 'navigate', (e) => {
      if (!e.cancelable || e.hashChange || e.formData || e.downloadRequest != null) return;
      if (e.navigationType === 'traverse' || e.navigationType === 'reload') return;
      if (performance.now() < navBypassUntil) { navBypassUntil = 0; return; }
      const href = e.destination.url;
      const byUser = !!e.userInitiated;
      const d = decideNav(href, byUser ? '' : navSuspicion(href), byUser);
      const replace = e.navigationType === 'replace';
      const r = handleNav(byUser ? 'chuyển trang' : 'script chuyển trang', href, d,
        () => { bypassNav(); replace ? location.replace(href) : location.assign(href); });
      if (r !== 'allow') e.preventDefault();
    }, false);
  });
  if (isTop && CFG.confirmNavigate !== 'off' && !window.navigation) {
    log('trình duyệt chưa có Navigation API: chỉ bắt được chuyển trang qua link/form/window.open, không bắt được location.href = ...');
  }

  // 4g. Quét chủ động: <a>/<iframe> vô hình phủ toàn trang
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
