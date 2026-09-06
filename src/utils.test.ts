import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	artistTitleFilename,
	cookiesToNetscape,
	extractGateUrl,
	findBandcampHomepageInHtml,
	findKnownGateInHtml,
	loadCookies,
	previewProcessedFilename,
	resolveGateProviderUrl,
	sanitizeFilenamePart,
	writeBrowserCookies,
	writeSoundcloudNetscapeCookies,
} from './utils';

describe('browser cookie persistence', () => {
	test('treats missing and blank cookie files as empty', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-test-'));
		try {
			expect(await loadCookies(join(dir, 'missing.json'))).toEqual([]);
			const blankPath = join(dir, 'blank.json');
			await writeFile(blankPath, '  \n', 'utf8');
			expect(await loadCookies(blankPath)).toEqual([]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('exports browser cookies for subsequent browser and yt-dlp use', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-test-'));
		const cookiePath = join(dir, 'cookies.json');
		try {
			await writeBrowserCookies(
				[
					{
						name: 'oauth_token',
						value: 'secret',
						domain: '.soundcloud.com',
						path: '/',
						expires: 1_900_000_000,
						size: 17,
						httpOnly: true,
						secure: true,
						session: false,
					},
				],
				cookiePath,
			);
			expect((await Bun.file(cookiePath).stat()).mode & 0o777).toBe(0o600);
			expect(await loadCookies(cookiePath)).toEqual([
				{
					name: 'oauth_token',
					value: 'secret',
					domain: '.soundcloud.com',
					path: '/',
					expires: 1_900_000_000,
					httpOnly: true,
					secure: true,
				},
			]);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('resolveGateProviderUrl', () => {
	test('extracts Bandcamp track URLs from surrounding prose', () => {
		expect(
			resolveGateProviderUrl(
				'grab it (https://artist.bandcamp.com/track/song).',
			),
		).toEqual({
			url: 'https://artist.bandcamp.com/track/song',
			provider: 'bandcamp',
		});
	});

	test('strips trailing sentence punctuation from SoundCloud URLs', () => {
		expect(
			resolveGateProviderUrl('listen: https://soundcloud.com/a/b!'),
		).toEqual({
			url: 'https://soundcloud.com/a/b',
			provider: 'soundcloud',
		});
	});

	test('strips Markdown-style closing delimiters', () => {
		expect(
			resolveGateProviderUrl('[buy](https://x.bandcamp.com/album/y)'),
		).toEqual({
			url: 'https://x.bandcamp.com/album/y',
			provider: 'bandcamp',
		});
	});

	test('prefers traditional gates over Bandcamp', () => {
		expect(
			resolveGateProviderUrl(
				'https://hypeddit.com/foo and https://x.bandcamp.com/track/y',
			),
		).toEqual({
			url: 'https://hypeddit.com/foo',
			provider: 'hypeddit',
		});
	});

	test('matches Dropbox direct download URLs and forces dl=1', () => {
		expect(
			resolveGateProviderUrl(
				'https://www.dropbox.com/scl/fi/abc/track.wav?rlkey=xyz&e=1&dl=0',
			),
		).toEqual({
			url: 'https://www.dropbox.com/scl/fi/abc/track.wav?rlkey=xyz&e=1&dl=1',
			provider: 'direct',
		});
	});

	test('rewrites Dropbox dl=0 to dl=1 when dl is the only query param', () => {
		expect(
			resolveGateProviderUrl('https://www.dropbox.com/s/abc123/track.wav?dl=0'),
		).toEqual({
			url: 'https://www.dropbox.com/s/abc123/track.wav?dl=1',
			provider: 'direct',
		});
	});

	test('adds dl=1 to Dropbox share links that omit dl', () => {
		expect(
			resolveGateProviderUrl(
				'https://www.dropbox.com/scl/fi/abc/track.wav?rlkey=xyz',
			),
		).toEqual({
			url: 'https://www.dropbox.com/scl/fi/abc/track.wav?rlkey=xyz&dl=1',
			provider: 'direct',
		});
	});

	test('normalizes valid Google Drive file links', () => {
		expect(
			resolveGateProviderUrl(
				'https://drive.google.com/file/d/abcdefghijklmnopqrstuvwx/view?usp=sharing',
			),
		).toEqual({
			url: 'https://drive.google.com/uc?export=download&id=abcdefghijklmnopqrstuvwx',
			provider: 'direct',
		});
	});

	test('preserves Google Drive resourcekey on normalized download URLs', () => {
		expect(
			resolveGateProviderUrl(
				'https://drive.google.com/file/d/abcdefghijklmnopqrstuvwx/view?usp=sharing&resourcekey=abc-123',
			),
		).toEqual({
			url: 'https://drive.google.com/uc?export=download&id=abcdefghijklmnopqrstuvwx&resourcekey=abc-123',
			provider: 'direct',
		});
	});

	test('does not treat malformed Google Drive URLs as direct downloads', () => {
		expect(
			resolveGateProviderUrl('https://drive.google.com/drive/my-drive'),
		).toBeNull();
		expect(
			resolveGateProviderUrl('https://drive.google.com/file/d/short/view'),
		).toBeNull();
	});

	test('matches StillHype gate URLs and normalizes http to https', () => {
		expect(
			resolveGateProviderUrl(
				'FREE DOWNLOAD : http://www.stillhype.io/g/mum-dad-beauty-and-a-beat-dub-HoMren',
			),
		).toEqual({
			url: 'https://www.stillhype.io/g/mum-dad-beauty-and-a-beat-dub-HoMren',
			provider: 'stillhype',
		});
	});

	test('matches PumpYourSound fangate URLs', () => {
		expect(
			resolveGateProviderUrl(
				'FREE DOWNLOAD: https://pumpyoursound.com/f/pys/aguanile-remix/224680',
			),
		).toEqual({
			url: 'https://pumpyoursound.com/f/pys/aguanile-remix/224680',
			provider: 'pumpyoursound',
		});
	});

	test('matches MyPressKit gate URLs and normalizes http to https', () => {
		expect(
			resolveGateProviderUrl(
				'http://www.mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit',
			),
		).toEqual({
			url: 'https://www.mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit',
			provider: 'mypresskit',
		});
	});

	test('prefers MyPressKit over Bandcamp in the same string', () => {
		expect(
			resolveGateProviderUrl(
				'https://artist.bandcamp.com/track/song and https://www.mypresskit.info/gate/some-track',
			),
		).toEqual({
			url: 'https://www.mypresskit.info/gate/some-track',
			provider: 'mypresskit',
		});
	});

	test('prefers PumpYourSound over Bandcamp in the same string', () => {
		expect(
			resolveGateProviderUrl(
				'https://artist.bandcamp.com/track/song and https://pumpyoursound.com/f/larrylars/aguanile-remix/224680',
			),
		).toEqual({
			url: 'https://pumpyoursound.com/f/larrylars/aguanile-remix/224680',
			provider: 'pumpyoursound',
		});
	});

	test('matches raw audio file URLs as direct downloads', () => {
		expect(
			resolveGateProviderUrl(
				'FREE DL: https://cdn.example.com/files/track.wav!',
			),
		).toEqual({
			url: 'https://cdn.example.com/files/track.wav',
			provider: 'direct',
		});
	});
});

describe('extractGateUrl', () => {
	test('prefers PumpYourSound in description over Bandcamp purchase_url', () => {
		expect(
			extractGateUrl({
				purchase_url:
					'https://larrylars.bandcamp.com/track/aguanile-groove-hector-lavoe-larrylars-remix',
				description:
					'FREE DOWNLOAD: https://pumpyoursound.com/f/pys/aguanile-remix/224680\n\nBandcamp: larrylars.bandcamp.com/',
			} as Parameters<typeof extractGateUrl>[0]),
		).toEqual({
			url: 'https://pumpyoursound.com/f/pys/aguanile-remix/224680',
			provider: 'pumpyoursound',
			type: 'description',
		});
	});

	test('prefers MyPressKit purchase_url over Bandcamp description', () => {
		expect(
			extractGateUrl({
				purchase_url:
					'https://www.mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit',
				description:
					'Also on Bandcamp: https://artist.bandcamp.com/track/umbrella',
			} as Parameters<typeof extractGateUrl>[0]),
		).toEqual({
			url: 'https://www.mypresskit.info/gate/dj-felge-rihanna-umbrella-dj-felge-x-kluge-edit',
			provider: 'mypresskit',
			type: 'purchase_url',
		});
	});
});

describe('findKnownGateInHtml', () => {
	test('follows a smart-link Bandcamp homepage to its newest album', () => {
		const smartLinkHtml = `
			<a href="https://unrelated.bandcamp.com/">Unrelated</a>
			<script>
				window.preloadLink = {"services":[{"url":"https:\\/\\/underzoneco.bandcamp.com\\/","service_name":"bandcamp"}]};
			</script>
		`;
		const homepage = findBandcampHomepageInHtml(smartLinkHtml);
		expect(homepage).toBe('https://underzoneco.bandcamp.com/');

		const bandcampHtml = `
			<a href="/track/unrelated-featured-track">Featured track</a>
			<a href="/album/club-anthems-vol-4">Club Anthems Vol. 4</a>
		`;
		expect(findKnownGateInHtml(bandcampHtml, homepage ?? undefined)).toEqual({
			url: 'https://underzoneco.bandcamp.com/album/club-anthems-vol-4',
			provider: 'bandcamp',
		});
	});

	test('does not fall back to an unrelated Bandcamp track', () => {
		expect(
			findKnownGateInHtml(
				'<a href="/track/unrelated-featured-track">Featured track</a>',
				'https://underzoneco.bandcamp.com/',
			),
		).toBeNull();
	});

	test('prefers a relative album over an earlier absolute featured track', () => {
		const html = `
			<a href="https://underzoneco.bandcamp.com/track/unrelated-featured-track">Featured</a>
			<a href="/album/club-anthems-vol-4">Album</a>
		`;
		expect(
			findKnownGateInHtml(html, 'https://underzoneco.bandcamp.com/'),
		).toEqual({
			url: 'https://underzoneco.bandcamp.com/album/club-anthems-vol-4',
			provider: 'bandcamp',
		});
	});

	test('scans links when a meta refresh is not a known gate', () => {
		const html = `
			<meta http-equiv="refresh" content="0;url=/news">
			<a href="/album/club-anthems-vol-4">Album</a>
		`;
		expect(
			findKnownGateInHtml(html, 'https://underzoneco.bandcamp.com/'),
		).toEqual({
			url: 'https://underzoneco.bandcamp.com/album/club-anthems-vol-4',
			provider: 'bandcamp',
		});
	});

	test('finds embedded Hypeddit destination in smart-link HTML', () => {
		const html = `
			<script>
			window.linkfire.destination = {"url":"https:\\/\\/hypeddit.com\\/dorey\\/strobedoreyedit","serviceType":"contentlink"};
			</script>
		`;
		expect(findKnownGateInHtml(html)).toEqual({
			url: 'https://hypeddit.com/dorey/strobedoreyedit',
			provider: 'hypeddit',
		});
	});

	test('follows meta refresh to a known gate', () => {
		const html =
			'<meta http-equiv="refresh" content="0;url=https://hypeddit.com/artist/track">';
		expect(findKnownGateInHtml(html)).toEqual({
			url: 'https://hypeddit.com/artist/track',
			provider: 'hypeddit',
		});
	});

	test('prefers Hypeddit when Bandcamp is also present', () => {
		const html = 'https://hypeddit.com/a/b and https://x.bandcamp.com/track/y';
		expect(findKnownGateInHtml(html)).toEqual({
			url: 'https://hypeddit.com/a/b',
			provider: 'hypeddit',
		});
	});
});
describe('writeSoundcloudNetscapeCookies', () => {
	test('returns null for malformed JSON', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-test-'));
		const jsonPath = join(dir, 'cookies.json');
		try {
			await writeFile(jsonPath, 'not valid json{{{', 'utf8');
			expect(await writeSoundcloudNetscapeCookies(jsonPath)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('returns null when every cookie record is malformed', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'sc-gate-dl-test-'));
		const jsonPath = join(dir, 'cookies.json');
		try {
			await writeFile(
				jsonPath,
				JSON.stringify([null, {}, { name: 'x' }]),
				'utf8',
			);
			expect(await writeSoundcloudNetscapeCookies(jsonPath)).toBeNull();
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe('cookiesToNetscape', () => {
	test('emits Netscape rows with subdomain flag from leading dot', () => {
		const text = cookiesToNetscape([
			{
				name: 'oauth_token',
				value: 'tok',
				domain: 'soundcloud.com',
				path: '/',
				secure: true,
				expirationDate: 1700000000.5,
			},
			{
				name: 'datadome',
				value: 'dd',
				domain: '.soundcloud.com',
				path: '/',
				secure: false,
			},
		]);
		expect(text).not.toBeNull();
		expect(text?.startsWith('# Netscape HTTP Cookie File\n')).toBe(true);
		expect(text).toContain(
			'soundcloud.com\tFALSE\t/\tTRUE\t1700000000\toauth_token\ttok',
		);
		expect(text).toContain('.soundcloud.com\tTRUE\t/\tFALSE\t0\tdatadome\tdd');
	});

	test('returns null for null entries and empty objects', () => {
		expect(cookiesToNetscape([null, {}])).toBeNull();
		expect(
			cookiesToNetscape([
				null,
				{},
				{ name: 'oauth_token', value: 'tok', domain: 'soundcloud.com' },
			]),
		).toContain('oauth_token\ttok');
	});
});

describe('sanitizeFilenamePart', () => {
	test('strips unsafe filename characters and collapses whitespace', () => {
		expect(sanitizeFilenamePart('  a/b:c*d?e  ')).toBe('abcde');
		expect(sanitizeFilenamePart('foo   bar')).toBe('foo bar');
	});
});

describe('artistTitleFilename', () => {
	test('builds Artist - Title with default mp3 extension', () => {
		expect(artistTitleFilename('Wax Thief', 'When I grow up')).toBe(
			'Wax Thief - When I grow up.mp3',
		);
	});

	test('falls back for empty artist/title and preserves custom extension', () => {
		expect(artistTitleFilename('  ', '', '.wav')).toBe(
			'Unknown Artist - Unknown Title.wav',
		);
		expect(artistTitleFilename('A', 'B', 'flac')).toBe('A - B.flac');
	});

	test('falls back when artist/title are only invalid filename characters', () => {
		expect(artistTitleFilename('<>:"/\\|?*', '<>:"/\\|?*')).toBe(
			'Unknown Artist - Unknown Title.mp3',
		);
	});
});

describe('previewProcessedFilename', () => {
	test('prefers artist-title naming when requested', () => {
		expect(
			previewProcessedFilename('track.wav', {
				nameAsArtistTitle: true,
				artist: 'Artist',
				title: 'Title',
			}),
		).toBe('Artist - Title.mp3');
	});

	test('converts lossless and lossy containers to mp3 when not renaming', () => {
		expect(
			previewProcessedFilename('song.flac', { nameAsArtistTitle: false }),
		).toBe('song.mp3');
		expect(
			previewProcessedFilename('song.aiff', { nameAsArtistTitle: false }),
		).toBe('song.mp3');
		expect(
			previewProcessedFilename('song.m4a', { nameAsArtistTitle: false }),
		).toBe('song.mp3');
	});

	test('keeps mp3 filenames unchanged when not renaming', () => {
		expect(
			previewProcessedFilename('song.mp3', { nameAsArtistTitle: false }),
		).toBe('song.mp3');
	});

	test('always previews a flac extension for flac output', () => {
		expect(
			previewProcessedFilename('song.mp3', {
				nameAsArtistTitle: false,
				outputFormat: 'flac',
			}),
		).toBe('song.flac');
		expect(
			previewProcessedFilename('song.m4a', {
				nameAsArtistTitle: true,
				artist: 'Artist',
				title: 'Title',
				outputFormat: 'flac',
			}),
		).toBe('Artist - Title.flac');
	});
});
