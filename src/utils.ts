import crypto from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookpath } from 'find-bin';
import type { Cookie, CookieData } from 'puppeteer';
import type { SoundcloudTrack } from 'soundcloud.ts';
import packageJson from '../package.json' with { type: 'json' };
import {
	normalizeDirectDownloadParsedUrl,
	urlLooksLikeDirectDownload,
} from './directLinkRules';
import { safeFetch } from './safeOutboundUrl';
import type { LocalCookieData, Metadata } from './types';

export const REPO_URL = packageJson.repository.url;

export async function getFfmpegBin() {
	const ffmpegBin = await lookpath('ffmpeg');
	if (!ffmpegBin) {
		throw new Error(
			'ffmpeg is not installed. Please make sure it is in your PATH.',
		);
	}
	return ffmpegBin;
}

export async function getFfprobeBin() {
	const ffprobeBin = await lookpath('ffprobe');
	if (!ffprobeBin) {
		throw new Error(
			'ffprobe is not installed. Please make sure it is in your PATH.',
		);
	}
	return ffprobeBin;
}

export async function timeout(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull a DataDome / captcha-delivery challenge URL out of an API error body. */
export function extractCaptchaDeliveryUrl(body: string): string | undefined {
	try {
		const json = JSON.parse(body) as { url?: unknown };
		if (
			typeof json.url === 'string' &&
			/captcha-delivery\.com/i.test(json.url)
		) {
			return json.url;
		}
	} catch {
		// not JSON
	}
	const match = body.match(
		/https?:\/\/geo\.captcha-delivery\.com\/captcha\/[^"\\\s]+/i,
	);
	return match?.[0]?.replace(/\\u0026/g, '&');
}

/**
 * Parse DataDome `/captcha/check` JSON: `{ "cookie": "datadome=...; Domain=.soundcloud.com; ..." }`
 */
export function parseDatadomeCheckCookie(body: string): {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
} | null {
	try {
		const json = JSON.parse(body) as { cookie?: unknown };
		if (typeof json.cookie !== 'string' || !json.cookie.includes('datadome=')) {
			return null;
		}
		const parts = json.cookie.split(';').map((p) => p.trim());
		const nameValue = parts[0];
		if (!nameValue) return null;
		const eq = nameValue.indexOf('=');
		if (eq < 0) return null;
		const name = nameValue.slice(0, eq);
		const value = nameValue.slice(eq + 1);
		let domain = '.soundcloud.com';
		let path = '/';
		let secure = true;
		for (const attr of parts.slice(1)) {
			const sep = attr.indexOf('=');
			const k = (sep >= 0 ? attr.slice(0, sep) : attr).trim();
			const v = sep >= 0 ? attr.slice(sep + 1).trim() : '';
			if (/^domain$/i.test(k) && v) domain = v;
			if (/^path$/i.test(k) && v) path = v;
			if (/^secure$/i.test(k)) secure = true;
		}
		return { name, value, domain, path, secure };
	} catch {
		return null;
	}
}

export async function loadCookies(filename: string): Promise<CookieData[]> {
	const file = Bun.file(filename);
	if (!(await file.exists())) return [];
	const text = (await file.text()).trim();
	if (!text) return [];
	const cookiesData = JSON.parse(text) as LocalCookieData[];
	return cookiesData.map((cookie) => {
		const puppeteerCookie: CookieData = {
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path || '/',
		};

		if (cookie.expirationDate) {
			puppeteerCookie.expires = cookie.expirationDate;
		}
		if (cookie.httpOnly !== undefined) {
			puppeteerCookie.httpOnly = cookie.httpOnly;
		}
		if (cookie.secure !== undefined) {
			puppeteerCookie.secure = cookie.secure;
		}
		if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
			puppeteerCookie.sameSite = cookie.sameSite as 'Strict' | 'Lax' | 'None';
		}

		return puppeteerCookie;
	});
}

/** Persist browser cookies in the JSON format accepted by loadCookies(). */
export async function writeBrowserCookies(
	cookies: Cookie[],
	filename = 'soundcloud-cookies.json',
): Promise<void> {
	const serialized: LocalCookieData[] = cookies.map((cookie) => ({
		name: cookie.name,
		value: cookie.value,
		domain: cookie.domain,
		path: cookie.path,
		expirationDate: cookie.expires > 0 ? cookie.expires : undefined,
		httpOnly: cookie.httpOnly,
		secure: cookie.secure,
		sameSite: cookie.sameSite,
	}));
	const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(serialized, null, 2)}\n`, {
			mode: 0o600,
		});
		await rename(temporary, filename);
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}

/**
 * Convert EditThisCookie-style JSON cookies to Netscape/Mozilla cookie file
 * text (required by yt-dlp `--cookies`).
 * Returns null when no usable cookie records remain.
 */
export function cookiesToNetscape(cookies: unknown): string | null {
	if (!Array.isArray(cookies) || cookies.length === 0) {
		return null;
	}

	const lines = ['# Netscape HTTP Cookie File'];
	for (const entry of cookies) {
		if (!isValidLocalCookie(entry)) {
			continue;
		}
		const domain = entry.domain;
		const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
		const path = entry.path || '/';
		const secure = entry.secure ? 'TRUE' : 'FALSE';
		const expires = Math.floor(entry.expirationDate ?? 0);
		lines.push(
			[
				domain,
				includeSubdomains,
				path,
				secure,
				String(expires),
				entry.name,
				entry.value,
			].join('\t'),
		);
	}

	// Header only — nothing valid to serialize.
	if (lines.length === 1) {
		return null;
	}
	return `${lines.join('\n')}\n`;
}

function isValidLocalCookie(entry: unknown): entry is LocalCookieData {
	if (entry === null || typeof entry !== 'object') {
		return false;
	}
	const cookie = entry as Record<string, unknown>;
	return (
		typeof cookie.domain === 'string' &&
		cookie.domain.length > 0 &&
		typeof cookie.name === 'string' &&
		cookie.name.length > 0 &&
		typeof cookie.value === 'string'
	);
}

/** Write `soundcloud-cookies.json` as a Netscape cookie file for yt-dlp. */
export async function writeSoundcloudNetscapeCookies(
	jsonPath = 'soundcloud-cookies.json',
	outPath?: string,
): Promise<string | null> {
	const file = Bun.file(jsonPath);
	if (!(await file.exists())) {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(await file.text());
	} catch {
		return null;
	}
	const netscape = cookiesToNetscape(parsed);
	if (!netscape) {
		return null;
	}
	const dest =
		outPath ??
		join(
			tmpdir(),
			`sc-gate-dl-cookies-${process.pid}-${crypto.randomUUID()}.txt`,
		);
	await Bun.write(dest, netscape, { mode: 0o600 });
	return dest;
}

export function isSoundcloudUrl(value: string): boolean {
	return value?.startsWith('https://soundcloud.com/') ?? false;
}

export function validateSoundcloudUrl(value: string): true | string {
	if (!isSoundcloudUrl(value)) {
		return 'A valid SoundCloud URL is required';
	}
	return true;
}

export type GateProvider =
	| 'hypeddit'
	| 'droploud'
	| 'gaterush'
	| 'downloadgater'
	| 'stillhype'
	| 'pumpyoursound'
	| 'mypresskit'
	/** Direct HTTP(S) file URL (Dropbox, Drive, raw audio link, …). */
	| 'direct'
	| 'bandcamp'
	/** Direct track download via yt-dlp (manual fallback, not auto-extracted). */
	| 'soundcloud';

export type GateUrlMatch = {
	url: string;
	provider: GateProvider;
	type: 'purchase_url' | 'description';
};

const HYPEDDIT_URL_RE = /https:\/\/hypeddit\.com\/[^\s]+/;
const DROPLOUD_URL_RE = /https:\/\/droploud\.com\/(?:gate|track)\/[0-9a-f-]+/i;
const GATERUSH_URL_RE = /https?:\/\/(?:www\.)?gaterush\.me\/[A-Za-z0-9_-]+/i;
const DOWNLOADGATER_URL_RE =
	/https?:\/\/(?:www\.)?downloadgater\.com\/g\/[A-Za-z0-9_-]+/i;
const STILLHYPE_URL_RE =
	/https?:\/\/(?:www\.)?stillhype\.io\/g\/[A-Za-z0-9_-]+/i;
/** pumpyoursound.com/f/{channel}/{slug}/{id} (channel may be `pys` or the artist). */
const PUMPYOURSOUND_URL_RE =
	/https?:\/\/(?:www\.)?pumpyoursound\.com\/f\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/\d+/i;
/** mypresskit.info/gate/{handle} */
const MYPRESSKIT_URL_RE =
	/https?:\/\/(?:www\.)?mypresskit\.info\/gate\/[A-Za-z0-9_-]+/i;
/** artist.bandcamp.com/track|album/... (and bare bandcamp.com). */
const BANDCAMP_URL_RE =
	/https?:\/\/(?:[\w-]+\.)?bandcamp\.com\/(?:track|album)\/[^\s?#]+/i;
const BANDCAMP_ALBUM_URL_RE =
	/https?:\/\/(?:[\w-]+\.)?bandcamp\.com\/album\/[^\s?#]+/i;
const SOUNDCLOUD_URL_RE = /https:\/\/soundcloud\.com\/[^\s?#]+/i;
const ANY_HTTP_URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

const GATE_RESOLVE_USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Strip prose/Markdown/JSON delimiters glued to the end of a matched URL. */
export function trimExtractedUrl(url: string): string {
	const cut = url.search(/["'<>\\]/);
	const base = cut >= 0 ? url.slice(0, cut) : url;
	return base.replace(/[)\]}>.,;:!?'"…]+$/g, '');
}

export function isHypedditUrl(value: string): boolean {
	return value.startsWith('https://hypeddit.com/');
}

export function isDroploudUrl(value: string): boolean {
	return DROPLOUD_URL_RE.test(value);
}

export function isGaterushUrl(value: string): boolean {
	return GATERUSH_URL_RE.test(value);
}

export function isDownloadgaterUrl(value: string): boolean {
	return DOWNLOADGATER_URL_RE.test(value);
}

export function isStillhypeUrl(value: string): boolean {
	return STILLHYPE_URL_RE.test(value);
}

export function isPumpyoursoundUrl(value: string): boolean {
	return PUMPYOURSOUND_URL_RE.test(value);
}

export function isMypresskitUrl(value: string): boolean {
	return MYPRESSKIT_URL_RE.test(value);
}

export function isBandcampUrl(value: string): boolean {
	return BANDCAMP_URL_RE.test(value);
}

export function isBandcampAlbumUrl(value: string): boolean {
	return BANDCAMP_ALBUM_URL_RE.test(value);
}

/**
 * Extract the canonical provider URL from a string (possibly with surrounding
 * text). Prefer traditional gates, then Bandcamp, then direct file links, then
 * SoundCloud.
 */
export function resolveGateProviderUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const traditional = matchTraditionalGateUrl(value);
	if (traditional) return traditional;

	const bandcamp = matchBandcampUrl(value);
	if (bandcamp) return bandcamp;

	const direct = matchDirectDownloadUrl(value);
	if (direct) return direct;

	const soundcloudMatch = value.match(SOUNDCLOUD_URL_RE)?.[0];
	if (soundcloudMatch) {
		return {
			url: trimExtractedUrl(soundcloudMatch),
			provider: 'soundcloud',
		};
	}
	return null;
}

export function getGateProvider(value: string): GateProvider | null {
	return resolveGateProviderUrl(value)?.provider ?? null;
}

export function validateHypedditUrl(value: string): true | string {
	if (!isHypedditUrl(value)) {
		return 'A valid Hypeddit URL is required';
	}
	return true;
}

export function validateGateUrl(value: string): true | string {
	if (resolveGateProviderUrl(value)) {
		return true;
	}
	// Unknown http(s) URLs may still resolve via redirects / embedded destinations.
	if (/^https?:\/\/\S+/i.test(value.trim())) {
		return true;
	}
	return 'A valid Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, direct download, SoundCloud, or resolvable http(s) URL is required';
}

function normalizeGateUrl(
	url: string,
	provider: GateProvider,
): { url: string; provider: GateProvider } {
	if (
		provider === 'gaterush' ||
		provider === 'downloadgater' ||
		provider === 'stillhype' ||
		provider === 'pumpyoursound' ||
		provider === 'mypresskit' ||
		provider === 'bandcamp' ||
		provider === 'direct'
	) {
		return {
			url: url.replace(/^http:\/\//i, 'https://'),
			provider,
		};
	}
	return { url, provider };
}

/** Known download gates / Bandcamp / direct files (excludes SoundCloud). */
function matchKnownDownloadGateUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const traditional = matchTraditionalGateUrl(value);
	if (traditional) return traditional;
	const bandcamp = matchBandcampUrl(value);
	if (bandcamp) return bandcamp;
	return matchDirectDownloadUrl(value);
}

/** Traditional unlock gates (browser / HTTP). Prefer these over Bandcamp. */
function matchTraditionalGateUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const hypedditMatch = value.match(HYPEDDIT_URL_RE)?.[0];
	if (hypedditMatch) {
		return { url: trimExtractedUrl(hypedditMatch), provider: 'hypeddit' };
	}
	const droploudMatch = value.match(DROPLOUD_URL_RE)?.[0];
	if (droploudMatch) {
		return { url: trimExtractedUrl(droploudMatch), provider: 'droploud' };
	}
	const gaterushMatch = value.match(GATERUSH_URL_RE)?.[0];
	if (gaterushMatch) {
		return normalizeGateUrl(trimExtractedUrl(gaterushMatch), 'gaterush');
	}
	const downloadgaterMatch = value.match(DOWNLOADGATER_URL_RE)?.[0];
	if (downloadgaterMatch) {
		return normalizeGateUrl(
			trimExtractedUrl(downloadgaterMatch),
			'downloadgater',
		);
	}
	const stillhypeMatch = value.match(STILLHYPE_URL_RE)?.[0];
	if (stillhypeMatch) {
		return normalizeGateUrl(trimExtractedUrl(stillhypeMatch), 'stillhype');
	}
	const pumpyoursoundMatch = value.match(PUMPYOURSOUND_URL_RE)?.[0];
	if (pumpyoursoundMatch) {
		return normalizeGateUrl(
			trimExtractedUrl(pumpyoursoundMatch),
			'pumpyoursound',
		);
	}
	const mypresskitMatch = value.match(MYPRESSKIT_URL_RE)?.[0];
	if (mypresskitMatch) {
		return normalizeGateUrl(trimExtractedUrl(mypresskitMatch), 'mypresskit');
	}
	return null;
}

function matchBandcampUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const bandcampMatch = value.match(BANDCAMP_URL_RE)?.[0];
	if (bandcampMatch) {
		return normalizeGateUrl(trimExtractedUrl(bandcampMatch), 'bandcamp');
	}
	return null;
}

function normalizeBandcampHomepageUrl(value: string): string | null {
	try {
		const url = new URL(trimExtractedUrl(value).replace(/&amp;/g, '&'));
		if (
			url.hostname !== 'bandcamp.com' &&
			url.hostname.endsWith('.bandcamp.com') &&
			!url.port &&
			(url.pathname === '' || url.pathname === '/')
		) {
			return `https://${url.hostname}/`;
		}
	} catch {
		// Not a valid Bandcamp artist homepage.
	}
	return null;
}

function extractAssignedJsonObject(html: string, assignment: RegExp): unknown {
	const assignmentMatch = assignment.exec(html);
	if (!assignmentMatch) return null;
	const start = html.indexOf(
		'{',
		assignmentMatch.index + assignmentMatch[0].length,
	);
	if (start < 0) return null;

	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let index = start; index < html.length; index++) {
		const char = html[index];
		if (inString) {
			if (escaped) escaped = false;
			else if (char === '\\') escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"') inString = true;
		else if (char === '{') depth += 1;
		else if (char === '}' && --depth === 0) {
			try {
				return JSON.parse(html.slice(start, index + 1));
			} catch {
				return null;
			}
		}
	}
	return null;
}

/** Find an artist's bare Bandcamp homepage embedded in a smart-link page. */
export function findBandcampHomepageInHtml(html: string): string | null {
	const normalized = html.replace(/\\\//g, '/');
	const preloadLink = extractAssignedJsonObject(
		normalized,
		/window\.preloadLink\s*=/i,
	);
	if (preloadLink && typeof preloadLink === 'object') {
		const services = (preloadLink as { services?: unknown }).services;
		if (Array.isArray(services)) {
			for (const service of services) {
				if (
					service &&
					typeof service === 'object' &&
					(service as { service_name?: unknown }).service_name === 'bandcamp'
				) {
					const url = (service as { url?: unknown }).url;
					const homepage =
						typeof url === 'string' ? normalizeBandcampHomepageUrl(url) : null;
					if (homepage) return homepage;
				}
			}
		}
	}

	for (const match of normalized.match(ANY_HTTP_URL_RE) ?? []) {
		try {
			const homepage = normalizeBandcampHomepageUrl(match);
			if (homepage) return homepage;
		} catch {
			// Ignore malformed URLs embedded in page scripts.
		}
	}
	return null;
}

function matchDirectDownloadUrl(
	value: string,
): { url: string; provider: GateProvider } | null {
	const httpMatch = value.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0];
	if (!httpMatch) return null;
	const trimmed = trimExtractedUrl(httpMatch);
	try {
		const url = new URL(trimmed.replace(/^http:\/\//i, 'https://'));
		if (!urlLooksLikeDirectDownload(url)) return null;
		return {
			url: normalizeDirectDownloadParsedUrl(url),
			provider: 'direct',
		};
	} catch {
		return null;
	}
}

/**
 * Scan HTML (or any text blob) for a known gate / Bandcamp URL, including
 * meta-refresh targets. Used for smart-link pages that embed destinations.
 */
export function findKnownGateInHtml(
	html: string,
	baseUrl?: string,
): { url: string; provider: GateProvider } | null {
	const normalized = html.replace(/\\\//g, '/');
	const direct = matchKnownDownloadGateUrl(normalized);
	if (direct && direct.provider !== 'bandcamp') return direct;

	const refresh =
		normalized.match(
			/http-equiv=["']refresh["'][^>]*content=["'][^"']*url=([^"'>\s]+)/i,
		) ??
		normalized.match(
			/content=["'][^"']*url=([^"'>\s]+)[^"']*["'][^>]*http-equiv=["']refresh["']/i,
		);
	if (refresh?.[1]) {
		const rawTarget = refresh[1].replace(/&amp;/g, '&');
		let target = rawTarget;
		if (baseUrl) {
			try {
				target = new URL(rawTarget, baseUrl).toString();
			} catch {
				target = rawTarget;
			}
		}
		const refreshMatch = matchKnownDownloadGateUrl(target);
		if (refreshMatch) return refreshMatch;
	}

	if (baseUrl) {
		const relativeMatches = [...normalized.matchAll(/href=["']([^"']+)["']/gi)]
			.map((match) => match[1])
			.filter((target): target is string => Boolean(target))
			.flatMap((target) => {
				try {
					const resolved = matchKnownDownloadGateUrl(
						new URL(target.replace(/&amp;/g, '&'), baseUrl).toString(),
					);
					return resolved ? [resolved] : [];
				} catch {
					return [];
				}
			});

		if (direct?.provider === 'bandcamp') relativeMatches.push(direct);

		const traditional = relativeMatches.find((match) =>
			[
				'hypeddit',
				'droploud',
				'gaterush',
				'downloadgater',
				'stillhype',
				'pumpyoursound',
				'mypresskit',
			].includes(match.provider),
		);
		if (traditional) return traditional;

		// Artist homepages often feature an unrelated track before their albums.
		const album = relativeMatches.find(
			(match) => match.provider === 'bandcamp' && isBandcampAlbumUrl(match.url),
		);
		if (album) return album;
		return (
			relativeMatches.find((match) => match.provider !== 'bandcamp') ?? null
		);
	}
	return direct;
}

/**
 * Resolve an unrecognized (or already-known) URL to a download gate by
 * following HTTP redirects and scanning the final HTML for embedded destinations.
 * Each hop is validated against private/local destinations before fetching.
 */
export async function resolveUnknownGateUrl(
	url: string,
): Promise<{ url: string; provider: GateProvider } | null> {
	const trimmed = trimExtractedUrl(url.trim());
	if (!/^https?:\/\//i.test(trimmed)) {
		return null;
	}

	const knownUpFront = matchKnownDownloadGateUrl(trimmed);
	if (knownUpFront) return knownUpFront;

	// SoundCloud pages are not smart-link hops we want to chase.
	if (isSoundcloudUrl(trimmed)) {
		return null;
	}

	const maxHops = 10;
	let current = trimmed;

	try {
		for (let hop = 0; hop < maxHops; hop++) {
			const known = matchKnownDownloadGateUrl(current);
			if (known) return known;
			if (isSoundcloudUrl(current)) return null;

			const { response } = await safeFetch(current, {
				signal: AbortSignal.timeout(15_000),
				headers: {
					'user-agent': GATE_RESOLVE_USER_AGENT,
					accept:
						'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
				},
			});

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				await response.body?.cancel().catch(() => {});
				if (!location) return null;
				current = trimExtractedUrl(new URL(location, current).toString());
				continue;
			}

			const finalUrl = trimExtractedUrl(current);
			const fromFinal = matchKnownDownloadGateUrl(finalUrl);
			if (fromFinal) {
				await response.body?.cancel().catch(() => {});
				return fromFinal;
			}

			const html = await response.text();
			const fromHtml = findKnownGateInHtml(html, current);
			if (fromHtml) return fromHtml;

			const bandcampHomepage = findBandcampHomepageInHtml(html);
			if (bandcampHomepage && bandcampHomepage !== current) {
				current = bandcampHomepage;
				continue;
			}
			return null;
		}
	} catch {
		return null;
	}

	return null;
}

function collectUnresolvedHttpCandidates(
	track: SoundcloudTrack,
): { url: string; type: 'purchase_url' | 'description' }[] {
	const candidates: { url: string; type: 'purchase_url' | 'description' }[] =
		[];
	const seen = new Set<string>();

	const push = (raw: string, type: 'purchase_url' | 'description') => {
		const url = trimExtractedUrl(raw);
		if (!/^https?:\/\//i.test(url) || isSoundcloudUrl(url) || seen.has(url)) {
			return;
		}
		// Skip URLs already recognized as download gates / Bandcamp.
		if (matchKnownDownloadGateUrl(url)) return;
		seen.add(url);
		candidates.push({ url, type });
	};

	if (track.purchase_url) {
		push(track.purchase_url, 'purchase_url');
	}
	if (track.description) {
		for (const match of track.description.match(ANY_HTTP_URL_RE) ?? []) {
			push(match, 'description');
		}
	}
	return candidates;
}

/**
 * Prefer traditional unlock gates (Hypeddit, Droploud, GateRush, DownloadGater,
 * StillHype, PumpYourSound, MyPressKit) from purchase_url or description over
 * Bandcamp / SoundCloud store links, then direct file links (Dropbox, Drive, …).
 */
export function extractGateUrl(track: SoundcloudTrack): GateUrlMatch | null {
	const { purchase_url, description } = track;

	if (purchase_url) {
		const fromPurchase = matchTraditionalGateUrl(purchase_url);
		if (fromPurchase) {
			return { ...fromPurchase, type: 'purchase_url' };
		}
	}

	if (description) {
		const fromDescription = matchTraditionalGateUrl(description);
		if (fromDescription) {
			return { ...fromDescription, type: 'description' };
		}
	}

	if (purchase_url) {
		const bandcamp = matchBandcampUrl(purchase_url);
		if (bandcamp) {
			return { ...bandcamp, type: 'purchase_url' };
		}
	}

	if (description) {
		const bandcamp = matchBandcampUrl(description);
		if (bandcamp) {
			return { ...bandcamp, type: 'description' };
		}
	}

	if (purchase_url) {
		const direct = matchDirectDownloadUrl(purchase_url);
		if (direct) {
			return { ...direct, type: 'purchase_url' };
		}
	}

	if (description) {
		const direct = matchDirectDownloadUrl(description);
		if (direct) {
			return { ...direct, type: 'description' };
		}
	}

	return null;
}

/**
 * Like extractGateUrl, but also follows redirects / scans smart-link HTML when
 * purchase_url or description contain unrecognized http(s) links.
 */
export async function extractAndResolveGateUrl(
	track: SoundcloudTrack,
): Promise<GateUrlMatch | null> {
	const sync = extractGateUrl(track);
	if (sync) return sync;

	for (const candidate of collectUnresolvedHttpCandidates(track)) {
		const resolved = await resolveUnknownGateUrl(candidate.url);
		if (resolved) {
			return { ...resolved, type: candidate.type };
		}
	}
	return null;
}

/**
 * Resolve a user-supplied or stored gate URL: known providers pass through;
 * otherwise try redirect / HTML destination resolution.
 */
export async function resolveGateUrlOrFollow(
	value: string,
): Promise<{ url: string; provider: GateProvider } | null> {
	const direct = resolveGateProviderUrl(value);
	if (direct && direct.provider !== 'soundcloud') {
		return direct;
	}
	if (direct?.provider === 'soundcloud') {
		return direct;
	}
	return resolveUnknownGateUrl(value);
}

/** @deprecated Prefer extractGateUrl */
export function extractHypedditUrl(
	track: SoundcloudTrack,
): { url: string; type: 'purchase_url' | 'description' } | null {
	const gate = extractGateUrl(track);
	if (gate?.provider !== 'hypeddit') {
		return null;
	}
	return { url: gate.url, type: gate.type };
}

export function getDefaultMetadata(track: SoundcloudTrack): Metadata {
	return {
		title: track.title,
		artist:
			track.publisher_metadata?.artist ||
			track.user.full_name ||
			track.user.username,
		album: track.publisher_metadata?.album_title || '',
		genre: track.genre,
	};
}

const LOSSLESS_EXTENSIONS = [
	'.wav',
	'.aiff',
	'.aif',
	'.flac',
	'.ape',
	'.wv',
	'.alac',
] as const;
/** Lossy containers we still re-encode to MP3 (bitrate chosen from the source). */
const LOSSY_TO_MP3_EXTENSIONS = [
	'.m4a',
	'.aac',
	'.ogg',
	'.opus',
	'.webm',
] as const;
const MP3_CONVERTIBLE_EXTENSIONS = [
	...LOSSLESS_EXTENSIONS,
	...LOSSY_TO_MP3_EXTENSIONS,
] as const;
const MP3_CONVERTIBLE_EXT_PATTERN = new RegExp(
	`\\.(${MP3_CONVERTIBLE_EXTENSIONS.map((ext) => ext.slice(1)).join('|')})$`,
	'i',
);

function hasExtension(
	filename: string,
	extensions: readonly string[],
): boolean {
	const lower = filename.toLowerCase();
	return extensions.some((ext) => lower.endsWith(ext));
}

export function isLosslessFormat(filename: string): boolean {
	return hasExtension(filename, LOSSLESS_EXTENSIONS);
}

export function isMp3Format(filename: string): boolean {
	return filename.toLowerCase().endsWith('.mp3');
}

/** True when the file must be re-encoded to MP3 for the MP3 output path. */
export function needsMp3Conversion(filename: string): boolean {
	return (
		isLosslessFormat(filename) ||
		hasExtension(filename, LOSSY_TO_MP3_EXTENSIONS)
	);
}

export function toMp3Filename(filename: string): string {
	return filename.replace(MP3_CONVERTIBLE_EXT_PATTERN, '.mp3');
}

export function toFlacFilename(filename: string): string {
	return filename.replace(/\.[^.]+$/i, '.flac');
}

/** @deprecated Prefer toMp3Filename */
export function losslessToMp3Filename(filename: string): string {
	return toMp3Filename(filename);
}

/** Strip characters that are unsafe or awkward in filenames. */
export function sanitizeFilenamePart(value: string): string {
	return value
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** `Artist - Title` (+ extension) from metadata fields. */
export function artistTitleFilename(
	artist?: string,
	title?: string,
	extension = '.mp3',
): string {
	const safeArtist = sanitizeFilenamePart(artist || '') || 'Unknown Artist';
	const safeTitle = sanitizeFilenamePart(title || '') || 'Unknown Title';
	const ext = extension.startsWith('.') ? extension : `.${extension}`;
	return `${safeArtist} - ${safeTitle}${ext}`;
}

/** Predicted output name for the metadata step (always ends as MP3). */
export function previewProcessedFilename(
	downloadFilename: string,
	options: {
		nameAsArtistTitle: boolean;
		artist?: string;
		title?: string;
		outputFormat?: 'mp3-320' | 'flac';
	},
): string {
	const extension = options.outputFormat === 'flac' ? '.flac' : '.mp3';
	if (options.nameAsArtistTitle) {
		return artistTitleFilename(options.artist, options.title, extension);
	}
	if (options.outputFormat === 'flac') {
		return toFlacFilename(downloadFilename);
	}
	if (needsMp3Conversion(downloadFilename)) {
		return toMp3Filename(downloadFilename);
	}
	return downloadFilename;
}
