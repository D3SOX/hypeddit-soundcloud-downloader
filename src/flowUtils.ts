import type { SoundcloudTrack } from 'soundcloud.ts';
import type { Metadata } from './types';

/**
 * Validates a SoundCloud URL
 * @returns true if valid, or an error message string if invalid
 */
export function validateSoundcloudUrl(value: string): true | string {
	if (!value || !value.startsWith('https://soundcloud.com/')) {
		return 'A valid SoundCloud URL is required';
	}
	return true;
}

/**
 * Validates a Hypeddit URL
 * @returns true if valid, or an error message string if invalid
 */
export function validateHypedditUrl(value: string): true | string {
	if (!value || !value.startsWith('https://hypeddit.com/')) {
		return 'A valid Hypeddit URL is required';
	}
	return true;
}

/**
 * Extracts a Hypeddit URL from a SoundCloud track's purchase_url or description
 * @returns The Hypeddit URL if found, or null
 */
export function extractHypedditUrl(track: SoundcloudTrack): string | null {
	const { purchase_url, description } = track;

	if (purchase_url?.startsWith('https://hypeddit.com/')) {
		return purchase_url;
	}

	if (description?.includes('https://hypeddit.com/')) {
		const matchedUrl = description.match(
			/https:\/\/hypeddit\.com\/[^\s]+/,
		)?.[0];
		if (matchedUrl) {
			return matchedUrl;
		}
	}

	return null;
}

/**
 * Extracts default metadata from a SoundCloud track
 */
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

/**
 * Checks if a filename is a lossless audio format
 */
export function isLosslessFormat(filename: string): boolean {
	const lower = filename.toLowerCase();
	return (
		lower.endsWith('.wav') ||
		lower.endsWith('.aiff') ||
		lower.endsWith('.aif') ||
		lower.endsWith('.flac')
	);
}

/**
 * Checks if a filename is an MP3 file
 */
export function isMp3Format(filename: string): boolean {
	return filename.toLowerCase().endsWith('.mp3');
}

/**
 * Converts a lossless filename to MP3 filename
 */
export function losslessToMp3Filename(filename: string): string {
	return filename
		.replace(/\.wav$/i, '.mp3')
		.replace(/\.aiff$/i, '.mp3')
		.replace(/\.aif$/i, '.mp3')
		.replace(/\.flac$/i, '.mp3');
}
