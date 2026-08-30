// ==UserScript==
// @name         sc-gate-dl
// @namespace    https://github.com/D3SOX/sc-gate-dl
// @version      1.11.18
// @description  Add sc-gate-dl download controls and remember your position in the SoundCloud feed
// @author       D3SOX
// @match        https://soundcloud.com/*
// @match        https://www.soundcloud.com/*
// @noframes
// @icon         https://soundcloud.com/favicon.ico
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @connect      *
// @connect      localhost
// @connect      127.0.0.1
// @run-at       document-idle
// @homepageURL  https://github.com/D3SOX/sc-gate-dl
// @supportURL   https://github.com/D3SOX/sc-gate-dl/issues
// @downloadURL  https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/userscript/sc-gate-dl.user.js
// @updateURL    https://raw.githubusercontent.com/D3SOX/sc-gate-dl/master/userscript/sc-gate-dl.user.js
// ==/UserScript==

(() => {
	'use strict';

	const WEBUI_BASE_KEY = 'sc-gate-dl-webui-base';
	const API_BASE_KEY = 'sc-gate-dl-api-base';
	const PANEL_GEOM_KEY = 'sc-gate-dl-panel-geom';
	const QUEUE_GEOM_KEY = 'sc-gate-dl-queue-geom';
	const OUTPUT_FORMAT_KEY = 'sc-gate-dl-output-format';
	const BROWSER_MODE_KEY = 'sc-gate-dl-browser-mode';
	const AUTO_CLOSE_KEY = 'sc-gate-dl-auto-close';
	const ALWAYS_OPEN_TAB_KEY = 'sc-gate-dl-always-open-tab';
	const FEED_CHECKPOINT_KEY = 'sc-gate-dl-feed-checkpoint';
	const DEFAULT_WEBUI_BASE = 'http://localhost:4321';
	const BUTTON_ATTR = 'data-sc-gate-dl-btn';
	const WRAP_ATTR = 'data-sc-gate-dl-wrap';
	const PANEL_ID = 'sc-gate-dl-panel';
	const QUEUE_ID = 'sc-gate-dl-queue';
	const STYLE_ID = 'sc-gate-dl-styles';
	const TOOLTIP_ID = 'sc-gate-dl-tooltip';
	const FEED_NAV_ID = 'sc-gate-dl-feed-nav';
	const TOOLTIP_LABEL = 'Download with sc-gate-dl';
	const MIN_PANEL_W = 280;
	const MIN_PANEL_H = 240;
	const FEED_CARD_SELECTOR = '.sound, .soundList__item, .userStreamItem';
	const FEED_LOAD_TIMEOUT_MS = 15_000;

	const DEFAULT_GEOM = {
		width: 400,
		height: 0, // filled from viewport
		right: 12,
		top: 72,
	};

	const DEFAULT_QUEUE_GEOM = {
		width: 280,
		left: 12,
		top: 12,
	};

	/** @type {{ url: string, label: string }[]} */
	const downloadQueue = [];
	const feedTrackUrlCache = new WeakMap();

	const RESERVED_FIRST = new Set([
		'you',
		'discover',
		'stream',
		'library',
		'messages',
		'notifications',
		'settings',
		'pages',
		'charts',
		'jobs',
		'pro',
		'upload',
		'search',
		'login',
		'signup',
		'about',
		'stations',
		'feed',
		'tags',
	]);

	const TRAILING_SEGMENTS = new Set([
		'likes',
		'reposts',
		'comments',
		'recommended',
		'sets',
		'popular-tracks',
		'albums',
		'tracks',
		'followers',
		'following',
	]);

	const DOWNLOAD_ICON_16 = `
<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="16" height="16">
  <path fill="currentColor" d="M8 1.25a.75.75 0 0 1 .75.75v7.19l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 0 1 1.06-1.06l2.22 2.22V2A.75.75 0 0 1 8 1.25Z"/>
  <path fill="currentColor" d="M2.5 11.25a.75.75 0 0 1 .75.75v1.25h9.5V12a.75.75 0 0 1 1.5 0v1.5A1.25 1.25 0 0 1 13 14.75H3A1.25 1.25 0 0 1 1.75 13.5V12a.75.75 0 0 1 .75-.75Z"/>
</svg>`;

	const DOWNLOAD_ICON_24 = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" width="24" height="24">
  <path fill="currentColor" d="M12 3.25a.75.75 0 0 1 .75.75v9.19l3.22-3.22a.75.75 0 1 1 1.06 1.06l-4.5 4.5a.75.75 0 0 1-1.06 0l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.22 3.22V4A.75.75 0 0 1 12 3.25Z"/>
  <path fill="currentColor" d="M4.5 15.25a.75.75 0 0 1 .75.75v2.25h13.5V16a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 18.5 20.25h-13A1.75 1.75 0 0 1 3.75 18.5V16a.75.75 0 0 1 .75-.75Z"/>
</svg>`;

	const STORE_SERVICE_ATTR = 'data-sc-gate-dl-store-service';
	const STORE_SERVICES = {
		hypeddit: {
			icon: 'https://hypeddit.com/images/favicon.ico',
		},
		droploud: {
			icon: 'https://droploud.com/favicon.ico',
		},
		gaterush: {
			icon: 'https://gaterush.me/icons/logo-icon-large.png',
		},
		downloadgater: {
			icon: 'https://downloadgater.com/favicon.png',
		},
		stillhype: {
			icon: 'https://www.stillhype.io/favicon-32x32.png',
		},
		pumpyoursound: {
			icon: 'https://pumpyoursound.com/favicon.ico',
		},
		mypresskit: {
			icon: 'https://www.mypresskit.info/favicon.ico',
		},
		bandcamp: {
			icon: 'https://s4.bcbits.com/client-bundle/1/PageLayout_1/favicon-78ff127104384a042453aca8d73be7dc.static/favicon/favicon-32x32.png',
		},
	};

	function getAutoClose() {
		try {
			if (typeof GM_getValue === 'function') {
				const gm = GM_getValue(AUTO_CLOSE_KEY, null);
				if (typeof gm === 'boolean') return gm;
			}
		} catch {
			// ignore
		}
		try {
			const v = localStorage.getItem(AUTO_CLOSE_KEY);
			if (v === '0' || v === 'false') return false;
			if (v === '1' || v === 'true') return true;
		} catch {
			// ignore
		}
		return true; // default on
	}

	function setAutoClose(value) {
		const on = Boolean(value);
		try {
			if (typeof GM_setValue === 'function') GM_setValue(AUTO_CLOSE_KEY, on);
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(AUTO_CLOSE_KEY, on ? '1' : '0');
		} catch {
			// ignore
		}
	}

	function getAlwaysOpenTab() {
		try {
			if (typeof GM_getValue === 'function') {
				const stored = GM_getValue(ALWAYS_OPEN_TAB_KEY, null);
				if (typeof stored === 'boolean') return stored;
			}
		} catch {
			// ignore
		}
		try {
			const stored = localStorage.getItem(ALWAYS_OPEN_TAB_KEY);
			if (stored === '1' || stored === 'true') return true;
			if (stored === '0' || stored === 'false') return false;
		} catch {
			// ignore
		}
		return false;
	}

	function setAlwaysOpenTab(value) {
		const enabled = Boolean(value);
		try {
			if (typeof GM_setValue === 'function') {
				GM_setValue(ALWAYS_OPEN_TAB_KEY, enabled);
			}
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(ALWAYS_OPEN_TAB_KEY, enabled ? '1' : '0');
		} catch {
			// ignore
		}
	}

	function getOutputFormat() {
		try {
			if (typeof GM_getValue === 'function') {
				const gm = GM_getValue(OUTPUT_FORMAT_KEY, null);
				if (gm === 'original' || gm === 'mp3-320' || gm === 'flac') return gm;
			}
		} catch {
			// ignore
		}
		try {
			const v = localStorage.getItem(OUTPUT_FORMAT_KEY);
			if (v === 'original' || v === 'mp3-320' || v === 'flac') return v;
		} catch {
			// ignore
		}
		return 'mp3-320';
	}

	function syncFormatSelect(value) {
		const select = document.querySelector(`#${PANEL_ID} .sc-gate-dl-format`);
		if (select instanceof HTMLSelectElement) select.value = value;
	}

	function setOutputFormat(value) {
		if (value !== 'original' && value !== 'mp3-320' && value !== 'flac') return;
		try {
			if (typeof GM_setValue === 'function')
				GM_setValue(OUTPUT_FORMAT_KEY, value);
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(OUTPUT_FORMAT_KEY, value);
		} catch {
			// ignore
		}
		syncFormatSelect(value);
		const panel = document.getElementById(PANEL_ID);
		if (panel && !panel.hidden && panel.dataset.trackUrl) {
			loadTrackIntoPanel(panel, panel.dataset.trackUrl);
		}
	}

	function getBrowserMode() {
		try {
			if (typeof GM_getValue === 'function') {
				const gm = GM_getValue(BROWSER_MODE_KEY, null);
				if (gm === 'headless' || gm === 'xvfb' || gm === 'headed') return gm;
			}
		} catch {
			// ignore
		}
		try {
			const value = localStorage.getItem(BROWSER_MODE_KEY);
			if (value === 'headless' || value === 'xvfb' || value === 'headed') {
				return value;
			}
		} catch {
			// ignore
		}
		return 'headless';
	}

	function syncBrowserModeSelect(value) {
		const select = document.querySelector(
			`#${PANEL_ID} .sc-gate-dl-browser-mode`,
		);
		if (select instanceof HTMLSelectElement) select.value = value;
	}

	function setBrowserMode(value) {
		if (value !== 'headless' && value !== 'xvfb' && value !== 'headed') return;
		try {
			if (typeof GM_setValue === 'function')
				GM_setValue(BROWSER_MODE_KEY, value);
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(BROWSER_MODE_KEY, value);
		} catch {
			// ignore
		}
		syncBrowserModeSelect(value);
		const panel = document.getElementById(PANEL_ID);
		if (panel && !panel.hidden && panel.dataset.trackUrl) {
			loadTrackIntoPanel(panel, panel.dataset.trackUrl);
		}
	}

	let autoCloseMenuId;
	let alwaysOpenTabMenuId;

	function refreshAutoCloseMenu() {
		if (typeof GM_registerMenuCommand !== 'function') return;
		if (
			typeof GM_unregisterMenuCommand === 'function' &&
			autoCloseMenuId != null
		) {
			try {
				GM_unregisterMenuCommand(autoCloseMenuId);
			} catch {
				// ignore
			}
		}
		const on = getAutoClose();
		autoCloseMenuId = GM_registerMenuCommand(
			`Auto-close after browser download: ${on ? 'ON' : 'OFF'}`,
			() => {
				setAutoClose(!getAutoClose());
				refreshAutoCloseMenu();
			},
		);
	}

	function refreshAlwaysOpenTabMenu() {
		if (typeof GM_registerMenuCommand !== 'function') return;
		if (
			typeof GM_unregisterMenuCommand === 'function' &&
			alwaysOpenTabMenuId != null
		) {
			try {
				GM_unregisterMenuCommand(alwaysOpenTabMenuId);
			} catch {
				// ignore
			}
		}
		const enabled = getAlwaysOpenTab();
		alwaysOpenTabMenuId = GM_registerMenuCommand(
			`Always open downloads in new tab: ${enabled ? 'ON' : 'OFF'}`,
			() => {
				setAlwaysOpenTab(!getAlwaysOpenTab());
				refreshAlwaysOpenTabMenu();
			},
		);
	}

	function registerMenuCommands() {
		if (typeof GM_registerMenuCommand !== 'function') return;
		GM_registerMenuCommand('Configure server…', () => {
			configureWebuiBase();
		});
		GM_registerMenuCommand('Feed position controls…', () => {
			toggleFeedNavigator();
		});
		GM_registerMenuCommand('Choose output format…', () => {
			openFormatDialog();
		});
		GM_registerMenuCommand('Choose browser mode…', () => {
			openBrowserModeDialog();
		});
		refreshAlwaysOpenTabMenu();
		refreshAutoCloseMenu();
	}

	function currentHref() {
		try {
			// document.location is the browsing document (reliable with GM sandbox)
			return document.location.href;
		} catch {
			try {
				return window.location.href;
			} catch {
				return document.URL || '';
			}
		}
	}

	function unwrapStoreUrl(href) {
		try {
			const url = new URL(href, currentHref() || 'https://soundcloud.com/');
			if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
			if (url.hostname.toLowerCase().replace(/^www\./, '') !== 'gate.sc') {
				return url.href;
			}
			const wrapped = url.searchParams.get('url');
			if (!wrapped) return url.href;
			const destination = new URL(wrapped);
			if (
				destination.protocol !== 'https:' &&
				destination.protocol !== 'http:'
			) {
				return url.href;
			}
			return destination.href;
		} catch {
			return null;
		}
	}

	function storeServiceForUrl(href) {
		try {
			const url = new URL(href);
			const host = url.hostname.toLowerCase().replace(/^www\./, '');
			const path = url.pathname;
			if (host === 'hypeddit.com' && path.startsWith('/')) return 'hypeddit';
			if (
				host === 'droploud.com' &&
				/^\/(?:gate|track)\/[0-9a-f-]+\/?$/i.test(path)
			) {
				return 'droploud';
			}
			if (host === 'gaterush.me' && /^\/[A-Za-z0-9_-]+\/?$/.test(path)) {
				return 'gaterush';
			}
			if (
				host === 'downloadgater.com' &&
				/^\/g\/[A-Za-z0-9_-]+\/?$/.test(path)
			) {
				return 'downloadgater';
			}
			if (host === 'stillhype.io' && /^\/g\/[A-Za-z0-9_-]+\/?$/.test(path)) {
				return 'stillhype';
			}
			if (
				host === 'pumpyoursound.com' &&
				/^\/f\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/\d+\/?$/i.test(path)
			) {
				return 'pumpyoursound';
			}
			if (
				host === 'mypresskit.info' &&
				/^\/gate\/[A-Za-z0-9_-]+\/?$/i.test(path)
			) {
				return 'mypresskit';
			}
			if (
				(host === 'bandcamp.com' || host.endsWith('.bandcamp.com')) &&
				(path === '/' || /^\/(?:track|album)\/[^/]+\/?$/i.test(path))
			) {
				return 'bandcamp';
			}
		} catch {
			// Ignore malformed store URLs.
		}
		return null;
	}

	function decorateStoreLink(anchor) {
		if (!(anchor instanceof HTMLAnchorElement) || isOurNode(anchor)) return;
		const destination = unwrapStoreUrl(anchor.href);
		if (!destination) return;
		const serviceKey = storeServiceForUrl(destination);
		if (!serviceKey) {
			anchor.removeAttribute(STORE_SERVICE_ATTR);
			anchor.style.removeProperty('--sc-gate-dl-store-icon');
			return;
		}
		if (destination !== anchor.href) anchor.href = destination;
		const service = STORE_SERVICES[serviceKey];
		if (!service) return;

		anchor.setAttribute(STORE_SERVICE_ATTR, serviceKey);
		anchor.style.setProperty(
			'--sc-gate-dl-store-icon',
			`url("${service.icon}")`,
		);
	}

	function normalizeTrackUrl(href) {
		try {
			const url = new URL(href, currentHref() || 'https://soundcloud.com/');
			const host = url.hostname.replace(/^www\./i, '').toLowerCase();
			if (
				host !== 'soundcloud.com' &&
				host !== 'm.soundcloud.com' &&
				host !== 'on.soundcloud.com'
			) {
				return null;
			}
			let parts = url.pathname.split('/').filter(Boolean);
			// New logged-in listen layout uses /n/artist/track
			if (parts[0]?.toLowerCase() === 'n' && parts.length >= 3) {
				parts = parts.slice(1);
			}
			while (
				parts.length > 2 &&
				TRAILING_SEGMENTS.has(parts[parts.length - 1].toLowerCase())
			) {
				parts = parts.slice(0, -1);
			}
			if (parts.length === 3 && parts[2].toLowerCase().startsWith('s-')) {
				parts = parts.slice(0, 2);
			}
			if (parts.length < 2) return null;
			if (RESERVED_FIRST.has(parts[0].toLowerCase())) return null;
			// Playlists / albums: /artist/sets/slug — not a single track
			if (parts[1].toLowerCase() === 'sets') return null;
			if (TRAILING_SEGMENTS.has(parts[1].toLowerCase())) return null;
			return `https://soundcloud.com/${parts[0]}/${parts[1]}`;
		} catch {
			return null;
		}
	}

	function pageTrackUrl() {
		// Only the real page location — meta tags / embeds can be /n/... or wrong
		const href = currentHref();
		if (href) {
			const normalized = normalizeTrackUrl(href);
			if (normalized) return normalized;
		}
		try {
			const pathUrl = `https://soundcloud.com${document.location.pathname}`;
			return normalizeTrackUrl(pathUrl);
		} catch {
			return null;
		}
	}

	/** Feed/search cards only — track pages use the current URL. */
	function trackUrlFromCard(el) {
		const trackItem = el?.closest?.('.trackItem');
		const trackItemTitle = trackItem?.querySelector(
			'a.trackItem__trackTitle[href]',
		);
		if (trackItemTitle instanceof HTMLAnchorElement) {
			const trackItemUrl = normalizeTrackUrl(trackItemTitle.href);
			if (trackItemUrl) return trackItemUrl;
		}
		const closest = el?.closest?.(
			'.sound, .soundList__item, .userStreamItem, .searchItem__trackItem, .listenContext',
		);
		if (!closest) return null;
		const sound = closest.matches('.sound')
			? closest
			: closest.querySelector('.sound') || closest;
		if (feedTrackUrlCache.has(sound)) return feedTrackUrlCache.get(sound);
		let trackUrl = null;
		const titleLink = sound.querySelector(
			'a.soundTitle__title, a[href][class*="soundTitle"]',
		);
		if (titleLink?.href) {
			const fromTitle = normalizeTrackUrl(titleLink.href);
			if (fromTitle) trackUrl = fromTitle;
		}
		if (!trackUrl) {
			for (const a of sound.querySelectorAll('a[href]')) {
				const fromA = normalizeTrackUrl(a.href);
				if (!fromA) continue;
				trackUrl = fromA;
				break;
			}
		}
		if (trackUrl) feedTrackUrlCache.set(sound, trackUrl);
		return trackUrl;
	}

	function isFeedPage() {
		return /^\/(?:you\/stream|feed)\/?$/i.test(document.location.pathname);
	}

	function feedCards() {
		const sounds = Array.from(
			document.querySelectorAll(
				'.userStream .sound, .stream__list .sound, .soundList__item .sound',
			),
		);
		return sounds.length > 0
			? sounds
			: Array.from(
					document.querySelectorAll('.soundList__item, .userStreamItem'),
				);
	}

	function findFeedCard(trackUrl) {
		const normalized = normalizeTrackUrl(trackUrl);
		if (!normalized) return null;
		return (
			feedCards().find(
				(card) =>
					trackUrlFromCard(card) === normalized ||
					Array.from(
						card.querySelectorAll('a.trackItem__trackTitle[href]'),
					).some((link) => normalizeTrackUrl(link.href) === normalized),
			) || null
		);
	}

	function feedTimestamp(card) {
		const time = card.querySelector(
			'.sound__header time[datetime], .soundTitle time[datetime], time[datetime]',
		);
		if (!(time instanceof HTMLTimeElement)) return null;
		const timestamp = Date.parse(time.dateTime);
		return Number.isFinite(timestamp) ? timestamp : null;
	}

	function parseFeedCheckpoint(value) {
		const url = normalizeTrackUrl(value?.url || '');
		if (!url) return null;
		return {
			url,
			label:
				typeof value.label === 'string' ? value.label : trackLabelFromUrl(url),
			feedTimestamp:
				typeof value.feedTimestamp === 'number' ? value.feedTimestamp : null,
			savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0,
		};
	}

	function loadFeedCheckpoints() {
		let raw = null;
		try {
			if (typeof GM_getValue === 'function') {
				raw = GM_getValue(FEED_CHECKPOINT_KEY, null);
			}
		} catch {
			// ignore
		}
		try {
			raw ??= localStorage.getItem(FEED_CHECKPOINT_KEY);
			const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
			const legacy = parseFeedCheckpoint(parsed);
			if (legacy) return { newer: legacy, older: legacy };
			const checkpoints = {
				newer: parseFeedCheckpoint(parsed?.newer),
				older: parseFeedCheckpoint(parsed?.older),
			};
			return checkpoints.newer || checkpoints.older ? checkpoints : null;
		} catch {
			return null;
		}
	}

	function persistFeedCheckpoints(checkpoints) {
		const raw = JSON.stringify(checkpoints);
		try {
			if (typeof GM_setValue === 'function') {
				GM_setValue(FEED_CHECKPOINT_KEY, raw);
			}
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(FEED_CHECKPOINT_KEY, raw);
		} catch {
			// ignore
		}
	}

	function resetFeedCheckpoint(direction) {
		if (direction !== 'newer' && direction !== 'older') return;
		const checkpoints = loadFeedCheckpoints() ?? { newer: null, older: null };
		checkpoints[direction] = null;
		persistFeedCheckpoints(checkpoints);
		setFeedStatus(
			`${direction === 'newer' ? 'Up' : 'Down'} position reset. The next eligible played track will seed it.`,
		);
		updateFeedNavigator();
	}

	function checkpointLabelFromCard(card, url) {
		const normalizedUrl = normalizeTrackUrl(url);
		const title = Array.from(card.querySelectorAll('a[href]'))
			.find(
				(link) =>
					!link.matches('.soundTitle__username, [class*="username"]') &&
					normalizeTrackUrl(link.href) === normalizedUrl &&
					link.textContent?.trim(),
			)
			?.textContent?.trim();
		const artist = card
			.querySelector('.soundTitle__username, a.soundTitle__username')
			?.textContent?.trim();
		return title && title !== artist
			? artist
				? `${artist} — ${title}`
				: title
			: trackLabelFromUrl(url);
	}

	function shouldAdvanceCheckpoint(
		saved,
		card,
		candidateTimestamp,
		direction,
		candidateUrl,
	) {
		if (!saved || saved.url === candidateUrl) return true;
		if (saved.feedTimestamp != null && candidateTimestamp != null) {
			return direction === 'newer'
				? candidateTimestamp >= saved.feedTimestamp
				: candidateTimestamp <= saved.feedTimestamp;
		}
		const savedCard = findFeedCard(saved.url);
		if (!savedCard) return false;
		const cards = feedCards();
		const candidateIndex = cards.indexOf(card);
		const savedIndex = cards.indexOf(savedCard);
		if (candidateIndex < 0 || savedIndex < 0) return false;
		return direction === 'newer'
			? candidateIndex <= savedIndex
			: candidateIndex >= savedIndex;
	}

	function isFeedNavigatorOpen() {
		const nav = document.getElementById(FEED_NAV_ID);
		return Boolean(nav && !nav.hidden);
	}

	function saveFeedCheckpointFromCard(card, playedUrl = null) {
		if (!isFeedNavigatorOpen() || !isFeedPage() || !(card instanceof Element))
			return;
		const feedCard = card.matches('.sound')
			? card
			: card.querySelector('.sound') || card;
		const url =
			(playedUrl ? normalizeTrackUrl(playedUrl) : null) ||
			trackUrlFromCard(feedCard);
		if (!url) return;
		const timestamp = feedTimestamp(feedCard);
		const label = checkpointLabelFromCard(feedCard, url);
		const checkpoints = loadFeedCheckpoints() ?? { newer: null, older: null };
		const candidate = {
			url,
			label,
			feedTimestamp: timestamp,
			savedAt: Date.now(),
		};
		let changed = false;
		for (const direction of ['newer', 'older']) {
			const saved = checkpoints[direction];
			if (
				!shouldAdvanceCheckpoint(saved, feedCard, timestamp, direction, url)
			) {
				continue;
			}
			if (saved?.url === url) {
				if (saved.label !== label) {
					checkpoints[direction] = { ...saved, label };
					changed = true;
				}
			} else {
				checkpoints[direction] = candidate;
				changed = true;
			}
		}
		if (changed) {
			persistFeedCheckpoints(checkpoints);
			updateFeedNavigator();
		}
	}

	function updateFeedPlaybackOrigin(
		currentOrigin,
		feedCardUrl,
		outsidePlaybackSelection,
	) {
		if (feedCardUrl) return feedCardUrl;
		return outsidePlaybackSelection ? null : currentOrigin;
	}

	let lastRecordedPlayingUrl = null;
	let feedPlaybackOriginUrl = null;

	function recordPlayingFeedTrack() {
		if (!isFeedPage()) {
			feedPlaybackOriginUrl = null;
			lastRecordedPlayingUrl = null;
			return;
		}
		if (!isFeedNavigatorOpen() || !feedPlaybackOriginUrl) return;
		const playing = document.querySelector(
			'.playControls .playControl.playing, .playControls__play.playing, .playControls button[title^="Pause"], .playControls button[aria-label^="Pause"]',
		);
		if (!playing) {
			lastRecordedPlayingUrl = null;
			return;
		}
		const link = document.querySelector(
			'.playbackSoundBadge__titleLink[href], .playbackSoundBadge a[href][class*="title"]',
		);
		const url =
			link instanceof HTMLAnchorElement ? normalizeTrackUrl(link.href) : null;
		if (!url || url === lastRecordedPlayingUrl) return;
		const card = url ? findFeedCard(url) : null;
		if (card) {
			saveFeedCheckpointFromCard(card, url);
			lastRecordedPlayingUrl = url;
			feedPlaybackOriginUrl = url;
		}
	}

	let feedSearchToken = 0;
	let feedSearchActive = false;

	function setFeedStatus(message) {
		const status = document.querySelector(
			`#${FEED_NAV_ID} .sc-gate-dl-feed-status`,
		);
		if (status) status.textContent = message;
	}

	function updateFeedNavigator() {
		const nav = document.getElementById(FEED_NAV_ID);
		if (!nav) return;
		const checkpoints = loadFeedCheckpoints();
		const resumeNewer = nav.querySelector('.sc-gate-dl-feed-resume-newer');
		const resumeOlder = nav.querySelector('.sc-gate-dl-feed-resume-older');
		const cancel = nav.querySelector('.sc-gate-dl-feed-cancel');
		const find = nav.querySelector('.sc-gate-dl-feed-find');
		const resetNewer = nav.querySelector('.sc-gate-dl-feed-reset-newer');
		const resetOlder = nav.querySelector('.sc-gate-dl-feed-reset-older');
		const updateResumeLink = (link, checkpoint, label) => {
			if (!(link instanceof HTMLAnchorElement)) return;
			link.hidden = feedSearchActive;
			link.textContent = checkpoint
				? `Resume ${label}: ${checkpoint.label}`
				: 'No listened track saved yet';
			link.title = checkpoint?.url || '';
			if (checkpoint) {
				link.removeAttribute('aria-disabled');
				link.href = checkpoint.url;
			} else {
				link.setAttribute('aria-disabled', 'true');
				link.removeAttribute('href');
			}
		};
		updateResumeLink(resumeNewer, checkpoints?.newer, 'farthest up');
		updateResumeLink(resumeOlder, checkpoints?.older, 'farthest down');
		if (resetNewer instanceof HTMLButtonElement) {
			resetNewer.disabled = !checkpoints?.newer;
		}
		if (resetOlder instanceof HTMLButtonElement) {
			resetOlder.disabled = !checkpoints?.older;
		}
		if (cancel instanceof HTMLButtonElement) cancel.hidden = !feedSearchActive;
		if (find instanceof HTMLButtonElement) find.disabled = feedSearchActive;
	}

	function waitForMoreFeed(snapshot, token, targetUrl) {
		return new Promise((resolve) => {
			let finished = false;
			let mutationTimer = 0;
			const finish = (grew) => {
				if (finished) return;
				finished = true;
				observer.disconnect();
				window.clearInterval(bottomTimer);
				window.clearTimeout(timeoutTimer);
				window.clearTimeout(mutationTimer);
				resolve(grew);
			};
			const hasChanged = () => {
				if (token !== feedSearchToken) return finish(false);
				if (findFeedCard(targetUrl)) return finish(true);
				const cards = feedCards();
				const lastUrl = trackUrlFromCard(cards.at(-1));
				if (
					cards.length > snapshot.count ||
					(lastUrl && lastUrl !== snapshot.lastUrl) ||
					document.documentElement.scrollHeight > snapshot.height + 20
				) {
					finish(true);
				}
			};
			const observer = new MutationObserver(() => {
				if (mutationTimer) return;
				mutationTimer = window.setTimeout(() => {
					mutationTimer = 0;
					hasChanged();
				}, 100);
			});
			observer.observe(document.body, { childList: true, subtree: true });
			const bottomTimer = window.setInterval(() => {
				window.scrollTo(0, document.documentElement.scrollHeight);
				hasChanged();
			}, 750);
			const timeoutTimer = window.setTimeout(
				() => finish(false),
				FEED_LOAD_TIMEOUT_MS,
			);
		});
	}

	async function scrollToFeedTrack(trackUrl) {
		const url = normalizeTrackUrl(trackUrl);
		if (!url) {
			setFeedStatus('Enter a valid SoundCloud track URL.');
			return;
		}
		if (!isFeedPage()) {
			setFeedStatus('Open your SoundCloud Stream first.');
			return;
		}
		const token = ++feedSearchToken;
		feedSearchActive = true;
		updateFeedNavigator();
		let stalledLoads = 0;

		while (token === feedSearchToken && isFeedPage()) {
			const card = findFeedCard(url);
			if (card instanceof HTMLElement) {
				card.scrollIntoView({ behavior: 'smooth', block: 'center' });
				window.setTimeout(() => {
					if (card.isConnected) card.scrollIntoView({ block: 'center' });
				}, 450);
				card.classList.add('sc-gate-dl-feed-target');
				window.setTimeout(
					() => card.classList.remove('sc-gate-dl-feed-target'),
					2400,
				);
				setFeedStatus('Track found and centered.');
				break;
			}

			const cards = feedCards();
			setFeedStatus(
				`Loading more tracks… ${cards.length.toLocaleString()} checked`,
			);
			const snapshot = {
				count: cards.length,
				lastUrl: trackUrlFromCard(cards.at(-1)),
				height: document.documentElement.scrollHeight,
			};
			window.scrollTo(0, document.documentElement.scrollHeight);
			const grew = await waitForMoreFeed(snapshot, token, url);
			stalledLoads = grew ? 0 : stalledLoads + 1;
			if (stalledLoads >= 2) {
				setFeedStatus('Track was not found in the available feed.');
				break;
			}
		}

		if (token === feedSearchToken) {
			feedSearchActive = false;
			updateFeedNavigator();
		}
	}

	function cancelFeedSearch() {
		if (!feedSearchActive) return;
		feedSearchToken++;
		feedSearchActive = false;
		setFeedStatus('Scrolling cancelled.');
		updateFeedNavigator();
	}

	function toggleFeedNavigator() {
		const nav = document.getElementById(FEED_NAV_ID);
		if (nav && !nav.hidden) {
			if (feedSearchActive) cancelFeedSearch();
			nav.hidden = true;
			return;
		}
		ensureFeedNavigator(true);
	}

	function ensureFeedNavigator(open = false) {
		let nav = document.getElementById(FEED_NAV_ID);
		if (!isFeedPage()) {
			if (feedSearchActive) cancelFeedSearch();
			if (nav) nav.hidden = true;
			if (open) {
				alert('sc-gate-dl: open your SoundCloud Stream first.');
			}
			return;
		}
		if (!open) return;
		if (!nav) {
			nav = document.createElement('aside');
			nav.id = FEED_NAV_ID;
			nav.setAttribute('aria-label', 'SoundCloud feed position');
			nav.innerHTML = `
				<div class="sc-gate-dl-feed-heading">
					<span>Feed position</span>
					<button type="button" class="sc-gate-dl-feed-close" aria-label="Close" title="Close">×</button>
				</div>
				<a class="sc-gate-dl-feed-resume sc-gate-dl-feed-resume-newer"></a>
				<a class="sc-gate-dl-feed-resume sc-gate-dl-feed-resume-older"></a>
				<button type="button" class="sc-gate-dl-feed-cancel" hidden>Cancel scrolling</button>
				<button type="button" class="sc-gate-dl-feed-find">Find track URL…</button>
				<div class="sc-gate-dl-feed-reset-row">
					<button type="button" class="sc-gate-dl-feed-reset-newer">Reset up</button>
					<button type="button" class="sc-gate-dl-feed-reset-older">Reset down</button>
				</div>
				<div class="sc-gate-dl-feed-status" aria-live="polite"></div>
			`;
			nav
				.querySelector('.sc-gate-dl-feed-close')
				?.addEventListener('click', () => toggleFeedNavigator());
			for (const direction of ['newer', 'older']) {
				nav
					.querySelector(`.sc-gate-dl-feed-resume-${direction}`)
					?.addEventListener('click', (event) => {
						event.preventDefault();
						if (feedSearchActive) {
							cancelFeedSearch();
							return;
						}
						const checkpoint = loadFeedCheckpoints()?.[direction];
						if (checkpoint) void scrollToFeedTrack(checkpoint.url);
					});
			}
			nav
				.querySelector('.sc-gate-dl-feed-cancel')
				?.addEventListener('click', cancelFeedSearch);
			nav
				.querySelector('.sc-gate-dl-feed-find')
				?.addEventListener('click', () => {
					const input = window.prompt(
						'SoundCloud track URL to find in your feed:',
					);
					if (input?.trim()) void scrollToFeedTrack(input.trim());
				});
			for (const direction of ['newer', 'older']) {
				nav
					.querySelector(`.sc-gate-dl-feed-reset-${direction}`)
					?.addEventListener('click', () => resetFeedCheckpoint(direction));
			}
			document.documentElement.appendChild(nav);
		}
		nav.hidden = false;
		updateFeedNavigator();
		recordPlayingFeedTrack();
	}

	function resolveTrackUrl(el) {
		// Listen page (classic or MUI): always prefer the address bar URL
		const fromPage = pageTrackUrl();
		if (fromPage) return fromPage;
		return trackUrlFromCard(el);
	}

	/** Playlists/albums aren't single-track downloads — skip injection there. */
	function isPlaylistOrAlbumContext(el) {
		if (!(el instanceof Element)) return false;
		if (el.closest('.sound.playlist')) return true;
		if (
			el.closest(
				'.l-listen-hero.playlist, .fullHero.playlist, .listenContext.playlist',
			)
		) {
			return true;
		}
		const sound = el.closest(
			'.sound, .soundList__item, .activity, [role="group"]',
		);
		if (sound?.classList?.contains('playlist')) return true;
		if (
			sound?.querySelector(
				'a.soundTitle__title[href*="/sets/"], a.sound__coverArt[href*="/sets/"]',
			)
		) {
			return true;
		}
		const buy =
			(el.closest('.purchaseLink__container') || el).querySelector?.(
				'a[aria-label], a[title]',
			) || el;
		const label = (
			buy.getAttribute?.('aria-label') ||
			buy.getAttribute?.('title') ||
			''
		).toLowerCase();
		if (/\bbuy all\b/.test(label)) return true;
		return false;
	}

	const WEBUI_REACHABILITY_TIMEOUT_MS = 1_500;
	const WEBUI_RESOLVE_CACHE_MS = 30_000;
	/** Last server proven reachable — used for iframe origin / API until re-resolved. */
	let activeWebuiBase = null;
	let activeWebuiBaseAt = 0;

	function readStoredWebuiRaw() {
		try {
			const stored = localStorage.getItem(WEBUI_BASE_KEY);
			if (stored?.trim()) return stored;
		} catch {
			// ignore
		}
		try {
			if (typeof GM_getValue === 'function') {
				const stored = GM_getValue(WEBUI_BASE_KEY, null);
				if (typeof stored === 'string' && stored.trim()) return stored;
			}
		} catch {
			// ignore
		}
		return null;
	}

	function normalizeWebuiBase(value) {
		const url = new URL(value.trim());
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			throw new TypeError('The Web UI address must use HTTP or HTTPS.');
		}
		url.search = '';
		url.hash = '';
		return url.href.replace(/\/$/, '');
	}

	function parseWebuiBases(
		raw,
		fallback = DEFAULT_WEBUI_BASE,
		{ strict = true } = {},
	) {
		if (typeof raw !== 'string' || !raw.trim()) {
			return [normalizeWebuiBase(fallback)];
		}
		const parts = raw
			.split(/[\n,]+/)
			.map((part) => part.trim())
			.filter(Boolean);
		const bases = [];
		const seen = new Set();
		for (const part of parts) {
			try {
				const normalized = normalizeWebuiBase(part);
				if (seen.has(normalized)) continue;
				seen.add(normalized);
				bases.push(normalized);
			} catch (error) {
				if (strict) throw error;
			}
		}
		return bases.length > 0 ? bases : [normalizeWebuiBase(fallback)];
	}

	function getWebuiBases() {
		return parseWebuiBases(readStoredWebuiRaw(), DEFAULT_WEBUI_BASE, {
			strict: false,
		});
	}

	function getWebuiBase() {
		return activeWebuiBase || getWebuiBases()[0] || DEFAULT_WEBUI_BASE;
	}

	function persistWebuiBases(bases) {
		const serialized = bases.join('\n');
		try {
			if (typeof GM_setValue === 'function') {
				GM_setValue(WEBUI_BASE_KEY, serialized);
			}
		} catch {
			// ignore
		}
		try {
			localStorage.setItem(WEBUI_BASE_KEY, serialized);
		} catch {
			// ignore
		}
		return serialized;
	}

	function setWebuiBases(value) {
		const bases = value.trim()
			? parseWebuiBases(value)
			: [DEFAULT_WEBUI_BASE];
		activeWebuiBase = null;
		activeWebuiBaseAt = 0;
		persistWebuiBases(bases);
		return bases;
	}

	function apiOriginFromWebui(webuiBase) {
		const url = new URL(webuiBase);
		if (url.port === '4321') url.port = '3000';
		return url.origin;
	}

	function abortSignalTimeout(ms) {
		if (typeof AbortSignal?.timeout === 'function') {
			return AbortSignal.timeout(ms);
		}
		const controller = new AbortController();
		const timer = window.setTimeout(() => controller.abort(), ms);
		controller.signal.addEventListener(
			'abort',
			() => window.clearTimeout(timer),
			{ once: true },
		);
		return controller.signal;
	}

	const gmXmlHttpRequest =
		typeof GM_xmlhttpRequest === 'function'
			? GM_xmlhttpRequest
			: typeof GM !== 'undefined' && typeof GM.xmlHttpRequest === 'function'
				? GM.xmlHttpRequest.bind(GM)
				: null;

	/** Probe via the userscript bridge — page fetch is blocked by Private Network Access. */
	function probeUrl(url) {
		if (gmXmlHttpRequest) {
			return new Promise((resolve) => {
				gmXmlHttpRequest({
					method: 'GET',
					url,
					timeout: WEBUI_REACHABILITY_TIMEOUT_MS,
					anonymous: true,
					onload: (response) => resolve(response.status > 0),
					onerror: () => resolve(false),
					ontimeout: () => resolve(false),
					onabort: () => resolve(false),
				});
			});
		}
		return fetch(url, {
			method: 'GET',
			mode: 'cors',
			cache: 'no-store',
			signal: abortSignalTimeout(WEBUI_REACHABILITY_TIMEOUT_MS),
		})
			.then((response) => response.ok)
			.catch(async () => {
				try {
					await fetch(url, {
						method: 'GET',
						mode: 'no-cors',
						cache: 'no-store',
						signal: abortSignalTimeout(WEBUI_REACHABILITY_TIMEOUT_MS),
					});
					return true;
				} catch {
					return false;
				}
			});
	}

	/** Cancel via GM bridge — page fetch to localhost is blocked by PNA. */
	function requestJobCancel(jobId) {
		const url = `${getApiBase()}/api/job/${encodeURIComponent(jobId)}/cancel`;
		if (gmXmlHttpRequest) {
			try {
				// Dispatch immediately; do not wait for teardown (browser close can take seconds).
				gmXmlHttpRequest({
					method: 'POST',
					url,
					anonymous: true,
					onload: () => {},
					onerror: () => {},
					ontimeout: () => {},
					onabort: () => {},
				});
			} catch {
				// Bridge may throw synchronously; panel cleanup must still continue.
			}
			return Promise.resolve();
		}
		return fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
	}

	async function isWebuiReachable(base) {
		const urls = [`${base}/`, `${apiOriginFromWebui(base)}/api/capabilities`];
		const seen = new Set();
		for (const url of urls) {
			if (seen.has(url)) continue;
			seen.add(url);
			if (await probeUrl(url)) return true;
		}
		return false;
	}

	async function resolveWebuiBase() {
		const bases = getWebuiBases();
		const now = Date.now();
		const cached =
			activeWebuiBase &&
			now - activeWebuiBaseAt < WEBUI_RESOLVE_CACHE_MS &&
			bases.includes(activeWebuiBase)
				? activeWebuiBase
				: null;
		const ordered = cached
			? [cached, ...bases.filter((base) => base !== cached)]
			: bases;
		for (const base of ordered) {
			if (await isWebuiReachable(base)) {
				activeWebuiBase = base;
				activeWebuiBaseAt = Date.now();
				return base;
			}
		}
		activeWebuiBase = null;
		activeWebuiBaseAt = 0;
		throw new Error(
			`None of the configured sc-gate-dl servers are reachable:\n${bases.join('\n')}`,
		);
	}

	function bindBackdropDismiss(dialog, close) {
		let pointerDownOnBackdrop = false;
		dialog.addEventListener('pointerdown', (event) => {
			pointerDownOnBackdrop = event.target === dialog;
		});
		dialog.addEventListener('click', (event) => {
			if (pointerDownOnBackdrop && event.target === dialog) close();
			pointerDownOnBackdrop = false;
		});
	}

	function configureWebuiBase() {
		ensureStyles();
		document.getElementById('sc-gate-dl-server-dialog')?.remove();
		const dialog = document.createElement('div');
		dialog.id = 'sc-gate-dl-server-dialog';
		dialog.innerHTML = `
			<div class="sc-gate-dl-format-card sc-gate-dl-server-card" role="dialog" aria-label="Configure server">
				<div class="sc-gate-dl-format-title">Web UI servers</div>
				<p class="sc-gate-dl-server-hint">One address per line, tried in order before opening. Leave empty to reset to localhost.</p>
				<textarea class="sc-gate-dl-server-input" rows="4" spellcheck="false"></textarea>
				<div class="sc-gate-dl-format-actions">
					<button type="button" class="sc-gate-dl-format-cancel">Cancel</button>
					<button type="button" class="sc-gate-dl-format-save">Save</button>
				</div>
			</div>
		`;
		const input = dialog.querySelector('.sc-gate-dl-server-input');
		if (input instanceof HTMLTextAreaElement) {
			input.value = getWebuiBases().join('\n');
		}
		const close = () => dialog.remove();
		bindBackdropDismiss(dialog, close);
		dialog
			.querySelector('.sc-gate-dl-format-cancel')
			?.addEventListener('click', close);
		dialog
			.querySelector('.sc-gate-dl-format-save')
			?.addEventListener('click', () => {
				const value =
					input instanceof HTMLTextAreaElement ? input.value : '';
				try {
					const bases = setWebuiBases(value);
					close();
					void (async () => {
						const panel = document.getElementById(PANEL_ID);
						if (panel && !panel.hidden && panel.dataset.trackUrl) {
							try {
								await resolveWebuiBase();
								loadTrackIntoPanel(panel, panel.dataset.trackUrl);
							} catch (error) {
								window.alert(
									error instanceof Error
										? error.message
										: 'No configured sc-gate-dl server is reachable.',
								);
								return;
							}
						}
						window.alert(
							bases.length === 1
								? `sc-gate-dl server set to ${bases[0]}`
								: `sc-gate-dl servers (tried in order):\n${bases.join('\n')}`,
						);
					})();
				} catch {
					window.alert(
						'Enter complete HTTP(S) addresses, one per line.\nExample:\nhttp://192.168.178.57:4321\nhttp://100.x.y.z:8123',
					);
				}
			});
		document.documentElement.appendChild(dialog);
		if (input instanceof HTMLTextAreaElement) input.focus();
	}

	function loadGeom() {
		try {
			const raw = localStorage.getItem(PANEL_GEOM_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (
				typeof parsed?.width === 'number' &&
				typeof parsed?.height === 'number' &&
				typeof parsed?.left === 'number' &&
				typeof parsed?.top === 'number'
			) {
				return parsed;
			}
		} catch {
			// ignore
		}
		return null;
	}

	function saveGeom(panel) {
		try {
			const rect = panel.getBoundingClientRect();
			localStorage.setItem(
				PANEL_GEOM_KEY,
				JSON.stringify({
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					left: Math.round(rect.left),
					top: Math.round(rect.top),
				}),
			);
		} catch {
			// ignore
		}
	}

	function loadQueueGeom() {
		try {
			const raw = localStorage.getItem(QUEUE_GEOM_KEY);
			if (!raw) return null;
			const parsed = JSON.parse(raw);
			if (
				typeof parsed?.left === 'number' &&
				typeof parsed?.top === 'number' &&
				typeof parsed?.width === 'number'
			) {
				return parsed;
			}
		} catch {
			// ignore
		}
		return null;
	}

	function saveQueueGeom(el) {
		try {
			const rect = el.getBoundingClientRect();
			localStorage.setItem(
				QUEUE_GEOM_KEY,
				JSON.stringify({
					width: Math.round(rect.width),
					left: Math.round(rect.left),
					top: Math.round(rect.top),
				}),
			);
		} catch {
			// ignore
		}
	}

	function trackLabelFromUrl(url) {
		try {
			const parts = new URL(url).pathname.split('/').filter(Boolean);
			if (parts.length >= 2) {
				const artist = decodeURIComponent(parts[0]).replace(/-/g, ' ');
				const track = decodeURIComponent(parts[1]).replace(/-/g, ' ');
				return `${artist} — ${track}`;
			}
		} catch {
			// ignore
		}
		return url;
	}

	function isPanelBusy() {
		const panel = document.getElementById(PANEL_ID);
		return Boolean(panel && !panel.hidden && panel.dataset.jobId);
	}

	/** @type {Element | null} */
	let tooltipAnchor = null;
	let tooltipShowTimer = 0;
	let tooltipHideTimer = 0;
	let tooltipTracking = false;
	const TOOLTIP_ENTER_MS_CLASSIC = 60;
	const TOOLTIP_ENTER_MS_MUI = 100;
	const TOOLTIP_EXIT_MS_CLASSIC = 150;
	/** Faster Grow (still scale + fade; was 200ms). */
	const TOOLTIP_EXIT_MS_MUI = 100;
	const TOOLTIP_ENTER_ANIM_MS_MUI = 100;

	function tooltipVariantFor(anchor) {
		if (
			anchor instanceof Element &&
			(anchor.getAttribute(WRAP_ATTR) === 'mui' ||
				anchor.closest?.(`[${WRAP_ATTR}="mui"]`))
		) {
			return 'mui';
		}
		return 'classic';
	}

	function isTooltipAnchorActive(anchor) {
		if (!(anchor instanceof Element) || !anchor.isConnected) return false;
		if (anchor.matches(':hover')) return true;
		const active = document.activeElement;
		return active instanceof Element && anchor.contains(active);
	}

	function onTooltipPointerMove() {
		if (tooltipAnchor && !isTooltipAnchorActive(tooltipAnchor)) {
			hideTooltip();
		}
	}

	function onTooltipPointerDown(e) {
		if (
			tooltipAnchor &&
			e.target instanceof Node &&
			!tooltipAnchor.contains(e.target)
		) {
			hideTooltip();
		}
	}

	function stopTooltipTracking() {
		if (!tooltipTracking) return;
		tooltipTracking = false;
		document.removeEventListener('scroll', hideTooltip, true);
		document.removeEventListener('pointermove', onTooltipPointerMove, true);
		document.removeEventListener('pointerdown', onTooltipPointerDown, true);
		window.removeEventListener('blur', hideTooltip);
	}

	function startTooltipTracking() {
		if (tooltipTracking) return;
		tooltipTracking = true;
		// Scroll/move can leave the cursor off the control without pointerleave.
		document.addEventListener('scroll', hideTooltip, true);
		document.addEventListener('pointermove', onTooltipPointerMove, true);
		document.addEventListener('pointerdown', onTooltipPointerDown, true);
		window.addEventListener('blur', hideTooltip);
	}

	function removeTooltipEl() {
		window.clearTimeout(tooltipHideTimer);
		tooltipHideTimer = 0;
		document.getElementById(TOOLTIP_ID)?.remove();
	}

	function hideTooltip() {
		window.clearTimeout(tooltipShowTimer);
		tooltipShowTimer = 0;
		tooltipAnchor = null;
		stopTooltipTracking();
		const tip = document.getElementById(TOOLTIP_ID);
		if (!tip) {
			window.clearTimeout(tooltipHideTimer);
			tooltipHideTimer = 0;
			return;
		}
		if (tip.classList.contains('sc-gate-dl-tip-hiding')) return;
		const exitMs =
			tip.dataset.variant === 'mui'
				? TOOLTIP_EXIT_MS_MUI
				: TOOLTIP_EXIT_MS_CLASSIC;
		tip.classList.remove('sc-gate-dl-tip-visible');
		tip.classList.add('sc-gate-dl-tip-hiding');
		window.clearTimeout(tooltipHideTimer);
		tooltipHideTimer = window.setTimeout(() => {
			tooltipHideTimer = 0;
			tip.remove();
		}, exitMs);
	}

	function showTooltip(anchor) {
		removeTooltipEl();
		window.clearTimeout(tooltipShowTimer);
		tooltipShowTimer = 0;
		if (!isTooltipAnchorActive(anchor)) return;
		const variant = tooltipVariantFor(anchor);
		tooltipAnchor = anchor;
		startTooltipTracking();
		const tip = document.createElement('div');
		tip.id = TOOLTIP_ID;
		tip.dataset.variant = variant;
		tip.setAttribute('role', 'tooltip');
		tip.className = `sc-gate-dl-tip-${variant}`;
		// Classic SC tooltips use a caret; Webi/MUI track actions do not.
		tip.innerHTML =
			variant === 'mui'
				? `<div class="sc-gate-dl-tip-content"></div>`
				: `<div class="sc-gate-dl-tip-arrow"></div><div class="sc-gate-dl-tip-content"></div>`;
		const content = tip.querySelector('.sc-gate-dl-tip-content');
		if (content) content.textContent = TOOLTIP_LABEL;
		document.documentElement.appendChild(tip);

		// Anchor to the visible icon button, not a wide wrapper
		const icon =
			anchor.querySelector?.(`[${BUTTON_ATTR}]`) ||
			(anchor.hasAttribute?.(BUTTON_ATTR) ? anchor : null) ||
			anchor;
		const ar = icon.getBoundingClientRect();

		// Measure untransformed so width/height match the final painted box.
		tip.classList.add('sc-gate-dl-tip-measure');
		const tr = tip.getBoundingClientRect();
		tip.classList.remove('sc-gate-dl-tip-measure');

		const gap = variant === 'mui' ? 4 : 8;
		let below = false;
		let top;
		if (variant === 'classic') {
			// Classic feed tooltips (Buy Link, etc.) open below the control.
			below = true;
			top = ar.bottom + gap;
			if (top + tr.height > window.innerHeight - 4) {
				const above = ar.top - tr.height - gap;
				if (above >= 4) {
					below = false;
					top = above;
				}
			}
		} else {
			// MUI track-header actions open above.
			top = ar.top - tr.height - gap;
			if (top < 4) {
				top = ar.bottom + gap;
				below = true;
			}
		}
		if (below) tip.classList.add('sc-gate-dl-tip-below');

		let left = ar.left + ar.width / 2 - tr.width / 2;
		left = Math.min(Math.max(8, left), window.innerWidth - tr.width - 8);
		tip.style.top = `${Math.round(top)}px`;
		tip.style.left = `${Math.round(left)}px`;

		const arrow = tip.querySelector('.sc-gate-dl-tip-arrow');
		if (arrow instanceof HTMLElement) {
			arrow.style.left = '50%';
			arrow.style.marginLeft = '-5px';
		}

		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				if (document.getElementById(TOOLTIP_ID) !== tip) return;
				if (!isTooltipAnchorActive(anchor)) {
					removeTooltipEl();
					tooltipAnchor = null;
					stopTooltipTracking();
					return;
				}
				tip.classList.add('sc-gate-dl-tip-visible');
			});
		});
	}

	function openFormatDialog() {
		ensureStyles();
		document.getElementById('sc-gate-dl-format-dialog')?.remove();
		const current = getOutputFormat();
		const dialog = document.createElement('div');
		dialog.id = 'sc-gate-dl-format-dialog';
		dialog.innerHTML = `
			<div class="sc-gate-dl-format-card" role="dialog" aria-label="Output format">
				<div class="sc-gate-dl-format-title">Output format</div>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-fmt" value="mp3-320"${current === 'mp3-320' ? ' checked' : ''}/>
					<span>MP3 320kbps</span>
				</label>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-fmt" value="flac"${current === 'flac' ? ' checked' : ''}/>
					<span>FLAC</span>
				</label>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-fmt" value="original"${current === 'original' ? ' checked' : ''}/>
					<span>Original file</span>
				</label>
				<div class="sc-gate-dl-format-actions">
					<button type="button" class="sc-gate-dl-format-cancel">Cancel</button>
					<button type="button" class="sc-gate-dl-format-save">Save</button>
				</div>
			</div>
		`;
		const close = () => dialog.remove();
		bindBackdropDismiss(dialog, close);
		dialog
			.querySelector('.sc-gate-dl-format-cancel')
			?.addEventListener('click', close);
		dialog
			.querySelector('.sc-gate-dl-format-save')
			?.addEventListener('click', () => {
				const selected = dialog.querySelector(
					'input[name="sc-gate-dl-fmt"]:checked',
				);
				if (selected instanceof HTMLInputElement)
					setOutputFormat(selected.value);
				close();
			});
		document.documentElement.appendChild(dialog);
	}

	function openBrowserModeDialog() {
		ensureStyles();
		document.getElementById('sc-gate-dl-browser-mode-dialog')?.remove();
		const current = getBrowserMode();
		const dialog = document.createElement('div');
		dialog.id = 'sc-gate-dl-browser-mode-dialog';
		dialog.innerHTML = `
			<div class="sc-gate-dl-format-card" role="dialog" aria-label="Browser mode">
				<div class="sc-gate-dl-format-title">Browser mode</div>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-browser-mode" value="headless"${current === 'headless' ? ' checked' : ''}/>
					<span>Headless</span>
				</label>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-browser-mode" value="xvfb"${current === 'xvfb' ? ' checked' : ''}/>
					<span>Invisible headed (Xvfb)</span>
				</label>
				<label class="sc-gate-dl-format-option">
					<input type="radio" name="sc-gate-dl-browser-mode" value="headed"${current === 'headed' ? ' checked' : ''}/>
					<span>Visible headed window</span>
				</label>
				<div class="sc-gate-dl-format-actions">
					<button type="button" class="sc-gate-dl-format-cancel">Cancel</button>
					<button type="button" class="sc-gate-dl-format-save">Save</button>
				</div>
			</div>
		`;
		const close = () => dialog.remove();
		bindBackdropDismiss(dialog, close);
		dialog
			.querySelector('.sc-gate-dl-format-cancel')
			?.addEventListener('click', close);
		dialog
			.querySelector('.sc-gate-dl-format-save')
			?.addEventListener('click', () => {
				const selected = dialog.querySelector(
					'input[name="sc-gate-dl-browser-mode"]:checked',
				);
				if (selected instanceof HTMLInputElement)
					setBrowserMode(selected.value);
				close();
			});
		document.documentElement.appendChild(dialog);
	}

	function bindTooltip(anchor) {
		const enterMs =
			tooltipVariantFor(anchor) === 'mui'
				? TOOLTIP_ENTER_MS_MUI
				: TOOLTIP_ENTER_MS_CLASSIC;
		const onEnter = () => {
			window.clearTimeout(tooltipShowTimer);
			tooltipShowTimer = window.setTimeout(() => showTooltip(anchor), enterMs);
		};
		const onLeave = () => {
			window.clearTimeout(tooltipShowTimer);
			tooltipShowTimer = 0;
			hideTooltip();
		};
		anchor.addEventListener('pointerenter', onEnter);
		anchor.addEventListener('pointerleave', onLeave);
		anchor.addEventListener('focusin', onEnter);
		anchor.addEventListener('focusout', (e) => {
			if (
				e.relatedTarget instanceof Node &&
				anchor.contains(e.relatedTarget)
			) {
				return;
			}
			onLeave();
		});
	}

	function isOurNode(el) {
		return (
			el instanceof Element &&
			(el.hasAttribute(BUTTON_ATTR) ||
				el.hasAttribute(WRAP_ATTR) ||
				!!el.closest(`[${BUTTON_ATTR}], [${WRAP_ATTR}], #${PANEL_ID}`))
		);
	}

	function alreadyInjectedNear(anchorPoint) {
		if (!anchorPoint) return true;
		const scope =
			anchorPoint.closest('.soundActions, .sound__soundActions') ||
			anchorPoint.parentElement;
		if (scope?.querySelector(`[${WRAP_ATTR}]`)) return true;
		const next = anchorPoint.nextElementSibling;
		const prev = anchorPoint.previousElementSibling;
		return !!(
			next?.hasAttribute?.(WRAP_ATTR) ||
			next?.hasAttribute?.(BUTTON_ATTR) ||
			prev?.hasAttribute?.(WRAP_ATTR) ||
			prev?.hasAttribute?.(BUTTON_ATTR)
		);
	}

	function ensureStyles() {
		let style = document.getElementById(STYLE_ID);
		if (!style) {
			style = document.createElement('style');
			style.id = STYLE_ID;
			document.documentElement.appendChild(style);
		}
		// Always rewrite so userscript updates pick up new tooltip CSS without a hard cache.
		style.textContent = `
#${PANEL_ID} {
	position: fixed;
	z-index: 2147483646;
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	min-width: ${MIN_PANEL_W}px;
	min-height: ${MIN_PANEL_H}px;
	max-width: calc(100vw - 8px);
	max-height: calc(100vh - 8px);
	background: #0f0f12;
	border-radius: 10px;
	overflow: hidden;
	box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
	border: 1px solid rgba(255, 255, 255, 0.12);
}
#${PANEL_ID}[hidden] { display: none !important; }
#${PANEL_ID} .sc-gate-dl-toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 6px 8px 6px 10px;
	background: #16161c;
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	color: #eee;
	font: 600 12px/1.2 Interstate, "Lucida Grande", Arial, sans-serif;
	cursor: move;
	user-select: none;
	flex-shrink: 0;
	touch-action: none;
}
#${PANEL_ID} .sc-gate-dl-toolbar a {
	color: #f50;
	text-decoration: none;
	cursor: pointer;
}
#${PANEL_ID} .sc-gate-dl-toolbar .sc-gate-dl-actions {
	display: flex;
	align-items: center;
	gap: 6px;
	flex-shrink: 0;
	margin-left: auto;
}
#${PANEL_ID} .sc-gate-dl-format,
#${PANEL_ID} .sc-gate-dl-browser-mode {
	appearance: none;
	background: #0f0f12;
	color: #ddd;
	border: 1px solid rgba(255,255,255,0.14);
	border-radius: 6px;
	font: 500 11px/1.2 Interstate, "Lucida Grande", Arial, sans-serif;
	padding: 4px 6px;
	cursor: pointer;
	max-width: 118px;
}
#${PANEL_ID} .sc-gate-dl-browser-mode { max-width: 92px; }
#${PANEL_ID} .sc-gate-dl-server {
	display: inline-grid;
	place-items: center;
	width: 28px;
	height: 28px;
	padding: 0;
	border: 1px solid rgba(255,255,255,0.14);
	border-radius: 6px;
	background: #0f0f12;
	color: #ccc;
	cursor: pointer;
}
#${PANEL_ID} .sc-gate-dl-server:hover { color: #fff; }
#${PANEL_ID} .sc-gate-dl-server svg {
	width: 15px;
	height: 15px;
	fill: currentColor;
}
#${PANEL_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close {
	appearance: none;
	border: 0;
	background: transparent;
	color: #ccc;
	font-size: 18px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 6px;
}
#${PANEL_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close:hover { color: #fff; }
#${PANEL_ID} iframe {
	flex: 1;
	width: 100%;
	border: 0;
	background: #0f0f12;
	min-height: 0;
}

/* Download queue — smaller floating window (default top-left) */
#${QUEUE_ID} {
	position: fixed;
	z-index: 2147483645;
	display: flex;
	flex-direction: column;
	box-sizing: border-box;
	width: ${DEFAULT_QUEUE_GEOM.width}px;
	max-width: calc(100vw - 16px);
	max-height: min(360px, calc(100vh - 24px));
	background: #0f0f12;
	border-radius: 8px;
	overflow: hidden;
	box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
	border: 1px solid rgba(255, 255, 255, 0.12);
}
#${QUEUE_ID}[hidden] { display: none !important; }
#${QUEUE_ID} .sc-gate-dl-toolbar {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	padding: 5px 6px 5px 10px;
	background: #16161c;
	border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	color: #eee;
	font: 600 11px/1.2 Interstate, "Lucida Grande", Arial, sans-serif;
	cursor: move;
	user-select: none;
	flex-shrink: 0;
	touch-action: none;
}
#${QUEUE_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close {
	appearance: none;
	border: 0;
	background: transparent;
	color: #ccc;
	font-size: 16px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 6px;
}
#${QUEUE_ID} .sc-gate-dl-toolbar button.sc-gate-dl-close:hover { color: #fff; }
#${QUEUE_ID} .sc-gate-dl-queue-list {
	list-style: none;
	margin: 0;
	padding: 4px 0;
	overflow-y: auto;
	flex: 1;
	min-height: 0;
}
#${QUEUE_ID} .sc-gate-dl-queue-item {
	display: flex;
	align-items: center;
	gap: 6px;
	padding: 6px 8px 6px 10px;
	color: #ddd;
	font: 500 11px/1.3 Interstate, "Lucida Grande", Arial, sans-serif;
	border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
#${QUEUE_ID} .sc-gate-dl-queue-item:last-child { border-bottom: 0; }
#${QUEUE_ID} .sc-gate-dl-queue-label {
	flex: 1;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
	appearance: none;
	border: 0;
	background: transparent;
	color: inherit;
	font: inherit;
	text-align: left;
	cursor: pointer;
	padding: 0;
}
#${QUEUE_ID} .sc-gate-dl-queue-label:hover { color: #f50; }
#${QUEUE_ID} .sc-gate-dl-queue-remove {
	appearance: none;
	border: 0;
	background: transparent;
	color: #888;
	font-size: 14px;
	line-height: 1;
	cursor: pointer;
	padding: 2px 4px;
	flex-shrink: 0;
}
#${QUEUE_ID} .sc-gate-dl-queue-remove:hover { color: #fff; }

/* Resize handles — all edges + corners */
#${PANEL_ID} .sc-gate-dl-rh {
	position: absolute;
	z-index: 3;
	background: transparent;
}
#${PANEL_ID} .sc-gate-dl-rh[data-dir="n"] { top: 0; left: 8px; right: 8px; height: 6px; cursor: n-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="s"] { bottom: 0; left: 8px; right: 8px; height: 6px; cursor: s-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="e"] { top: 8px; right: 0; bottom: 8px; width: 6px; cursor: e-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="w"] { top: 8px; left: 0; bottom: 8px; width: 6px; cursor: w-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="ne"] { top: 0; right: 0; width: 10px; height: 10px; cursor: ne-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="nw"] { top: 0; left: 0; width: 10px; height: 10px; cursor: nw-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="se"] { bottom: 0; right: 0; width: 10px; height: 10px; cursor: se-resize; }
#${PANEL_ID} .sc-gate-dl-rh[data-dir="sw"] { bottom: 0; left: 0; width: 10px; height: 10px; cursor: sw-resize; }

/* Feed checkpoint and deep-scroll controls */
#${FEED_NAV_ID} {
	position: fixed;
	right: 16px;
	bottom: 72px;
	z-index: 2147483644;
	display: flex;
	flex-direction: column;
	gap: 6px;
	box-sizing: border-box;
	width: min(300px, calc(100vw - 32px));
	padding: 8px;
	background: #16161c;
	border: 1px solid rgba(255, 255, 255, 0.12);
	border-radius: 8px;
	box-shadow: 0 8px 28px rgba(0, 0, 0, 0.4);
	font: 500 12px/1.3 Interstate, "Lucida Grande", Arial, sans-serif;
}
#${FEED_NAV_ID}[hidden] { display: none !important; }
#${FEED_NAV_ID} .sc-gate-dl-feed-heading {
	display: flex;
	align-items: center;
	justify-content: space-between;
	color: #eee;
	font-weight: 700;
}
#${FEED_NAV_ID} button,
#${FEED_NAV_ID} .sc-gate-dl-feed-resume {
	appearance: none;
	display: block;
	box-sizing: border-box;
	width: 100%;
	min-height: 30px;
	padding: 6px 9px;
	overflow: hidden;
	border: 1px solid rgba(255, 255, 255, 0.14);
	border-radius: 6px;
	background: #0f0f12;
	color: #eee;
	font: inherit;
	text-align: left;
	text-decoration: none;
	text-overflow: ellipsis;
	white-space: nowrap;
	cursor: pointer;
}
#${FEED_NAV_ID} button.sc-gate-dl-feed-close {
	width: auto;
	min-height: 0;
	padding: 0 5px;
	border: 0;
	background: transparent;
	font-size: 18px;
	line-height: 1;
}
#${FEED_NAV_ID} button[hidden] { display: none !important; }
#${FEED_NAV_ID} .sc-gate-dl-feed-resume[hidden] { display: none !important; }
#${FEED_NAV_ID} button:hover:not(:disabled),
#${FEED_NAV_ID} .sc-gate-dl-feed-resume:hover:not([aria-disabled]) {
	border-color: #f50;
	color: #fff;
}
#${FEED_NAV_ID} button:disabled { color: #777; cursor: default; }
#${FEED_NAV_ID} .sc-gate-dl-feed-resume[aria-disabled] {
	color: #777;
	cursor: default;
}
#${FEED_NAV_ID} .sc-gate-dl-feed-find { text-align: center; }
#${FEED_NAV_ID} .sc-gate-dl-feed-reset-row {
	display: flex;
	gap: 6px;
}
#${FEED_NAV_ID} .sc-gate-dl-feed-reset-row button {
	flex: 1 1 50%;
	width: 50%;
	color: #aaa;
	text-align: center;
}
#${FEED_NAV_ID} .sc-gate-dl-feed-status:empty { display: none; }
#${FEED_NAV_ID} .sc-gate-dl-feed-status {
	padding: 1px 2px;
	color: #aaa;
	font-size: 11px;
}
.sc-gate-dl-feed-target {
	outline: 3px solid #f50 !important;
	outline-offset: 5px;
	transition: outline-color 300ms ease;
}

/* Classic: SoundCloud .tooltip (#303030 + caret + opacity fade)
   MUI/Webi: sampled native tip — #191919 fill, #3a3a3a border, ~#f8f8f8
   11px regular text, Grow enter (scale 0.75→1 + fade, 200ms) */
#${TOOLTIP_ID} {
	position: fixed !important;
	z-index: 2147483647 !important;
	pointer-events: none;
	border: 0;
	box-shadow: none;
	white-space: nowrap;
	max-width: min(280px, calc(100vw - 16px));
	opacity: 0;
	transform: none;
	will-change: opacity, transform;
}
#${TOOLTIP_ID}.sc-gate-dl-tip-measure {
	opacity: 0 !important;
	transform: none !important;
	transition: none !important;
}
#${TOOLTIP_ID}.sc-gate-dl-tip-classic {
	background: #303030;
	color: #fff;
	border-radius: 4px;
	padding: 4px 8px;
	font: 500 12px/1.3 Söhne, Interstate, "Lucida Grande", Arial, sans-serif;
	transition: opacity ${TOOLTIP_EXIT_MS_CLASSIC}ms ease;
}
#${TOOLTIP_ID}.sc-gate-dl-tip-mui {
	background: #191919;
	color: #f8f8f8;
	border: 1px solid #3a3a3a;
	border-radius: 4px;
	padding: 4px 8px;
	font: 400 11px/1.4 Söhne, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	transform: scale(0.75);
	transform-origin: center bottom;
	transition:
		opacity ${TOOLTIP_ENTER_ANIM_MS_MUI}ms cubic-bezier(0, 0, 0.2, 1),
		transform ${TOOLTIP_ENTER_ANIM_MS_MUI}ms cubic-bezier(0, 0, 0.2, 1);
}
#${TOOLTIP_ID}.sc-gate-dl-tip-mui.sc-gate-dl-tip-below {
	transform-origin: center top;
}
#${TOOLTIP_ID}.sc-gate-dl-tip-mui.sc-gate-dl-tip-hiding {
	transition:
		opacity ${TOOLTIP_EXIT_MS_MUI}ms cubic-bezier(0.4, 0, 1, 1),
		transform ${TOOLTIP_EXIT_MS_MUI}ms cubic-bezier(0.4, 0, 1, 1);
}
#${TOOLTIP_ID}.sc-gate-dl-tip-visible {
	opacity: 1;
}
#${TOOLTIP_ID}.sc-gate-dl-tip-mui.sc-gate-dl-tip-visible {
	transform: scale(1);
}
#${TOOLTIP_ID} .sc-gate-dl-tip-content { position: relative; z-index: 1; }
#${TOOLTIP_ID} .sc-gate-dl-tip-arrow {
	position: absolute;
	bottom: -5px;
	left: 50%;
	width: 10px;
	height: 10px;
	margin-left: -5px;
	border: 0;
	transform: rotate(45deg);
	background: #303030;
}
#${TOOLTIP_ID}.sc-gate-dl-tip-below .sc-gate-dl-tip-arrow {
	bottom: auto;
	top: -5px;
}
@media (prefers-reduced-motion: reduce) {
	#${TOOLTIP_ID}.sc-gate-dl-tip-classic,
	#${TOOLTIP_ID}.sc-gate-dl-tip-mui {
		transition: none;
		transform: none;
	}
	#${TOOLTIP_ID}.sc-gate-dl-tip-mui.sc-gate-dl-tip-visible {
		transform: none;
	}
}

/* Format / server chooser (Violentmonkey menu) */
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) {
	position: fixed;
	inset: 0;
	z-index: 2147483647;
	display: flex;
	align-items: flex-start;
	justify-content: flex-end;
	padding: 72px 16px 16px;
	pointer-events: auto;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-format-card {
	pointer-events: auto;
	width: min(280px, calc(100vw - 32px));
	background: #16161c;
	color: #eee;
	border: 1px solid rgba(255,255,255,0.12);
	border-radius: 10px;
	box-shadow: 0 12px 40px rgba(0,0,0,0.45);
	padding: 14px;
	font: 500 13px/1.35 Interstate, "Lucida Grande", Arial, sans-serif;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-server-card {
	width: min(360px, calc(100vw - 32px));
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-format-title {
	font-weight: 700;
	margin-bottom: 10px;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-server-hint {
	margin: 0 0 10px;
	color: #aaa;
	font-size: 12px;
	font-weight: 400;
	line-height: 1.4;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-server-input {
	display: block;
	width: 100%;
	box-sizing: border-box;
	resize: vertical;
	min-height: 88px;
	margin: 0;
	padding: 8px;
	border-radius: 6px;
	border: 1px solid rgba(255,255,255,0.16);
	background: #0f0f14;
	color: #eee;
	font: 500 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-format-option {
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 8px 4px;
	cursor: pointer;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-format-actions {
	display: flex;
	justify-content: flex-end;
	gap: 8px;
	margin-top: 12px;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) button {
	appearance: none;
	border: 1px solid rgba(255,255,255,0.14);
	background: #0f0f12;
	color: #ddd;
	border-radius: 6px;
	padding: 6px 10px;
	cursor: pointer;
	font: inherit;
}
:is(#sc-gate-dl-format-dialog, #sc-gate-dl-browser-mode-dialog, #sc-gate-dl-server-dialog) .sc-gate-dl-format-save {
	background: #f50;
	border-color: #f50;
	color: #fff;
}

/* Classic SC — sibling of cart in .soundActions (cart wrapper is ~16px and clips) */
div[${WRAP_ATTR}="classic"] {
	display: inline-flex !important;
	align-items: center;
	justify-content: center;
	vertical-align: middle;
	margin-left: 2px !important;
	width: 32px;
	height: 32px;
	overflow: visible !important;
	line-height: 0;
	flex-shrink: 0;
}
a[${BUTTON_ATTR}="classic"] {
	display: inline-flex !important;
	align-items: center;
	justify-content: center;
	width: 32px !important;
	height: 32px !important;
	min-width: 32px !important;
	min-height: 32px !important;
	padding: 0 !important;
	box-sizing: border-box;
	vertical-align: middle;
	overflow: visible !important;
}
a[${BUTTON_ATTR}="classic"] .sc-button-label {
	display: flex !important;
	align-items: center;
	justify-content: center;
	padding: 0 !important;
	width: 100%;
}
a[${BUTTON_ATTR}="classic"] svg {
	display: block;
	width: 16px;
	height: 16px;
}
a[${STORE_SERVICE_ATTR}] svg,
a[${STORE_SERVICE_ATTR}] .sc-button-icon {
	opacity: 0 !important;
}
a.soundActions__purchaseLink[${STORE_SERVICE_ATTR}],
a.sc-button-buy[${STORE_SERVICE_ATTR}] {
	position: relative !important;
	background-image: none !important;
}
a.soundActions__purchaseLink[${STORE_SERVICE_ATTR}]::before,
a.sc-button-buy[${STORE_SERVICE_ATTR}]::before {
	opacity: 0 !important;
}
a.soundActions__purchaseLink[${STORE_SERVICE_ATTR}]::after,
a.sc-button-buy[${STORE_SERVICE_ATTR}]::after {
	content: "";
	position: absolute;
	top: 50%;
	left: 50%;
	width: 16px;
	height: 16px;
	transform: translate(-50%, -50%);
	background: var(--sc-gate-dl-store-icon) center / contain no-repeat;
	pointer-events: none;
}

/* MUI listen page */
div[${WRAP_ATTR}="mui"] {
	display: inline-flex;
	vertical-align: middle;
}
button[${BUTTON_ATTR}="mui"] svg {
	display: block;
	width: 24px;
	height: 24px;
}
a[${STORE_SERVICE_ATTR}] > button {
	position: relative;
}
a[${STORE_SERVICE_ATTR}] > button::after {
	content: "";
	position: absolute;
	top: 50%;
	left: 50%;
	width: 24px;
	height: 24px;
	transform: translate(-50%, -50%);
	background: var(--sc-gate-dl-store-icon) center / contain no-repeat;
	pointer-events: none;
}
`;
	}

	function applyDefaultGeom(panel) {
		const saved = loadGeom();
		if (saved) {
			panel.style.width = `${saved.width}px`;
			panel.style.height = `${saved.height}px`;
			panel.style.left = `${saved.left}px`;
			panel.style.top = `${saved.top}px`;
			panel.style.right = 'auto';
			return;
		}
		const height = Math.min(
			Math.max(window.innerHeight - DEFAULT_GEOM.top - 12, 360),
			window.innerHeight - 24,
		);
		panel.style.width = `${DEFAULT_GEOM.width}px`;
		panel.style.height = `${height}px`;
		panel.style.top = `${DEFAULT_GEOM.top}px`;
		panel.style.right = `${DEFAULT_GEOM.right}px`;
		panel.style.left = 'auto';
	}

	function clampPanel(panel) {
		// display:none → zero rect; clamping then would snap to (0,0) and wipe position
		if (panel.hidden) return;
		const rect = panel.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const maxLeft = window.innerWidth - Math.min(rect.width, window.innerWidth);
		const maxTop =
			window.innerHeight - Math.min(rect.height, window.innerHeight);
		const left = Math.min(Math.max(0, rect.left), Math.max(0, maxLeft));
		const top = Math.min(Math.max(0, rect.top), Math.max(0, maxTop));
		panel.style.left = `${left}px`;
		panel.style.top = `${top}px`;
		panel.style.right = 'auto';
	}

	function enableDrag(panel) {
		const toolbar = panel.querySelector('.sc-gate-dl-toolbar');
		if (!toolbar || toolbar.dataset.dragBound) return;
		toolbar.dataset.dragBound = '1';

		let dragging = false;
		let startX = 0;
		let startY = 0;
		let origLeft = 0;
		let origTop = 0;

		toolbar.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			if (e.target.closest('a, button, select, label')) return;
			dragging = true;
			const rect = panel.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			origLeft = rect.left;
			origTop = rect.top;
			panel.style.left = `${origLeft}px`;
			panel.style.top = `${origTop}px`;
			panel.style.right = 'auto';
			toolbar.setPointerCapture(e.pointerId);
			e.preventDefault();
		});

		toolbar.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			panel.style.left = `${origLeft + (e.clientX - startX)}px`;
			panel.style.top = `${origTop + (e.clientY - startY)}px`;
		});

		const endDrag = (e) => {
			if (!dragging) return;
			dragging = false;
			try {
				toolbar.releasePointerCapture(e.pointerId);
			} catch {
				// ignore
			}
			clampPanel(panel);
			saveGeom(panel);
		};

		toolbar.addEventListener('pointerup', endDrag);
		toolbar.addEventListener('pointercancel', endDrag);
	}

	function enableEdgeResize(panel) {
		if (panel.dataset.resizeBound) return;
		panel.dataset.resizeBound = '1';

		for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
			const handle = document.createElement('div');
			handle.className = 'sc-gate-dl-rh';
			handle.dataset.dir = dir;
			panel.appendChild(handle);
		}

		let resizing = false;
		let dir = '';
		let startX = 0;
		let startY = 0;
		let startLeft = 0;
		let startTop = 0;
		let startW = 0;
		let startH = 0;

		panel.addEventListener('pointerdown', (e) => {
			const handle = e.target.closest?.('.sc-gate-dl-rh');
			if (!(handle instanceof HTMLElement) || e.button !== 0) return;
			e.preventDefault();
			e.stopPropagation();
			resizing = true;
			dir = handle.dataset.dir || '';
			const rect = panel.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			startLeft = rect.left;
			startTop = rect.top;
			startW = rect.width;
			startH = rect.height;
			panel.style.left = `${startLeft}px`;
			panel.style.top = `${startTop}px`;
			panel.style.right = 'auto';
			handle.setPointerCapture(e.pointerId);
		});

		panel.addEventListener('pointermove', (e) => {
			if (!resizing) return;
			const dx = e.clientX - startX;
			const dy = e.clientY - startY;
			let left = startLeft;
			let top = startTop;
			let width = startW;
			let height = startH;

			if (dir.includes('e')) width = startW + dx;
			if (dir.includes('s')) height = startH + dy;
			if (dir.includes('w')) {
				width = startW - dx;
				left = startLeft + dx;
			}
			if (dir.includes('n')) {
				height = startH - dy;
				top = startTop + dy;
			}

			if (width < MIN_PANEL_W) {
				if (dir.includes('w')) left = startLeft + startW - MIN_PANEL_W;
				width = MIN_PANEL_W;
			}
			if (height < MIN_PANEL_H) {
				if (dir.includes('n')) top = startTop + startH - MIN_PANEL_H;
				height = MIN_PANEL_H;
			}

			width = Math.min(width, window.innerWidth - 8);
			height = Math.min(height, window.innerHeight - 8);
			left = Math.min(Math.max(0, left), window.innerWidth - width);
			top = Math.min(Math.max(0, top), window.innerHeight - height);

			panel.style.left = `${left}px`;
			panel.style.top = `${top}px`;
			panel.style.width = `${width}px`;
			panel.style.height = `${height}px`;
		});

		const endResize = (e) => {
			if (!resizing) return;
			resizing = false;
			try {
				e.target.releasePointerCapture?.(e.pointerId);
			} catch {
				// ignore
			}
			clampPanel(panel);
			saveGeom(panel);
		};

		panel.addEventListener('pointerup', endResize);
		panel.addEventListener('pointercancel', endResize);
	}

	function buildWebuiSrc(trackUrl, embedded = false) {
		const params = new URLSearchParams({
			url: trackUrl,
			outputFormat: getOutputFormat(),
			browserMode: getBrowserMode(),
		});
		if (embedded) params.set('embedded', '1');
		return `${getWebuiBase()}/?${params.toString()}`;
	}

	function loadTrackIntoPanel(panel, trackUrl) {
		// Switching tracks cancels any in-flight job for the previous one
		if (panel.dataset.jobId) {
			void cancelActiveJob(panel);
		}
		panel.dataset.trackUrl = trackUrl;
		const iframeSrc = buildWebuiSrc(trackUrl, true);
		const tabSrc = buildWebuiSrc(trackUrl);
		const iframe = panel.querySelector('iframe');
		const openTab = panel.querySelector('.sc-gate-dl-open-tab');
		if (iframe) iframe.src = iframeSrc;
		if (openTab instanceof HTMLAnchorElement) openTab.href = tabSrc;
	}

	function getApiBase() {
		try {
			if (typeof GM_getValue === 'function') {
				const gm = GM_getValue(API_BASE_KEY, null);
				if (typeof gm === 'string' && gm.trim()) {
					return gm.replace(/\/$/, '');
				}
			}
		} catch {
			// ignore
		}
		try {
			const stored = localStorage.getItem(API_BASE_KEY)?.replace(/\/$/, '');
			if (stored) return stored;
		} catch {
			// ignore
		}
		try {
			return apiOriginFromWebui(getWebuiBase());
		} catch {
			return 'http://localhost:3000';
		}
	}

	async function cancelActiveJob(panel) {
		if (!panel) return;
		const jobId = panel.dataset.jobId;
		if (!jobId) return;

		const iframe = panel.querySelector('iframe');
		if (iframe?.contentWindow) {
			try {
				iframe.contentWindow.postMessage(
					{ source: 'sc-gate-dl-host', type: 'cancel' },
					new URL(getWebuiBase()).origin,
				);
			} catch {
				// ignore
			}
		}
		await requestJobCancel(jobId);
		delete panel.dataset.jobId;
	}

	function cancelJobOnHostUnload() {
		const panel = document.getElementById(PANEL_ID);
		const jobId = panel?.dataset.jobId;
		if (!jobId) return;
		void requestJobCancel(jobId);
		delete panel.dataset.jobId;
	}

	window.addEventListener('pagehide', cancelJobOnHostUnload);
	window.addEventListener('beforeunload', cancelJobOnHostUnload);

	async function closePanel() {
		window.clearTimeout(autoCloseTimer);
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		// Cancel via the GM bridge before tearing down the iframe — page fetch to
		// localhost is blocked by Private Network Access, and blanking the iframe
		// races the embedded WebUI's own unload cancel.
		const cancellation = cancelActiveJob(panel);
		await cancellation;
		const iframe = panel.querySelector('iframe');
		if (iframe) iframe.src = 'about:blank';
		delete panel.dataset.trackUrl;
		delete panel.dataset.jobId;
		panel.hidden = true;
	}

	function applyQueueGeom(el) {
		const saved = loadQueueGeom();
		if (saved) {
			el.style.width = `${saved.width}px`;
			el.style.left = `${saved.left}px`;
			el.style.top = `${saved.top}px`;
			return;
		}
		el.style.width = `${DEFAULT_QUEUE_GEOM.width}px`;
		el.style.left = `${DEFAULT_QUEUE_GEOM.left}px`;
		el.style.top = `${DEFAULT_QUEUE_GEOM.top}px`;
	}

	function clampQueue(el) {
		if (el.hidden) return;
		const rect = el.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const maxLeft = window.innerWidth - Math.min(rect.width, window.innerWidth);
		const maxTop =
			window.innerHeight - Math.min(rect.height, window.innerHeight);
		const left = Math.min(Math.max(0, rect.left), Math.max(0, maxLeft));
		const top = Math.min(Math.max(0, rect.top), Math.max(0, maxTop));
		el.style.left = `${left}px`;
		el.style.top = `${top}px`;
	}

	function enableQueueDrag(el) {
		const toolbar = el.querySelector('.sc-gate-dl-toolbar');
		if (!toolbar || toolbar.dataset.dragBound) return;
		toolbar.dataset.dragBound = '1';

		let dragging = false;
		let startX = 0;
		let startY = 0;
		let origLeft = 0;
		let origTop = 0;

		toolbar.addEventListener('pointerdown', (e) => {
			if (e.button !== 0) return;
			if (e.target.closest('button')) return;
			dragging = true;
			const rect = el.getBoundingClientRect();
			startX = e.clientX;
			startY = e.clientY;
			origLeft = rect.left;
			origTop = rect.top;
			toolbar.setPointerCapture(e.pointerId);
			e.preventDefault();
		});

		toolbar.addEventListener('pointermove', (e) => {
			if (!dragging) return;
			el.style.left = `${origLeft + (e.clientX - startX)}px`;
			el.style.top = `${origTop + (e.clientY - startY)}px`;
		});

		const endDrag = (e) => {
			if (!dragging) return;
			dragging = false;
			try {
				toolbar.releasePointerCapture(e.pointerId);
			} catch {
				// ignore
			}
			clampQueue(el);
			saveQueueGeom(el);
		};

		toolbar.addEventListener('pointerup', endDrag);
		toolbar.addEventListener('pointercancel', endDrag);
	}

	function clearQueue() {
		downloadQueue.length = 0;
		renderQueue();
	}

	function removeFromQueue(index) {
		if (index < 0 || index >= downloadQueue.length) return;
		downloadQueue.splice(index, 1);
		renderQueue();
	}

	function enqueueDownload(trackUrl) {
		if (downloadQueue.some((item) => item.url === trackUrl)) return;
		const panel = document.getElementById(PANEL_ID);
		if (panel && !panel.hidden && panel.dataset.trackUrl === trackUrl) return;
		downloadQueue.push({
			url: trackUrl,
			label: trackLabelFromUrl(trackUrl),
		});
		renderQueue();
	}

	async function startNextFromQueue() {
		window.clearTimeout(autoCloseTimer);
		const next = downloadQueue.shift();
		renderQueue();
		if (!next) return false;
		const opened = await openDownload(next.url);
		if (!opened) {
			downloadQueue.unshift(next);
			renderQueue();
			return false;
		}
		return true;
	}

	async function startQueuedAt(index) {
		if (index < 0 || index >= downloadQueue.length) return;
		const [item] = downloadQueue.splice(index, 1);
		renderQueue();
		if (!item) return;
		const panel = document.getElementById(PANEL_ID);
		// Active job in progress — only promote to next in line
		if (panel && !panel.hidden && panel.dataset.jobId) {
			downloadQueue.unshift(item);
			renderQueue();
			return;
		}
		const opened = await openDownload(item.url);
		if (!opened) {
			downloadQueue.splice(Math.min(index, downloadQueue.length), 0, item);
			renderQueue();
		}
	}

	function renderQueue() {
		ensureStyles();
		let el = document.getElementById(QUEUE_ID);
		if (downloadQueue.length === 0) {
			if (el) el.hidden = true;
			return;
		}

		if (!el) {
			el = document.createElement('div');
			el.id = QUEUE_ID;
			el.setAttribute('role', 'dialog');
			el.setAttribute('aria-modal', 'false');
			el.setAttribute('aria-label', 'sc-gate-dl download queue');
			el.innerHTML = `
				<div class="sc-gate-dl-toolbar">
					<span class="sc-gate-dl-queue-title">Queue</span>
					<button type="button" class="sc-gate-dl-close" aria-label="Clear queue" title="Clear queue">×</button>
				</div>
				<ul class="sc-gate-dl-queue-list"></ul>
			`;
			el.querySelector('.sc-gate-dl-close')?.addEventListener('click', () => {
				clearQueue();
			});
			document.documentElement.appendChild(el);
			applyQueueGeom(el);
			enableQueueDrag(el);
		}

		const title = el.querySelector('.sc-gate-dl-queue-title');
		if (title) title.textContent = `Queue (${downloadQueue.length})`;

		const list = el.querySelector('.sc-gate-dl-queue-list');
		if (!(list instanceof HTMLElement)) return;
		list.replaceChildren();
		downloadQueue.forEach((item, index) => {
			const li = document.createElement('li');
			li.className = 'sc-gate-dl-queue-item';

			const labelBtn = document.createElement('button');
			labelBtn.type = 'button';
			labelBtn.className = 'sc-gate-dl-queue-label';
			labelBtn.title = item.url;
			labelBtn.textContent = item.label;
			labelBtn.addEventListener('click', () => startQueuedAt(index));

			const removeBtn = document.createElement('button');
			removeBtn.type = 'button';
			removeBtn.className = 'sc-gate-dl-queue-remove';
			removeBtn.setAttribute('aria-label', 'Remove from queue');
			removeBtn.title = 'Remove';
			removeBtn.textContent = '×';
			removeBtn.addEventListener('click', () => removeFromQueue(index));

			li.append(labelBtn, removeBtn);
			list.appendChild(li);
		});

		el.hidden = false;
		clampQueue(el);
	}

	async function openDownload(trackUrl) {
		if (getAlwaysOpenTab()) {
			const bases = getWebuiBases();
			const cacheHit =
				activeWebuiBase &&
				Date.now() - activeWebuiBaseAt < WEBUI_RESOLVE_CACHE_MS &&
				bases.includes(activeWebuiBase);
			if (cacheHit) {
				window.open(buildWebuiSrc(trackUrl), '_blank', 'noopener,noreferrer');
				return true;
			}
			// Keep the window handle (no noopener) so we can navigate after probing.
			const tab = window.open('about:blank', '_blank');
			if (!tab) {
				window.alert(
					'sc-gate-dl: popup blocked. Allow popups for SoundCloud or disable always-open-in-tab.',
				);
				return false;
			}
			try {
				await resolveWebuiBase();
				tab.location.href = buildWebuiSrc(trackUrl);
				return true;
			} catch (error) {
				tab.close();
				window.alert(
					error instanceof Error
						? error.message
						: 'No configured sc-gate-dl server is reachable.',
				);
				return false;
			}
		}
		try {
			await resolveWebuiBase();
		} catch (error) {
			window.alert(
				error instanceof Error
					? error.message
					: 'No configured sc-gate-dl server is reachable.',
			);
			return false;
		}
		if (isPanelBusy()) {
			enqueueDownload(trackUrl);
			return true;
		}
		openPanel(trackUrl);
		return true;
	}

	function requestDownload(trackUrl) {
		void openDownload(trackUrl);
	}

	function finishCurrentAndAdvance() {
		if (downloadQueue.length > 0) {
			void startNextFromQueue();
			return;
		}
		void closePanel();
	}

	let autoCloseTimer = 0;

	function releaseRemotePointer() {
		const iframe = document.getElementById(PANEL_ID)?.querySelector('iframe');
		if (!iframe?.contentWindow) return;
		try {
			iframe.contentWindow.postMessage(
				{ source: 'sc-gate-dl-host', type: 'release-remote-pointer' },
				new URL(getWebuiBase()).origin,
			);
		} catch {
			// The iframe may be navigating or already closed.
		}
	}

	window.addEventListener('pointerup', releaseRemotePointer, true);
	window.addEventListener('blur', releaseRemotePointer);

	window.addEventListener('message', (event) => {
		const data = event.data;
		if (!data || data.source !== 'sc-gate-dl') return;
		const panel = document.getElementById(PANEL_ID);
		let webuiOrigin;
		try {
			webuiOrigin = new URL(getWebuiBase()).origin;
		} catch {
			return;
		}
		if (event.origin !== webuiOrigin) return;
		if (event.source !== panel?.querySelector('iframe')?.contentWindow) return;

		if (data.type === 'job' && data.jobId && panel) {
			panel.dataset.jobId = String(data.jobId);
			return;
		}
		if ((data.type === 'cancelled' || data.type === 'ready') && panel) {
			delete panel.dataset.jobId;
			return;
		}

		if (data.type === 'file-download') {
			if (panel) delete panel.dataset.jobId;
			if (!getAutoClose()) return;
			window.clearTimeout(autoCloseTimer);
			autoCloseTimer = window.setTimeout(() => {
				finishCurrentAndAdvance();
			}, 600);
		} else if (data.type === 'new-download') {
			if (panel) delete panel.dataset.jobId;
			if (downloadQueue.length > 0) {
				startNextFromQueue();
				return;
			}
			if (getAutoClose()) void closePanel();
		}
	});

	function openPanel(trackUrl) {
		window.clearTimeout(autoCloseTimer);
		ensureStyles();
		let panel = document.getElementById(PANEL_ID);
		if (!panel) {
			panel = document.createElement('div');
			panel.id = PANEL_ID;
			panel.hidden = true;
			panel.setAttribute('role', 'dialog');
			panel.setAttribute('aria-modal', 'false');
			panel.setAttribute('aria-label', 'sc-gate-dl');
			const format = getOutputFormat();
			const browserMode = getBrowserMode();
			panel.innerHTML = `
				<div class="sc-gate-dl-toolbar">
					<span>sc-gate-dl · <a class="sc-gate-dl-open-tab" href="#" target="_blank" rel="noopener">open in tab</a></span>
					<span class="sc-gate-dl-actions">
						<button type="button" class="sc-gate-dl-server" aria-label="Configure server" title="Configure server">
							<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.14 12.94a7.8 7.8 0 0 0 .05-.94 7.8 7.8 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.62-.94L14.39 2.8a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.52a7.3 7.3 0 0 0-1.62.94L5.18 5.3a.5.5 0 0 0-.61.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.8 7.8 0 0 0-.05.94c0 .32.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.52a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.52a7.3 7.3 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
						</button>
						<label>
							<select class="sc-gate-dl-browser-mode" aria-label="Browser mode" title="Browser mode">
								<option value="headless"${browserMode === 'headless' ? ' selected' : ''}>Headless</option>
								<option value="xvfb"${browserMode === 'xvfb' ? ' selected' : ''}>Xvfb</option>
								<option value="headed"${browserMode === 'headed' ? ' selected' : ''}>Visible</option>
							</select>
						</label>
						<label>
							<select class="sc-gate-dl-format" aria-label="Output format" title="Output format">
								<option value="mp3-320"${format === 'mp3-320' ? ' selected' : ''}>MP3 320</option>
								<option value="flac"${format === 'flac' ? ' selected' : ''}>FLAC</option>
								<option value="original"${format === 'original' ? ' selected' : ''}>Original</option>
							</select>
						</label>
						<button type="button" class="sc-gate-dl-close" aria-label="Close" title="Close">×</button>
					</span>
				</div>
				<iframe title="sc-gate-dl" allow="clipboard-read; clipboard-write"></iframe>
			`;
			panel
				.querySelector('.sc-gate-dl-close')
				?.addEventListener('click', () => {
					void closePanel();
				});
			panel
				.querySelector('.sc-gate-dl-open-tab')
				?.addEventListener('click', () => {
					// Let the target=_blank navigation happen, then tear down this job.
					void closePanel();
				});
			panel
				.querySelector('.sc-gate-dl-server')
				?.addEventListener('click', configureWebuiBase);
			panel
				.querySelector('.sc-gate-dl-browser-mode')
				?.addEventListener('change', (e) => {
					const select = e.target;
					if (!(select instanceof HTMLSelectElement)) return;
					setBrowserMode(select.value);
				});
			panel
				.querySelector('.sc-gate-dl-format')
				?.addEventListener('change', (e) => {
					const select = e.target;
					if (!(select instanceof HTMLSelectElement)) return;
					setOutputFormat(select.value);
				});
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !panel.hidden) void closePanel();
			});
			document.documentElement.appendChild(panel);
			applyDefaultGeom(panel);
			enableDrag(panel);
			enableEdgeResize(panel);
		}

		loadTrackIntoPanel(panel, trackUrl);
		panel.hidden = false;
		clampPanel(panel);
	}

	function bindClick(el, trackUrl) {
		el.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			hideTooltip();
			const url = resolveTrackUrl(el) || trackUrl;
			if (!url) {
				alert('sc-gate-dl: could not resolve a SoundCloud track URL here.');
				return;
			}
			requestDownload(url);
		});
	}

	function makeClassicControl(trackUrl) {
		// Mirror purchaseLink__container: SC tooltips key off aria-describedby + hover
		const wrap = document.createElement('div');
		wrap.setAttribute(WRAP_ATTR, 'classic');
		wrap.className = 'purchaseLink__container';
		wrap.setAttribute('aria-describedby', TOOLTIP_ID);
		wrap.setAttribute('aria-label', TOOLTIP_LABEL);

		const btn = document.createElement('a');
		btn.href = '#';
		btn.setAttribute(BUTTON_ATTR, 'classic');
		btn.className =
			'soundActions__purchaseLink sc-button sc-button-tertiary sc-button-responsive';
		btn.setAttribute('aria-label', TOOLTIP_LABEL);
		btn.setAttribute('aria-describedby', TOOLTIP_ID);
		btn.innerHTML = `<span class="sc-button-label"><div>${DOWNLOAD_ICON_16}</div></span>`;
		bindClick(btn, trackUrl);
		wrap.appendChild(btn);
		bindTooltip(wrap);
		return wrap;
	}

	function makeMuiControl(trackUrl, templateBtn) {
		const wrap = document.createElement('div');
		wrap.setAttribute(WRAP_ATTR, 'mui');
		wrap.className = 'MuiBox-root mui-0';
		wrap.setAttribute('aria-label', TOOLTIP_LABEL);

		const btn = document.createElement('button');
		btn.type = 'button';
		btn.setAttribute(BUTTON_ATTR, 'mui');
		btn.setAttribute('aria-label', TOOLTIP_LABEL);
		btn.className =
			templateBtn?.className ||
			'MuiButtonBase-root MuiIconButton-root MuiIconButton-colorContrast MuiIconButton-sizeMedium';
		btn.innerHTML = DOWNLOAD_ICON_24;
		bindClick(btn, trackUrl);
		wrap.appendChild(btn);
		bindTooltip(wrap);
		return wrap;
	}

	/**
	 * Classic: cart sits in a 40px `.purchaseLink__container` inside an anonymous
	 * wrapper under `.soundActions` (flex row). Insert AFTER that wrapper.
	 */
	function classicAnchorPoint(el) {
		const container =
			el.closest?.('.purchaseLink__container') ||
			(el.classList?.contains('purchaseLink__container') ? el : null);
		if (!container) {
			return (
				el.closest?.('a.soundActions__purchaseLink, a.sc-button-buy') || el
			);
		}
		const actions = container.closest('.soundActions');
		const wrap = container.parentElement;
		if (actions && wrap && wrap.parentElement === actions && wrap !== actions) {
			return wrap;
		}
		// Container is already a direct child of .soundActions
		if (actions && container.parentElement === actions) return container;
		return container;
	}

	function injectClassic(el) {
		if (isOurNode(el)) return;
		if (isPlaylistOrAlbumContext(el)) return;
		const trackUrl = resolveTrackUrl(el);
		// Insert as sibling AFTER the cart cluster inside .soundActions.
		// Do not append inside the cart wrapper — it is ~16px tall and clips the icon.
		const anchorPoint = classicAnchorPoint(el);
		if (isOurNode(anchorPoint) || alreadyInjectedNear(anchorPoint)) return;
		const actions =
			anchorPoint.closest?.('.soundActions') || anchorPoint.parentElement;
		if (actions instanceof HTMLElement) {
			actions.style.overflow = 'visible';
			actions.style.alignItems = 'center';
		}
		anchorPoint.insertAdjacentElement('afterend', makeClassicControl(trackUrl));
	}

	function isMuiBuyAnchor(el) {
		if (!(el instanceof HTMLAnchorElement)) return false;
		if (isOurNode(el)) return false;
		// Never treat classic SC purchase links as MUI (caused duplicate under-cart inject)
		if (
			el.closest(
				'.purchaseLink__container, .soundActions, .sound__soundActions',
			)
		) {
			return false;
		}
		if (el.classList.contains('soundActions__purchaseLink')) return false;
		const label = el.getAttribute('aria-label') || '';
		if (!/buy|store|purchase|free\s*download/i.test(label)) return false;
		return !!el.querySelector('button.MuiIconButton-root, svg');
	}

	function injectMui(buyAnchor) {
		if (!isMuiBuyAnchor(buyAnchor)) return;
		if (isPlaylistOrAlbumContext(buyAnchor)) return;
		if (alreadyInjectedNear(buyAnchor)) return;
		const templateBtn = buyAnchor.querySelector('button.MuiIconButton-root');
		const trackUrl = resolveTrackUrl(buyAnchor);
		buyAnchor.insertAdjacentElement(
			'afterend',
			makeMuiControl(trackUrl, templateBtn),
		);
	}

	function injectMuiWithoutBuy(moreButton) {
		if (!(moreButton instanceof HTMLButtonElement)) return;
		if (isOurNode(moreButton)) return;
		if (!isMuiTrackMoreButton(moreButton)) return;
		if (isPlaylistOrAlbumContext(moreButton)) return;
		if (alreadyInjectedNear(moreButton)) return;
		const trackUrl = pageTrackUrl();
		if (!trackUrl) return;
		moreButton.insertAdjacentElement(
			'beforebegin',
			makeMuiControl(trackUrl, moreButton),
		);
	}

	/**
	 * MUI listen-page overflow control. Prefer the stable id prefix — aria-labels
	 * are localized ("More actions" / "Mehr Aktionen", etc.).
	 * Comment ellipsis and related-track menus reuse the same id prefix and can
	 * sit inside the Track header section, so id-only matching is not enough.
	 */
	function isMuiTrackMoreButton(el) {
		if (!(el instanceof HTMLButtonElement)) return false;
		if (!el.classList.contains('MuiIconButton-root')) return false;
		// Comments: variant=ghost + colorPrimary, inside ul[aria-label="Comments"].
		// Related tracks: sizeSmall, inside the track sidebar aside.
		if (el.getAttribute('variant') === 'ghost') return false;
		if (el.classList.contains('MuiIconButton-colorPrimary')) return false;
		if (el.classList.contains('MuiIconButton-sizeSmall')) return false;
		if (el.closest('ul[aria-label], aside')) return false;
		const id = el.id || '';
		if (id.startsWith('desktop-menu-button-')) return true;
		// Fallback if SC drops the id: last action with a menu popup.
		return (
			el.getAttribute('aria-haspopup') === 'true' &&
			!!el.closest('section[aria-label]') &&
			/track[- ]?header/i.test(
				el.closest('section[aria-label]')?.getAttribute('aria-label') || '',
			)
		);
	}

	function isClassicPurchase(el) {
		if (!(el instanceof Element) || isOurNode(el)) return false;
		if (el.classList.contains('purchaseLink__container')) return true;
		if (el.classList.contains('soundActions__purchaseLink')) return true;
		if (el.classList.contains('sc-button-buy')) return true;
		return false;
	}

	function scan(root = document) {
		const scope =
			root instanceof Element || root === document ? root : document;

		// Drop buttons that landed on playlist/album cards (e.g. before class hydrated)
		for (const wrap of scope.querySelectorAll?.(`[${WRAP_ATTR}]`) || []) {
			if (isPlaylistOrAlbumContext(wrap)) wrap.remove();
		}

		// Brand supported purchase links without loading third-party icon assets.
		for (const anchor of scope.querySelectorAll?.(
			'a.soundActions__purchaseLink, a.sc-button-buy, a[aria-label="Buy This Track"], a[target="_blank"][aria-label]',
		) || []) {
			const label = anchor.getAttribute('aria-label') || '';
			if (
				!anchor.classList.contains('soundActions__purchaseLink') &&
				!anchor.classList.contains('sc-button-buy') &&
				!/buy|store|purchase|free\s*download/i.test(label)
			) {
				continue;
			}
			decorateStoreLink(anchor);
		}

		// Classic layout only — one control per purchaseLink__container
		const containers =
			scope.querySelectorAll?.('.purchaseLink__container') || [];
		for (const el of containers) {
			if (isOurNode(el)) continue;
			injectClassic(el);
		}
		// Orphan classic purchase anchors without container (rare)
		for (const el of scope.querySelectorAll?.(
			'a.soundActions__purchaseLink, a.sc-button-buy',
		) || []) {
			if (isOurNode(el)) continue;
			if (el.closest('.purchaseLink__container')) continue;
			if (isClassicPurchase(el)) injectClassic(el);
		}

		// MUI logged-in listen page only
		for (const el of scope.querySelectorAll?.(
			'a[aria-label="Buy This Track"], a[target="_blank"][aria-label]',
		) || []) {
			injectMui(el);
		}
		// Tracks without a purchase link still have the action row's More button.
		// id prefix is language-stable; aria-labels are not.
		for (const el of scope.querySelectorAll?.(
			'button[id^="desktop-menu-button-"].MuiIconButton-root, section[aria-label] button.MuiIconButton-root[aria-haspopup="true"]',
		) || []) {
			if (!isMuiTrackMoreButton(el)) continue;
			injectMuiWithoutBuy(el);
		}
	}

	ensureStyles();
	scan();
	ensureFeedNavigator();

	document.addEventListener(
		'click',
		(event) => {
			if (!isFeedPage() || !(event.target instanceof Element)) return;
			const playControl = event.target.closest(
				'button.playControl, button.sc-button-play, button.sc-button-pause, .soundTitle__playButton, .sound__coverArt .playButton',
			);
			const card = playControl?.closest(FEED_CARD_SELECTOR);
			const cardUrl = card ? trackUrlFromCard(playControl) : null;
			const outsidePlaybackSelection = Boolean(
				!card &&
					event.target.closest('.playControls, .playbackSoundBadge, .queue'),
			);
			feedPlaybackOriginUrl = updateFeedPlaybackOrigin(
				feedPlaybackOriginUrl,
				cardUrl,
				outsidePlaybackSelection,
			);
			if (card) {
				saveFeedCheckpointFromCard(card, cardUrl);
			}
		},
		true,
	);

	let scanTimer = 0;
	function scheduleScan() {
		if (scanTimer) return;
		scanTimer = window.setTimeout(() => {
			scanTimer = 0;
			scan();
		}, 0);
	}

	const observer = new MutationObserver((mutations) => {
		let shouldScan = false;
		for (const m of mutations) {
			if (m.type === 'attributes') {
				shouldScan = true;
				break;
			}
			for (const node of m.addedNodes) {
				if (!(node instanceof Element)) continue;
				if (isOurNode(node)) continue;
				shouldScan = true;
				break;
			}
			if (shouldScan) break;
		}
		if (shouldScan) scheduleScan();
	});
	observer.observe(document.documentElement, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['href'],
	});

	let lastHref = location.href;
	setInterval(() => {
		if (location.href !== lastHref) {
			lastHref = location.href;
			scan();
			ensureFeedNavigator();
		}
		recordPlayingFeedTrack();
	}, 1000);

	registerMenuCommands();

	console.info(
		`[sc-gate-dl] ready — Web UI: ${getWebuiBases().join(' → ')} (run \`bun webui\`). Override with localStorage key "${WEBUI_BASE_KEY}" (one address per line).`,
	);
})();
