import { lookpath } from 'find-bin';
import type { CookieData } from 'puppeteer';
import type { SoundcloudTrack } from 'soundcloud.ts';
import packageJson from '../package.json' with { type: 'json' };
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

export async function loadCookies(filename: string): Promise<CookieData[]> {
	const cookiesData: LocalCookieData[] = JSON.parse(
		await Bun.file(filename).text(),
	);
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

export function validateSoundcloudUrl(value: string): true | string {
	if (!value || !value.startsWith('https://soundcloud.com/')) {
		return 'A valid SoundCloud URL is required';
	}
	return true;
}

export function validateHypedditUrl(value: string): true | string {
	if (!value || !value.startsWith('https://hypeddit.com/')) {
		return 'A valid Hypeddit URL is required';
	}
	return true;
}

export function extractHypedditUrl(
	track: SoundcloudTrack,
): { url: string; type: 'purchase_url' | 'description' } | null {
	const { purchase_url, description } = track;

	if (purchase_url?.startsWith('https://hypeddit.com/')) {
		return { url: purchase_url, type: 'purchase_url' };
	}

	if (description?.includes('https://hypeddit.com/')) {
		const matchedUrl = description.match(
			/https:\/\/hypeddit\.com\/[^\s]+/,
		)?.[0];
		if (matchedUrl) {
			return { url: matchedUrl, type: 'description' };
		}
	}

	return null;
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

export function isLosslessFormat(filename: string): boolean {
	const lower = filename.toLowerCase();
	return (
		lower.endsWith('.wav') ||
		lower.endsWith('.aiff') ||
		lower.endsWith('.aif') ||
		lower.endsWith('.flac')
	);
}

export function isMp3Format(filename: string): boolean {
	return filename.toLowerCase().endsWith('.mp3');
}

export function losslessToMp3Filename(filename: string): string {
	return filename
		.replace(/\.wav$/i, '.mp3')
		.replace(/\.aiff$/i, '.mp3')
		.replace(/\.aif$/i, '.mp3')
		.replace(/\.flac$/i, '.mp3');
}
