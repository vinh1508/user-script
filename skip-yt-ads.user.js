// ==UserScript==
// @name               Auto Skip Ads – YouTube, YouTube Music & Spotify
// @name:vi            Tự Động Bỏ Qua Quảng Cáo – YouTube, YouTube Music & Spotify
// @version            8.0.0
// @description        Auto skip ads on YouTube & YouTube Music. Mute + fast-forward audio ads on Spotify Web Player.
// @description:vi     Tự động bỏ qua quảng cáo trên YouTube & YouTube Music. Tắt tiếng + tua nhanh quảng cáo trên Spotify Web.
// @author             AI
// @icon               https://cdn-icons-png.flaticon.com/64/2504/2504965.png
// @match              https://www.youtube.com/*
// @match              https://m.youtube.com/*
// @match              https://music.youtube.com/*
// @match              https://open.spotify.com/*
// @exclude            https://studio.youtube.com/*
// @grant              none
// @run-at             document-start
// @license            MIT
// @noframes
// ==/UserScript==

(function () {
    'use strict'

    // Bật true để xem log trong DevTools Console
    const DEBUG = false

    // Spotify: có thử bấm nút "Next" khi đang có quảng cáo hay không.
    // Nếu phát hiện nhầm quảng cáo, nút này sẽ skip luôn bài hát => tắt nếu gặp lỗi.
    const SPOTIFY_TRY_SKIP = true

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
        '.ytp-ad-skip-button-slot button'
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
        // Đúng cho cả www, mobile và music (bản cũ dùng #ytd-player nên hỏng trên mobile)
        return document.querySelector('#movie_player video.html5-main-video')
    }

    // =====================================================================
    // YouTube (www + mobile) – giữ cơ chế reload video của bản gốc
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
        // Chỉ bỏ tắt tiếng nếu chính player không ở trạng thái mute (tôn trọng lựa chọn của người dùng)
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

    /**
     * Xoá phần tử quảng cáo bằng JS vì cần logic giống `:has`
     * (không hỗ trợ trên trình duyệt cũ). Bản cũ chỉ xoá phần tử đầu tiên,
     * bản này xoá tất cả.
     */
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
    // YouTube Music – bấm Skip / tua tới cuối, không reload để giữ hàng đợi
    // =====================================================================
    const YTM_HIDE = [
        // Popup mời dùng thử Premium góc dưới trái
        'ytmusic-mealbar-promo-renderer',
        // Banner Premium trên trang chủ
        'ytmusic-statement-banner-renderer',
        '.ytp-featured-product'
    ]

    let ytmAdState = null // { video, muted, rate }

    function ytmRestore() {
        const { video, muted, rate } = ytmAdState
        ytmAdState = null
        if (!video) return
        video.muted = muted
        setRate(video, rate)
        log('Ad ended, restored audio & speed', { muted, rate })
    }

    function skipYouTubeMusicAd() {
        const playerEl = document.querySelector('#movie_player')
        const isAd = !!playerEl && (
            playerEl.classList.contains('ad-showing') ||
            playerEl.classList.contains('ad-interrupting')
        )

        if (!isAd) {
            if (ytmAdState) ytmRestore()
            return
        }

        const video = ytGetVideo()
        if (!video) return

        if (!ytmAdState) {
            // Lưu trạng thái của người dùng để khôi phục sau quảng cáo
            ytmAdState = { video, muted: video.muted, rate: video.playbackRate || 1 }
            log('Ad detected')
        }

        video.muted = true

        if (clickFirst(YT_SKIP_BUTTONS)) {
            log('Clicked skip button')
            return
        }

        // Không skip được thì tua tới cuối + tăng tốc
        if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) {
            try { video.currentTime = video.duration } catch (_) { /* bỏ qua */ }
        }
        if (video.playbackRate < 16) setRate(video, 16)
    }

    // =====================================================================
    // Spotify Web Player (open.spotify.com)
    // Quảng cáo audio của Spotify không có nút skip => tắt tiếng + tua nhanh.
    // Selector có thể đổi khi Spotify cập nhật, chỉnh trong object này.
    // =====================================================================
    const SPOTIFY = {
        adSignals: [
            '[data-testid="context-item-info-ad-subtitle"]',
            '[data-testid="now-playing-widget"] a[href*="/ad/"]',
            '[data-testid="now-playing-widget"][aria-label*="advertisement" i]'
        ],
        titlePattern: /^(advertisement|quảng cáo)\b|spotify\s*[–-]\s*advertisement/i,
        skipButton: '[data-testid="control-button-skip-forward"]',
        muteButton: '[data-testid="volume-bar-toggle-mute-button"]',
        hide: [
            // Nút "Khám phá Premium" trên thanh top
            '[data-testid="upgrade-button"]',
            // Banner/quảng cáo nhúng
            '[data-testid="embedded-ad"]'
        ]
    }

    const spotifyMedia = new Set()

    // Spotify tạo <audio>/<video> không gắn vào DOM, nên phải bắt lúc tạo / lúc play.
    // Cần @run-at document-start để hook chạy trước code của Spotify.
    function spotifyHookMedia() {
        const origCreate = Document.prototype.createElement
        Document.prototype.createElement = function (tagName, options) {
            const el = origCreate.call(this, tagName, options)
            if (typeof tagName === 'string' && /^(audio|video)$/i.test(tagName)) {
                spotifyMedia.add(el)
                log('Captured media element (createElement)', { tag: tagName })
            }
            return el
        }

        const origPlay = HTMLMediaElement.prototype.play
        HTMLMediaElement.prototype.play = function () {
            spotifyMedia.add(this)
            return origPlay.apply(this, arguments)
        }
    }

    function spotifyGetPlayingMedia() {
        document.querySelectorAll('audio, video').forEach(el => spotifyMedia.add(el))
        return [...spotifyMedia].filter(el => !el.paused)
    }

    function spotifyIsAd() {
        if (SPOTIFY.adSignals.some(sel => document.querySelector(sel))) return true
        return SPOTIFY.titlePattern.test(document.title)
    }

    let spAdState = null // { entries: Map<el, {muted, rate}>, clickedMute }

    function spotifyRestore() {
        for (const [el, s] of spAdState.entries) {
            el.muted = s.muted
            setRate(el, s.rate)
        }
        if (spAdState.clickedMute) {
            document.querySelector(SPOTIFY.muteButton)?.click()
        }
        spAdState = null
        log('Ad ended, restored audio & speed')
    }

    function handleSpotifyAd() {
        const isAd = spotifyIsAd()

        if (!isAd) {
            if (spAdState) spotifyRestore()
            return
        }

        if (!spAdState) {
            spAdState = { entries: new Map(), clickedMute: false }
            log('Ad detected', { title: document.title })
        }

        const media = spotifyGetPlayingMedia()
        for (const el of media) {
            if (!spAdState.entries.has(el)) {
                spAdState.entries.set(el, { muted: el.muted, rate: el.playbackRate || 1 })
            }
            el.muted = true
            if (el.playbackRate < 16) setRate(el, 16)
        }

        // Dự phòng: không bắt được media element thì bấm nút mute trên UI
        if (media.length === 0 && !spAdState.clickedMute) {
            const btn = document.querySelector(SPOTIFY.muteButton)
            if (btn) {
                btn.click()
                spAdState.clickedMute = true
                log('Muted via UI button (fallback)')
            }
        }

        if (SPOTIFY_TRY_SKIP && clickFirst([SPOTIFY.skipButton])) {
            log('Clicked next button during ad')
        }
    }

    // =====================================================================
    // Khởi chạy
    // =====================================================================
    if (SITE === 'spotify') {
        spotifyHookMedia()
        onReady(() => {
            injectCss(SPOTIFY.hide)
            handleSpotifyAd()
            window.setInterval(handleSpotifyAd, 300)
        })
    } else if (SITE === 'ytmusic') {
        onReady(() => {
            injectCss(YTM_HIDE)
            skipYouTubeMusicAd()
            window.setInterval(skipYouTubeMusicAd, 300)
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
