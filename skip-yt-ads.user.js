// ==UserScript==
// @name               Auto Skip Ads – YouTube, YouTube Music & Spotify
// @name:vi            Tự Động Bỏ Qua Quảng Cáo – YouTube, YouTube Music & Spotify
// @version            8.1.0
// @description        Auto skip ads on YouTube & YouTube Music. Skip (or mute) audio ads on Spotify Web Player.
// @description:vi     Tự động bỏ qua quảng cáo trên YouTube & YouTube Music. Bỏ qua (hoặc tắt tiếng) quảng cáo trên Spotify Web.
// @author             AI
// @icon               https://cdn-icons-png.flaticon.com/64/2504/2504965.png
// @match              https://www.youtube.com/*
// @match              https://m.youtube.com/*
// @match              https://music.youtube.com/*
// @match              https://open.spotify.com/*
// @exclude            https://studio.youtube.com/*
// @grant              none
// @run-at             document-start
// @inject-into        page
// @license            MIT
// @noframes
// ==/UserScript==

(function () {
    'use strict'

    // Bật true để xem log trong DevTools Console
    const DEBUG = false

    const HOST = location.hostname
    const SITE =
        HOST === 'open.spotify.com' ? 'spotify'
            : HOST === 'music.youtube.com' ? 'ytmusic'
                : HOST === 'm.youtube.com' ? 'ytmobile'
                    : 'youtube'

    // =====================================================================
    // Tiện ích chung
    // =====================================================================
    function timeStr() {
        return new Date().toTimeString().split(' ', 1)[0]
    }

    function log(message, extra = {}) {
        if (!DEBUG) return
        console.log('[AutoSkipAds]', { message, site: SITE, time: timeStr(), ...extra })
    }

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true })
        } else {
            fn()
        }
    }

    function injectCss(selectors) {
        if (!selectors.length) return
        const style = document.createElement('style')
        style.textContent = `${selectors.join(',\n')} { display: none !important; }`
        ;(document.head || document.documentElement).appendChild(style)
    }

    function isClickable(btn) {
        return btn
            && !btn.disabled
            && btn.getAttribute('aria-disabled') !== 'true'
            && btn.offsetParent !== null
    }

    function clickFirst(selectors) {
        for (const sel of selectors) {
            const btn = document.querySelector(sel)
            if (isClickable(btn)) {
                btn.click()
                return true
            }
        }
        return false
    }

    function setRate(el, rate) {
        try {
            el.playbackRate = rate
        } catch (_) {
            // Một số trình duyệt giới hạn tốc độ tối đa (vd. Firefox), thử mức thấp hơn
            try { el.playbackRate = 4 } catch (_) { /* bỏ qua */ }
        }
    }

    // =====================================================================
    // YouTube (www + mobile) & YouTube Music – phần dùng chung
    // =====================================================================
    const YT_SKIP_BUTTONS = [
        '.ytp-skip-ad-button',
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-modern',
        '.ytp-ad-skip-button-slot button',
        '.ytp-skip-ad button'
    ]

    function ytGetPlayer() {
        if (SITE === 'youtube') {
            const el = document.querySelector('#ytd-player')
            return { el, player: el?.getPlayer?.() ?? null }
        }
        // m.youtube.com và music.youtube.com đều dùng #movie_player
        const el = document.querySelector('#movie_player')
        return { el, player: el }
    }

    function ytGetVideo() {
        return document.querySelector('#movie_player video.html5-main-video')
    }

    // =====================================================================
    // YouTube (www + mobile) – KHÔNG ĐỔI so với 8.0.0
    // =====================================================================
    const YT_HIDE = [
        // Banner quảng cáo góc trên phải, phía trên playlist
        '#player-ads',
        '#panels > ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]',
        // Masthead ad trên trang chủ
        '#masthead-ad',
        '.yt-mealbar-promo-renderer',
        // Banner sản phẩm góc dưới trái video
        '.ytp-featured-product',
        // Kệ sản phẩm dưới phần mô tả
        'ytd-merch-shelf-renderer'
    ]

    let ytMutedByScript = false

    function ytIsShorts() {
        return location.pathname.startsWith('/shorts/')
    }

    function ytRestoreMute() {
        ytMutedByScript = false
        const video = ytGetVideo()
        const { player } = ytGetPlayer()
        if (video && video.muted && typeof player?.isMuted === 'function' && !player.isMuted()) {
            video.muted = false
            log('Restored audio after ad')
        }
    }

    function skipYouTubeAd() {
        if (ytIsShorts()) return

        const adShowing = document.querySelector('.ad-showing')
        const pieCountdown = document.querySelector('.ytp-ad-timed-pie-countdown-container')
        const survey = document.querySelector('.ytp-ad-survey-questions')

        if (!adShowing && !pieCountdown && !survey) {
            if (ytMutedByScript) ytRestoreMute()
            return
        }

        const { el: playerEl, player } = ytGetPlayer()
        if (!playerEl || !player) {
            log('Player not found')
            return
        }

        if (!pieCountdown && !survey) {
            const adVideo = ytGetVideo()
            if (!adVideo || !adVideo.src || adVideo.paused || isNaN(adVideo.duration)) return
            adVideo.muted = true
            adVideo.pause()
            ytMutedByScript = true
        }

        const videoData = player.getVideoData?.()
        const videoId = videoData?.video_id
        if (!videoId) return

        const start = Math.floor(player.getCurrentTime?.() ?? 0)
        const load = playerEl.loadVideoWithPlayerVars || playerEl.loadVideoByPlayerVars
        if (typeof load !== 'function') return

        load.call(playerEl, { videoId, start })
        log('Ad skipped', { videoId, start, title: videoData.title })
    }

    function removeYouTubeAdElements() {
        const pairs = [
            // Video quảng cáo trong YouTube Shorts
            ['ytd-reel-video-renderer', '.ytd-ad-slot-renderer']
        ]
        for (const [outer, inner] of pairs) {
            document.querySelectorAll(outer).forEach(el => {
                if (el.querySelector(inner)) el.remove()
            })
        }
    }

    // =====================================================================
    // YouTube Music
    // - Chạy theo SỰ KIỆN (MutationObserver + media events) thay vì chỉ polling:
    //   tab nhạc thường nằm nền, Chrome bóp setInterval còn ~1 lần/giây.
    // - Khôi phục âm thanh / tốc độ NGAY khi hết quảng cáo, tránh bài hát bị
    //   phát câm hoặc 16x trong vài trăm ms đầu (mất vài giây đầu bài).
    // =====================================================================

    // Chỉ tua tới cuối nếu quảng cáo ngắn hơn ngưỡng này (giây). Dài hơn thì
    // tăng tốc 16x thay vì tua, phòng trường hợp quảng cáo bị ghép thẳng vào
    // stream bài hát (tua tới cuối sẽ nhảy qua luôn cả bài).
    const YTM_SEEK_MAX_DURATION = 120

    const YTM_HIDE = [
        // Popup mời dùng thử Premium góc dưới trái
        'ytmusic-mealbar-promo-renderer',
        // Banner Premium trên trang chủ
        'ytmusic-statement-banner-renderer',
        '.ytp-featured-product'
    ]

    let ytmAdState = null // { video, muted, rate, changedRate }
    let ytmObservedPlayer = null
    let ytmPlayerObserver = null
    let ytmBoundVideo = null

    function ytmIsAdShowing(playerEl) {
        return !!playerEl && (
            playerEl.classList.contains('ad-showing') ||
            playerEl.classList.contains('ad-interrupting')
        )
    }

    function ytmRestore() {
        const { video, muted, rate, changedRate } = ytmAdState
        ytmAdState = null
        video.muted = muted
        // Chỉ trả lại tốc độ nếu script đã đổi, không đè cài đặt của YouTube
        if (changedRate) setRate(video, rate)
        log('YTM: ad ended, restored', { muted, rate: changedRate ? rate : 'unchanged' })
    }

    function ytmCheck() {
        const playerEl = document.querySelector('#movie_player')

        if (!ytmIsAdShowing(playerEl)) {
            if (ytmAdState) ytmRestore()
            return
        }

        const video = ytGetVideo()
        if (!video) return

        if (ytmAdState && ytmAdState.video !== video) ytmRestore()
        if (!ytmAdState) {
            ytmAdState = { video, muted: video.muted, rate: video.playbackRate || 1, changedRate: false }
            log('YTM: ad detected')
        }

        video.muted = true

        // Bấm Skip nếu có, nhưng KHÔNG return: YouTube có thể bỏ qua click giả lập
        // (event.isTrusted = false), nên vẫn tua / tăng tốc ở dưới.
        if (clickFirst(YT_SKIP_BUTTONS)) log('YTM: clicked skip button')

        const d = video.duration
        if (isFinite(d) && d > 0 && d <= YTM_SEEK_MAX_DURATION) {
            if (video.currentTime < d - 0.25) {
                try {
                    video.currentTime = d
                    log('YTM: seeked to end', { duration: d })
                } catch (_) { /* bỏ qua */ }
            }
        } else if (video.playbackRate < 16) {
            // Chưa biết thời lượng, hoặc quảng cáo quá dài => tăng tốc
            setRate(video, 16)
            ytmAdState.changedRate = true
        }
    }

    function ytmBind() {
        const playerEl = document.querySelector('#movie_player')
        if (playerEl && playerEl !== ytmObservedPlayer) {
            ytmPlayerObserver?.disconnect()
            ytmPlayerObserver = new MutationObserver(ytmCheck)
            ytmPlayerObserver.observe(playerEl, { attributes: true, attributeFilter: ['class'] })
            ytmObservedPlayer = playerEl
            log('YTM: observing player')
        }

        const video = ytGetVideo()
        if (video && video !== ytmBoundVideo) {
            for (const type of ['loadedmetadata', 'durationchange', 'playing', 'timeupdate']) {
                video.addEventListener(type, ytmCheck)
            }
            ytmBoundVideo = video
            log('YTM: bound video events')
        }
    }

    // =====================================================================
    // Spotify Web Player (open.spotify.com)
    //
    // Phát hiện chính: nhạc/podcast của Spotify phát qua MediaSource nên src là
    // "blob:https://open.spotify.com/...", còn quảng cáo là file media trực tiếp
    // (URL thường) và ngắn. Cách này không phụ thuộc ngôn ngữ giao diện hay
    // data-testid, và chạy theo sự kiện nên phản ứng ngay cả khi tab ở nền.
    //
    // Xử lý: tắt tiếng -> tua tới cuối. Nếu Spotify bị treo ở màn
    // "Your music will continue after the break" (không chuyển bài), phát lại
    // quảng cáo từ đầu nhưng vẫn tắt tiếng để Spotify tự chạy tiếp.
    // =====================================================================
    const SPOTIFY = {
        // Quảng cáo audio thường 15–30s; nhạc / podcast dài hơn nhiều
        adMaxDuration: 70,
        // Chờ bao lâu (ms) sau khi tua để kiểm tra Spotify có bị treo không
        stuckCheckDelay: 400,
        // Media không phải quảng cáo: Canvas (video lặp sau bài hát), preview 30s
        ignoreSrc: /canvaz\.scdn\.co|p\.scdn\.co\/mp3-preview/i,

        // Dự phòng: phát hiện qua giao diện => chỉ TẮT TIẾNG, không tua.
        // Đặt false nếu bị tắt tiếng nhầm bài hát.
        domFallback: true,
        domAdSelectors: [
            '[data-testid="context-item-info-ad-subtitle"]',
            '[data-testid="now-playing-widget"] a[href*="/ad/"]'
        ],
        adLabel: /\badvertisement\b|quảng cáo/i,
        adTitle: /^(advertisement|quảng cáo)\b|spotify\s*[–—-]\s*(advertisement|quảng cáo)/i,

        hide: [
            // Nút "Khám phá Premium" trên thanh top
            '[data-testid="upgrade-button"]',
            // Banner / quảng cáo nhúng
            '[data-testid="embedded-ad"]'
        ]
    }

    const spMedia = new Set()        // mọi <audio>/<video> bắt được
    const spBound = new WeakSet()    // element đã gắn listener
    const spMuted = new Map()        // element -> trạng thái muted gốc
    const spSkipTried = new Map()    // element -> src đã thử tua
    let spLastPlaySrc = ''

    function spSrc(el) {
        return el.currentSrc || el.src || ''
    }

    /** 'content' | 'ad' | 'pending' (chưa biết thời lượng) | 'ignore' */
    function spClassify(el) {
        const src = spSrc(el)
        if (!src) return 'ignore'
        if (src.startsWith('blob:')) return 'content'
        if (el.loop || SPOTIFY.ignoreSrc.test(src)) return 'ignore'
        const d = el.duration
        if (Number.isNaN(d) || d <= 0) return 'pending'
        if (!isFinite(d)) return 'content'
        return d <= SPOTIFY.adMaxDuration ? 'ad' : 'content'
    }

    function spDomAdActive() {
        if (SPOTIFY.domAdSelectors.some(sel => document.querySelector(sel))) return true
        const widget = document.querySelector('[data-testid="now-playing-widget"]')
        if (widget && SPOTIFY.adLabel.test(widget.getAttribute('aria-label') || '')) return true
        return SPOTIFY.adTitle.test(document.title)
    }

    function spMute(el) {
        if (!spMuted.has(el)) spMuted.set(el, el.muted)
        el.muted = true
    }

    function spUnmute(el) {
        if (!spMuted.has(el)) return
        el.muted = spMuted.get(el)
        spMuted.delete(el)
    }

    function spRestoreAll() {
        if (!spMuted.size) return
        for (const el of [...spMuted.keys()]) spUnmute(el)
        spSkipTried.clear()
        log('Spotify: ad ended, audio restored')
    }

    function spTrySkip(el) {
        const src = spSrc(el)
        if (el.paused || spSkipTried.get(el) === src) return
        spSkipTried.set(el, src)

        try {
            el.currentTime = el.duration
        } catch (_) {
            return
        }
        log('Spotify: ad seeked to end', { duration: el.duration })

        setTimeout(() => {
            const stuck = el.ended && spSrc(el) === src && spLastPlaySrc === src
            if (!stuck) return
            // Spotify không chuyển bài => phát lại quảng cáo (vẫn tắt tiếng),
            // spSkipTried giữ src này nên sẽ không tua lần nữa.
            log('Spotify: skip did not advance, replaying ad muted')
            spMute(el)
            el.currentTime = 0
            el.play().catch(() => { /* bỏ qua */ })
        }, SPOTIFY.stuckCheckDelay)
    }

    function spOnMediaEvent(e) {
        const el = e.currentTarget
        if (e.type === 'play') spLastPlaySrc = spSrc(el)

        const kind = spClassify(el)
        if (kind === 'ignore') return

        if (kind === 'ad' || kind === 'pending') {
            // 'pending': tắt tiếng tạm cho tới khi biết thời lượng, tránh lọt tiếng quảng cáo
            spMute(el)
            if (kind === 'ad') spTrySkip(el)
            return
        }

        // kind === 'content'
        if (SPOTIFY.domFallback && spDomAdActive()) return
        spUnmute(el) // vd. podcast bị tắt tiếng tạm khi chưa biết thời lượng
        if (e.type === 'playing') spRestoreAll()
    }

    function spTrack(el) {
        spMedia.add(el)
        if (spBound.has(el)) return
        spBound.add(el)
        for (const type of ['play', 'playing', 'loadedmetadata', 'durationchange']) {
            el.addEventListener(type, spOnMediaEvent)
        }
    }

    // Spotify tạo <audio>/<video> không gắn vào DOM => bắt lúc tạo và lúc play().
    // Cần @run-at document-start để hook chạy trước code của Spotify.
    function spotifyHookMedia() {
        const origCreate = Document.prototype.createElement
        Document.prototype.createElement = function (tagName, options) {
            const el = origCreate.call(this, tagName, options)
            if (el instanceof HTMLMediaElement) spTrack(el)
            return el
        }

        const origPlay = HTMLMediaElement.prototype.play
        HTMLMediaElement.prototype.play = function () {
            spTrack(this)
            return origPlay.apply(this, arguments)
        }
    }

    // Vòng kiểm tra chậm: bắt media trong DOM + dự phòng theo giao diện
    function spTick() {
        document.querySelectorAll('audio, video').forEach(spTrack)

        if (SPOTIFY.domFallback && spDomAdActive()) {
            for (const el of spMedia) {
                if (!el.paused && spClassify(el) !== 'ignore') spMute(el)
            }
            return
        }

        if (!spMuted.size) return
        const adStillPlaying = [...spMuted.keys()].some(el =>
            !el.paused && !el.ended && spClassify(el) !== 'content'
        )
        if (!adStillPlaying) spRestoreAll()
    }

    // =====================================================================
    // Khởi chạy
    // =====================================================================
    if (SITE === 'spotify') {
        spotifyHookMedia()
        onReady(() => {
            injectCss(SPOTIFY.hide)
            spTick()
            window.setInterval(spTick, 500)
        })
    } else if (SITE === 'ytmusic') {
        onReady(() => {
            injectCss(YTM_HIDE)
            ytmBind()
            ytmCheck()
            window.setInterval(() => {
                ytmBind()
                ytmCheck()
            }, 1000)
        })
    } else {
        onReady(() => {
            injectCss(YT_HIDE)
            removeYouTubeAdElements()
            skipYouTubeAd()
            window.setInterval(skipYouTubeAd, 500)
            window.setInterval(removeYouTubeAdElements, 1000)
        })
    }
})()
