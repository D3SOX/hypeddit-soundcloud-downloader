import { join } from 'node:path';
import { execa } from 'execa';
import { lookpath } from 'find-bin';
import prompts from 'prompts';
import puppeteer, { type Page } from 'puppeteer';
import Soundcloud from 'soundcloud.ts';
import packageJson from '../package.json' with { type: 'json' };
import { loadCookies, timeout } from './utils';

const REPO_URL = packageJson.repository.url;

const ffmpegBin = await lookpath('ffmpeg');
if (!ffmpegBin) {
	throw new Error(
		'ffmpeg is not installed. Please make sure it is in your PATH.',
	);
}

// environment variables
const SC_COMMENT = process.env.SC_COMMENT;
if (!SC_COMMENT) {
	throw new Error('SC_COMMENT is required. Please set it in your .env file.');
}
const HYPEDDIT_NAME = process.env.HYPEDDIT_NAME;
const HYPEDDIT_EMAIL = process.env.HYPEDDIT_EMAIL;
if (!HYPEDDIT_NAME || !HYPEDDIT_EMAIL) {
	throw new Error(
		'HYPEDDIT_NAME and HYPEDDIT_EMAIL are required. Please set them in your .env file.',
	);
}

// prompt for user input
const { url: hypedditUrl } = await prompts({
	type: 'text',
	name: 'url',
	message: 'Enter the URL of the Hypeddit post',
	validate: (value) => {
		if (!value || !value.startsWith('https://hypeddit.com/')) {
			return 'A valid Hypeddit URL is required';
		}
		return true;
	},
});
const { url: soundcloudUrl } = await prompts({
	type: 'text',
	name: 'url',
	message: 'Enter the URL of the SoundCloud track',
	validate: (value) => {
		if (!value || !value.startsWith('https://soundcloud.com/')) {
			return 'A valid SoundCloud URL is required';
		}
		return true;
	},
});
if (!hypedditUrl || !soundcloudUrl) {
	throw new Error('Hypeddit and SoundCloud URLs are required');
}

const { headless } = await prompts({
	type: 'confirm',
	name: 'headless',
	message:
		'Do you want to run the browser in headless mode? (You will not see the browser window but the process will run in the background). If something does not work it is recommended to turn it off.',
	initial: true,
});

const browser = await puppeteer.launch({
	headless: headless,
	userDataDir: './browser-data', // persistent data directory for cookies/login
	args: [
		'--no-sandbox',
		'--disable-setuid-sandbox',
		'--mute-audio',
		'--hide-crash-restore-bubble',
		'--window-size=1920,1080',
	],
});

// Load and set cookies at browser context level to make them available to all pages
const browserContext = browser.defaultBrowserContext();
const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
await browserContext.setCookie(...soundCloudCookies);
const spotifyCookiesExists = await Bun.file('spotify-cookies.json').exists();
if (spotifyCookiesExists) {
	const spotifyCookies = await loadCookies('spotify-cookies.json');
	await browserContext.setCookie(...spotifyCookies);
}

const handleEmailSlide = async (page: Page) => {
	const nextButton = await page.waitForSelector('#email_to_downloads_next');
	if (!nextButton) {
		throw new Error('Next button not found');
	}
	await page.type('#email_name', HYPEDDIT_NAME);
	await page.type('#email_address', HYPEDDIT_EMAIL);
	await nextButton.click();
};

const handleSoundcloudSlide = async (page: Page) => {
	// check if #skipper_sc exists, if yes we can just click it to skip this step
	const skipperSc = await page.evaluate(() => {
		return document.querySelector('#skipper_sc') !== null;
	});
	if (skipperSc) {
		console.log('Soundcloud gate can be skipped for this post. Skipping...');
		await page.click('#skipper_sc');
		return;
	}

	// if no, we need to share a comment and connect
	await page.type('#sc_comment_text', SC_COMMENT);
	await timeout(500);

	const loginButton = await page.waitForSelector('#login_to_sc');
	if (!loginButton) {
		throw new Error('Login button not found');
	}
	await loginButton.click();
	await timeout(1_500);

	// wait for the SoundCloud window to appear (with timeout)
	let soundCloudWindow: Page | undefined;
	const maxWaitTime = 5000;
	const startTime = Date.now();
	while (!soundCloudWindow && Date.now() - startTime < maxWaitTime) {
		const pages = await browser.pages(true);
		soundCloudWindow = pages.find((window) =>
			window.url().includes('soundcloud.com'),
		);
		if (!soundCloudWindow) {
			await timeout(200);
		}
	}

	if (!soundCloudWindow) {
		throw new Error('SoundCloud window not found after clicking login button');
	}
	await soundCloudWindow.bringToFront();
	await soundCloudWindow.setViewport({ width: 1920, height: 1080 });
	await soundCloudWindow.waitForNetworkIdle({ timeout: 15_000 });

	const submitApprovalButton =
		await soundCloudWindow.waitForSelector('#submit_approval');
	if (!submitApprovalButton) {
		throw new Error('Submit approval button not found');
	}
	await submitApprovalButton.click();
};

const handleInstagramSlide = async (page: Page) => {
	// check if #skipper_ig exists, if yes we can just click it to skip this step
	const skipperIg = await page.evaluate(() => {
		return document.querySelector('#skipper_ig') !== null;
	});
	if (skipperIg) {
		console.log('Instagram gate can be skipped for this post. Skipping...');
		await page.click('#skipper_ig');
		return;
	}

	await page.waitForSelector('#instagram_status .hype-btn-instagram');
	// then we need to click each button with class .hype-btn-instagram that is not done
	// loop until there are no more buttons with the undone class
	while (true) {
		// try to find a button that's not done
		const button = await page.$('#instagram_status .hype-btn-instagram.undone');

		if (!button) {
			break;
		}

		await page.click('#instagram_status .hype-btn-instagram.undone');

		// wait for the Instagram window to appear (with timeout)
		let instagramWindow: Page | undefined;
		const maxWaitTime = 5000;
		const startTime = Date.now();
		while (!instagramWindow && Date.now() - startTime < maxWaitTime) {
			const pages = await browser.pages(true);
			instagramWindow = pages.find((window) =>
				window.url().includes('instagram.com'),
			);
			if (!instagramWindow) {
				await timeout(200);
			}
		}

		if (!instagramWindow) {
			throw new Error('Instagram window not found after clicking button');
		}
		await instagramWindow.close();

		// wait for the page to update after closing the window
		// the button should get the done class instead of undone
		await timeout(1_000);

		// wait for network to be idle to ensure DOM has updated
		try {
			await page.waitForNetworkIdle({ timeout: 3_000 });
		} catch {
			// ignore timeout
		}
	}

	// then we can click next
	await page.waitForSelector('#skipper_ig_next');
	await page.click('#skipper_ig_next');
};

const handleSpotifySlide = async (page: Page) => {
	// check if #skipper_sp exists, if yes we can just click it to skip this step
	const skipperSp = await page.evaluate(() => {
		return document.querySelector('#skipper_sp') !== null;
	});
	if (skipperSp) {
		console.log('Spotify gate can be skipped for this post. Skipping...');
		await page.click('#skipper_sp');
		return;
	}

	if (!spotifyCookiesExists) {
		throw new Error(
			'Spotify cookies are required to handle the Spotify gate. Please export your Spotify cookies and save them to spotify-cookies.json in the project root.',
		);
	}

	await page.waitForSelector('#login_to_sp');

	// if there is an optInSectionSpotify, we should click the anchor with class .optOutOption first
	const optInSectionSpotify = await page.$('#optInSectionSpotify');
	if (optInSectionSpotify) {
		const optOutOption = await optInSectionSpotify.$('a.optOutOption');
		if (optOutOption) {
			await optOutOption.click();
		}
	}

	// then we can click the login button
	await page.click('#login_to_sp');
	await timeout(1_500);

	// we might need to click the accept button in the new window if the app is not authorized yet
	const browserWindows = await browser.pages(true);
	const spotifyWindow = browserWindows.find((window) =>
		window.url().includes('spotify.com'),
	);
	if (spotifyWindow) {
		await spotifyWindow.bringToFront();
		await spotifyWindow.setViewport({ width: 1920, height: 1080 });
		await spotifyWindow.waitForNetworkIdle({ timeout: 15_000 });

		// then we need to click the login button in the new window [data-testid="auth-accept"]
		await spotifyWindow.click('[data-testid="auth-accept"]');
	}
	await timeout(1_000);
	// window should close automatically
};

let downloadFilename: string | null = null;

const handleDownloadSlide = async (page: Page) => {
	const downloadButton = await page.waitForSelector('#gateDownloadButton');
	if (!downloadButton) {
		throw new Error('Download button not found');
	}

	// configure CDP session to allow monitoring download events
	const client = await page.createCDPSession();
	await client.send('Browser.setDownloadBehavior', {
		behavior: 'allow',
		downloadPath: './downloads',
		eventsEnabled: true,
	});

	// track download state
	let downloadGuid: string | null = null;
	let downloadCompleteResolve: (value: string) => void;
	const downloadCompletePromise = new Promise<string>((resolve) => {
		downloadCompleteResolve = resolve;
	});

	// listen for download start event
	client.on('Browser.downloadWillBegin', (event) => {
		downloadGuid = event.guid;
		downloadFilename = event.suggestedFilename;
		console.log('Download started:', downloadFilename);
	});

	// listen for download status changes
	client.on('Browser.downloadProgress', (event) => {
		if (event.guid === downloadGuid && downloadFilename) {
			if (event.state === 'completed') {
				console.log('Download completed:', downloadFilename);
				downloadCompleteResolve(downloadFilename);
			} else if (event.state === 'inProgress') {
				const { receivedBytes, totalBytes } = event;
				const progress = Math.round((receivedBytes / totalBytes) * 100);
				console.log('Download in progress:', downloadFilename, `${progress}%`);
			} else if (event.state === 'canceled') {
				throw new Error('Download was canceled');
			}
		}
	});

	// click the download button and wait for download to complete
	await Promise.all([downloadButton.click(), downloadCompletePromise]);

	// clean up CDP session
	await client.detach();
};

const gates: Record<string, (page: Page) => Promise<void>> = {
	email: handleEmailSlide,
	sc: handleSoundcloudSlide,
	ig: handleInstagramSlide,
	sp: handleSpotifySlide,
	dw: handleDownloadSlide,
};

async function downloadHypedditAudio(hypedditUrl: string) {
	console.log('Navigating to Hypeddit post...');
	const page = await browser.newPage();
	await page.setViewport({ width: 1920, height: 1080 });
	await page.goto(hypedditUrl);
	// wait for page to be loaded
	await page.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });

	await page.waitForSelector('#downloadProcess');
	// click the download button
	await page.click('#downloadProcess');
	await timeout(500);
	await page.waitForSelector('#all_steps');

	// fetch gates by getting all divs with their first CSS class inside #all_steps
	const gateNames = await page.evaluate(() => {
		return Array.from(document.querySelectorAll('#all_steps > div')).map(
			(div) => div.classList.item(0),
		);
	});
	console.log('Hypeddit gates found', gateNames);

	// go through all gate names and call the corresponding gate handler
	for (const gateName of gateNames) {
		if (!gateName) {
			continue;
		}
		const gate = gates[gateName];
		if (!gate) {
			throw new Error(
				`No handler found for gate ${gateName}. Please create an issue about this on ${REPO_URL}/issues`,
			);
		}
		console.log(`Now handling ${gateName} gate...`);
		await gate(page);
		console.log(`✓ ${gateName} gate handled successfully`);
		await timeout(1_000);
	}

	// browser is no longer needed
	await page.close();
	await browser.close();
}

async function prepareLogins() {
	// for the login to be available from the cookies we have to open the soundcloud page
	// in a new tab first and do some interaction
	const soundCloudPage = await browser.newPage();
	soundCloudPage.setViewport({ width: 1920, height: 1080 });
	await soundCloudPage.goto('https://soundcloud.com/messages');
	await soundCloudPage.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });
	await soundCloudPage.click('a[href="/you/library"]');
	await timeout(100);
	await soundCloudPage.close();

	// same for spotify
	const spotifyPage = await browser.newPage();
	spotifyPage.setViewport({ width: 1920, height: 1080 });
	await spotifyPage.goto('http://accounts.spotify.com/');
	await spotifyPage.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });
	await spotifyPage.click('#account-settings-link');
	await timeout(100);
	await spotifyPage.close();
}

// prompt if you want to initialize logins
const { initializeLogins } = await prompts({
	type: 'confirm',
	name: 'initializeLogins',
	message:
		'Do you want to initialize logins for SoundCloud and Spotify? This is required for the first run. You can skip it for subsequent runs.',
	initial: false,
});
if (initializeLogins) {
	await prepareLogins();
}

// download the audio from the Hypeddit post
await downloadHypedditAudio(hypedditUrl);

// fetch track metadata from SoundCloud
const soundcloud = new Soundcloud(
	process.env.SC_CLIENT_ID,
	process.env.SC_OAUTH_TOKEN,
);
const track = await soundcloud.tracks.get(soundcloudUrl);

const {
	title,
	artwork_url,
	genre,
	user: { full_name, username },
} = track;
const artist = full_name || username;
const artworkUrl = artwork_url.replace('large', 'original');
const artwork = await fetch(artworkUrl).then((res) => res.arrayBuffer());

const unfollowAllUsersOnSoundcloud = async (meId: string) => {
	const { collection: following } = await soundcloud.api.getV2(
		`users/${meId}/followings`,
	);
	if (!following || !following.length) {
		console.log('No users to unfollow');
		return;
	}
	console.log(`Found ${following.length} users to unfollow`);
	// console.log(following);

	for (const user of following) {
		try {
			await soundcloud.api.deleteV2(`me/followings/${user.id}`);
			console.log(`✓ Unfollowed ${user.username} (${user.id})`);
		} catch (error) {
			console.error(
				`✗ Failed to unfollow ${user.username} (${user.id}):`,
				error,
			);
		}
	}
};
const unlikeAllTracksOnSoundcloud = async (meId: string) => {
	const { collection: likes } = await soundcloud.api.getV2(
		`users/${meId}/likes`,
	);
	if (!likes || !likes.length) {
		console.log('No tracks to unlike');
		return;
	}
	console.log(`Found ${likes.length} tracks to unlike`);
	// console.log(likes);

	for (const like of likes) {
		try {
			await soundcloud.api.deleteV2(
				`users/${meId}/track_likes/${like.track.id}`,
			);
			console.log(`✓ Unliked ${like.track.title} (${like.track.id})`);
		} catch (error) {
			console.error(
				`✗ Failed to unlike ${like.track.title} (${like.track.id}):`,
				error,
			);
		}
	}
};
const deleteAllCommentsOnSoundcloud = async (meId: string) => {
	const { collection: comments } = await soundcloud.api.getV2(
		`users/${meId}/comments`,
	);
	if (!comments || !comments.length) {
		console.log('No comments to delete');
		return;
	}
	console.log(`Found ${comments.length} comments to delete`);
	// console.log(comments);

	for (const comment of comments) {
		try {
			await soundcloud.api.deleteV2(`comments/${comment.id}`);
			console.log(`✓ Deleted comment ${comment.id}`);
		} catch (error) {
			console.error(`✗ Failed to delete comment ${comment.id}:`, error);
		}
	}
};
const deleteAllRepostsOnSoundcloud = async () => {
	const { collection: reposts } = await soundcloud.api.getV2(
		`me/track_reposts/ids`,
		{ limit: 200 },
	);
	if (!reposts || !reposts.length) {
		console.log('No reposts to delete');
		return;
	}
	console.log(`Found ${reposts.length} reposts to delete`);
	// console.log(reposts);

	for (const repost of reposts) {
		try {
			await soundcloud.api.deleteV2(`me/track_reposts/${repost}`);
			console.log(`✓ Deleted repost ${repost}`);
		} catch (error) {
			console.error(`✗ Failed to delete repost ${repost}:`, error);
		}
	}
};
async function cleanupSoundcloud() {
	const me = await soundcloud.api.getV2('me');
	if (!me) {
		throw new Error(
			'Failed to fetch your SoundCloud account. Please check your SoundCloud credentials.',
		);
	}
	await unfollowAllUsersOnSoundcloud(me.id);
	await unlikeAllTracksOnSoundcloud(me.id);
	await deleteAllCommentsOnSoundcloud(me.id);
	await deleteAllRepostsOnSoundcloud();
}

// prompt if you want to cleanup soundcloud
const { cleanupSoundcloudConfirm } = await prompts({
	type: 'confirm',
	name: 'cleanupSoundcloudConfirm',
	message:
		'Do you want to cleanup your SoundCloud account (unfollow all users, unlike all tracks, delete all comments and reposts)?',
	initial: true,
});
if (cleanupSoundcloudConfirm) {
	await cleanupSoundcloud();
}

console.log('Metadata', {
	title,
	artist,
	genre,
	downloadFilename,
});

console.log(
	'Now you can correct the metadata for the resulting MP3 file. All fields are optional and will be used if provided.',
);

// prompt user for correct metadata
const { correctedTitle } = await prompts({
	type: 'text',
	name: 'correctedTitle',
	message: 'Check and correct the title',
	initial: title,
});
const { correctedArtist } = await prompts({
	type: 'text',
	name: 'correctedArtist',
	message: 'Check and correct the artist',
	initial: artist,
});
const { correctedAlbum } = await prompts({
	type: 'text',
	name: 'correctedAlbum',
	message: 'Check and correct the album',
});
const { correctedGenre } = await prompts({
	type: 'text',
	name: 'correctedGenre',
	message: 'Check and correct the genre',
	initial: genre,
});

if (downloadFilename) {
	const filename: string = downloadFilename;
	const inputPath = join('./downloads', filename);

	// save artwork to temporary file
	const artworkPath = join('./downloads', `artwork_${Date.now()}.jpg`);
	await Bun.write(artworkPath, artwork);

	// if it is a WAV or AIFF, we convert it to MP3
	if (
		filename.toLowerCase().endsWith('.wav') ||
		filename.toLowerCase().endsWith('.aiff')
	) {
		const outputPath = join(
			'./downloads',
			filename.replace(/\.wav$/i, '.mp3').replace(/\.aiff$/i, '.mp3'),
		);

		const args: string[] = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'320k',
			'-id3v2_version',
			'3',
			'-map',
			'1:v',
			'-c:v',
			'copy',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		];

		if (correctedTitle) {
			args.push('-metadata', `title=${correctedTitle}`);
		}
		if (correctedArtist) {
			args.push('-metadata', `artist=${correctedArtist}`);
		}
		if (correctedAlbum) {
			args.push('-metadata', `album=${correctedAlbum}`);
		}
		if (correctedGenre) {
			args.push('-metadata', `genre=${correctedGenre}`);
		}

		args.push('-y', outputPath);

		console.log('Converting Lossless to MP3 (320kbps)...');
		await execa(ffmpegBin, args);
		console.log(`✓ Converted to ${outputPath}`);

		// ask if you want to remove the lossless file
		const { removeLosslessFile } = await prompts({
			type: 'confirm',
			name: 'removeLosslessFile',
			message: 'Do you want to remove the lossless file now?',
			initial: true,
		});
		if (removeLosslessFile) {
			await Bun.file(inputPath).unlink();
			console.log(`✓ Removed ${inputPath}`);
		}
	}
	// otherwise if it is an MP3, we retag it with the correct metadata
	else if (filename.toLowerCase().endsWith('.mp3')) {
		const args: string[] = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-c:a',
			'copy',
			'-id3v2_version',
			'3',
			'-map_metadata',
			'-1', // clear existing metadata
			'-map',
			'1:v',
			'-c:v',
			'copy',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		];

		if (correctedTitle) {
			args.push('-metadata', `title=${correctedTitle}`);
		}
		if (correctedArtist) {
			args.push('-metadata', `artist=${correctedArtist}`);
		}
		if (correctedAlbum) {
			args.push('-metadata', `album=${correctedAlbum}`);
		}
		if (correctedGenre) {
			args.push('-metadata', `genre=${correctedGenre}`);
		}

		args.push('-y', inputPath);

		console.log('Retagging MP3...');
		await execa(ffmpegBin, args);
		console.log(`✓ Retagged ${inputPath}`);
	} else {
		console.warn(
			`Unsupported file type: ${filename}. Leaving as is... If you want support for this file type, please create an issue about this on ${REPO_URL}/issues`,
		);
	}

	// clean up temporary artwork file
	try {
		await Bun.file(artworkPath).unlink();
	} catch {
		// ignore cleanup errors
	}
}
