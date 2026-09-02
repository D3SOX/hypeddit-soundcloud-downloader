import { describe, expect, test } from 'bun:test';

type UpdateFeedPlaybackOrigin = (
	currentOrigin: string | null,
	feedCardUrl: string | null,
	outsidePlaybackSelection: boolean,
) => string | null;

type StoreServiceForUrl = (href: string) => string | null;
type NormalizeWebuiBase = (value: string) => string;
type ParseWebuiBases = (
	raw: string | null | undefined,
	fallback?: string,
	options?: { strict?: boolean },
) => string[];
type ApiOriginFromWebui = (webuiBase: string) => string;

const source = await Bun.file(
	new URL('./sc-gate-dl.user.js', import.meta.url),
).text();

describe('userscript scope', () => {
	test('runs controls inside MUI track watch frames', () => {
		expect(source).not.toMatch(/^\/\/ @noframes\s*$/m);
		const shouldRunInDocument = extractHelper<
			(isTopLevel: boolean, pathname: string) => boolean
		>(
			'\tfunction shouldRunInDocument(',
			'\n\n\tif (!shouldRunInDocument(',
			'shouldRunInDocument',
		);
		expect(shouldRunInDocument(false, '/n/reesemusicofficial/kisses')).toBe(
			true,
		);
		expect(shouldRunInDocument(false, '/n/artist/track/s-secret')).toBe(true);
	});

	test('keeps unrelated frames and frame menu commands disabled', () => {
		const shouldRunInDocument = extractHelper<
			(isTopLevel: boolean, pathname: string) => boolean
		>(
			'\tfunction shouldRunInDocument(',
			'\n\n\tif (!shouldRunInDocument(',
			'shouldRunInDocument',
		);
		expect(shouldRunInDocument(true, '/feed')).toBe(true);
		expect(shouldRunInDocument(false, '/feed')).toBe(false);
		expect(shouldRunInDocument(false, '/n/artist/sets/playlist')).toBe(false);
		expect(source).toContain('if (IS_TOP_LEVEL) registerMenuCommands();');
	});
});

function extractHelper<T>(
	startMarker: string,
	endMarker: string,
	name: string,
): T {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start);
	if (start < 0 || end < 0) throw new Error(`${name} helper not found`);
	const helperSource = source.slice(start, end).trim();
	return Function(`"use strict"; ${helperSource}; return ${name};`)() as T;
}

function extractWebuiHelpers(): {
	normalizeWebuiBase: NormalizeWebuiBase;
	parseWebuiBases: ParseWebuiBases;
	apiOriginFromWebui: ApiOriginFromWebui;
} {
	const normalizeStart = source.indexOf('\tfunction normalizeWebuiBase(');
	const parseEnd = source.indexOf('\n\n\tfunction getWebuiBases(', normalizeStart);
	const apiStart = source.indexOf('\tfunction apiOriginFromWebui(');
	const apiEnd = source.indexOf(
		'\n\n\tfunction abortSignalTimeout(',
		apiStart,
	);
	if (normalizeStart < 0 || parseEnd < 0 || apiStart < 0 || apiEnd < 0) {
		throw new Error('webui helpers not found');
	}
	return Function(
		`"use strict";
		const DEFAULT_WEBUI_BASE = 'http://localhost:4321';
		${source.slice(normalizeStart, parseEnd)}
		${source.slice(apiStart, apiEnd)}
		return { normalizeWebuiBase, parseWebuiBases, apiOriginFromWebui };`,
	)() as {
		normalizeWebuiBase: NormalizeWebuiBase;
		parseWebuiBases: ParseWebuiBases;
		apiOriginFromWebui: ApiOriginFromWebui;
	};
}

const updateFeedPlaybackOrigin = extractHelper<UpdateFeedPlaybackOrigin>(
	'\tfunction updateFeedPlaybackOrigin(',
	'\n\n\tlet lastRecordedPlayingUrl',
	'updateFeedPlaybackOrigin',
);
const storeServiceForUrl = extractHelper<StoreServiceForUrl>(
	'\tfunction storeServiceForUrl(',
	'\n\n\tfunction decorateStoreLink(',
	'storeServiceForUrl',
);
const { normalizeWebuiBase, parseWebuiBases, apiOriginFromWebui } =
	extractWebuiHelpers();

describe('feed playback origin', () => {
	test('clears feed provenance when another track is selected outside the feed', () => {
		expect(
			updateFeedPlaybackOrigin('https://soundcloud.com/feed/track', null, true),
		).toBeNull();
	});

	test('preserves feed provenance through unrelated page clicks', () => {
		const origin = 'https://soundcloud.com/feed/track';
		expect(updateFeedPlaybackOrigin(origin, null, false)).toBe(origin);
	});
});

describe('store link branding', () => {
	test('recognizes MyPressKit gate URLs', () => {
		expect(
			storeServiceForUrl(
				'https://www.mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit',
			),
		).toBe('mypresskit');
		expect(
			storeServiceForUrl(
				'https://mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit/',
			),
		).toBe('mypresskit');
	});

	test('rejects non-gate MyPressKit URLs', () => {
		expect(storeServiceForUrl('https://www.mypresskit.info/')).toBeNull();
		expect(
			storeServiceForUrl('https://www.mypresskit.info/marketplace'),
		).toBeNull();
		expect(storeServiceForUrl('https://example.com/gate/foo')).toBeNull();
	});
});

describe('Web UI preferences', () => {
	test('normalizes HTTP(S) server addresses', () => {
		expect(normalizeWebuiBase(' http://192.168.178.57:4321/ ')).toBe(
			'http://192.168.178.57:4321',
		);
		expect(normalizeWebuiBase('https://downloads.example.com/?old=1#top')).toBe(
			'https://downloads.example.com',
		);
		expect(() => normalizeWebuiBase('ftp://downloads.example.com')).toThrow();
	});

	test('parses multiple server addresses in order', () => {
		expect(
			parseWebuiBases(
				'http://192.168.178.57:4321\nhttp://100.64.0.1:8123/',
			),
		).toEqual([
			'http://192.168.178.57:4321',
			'http://100.64.0.1:8123',
		]);
		expect(
			parseWebuiBases(
				'http://192.168.178.57:4321, http://192.168.178.57:4321, http://100.64.0.1:8123',
			),
		).toEqual([
			'http://192.168.178.57:4321',
			'http://100.64.0.1:8123',
		]);
		expect(parseWebuiBases('')).toEqual(['http://localhost:4321']);
		expect(
			parseWebuiBases('http://ok:4321\nftp://bad\nhttp://also:8123', undefined, {
				strict: false,
			}),
		).toEqual(['http://ok:4321', 'http://also:8123']);
		expect(() =>
			parseWebuiBases('http://ok:4321\nftp://bad', undefined, { strict: true }),
		).toThrow();
	});

	test('maps Web UI addresses to API origins', () => {
		expect(apiOriginFromWebui('http://192.168.178.57:4321')).toBe(
			'http://192.168.178.57:3000',
		);
		expect(apiOriginFromWebui('http://100.64.0.1:8123')).toBe(
			'http://100.64.0.1:8123',
		);
	});

	test('offers server configuration without developer tools', () => {
		expect(source).toContain("GM_registerMenuCommand('Configure server…'");
		expect(source).toContain('class="sc-gate-dl-server"');
		expect(source).toContain('sc-gate-dl-server-dialog');
		expect(source).toContain('resolveWebuiBase');
		expect(source).toContain('bindBackdropDismiss');
		expect(source).toContain('GM_xmlhttpRequest');
		expect(source).toContain('@connect      *');
	});

	test('offers a remembered always-open-in-tab mode', () => {
		expect(source).toContain('sc-gate-dl-always-open-tab');
		expect(source).toContain('Always open downloads in new tab:');
		expect(source).toContain(
			"window.open(buildWebuiSrc(trackUrl), '_blank', 'noopener,noreferrer')",
		);
	});

	test('passes the remembered browser mode through the deep link', () => {
		expect(source).toContain('browserMode: getBrowserMode()');
		expect(source).toContain('class="sc-gate-dl-browser-mode"');
		expect(source).toContain("GM_registerMenuCommand('Choose browser mode…'");
	});

	test('releases remote pointer capture when mouseup happens outside iframe', () => {
		expect(source).toContain("type: 'release-remote-pointer'");
		expect(source).toContain(
			"window.addEventListener('pointerup', releaseRemotePointer, true)",
		);
	});

	test('cancels active jobs via GM bridge on panel close and host unload', () => {
		expect(source).toContain('function requestJobCancel(jobId)');
		expect(source).toContain('gmXmlHttpRequest({');
		expect(source).toContain("method: 'POST'");
		expect(source).toContain(
			"window.addEventListener('pagehide', cancelJobOnHostUnload)",
		);
		expect(source).toContain(
			"window.addEventListener('beforeunload', cancelJobOnHostUnload)",
		);
		expect(source).toContain('await cancellation');
		expect(source).toContain("iframe.src = 'about:blank'");
		const cancelIdx = source.indexOf('await cancellation');
		const blankIdx = source.indexOf("iframe.src = 'about:blank'");
		expect(cancelIdx).toBeGreaterThan(-1);
		expect(blankIdx).toBeGreaterThan(cancelIdx);
	});
});

describe('MUI track header inject', () => {
	test('finds MUI more button via stable id, not localized aria-label', () => {
		expect(source).toContain('function isMuiTrackMoreButton(el)');
		expect(source).toContain("id.startsWith('desktop-menu-button-')");
		expect(source).toContain('[id^="desktop-menu-button-"]');
		expect(source).toContain("getAttribute('aria-haspopup') === 'true'");
		expect(source).toContain('/track[- ]?header/i');
		expect(source).not.toContain("label === 'More menu'");
		expect(source).not.toContain("label === 'More actions'");
		expect(source).toContain('injectMuiWithoutBuy(el)');
	});

	test('does not treat comment or related-track menus as the track overflow', () => {
		expect(source).toContain("getAttribute('variant') === 'ghost'");
		expect(source).toContain('MuiIconButton-colorPrimary');
		expect(source).toContain('MuiIconButton-sizeSmall');
		expect(source).toContain('ul[aria-label], aside');
	});

	test('hides stuck tooltips on scroll and pointer move away', () => {
		expect(source).toContain('function startTooltipTracking()');
		expect(source).toContain("document.addEventListener('scroll', hideTooltip, true)");
		expect(source).toContain(
			"document.addEventListener('pointermove', onTooltipPointerMove, true)",
		);
		expect(source).toContain('pointerenter');
		expect(source).toContain('pointerleave');
	});

	test('animates tooltips and uses MUI styling on MUI controls', () => {
		expect(source).toContain('sc-gate-dl-tip-visible');
		expect(source).toContain('sc-gate-dl-tip-mui');
		expect(source).toContain('sc-gate-dl-tip-classic');
		expect(source).toContain('background: #191919');
		expect(source).toContain('border: 1px solid #3a3a3a');
		expect(source).toContain('color: #f8f8f8');
		expect(source).toContain('400 11px/1.4');
		expect(source).toContain('scale(0.75)');
		expect(source).toContain('TOOLTIP_ENTER_ANIM_MS_MUI');
		expect(source).toContain('sc-gate-dl-tip-measure');
		expect(source).not.toContain('color: #b6b6b6');
		expect(source).toContain(
			'// Classic feed tooltips (Buy Link, etc.) open below the control.',
		);
	});
});
