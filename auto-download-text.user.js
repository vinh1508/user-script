// ==UserScript==
// @name        Download Text
// @namespace   Violentmonkey Scripts
// @match       http://www.2wxsi.com/book/*
// @match       https://www.wa01.com/novel/*
// @match       https://www.uukan.org/chapter/*/*
// @match       https://ixdzs8.com/read/*
// @version     1.15
// @author      -
// @description Thêm nút Copy TXT, Download TXT và Auto Next
// @grant       GM_download
// ==/UserScript==

(function () {
    'use strict';

    const SITE_CONFIGS = {
        '2wxsi.com': {
            titleSel: '.container h1',
            contentSel: '#content',
            insertAnchorSel: '.container h1',
            insertPosition: 'afterend',
        },
        'wa01.com': {
            titleSel: '.container h1',
            contentSel: '#content',
            insertAnchorSel: '.container h1',
            insertPosition: 'afterend',
        },
        'uukan.org': {
            titleSel: '.container h1',
            contentSel: '#content',
            insertAnchorSel: '.container h1',
            insertPosition: 'afterend',
        },
        'ixdzs8.com': {
            titleSel: '.page-content h3',
            contentSel: '.page-content section',
            insertAnchorSel: '.page-content h3',
            insertPosition: 'afterend',
            bookTitle: 'header.page-opt-header h2'
        }
    };

    const config = Object.entries(SITE_CONFIGS)
        .find(([domain]) => location.hostname.includes(domain))?.[1];

    if (!config) return;

    const AUTO_NEXT_ENABLED_KEY = 'uukanAutoNextEnabled';
    const AUTO_NEXT_PENDING_KEY = 'uukanAutoNextPending';
    const AUTO_NEXT_DELAY_SECONDS = 5;
    const AUTO_NEXT_CHECKBOX_ID = 'uukan-auto-next-checkbox';
    const DOWNLOAD_FALLBACK_DELAY_MS = 1500;
    const DOWNLOAD_ROOT_FOLDER_NAME = 'uukan-txt';

    // ── Toast ────────────────────────────────────────────────────────────────

    const style = document.createElement('style');
    style.textContent = `
    #vm-toast {
      position: fixed; bottom: 32px; left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: #1a1a1a; color: #fff;
      padding: 10px 20px; border-radius: 8px;
      font-size: 14px; font-family: sans-serif;
      opacity: 0; pointer-events: none;
      transition: opacity 0.25s ease, transform 0.25s ease;
      z-index: 999999; white-space: nowrap;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
    }
    #vm-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    #vm-toast.success { border-left: 4px solid #22c55e; }
    #vm-toast.error   { border-left: 4px solid #ef4444; }
  `;
    document.head.appendChild(style);

    const toast = Object.assign(document.createElement('div'), { id: 'vm-toast' });
    document.body.appendChild(toast);
    let toastTimer;

    function showToast(message, type = 'success') {
        clearTimeout(toastTimer);
        toast.textContent = message;
        toast.className = `${type} show`;
        toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
    }

    // ── Clipboard & Download ─────────────────────────────────────────────────

    async function copyText(text) {
        if (navigator.clipboard && window.isSecureContext) {
            return navigator.clipboard.writeText(text);
        }
        const ta = Object.assign(document.createElement('textarea'), { value: text });
        ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (!ok) throw new Error('Fallback copy failed');
    }

    function wait(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function sanitizePathSegment(value, fallback) {
        const sanitized = String(value || '')
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/^\.+$/, '');

        return sanitized || fallback;
    }

    function getPathSegmentAfter(...markers) {
        const parts = location.pathname.split('/').filter(Boolean);
        for (const marker of markers) {
            const index = parts.indexOf(marker);
            if (index !== -1 && parts[index + 1]) {
                return parts[index + 1].replace(/\.[^.]+$/, '');
            }
        }
        return parts[0]?.replace(/\.[^.]+$/, '') || location.hostname;
    }

    function isNavigationText(text) {
        return /^(首页|上一页|下一页|上一章|下一章|目录|章节目录|返回书页|书页|阅读记录|添加书签)$/i.test(text);
    }

    function getStoryTitleFromLinks(chapterTitle) {
        const links = document.querySelectorAll([
            'a[href*="/book/"]',
            'a[href*="/novel/"]',
        ].join(','));

        for (const link of links) {
            const text = link.innerText.trim();
            if (!text || text === chapterTitle || isNavigationText(text)) continue;
            if (link.id === 'linkNext' || link.id === 'linkPrev') continue;
            return text;
        }

        return '';
    }

    function getStoryTitleFromDocument(chapterTitle) {
        return document.title
            .split(/[_|｜-]/)
            .map(part => part.trim())
            .find(part => (
                part &&
                part !== chapterTitle &&
                !isNavigationText(part) &&
                !/uukan|UU看书|2wxsi|wa01/i.test(part)
            )) || '';
    }

    function getStoryFolderName(chapterTitle) {
        const storyTitle = getStoryTitleFromLinks(chapterTitle) ||
            getStoryTitleFromDocument(chapterTitle);
        const storyId = getPathSegmentAfter('book', 'novel', 'chapter');
        return sanitizePathSegment(storyTitle || storyId, 'unknown-story');
    }

    function buildDownloadPath(folderName, filename) {
        return `${DOWNLOAD_ROOT_FOLDER_NAME}/${folderName}/${filename}.txt`;
    }

    function isBookOverviewUrl(url) {
        try {
            return /^\/book\/[^/]+\.html?$/i.test(new URL(url, location.href).pathname);
        } catch (err) {
            return false;
        }
    }

    function downloadWithAnchor(filename, content) {
        const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
        const a = Object.assign(document.createElement('a'), { href: url, download: `${filename}.txt` });
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_FALLBACK_DELAY_MS);
        return wait(DOWNLOAD_FALLBACK_DELAY_MS);
    }

    function downloadWithUserscriptManager(folderName, filename, content) {
        if (typeof GM_download !== 'function') {
            return null;
        }

        const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));

        return new Promise((resolve, reject) => {
            const cleanup = () => URL.revokeObjectURL(url);

            try {
                GM_download({
                    url,
                    name: buildDownloadPath(folderName, filename),
                    saveAs: false,
                    onload: () => {
                        cleanup();
                        resolve();
                    },
                    onerror: error => {
                        cleanup();
                        reject(error);
                    },
                    ontimeout: () => {
                        cleanup();
                        reject(new Error('Download timed out'));
                    },
                });
            } catch (err) {
                cleanup();
                reject(err);
            }
        });
    }

    async function downloadTxt(folderName, filename, content) {
        const managerDownload = downloadWithUserscriptManager(folderName, filename, content);
        if (managerDownload) {
            try {
                await managerDownload;
                return;
            } catch (err) {
                console.warn('GM_download failed, falling back to anchor download:', err);
            }
        }

        await downloadWithAnchor(filename, content);
    }

    async function downloadCurrentPage() {
        const { title, text, story } = getContent();
        const folderName = getStoryFolderName(title);
        const parts = splitContentForDownload(title, story, text);

        for (const [index, part] of parts.entries()) {
            const filename = buildFilename(title, index + 1);
            await downloadTxt(folderName, filename, part.fullText);
        }

        showToast(`⬇️ Đã tải ${parts.length} phần của chương.`, 'success');
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    function buildFilename(title, partNumber) {
        const chapterMatch = title.match(/第\s*(\d+)\s*章/);
        const chapterLabel = chapterMatch ? `第${chapterMatch[1]}章` : title;
        const safeChapterLabel = sanitizePathSegment(chapterLabel, 'chapter');
        return `${safeChapterLabel} (${partNumber})`;
    }

    function splitContentForDownload(title, story, text) {
        const lines = text.split(/\r?\n/);
        const middleLineIndex = Math.ceil(lines.length / 2);
        const createPart = (suffix, contentLines) => {
            const partTitle = `${title} (${suffix})`;
            return {
                title: partTitle,
                fullText: `${partTitle}\n\n${contentLines.join('\n')}`,
            };
        };

        return [
            createPart('第1/2页', lines.slice(0, middleLineIndex)),
            createPart('第2/2页', lines.slice(middleLineIndex)),
        ];
    }
    function getStoryName() {
        return document.querySelector(config.bookTitle)?.innerText.trim() || document.querySelector('#bkName')?.value ||
        document.querySelector('.breadcrumbs li:last-child')?.textContent
        ;
    }

    function getContent() {
        document.querySelectorAll(`${config.contentSel} *:not(p):not(br)`).forEach(el => el.remove());
        const title = document.querySelector(config.titleSel)?.innerText.trim() || '';
        let text = (document.querySelector(config.contentSel)?.innerText.trim() || '').replace('read3();','');
        const story = getStoryName();
        const psIndex = text.search(/^\s*PS：/m);
        if (psIndex !== -1) text = text.slice(0, psIndex).trimEnd();
        return { title, text, story, fullText: `${title}\n\n${text}` };
    }

    function createButton(label, onClick) {
        const btn = document.createElement('button');
        btn.textContent = label;
        btn.style.cssText = 'margin-left:10px;padding:4px 8px;font-size:14px;cursor:pointer';
        btn.addEventListener('click', onClick);
        return btn;
    }

    function createAutoNextControl() {
        const label = document.createElement('label');
        label.style.cssText = 'margin-left:10px;font-size:14px;cursor:pointer;user-select:none';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = AUTO_NEXT_CHECKBOX_ID;
        checkbox.checked = localStorage.getItem(AUTO_NEXT_ENABLED_KEY) === '1';
        checkbox.style.cssText = 'margin-right:4px;vertical-align:middle';

        const text = document.createElement('span');
        text.textContent = 'Auto Next';

        label.append(checkbox, text);
        return { label, checkbox, text };
    }

    function setAutoNextEnabled(enabled) {
        if (enabled) {
            localStorage.setItem(AUTO_NEXT_ENABLED_KEY, '1');
            return;
        }
        localStorage.removeItem(AUTO_NEXT_ENABLED_KEY);
        localStorage.removeItem(AUTO_NEXT_PENDING_KEY);

        const checkbox = document.getElementById(AUTO_NEXT_CHECKBOX_ID);
        if (checkbox) checkbox.checked = false;
    }

    function goToNextPage() {
        const nextLink = document.getElementById('linkNext');
        if (!nextLink || isBookOverviewUrl(nextLink.href)) {
            setAutoNextEnabled(false);
            showToast('✅ Đã tới trang cuối, đã dừng Auto Next.', 'success');
            return false;
        }

        localStorage.setItem(AUTO_NEXT_PENDING_KEY, '1');
        nextLink.click();
        return true;
    }

    async function runDownloadAndNext() {
        await downloadCurrentPage();
        setTimeout(()=>{
            if (localStorage.getItem(AUTO_NEXT_ENABLED_KEY) === '1') {
                goToNextPage();
            }
        }, 250)
    }

    function startAutoNextCountdown(checkbox, text) {
        if (
            !checkbox.checked ||
            localStorage.getItem(AUTO_NEXT_PENDING_KEY) !== '1'
        ) {
            return null;
        }

        let remainingSeconds = AUTO_NEXT_DELAY_SECONDS;
        text.textContent = `Auto Next (${remainingSeconds}s)`;

        const timer = setInterval(() => {
            if (!checkbox.checked) {
                clearInterval(timer);
                text.textContent = 'Auto Next';
                localStorage.removeItem(AUTO_NEXT_PENDING_KEY);
                return;
            }

            remainingSeconds -= 1;
            if (remainingSeconds > 0) {
                text.textContent = `Auto Next (${remainingSeconds}s)`;
                return;
            }

            clearInterval(timer);
            text.textContent = 'Auto Next';
            runDownloadAndNext().catch(err => {
                setAutoNextEnabled(false);
                showToast('❌ Tải TXT thất bại, đã dừng Auto Next.', 'error');
                console.error('Auto Next download failed:', err);
            });
        }, 1000);

        return timer;
    }

    // ── Init ──────────────────────────────────────────────────────────────────

    function init() {
        const anchor = document.querySelector(config.insertAnchorSel);
        if (!anchor) return;

        const btnCopy = createButton('📋 Copy TXT', async () => {
            try {
                await copyText(getContent().fullText);
                showToast('✅ Đã sao chép vào clipboard!', 'success');
            } catch (err) {
                showToast('❌ Sao chép thất bại!', 'error');
                console.error('Lỗi khi sao chép:', err);
            }
        });

        const autoNext = createAutoNextControl();
        let autoNextTimer = null;

        const btnDownload = createButton('⬇️ Download TXT', () => {
            runDownloadAndNext().catch(err => {
                setAutoNextEnabled(false);
                showToast('❌ Tải TXT thất bại, đã dừng Auto Next.', 'error');
                console.error('Download failed:', err);
            });
        });

        autoNext.checkbox.addEventListener('change', () => {
            setAutoNextEnabled(autoNext.checkbox.checked);
            if (!autoNext.checkbox.checked && autoNextTimer) {
                clearInterval(autoNextTimer);
                autoNextTimer = null;
                autoNext.text.textContent = 'Auto Next';
            }
        });

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'text-align:center;margin-bottom:8px';
        wrapper.append(btnCopy, btnDownload, autoNext.label);
        anchor.insertAdjacentElement(config.insertPosition, wrapper);

        autoNextTimer = startAutoNextCountdown(autoNext.checkbox, autoNext.text);
    }

    document.readyState === 'loading'
        ? document.addEventListener('DOMContentLoaded', init)
        : init();

})();
