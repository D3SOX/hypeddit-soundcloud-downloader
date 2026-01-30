import { Presets, SingleBar } from 'cli-progress';
import puppeteer, { type Browser, type Page } from 'puppeteer';
import Selectors from './selectors';
import type { HypedditConfig, JobProgress, JobStage } from './types';
import { loadCookies, REPO_URL, timeout } from './utils';

export type ProgressCallback = (
	stage: JobStage,
	message: string,
	percent: number,
	extra?: Partial<JobProgress>,
) => void;

export class HypedditDownloader {
	private browser!: Browser; // null-asserted because it is initialized async and every call to it comes logically after the init
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private spotifyCookiesExists = false;
	private progressCallback: ProgressCallback | null = null;

	constructor(config: HypedditConfig) {
		this.config = config;
	}

	setProgressCallback(callback: ProgressCallback): void {
		this.progressCallback = callback;
	}

	private emitProgress(
		stage: JobStage,
		message: string,
		percent: number,
		extra?: Partial<JobProgress>,
	): void {
		if (this.progressCallback) {
			this.progressCallback(stage, message, percent, extra);
		}
	}

	async initialize() {
		this.browser = await puppeteer.launch({
			headless: this.config.headless,
			userDataDir: './browser-data', // persistent data directory for cookies/login
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--mute-audio',
				'--hide-crash-restore-bubble',
				'--no-first-run',
				'--no-default-browser-check',
				'--disable-restore-session-state',
				'--window-size=1920,1080',
			],
		});

		// Load and set cookies at browser context level to make them available to all pages
		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
		this.spotifyCookiesExists = await Bun.file('spotify-cookies.json').exists();
		if (this.spotifyCookiesExists) {
			const spotifyCookies = await loadCookies('spotify-cookies.json');
			await browserContext.setCookie(...spotifyCookies);
		}
	}

	async handlePossibleCaptcha(page: Page) {
		const captchaContainer = await page.$(
			Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
		);
		if (!captchaContainer) {
			console.log('No captcha found, we can continue');
			return;
		}
		// find iframe
		const captchaIframe = await page.$(Selectors.SOUNDCLOUD_CAPTCHA_IFRAME);
		if (!captchaIframe) {
			throw new Error('Captcha iframe not found');
		}
		await timeout(10_000);

		console.log('Captcha iframe found');
		const frame = await captchaIframe.contentFrame();

		// Wait for slider inside the iframe
		await frame.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_SLIDER, {
			timeout: 50_000,
		});

		const slider = await frame.$(Selectors.SOUNDCLOUD_CAPTCHA_SLIDER);
		if (!slider) {
			throw new Error('Slider not found');
		}
		const iframeBox = await captchaIframe.boundingBox();
		if (!iframeBox) {
			throw new Error('Iframe bounding box not found');
		}

		const sliderBox = await slider.boundingBox();
		if (!sliderBox) {
			throw new Error('Slider bounding box not found');
		}

		const sliderTrack = await frame.$(Selectors.SOUNDCLOUD_CAPTCHA_TRACK);
		if (!sliderTrack) {
			throw new Error('Slider track not found');
		}
		const trackBox = await sliderTrack.boundingBox();
		if (!trackBox) {
			throw new Error('Track bounding box not found');
		}

		// Calculate absolute coordinates on the main page
		// Start from the center of the slider handle (iframe position + slider position)
		const startX = iframeBox.x + sliderBox.x + sliderBox.width / 2;
		const startY = iframeBox.y + sliderBox.y + sliderBox.height / 2;
		// End at the right edge of the track (iframe position + track position + track width - half slider width)
		const endX =
			iframeBox.x + trackBox.x + trackBox.width - sliderBox.width / 2;
		const endY = startY; // Keep same Y position

		console.log('Dragging slider from', startX, 'to', endX);

		// Perform the drag using the page's mouse API with absolute coordinates
		await page.mouse.move(startX, startY); // Move to slider center
		await page.mouse.down(); // Press mouse button
		await page.mouse.move(endX, endY, { steps: 20 }); // Smooth movement to the right
		await timeout(500);
		await page.mouse.up(); // Release mouse button

		console.log('Drag performed');

		// wait for the captcha to be solved
		await page.waitForSelector(Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER, {
			hidden: true,
		});
	}

	async prepareLogins() {
		// for the login to be available from the cookies we have to open the soundcloud page
		// in a new tab first and do some interaction
		const soundCloudPage = await this.browser.newPage();
		soundCloudPage.setViewport({ width: 1920, height: 1080 });
		await soundCloudPage.goto('https://soundcloud.com/messages');
		let captchaFrameFound = false;
		try {
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ timeout: 30_000 },
			);
			captchaFrameFound = true;
		} catch {
			// No challenge container frame found, skip captcha handling
			console.log('No captcha frame found, skipping captcha handling');
		}
		if (captchaFrameFound) {
			await this.handlePossibleCaptcha(soundCloudPage);
		}

		await soundCloudPage.waitForSelector(Selectors.SOUNDCLOUD_LIBRARY_LINK, {
			timeout: 30_000,
		});
		await Promise.all([
			soundCloudPage.click(Selectors.SOUNDCLOUD_LIBRARY_LINK),
			soundCloudPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		]);
		// wait until page url includes /you/library
		await soundCloudPage.waitForFunction(() =>
			window.location.href.includes('/you/library'),
		);
		await soundCloudPage.close();

		if (this.spotifyCookiesExists) {
			const spotifyPage = await this.browser.newPage();
			spotifyPage.setViewport({ width: 1920, height: 1080 });
			await spotifyPage.goto('http://accounts.spotify.com/');
			await spotifyPage.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });
			await Promise.all([
				spotifyPage.click(Selectors.SPOTIFY_ACCOUNT_SETTINGS_LINK),
				spotifyPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
			]);
			await spotifyPage.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });
			await spotifyPage.close();
		}
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to Hypeddit post...');
		this.emitProgress('handling_gates', 'Navigating to Hypeddit post...', 25);

		const page = await this.browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto(url);
		// wait for page to be loaded
		await page.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });

		await page.waitForSelector(Selectors.DOWNLOAD_PROCESS_BUTTON);
		// click the download button
		await page.click(Selectors.DOWNLOAD_PROCESS_BUTTON);
		await timeout(500);
		await page.waitForSelector(Selectors.ALL_STEPS_CONTAINER);

		// fetch gates by getting all divs with their first CSS class inside #all_steps
		const gateNames = await page.evaluate((allStepsDivsSelector) => {
			return Array.from(
				document.querySelectorAll<HTMLDivElement>(allStepsDivsSelector),
			).map((div) => div.classList.item(0));
		}, Selectors.ALL_STEPS_CHILD_DIVS);
		console.log('Hypeddit gates found', gateNames);

		const gateLabels: Record<string, string> = {
			email: 'Email',
			sc: 'SoundCloud',
			ig: 'Instagram',
			sp: 'Spotify',
			dw: 'Download',
		};

		const gates: Record<string, (page: Page) => Promise<void>> = {
			email: (p) => this.handleEmailSlide(p),
			sc: (p) => this.handleSoundcloudSlide(p),
			ig: (p) => this.handleInstagramSlide(p),
			sp: (p) => this.handleSpotifySlide(p),
			dw: (p) => this.handleDownloadSlide(p),
		};

		// Calculate progress per gate (from 30% to 80%)
		const totalGates = gateNames.filter(Boolean).length;
		const progressPerGate = totalGates > 0 ? 50 / totalGates : 50;
		let gateIndex = 0;

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
			const gateLabel = gateLabels[gateName] || gateName;
			const currentProgress = 30 + gateIndex * progressPerGate;

			console.log(`Now handling ${gateName} gate...`);
			this.emitProgress(
				'handling_gates',
				`Handling ${gateLabel} gate...`,
				currentProgress,
				{ currentGate: gateName },
			);

			await gate(page);

			console.log(`✓ ${gateName} gate handled successfully`);
			gateIndex++;
			await timeout(1_000);
		}

		// browser is no longer needed
		await page.close();

		return this.downloadFilename;
	}

	async close() {
		await this.browser?.close();
	}

	private async handleEmailSlide(page: Page) {
		const nextButton = await page.waitForSelector(Selectors.EMAIL_NEXT_BUTTON);
		if (!nextButton) {
			throw new Error('Next button not found');
		}
		// not all email gates require entering a name
		const emailNameInput = await page.$(Selectors.EMAIL_NAME_INPUT);
		if (emailNameInput) {
			await page.type(Selectors.EMAIL_NAME_INPUT, this.config.name);
		}
		await page.type(Selectors.EMAIL_ADDRESS_INPUT, this.config.email);
		await nextButton.click();
	}

	private async handleSoundcloudSlide(page: Page) {
		// check if #skipper_sc exists, if yes we can just click it to skip this step
		const skipperSc = await page.evaluate((skipperScSelector) => {
			return document.querySelector(skipperScSelector) !== null;
		}, Selectors.SC_SKIPPER_BUTTON);
		if (skipperSc) {
			console.log('Soundcloud gate can be skipped for this post. Skipping...');
			await page.click(Selectors.SC_SKIPPER_BUTTON);
			return;
		}

		// not all hypeddit soundcloud gates have a comment text field, if it does not exist we can skip this
		const scCommentText = await page.$(Selectors.SC_COMMENT_TEXT_INPUT);
		if (scCommentText) {
			// if it exists, we need to enter a comment
			await page.type(Selectors.SC_COMMENT_TEXT_INPUT, this.config.comment);
			await timeout(500);
		}

		// then we can click next
		const loginButton = await page.waitForSelector(Selectors.SC_LOGIN_BUTTON);
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
			const pages = await this.browser.pages(true);
			soundCloudWindow = pages.find((window) =>
				window.url().includes('soundcloud.com'),
			);
			if (!soundCloudWindow) {
				await timeout(200);
			}
		}

		if (!soundCloudWindow) {
			throw new Error(
				'SoundCloud window not found after clicking login button',
			);
		}
		await soundCloudWindow.bringToFront();
		await soundCloudWindow.setViewport({ width: 1920, height: 1080 });
		await soundCloudWindow.waitForNetworkIdle({ timeout: 15_000 });

		const submitApprovalButton = await soundCloudWindow.waitForSelector(
			Selectors.SC_SUBMIT_APPROVAL_BUTTON,
		);
		if (!submitApprovalButton) {
			throw new Error('Submit approval button not found');
		}

		await soundCloudWindow.click(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
		// wait for window to close
		while (!soundCloudWindow.isClosed()) {
			await timeout(100);
		}
	}

	private async handleInstagramSlide(page: Page) {
		// check if #skipper_ig exists, if yes we can just click it to skip this step
		const skipperIg = await page.evaluate((skipperIgSelector) => {
			return document.querySelector(skipperIgSelector) !== null;
		}, Selectors.IG_SKIPPER_BUTTON);
		if (skipperIg) {
			console.log('Instagram gate can be skipped for this post. Skipping...');
			await page.click(Selectors.IG_SKIPPER_BUTTON);
			return;
		}

		await page.waitForSelector(Selectors.IG_STATUS_BUTTON);
		// then we need to click each button with class .hype-btn-instagram that is not done
		// loop until there are no more buttons with the undone class
		while (true) {
			// try to find a button that's not done
			const button = await page.$(Selectors.IG_STATUS_UNDONE_BUTTON);

			if (!button) {
				break;
			}

			await page.click(Selectors.IG_STATUS_UNDONE_BUTTON);

			// wait for the Instagram window to appear (with timeout)
			let instagramWindow: Page | undefined;
			const maxWaitTime = 5000;
			const startTime = Date.now();
			while (!instagramWindow && Date.now() - startTime < maxWaitTime) {
				const pages = await this.browser.pages(true);
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
		await page.waitForSelector(Selectors.IG_NEXT_BUTTON);
		await page.click(Selectors.IG_NEXT_BUTTON);
	}

	private async handleSpotifySlide(page: Page) {
		// check if #skipper_sp exists, if yes we can just click it to skip this step
		const skipperSp = await page.evaluate((skipperSpSelector) => {
			return document.querySelector(skipperSpSelector) !== null;
		}, Selectors.SP_SKIPPER_BUTTON);
		if (skipperSp) {
			console.log('Spotify gate can be skipped for this post. Skipping...');
			await page.click(Selectors.SP_SKIPPER_BUTTON);
			return;
		}

		if (!this.spotifyCookiesExists) {
			throw new Error(
				'Spotify cookies are required to handle the Spotify gate. Please export your Spotify cookies and save them to spotify-cookies.json in the project root.',
			);
		}

		await page.waitForSelector(Selectors.SP_LOGIN_BUTTON);

		// if there is an optInSectionSpotify, we should click the anchor with class .optOutOption first
		const optInSectionSpotify = await page.$(Selectors.SP_OPT_IN_SECTION);
		if (optInSectionSpotify) {
			const optOutOption = await optInSectionSpotify.$(
				Selectors.SP_OPT_OUT_OPTION,
			);
			if (optOutOption) {
				await optOutOption.click();
			}
		}

		// then we can click the login button
		await page.click(Selectors.SP_LOGIN_BUTTON);
		// TODO: I think this timeout is the only thing that keeps it working when spotify is already authorized,
		// TODO: Maybe we should also wait for a window to open in parallel to this and it being closed again?
		await timeout(1_500);

		// we might need to click the accept button in the new window if the app is not authorized yet
		const browserWindows = await this.browser.pages(true);
		const spotifyWindow = browserWindows.find((window) =>
			window.url().includes('spotify.com'),
		);
		// TODO: we should also try to deauthorize hypeddit from spotify and see if this code still works
		if (spotifyWindow) {
			await spotifyWindow.bringToFront();
			await spotifyWindow.setViewport({ width: 1920, height: 1080 });
			await spotifyWindow.waitForNetworkIdle({ timeout: 15_000 });

			await spotifyWindow.waitForSelector(Selectors.SP_AUTH_ACCEPT_BUTTON, {
				visible: true,
			});

			// then we need to click the login button in the new window
			await spotifyWindow.click(Selectors.SP_AUTH_ACCEPT_BUTTON);

			// wait for window to close
			while (!spotifyWindow.isClosed()) {
				await timeout(100);
			}
		}
	}

	private async handleDownloadSlide(page: Page) {
		const downloadButton = await page.waitForSelector(
			Selectors.DW_DOWNLOAD_BUTTON,
			{
				visible: true,
			},
		);
		if (!downloadButton) {
			throw new Error('Download button not found');
		}
		console.log('Download button found, setting up CDP session...');
		this.emitProgress('downloading', 'Preparing download...', 75);

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

		// create progress bar (for CLI)
		const pBar = new SingleBar(
			{
				format:
					'{prefix} {bar} {percentage}% | {current_mb}/{total_mb} MB | ETA: {eta_formatted}',
				hideCursor: true,
			},
			{
				// modern preset
				barCompleteChar: '█',
				barIncompleteChar: '░',
				format: Presets.shades_classic.format,
			},
		);

		console.log('CDP session set up, waiting for download start event...');

		// listen for download start event
		client.on('Browser.downloadWillBegin', (event) => {
			downloadGuid = event.guid;
			this.downloadFilename = event.suggestedFilename;
			console.log('Download started:', this.downloadFilename);
			this.emitProgress(
				'downloading',
				`Downloading ${this.downloadFilename}...`,
				76,
			);
		});

		// listen for download status changes
		client.on('Browser.downloadProgress', (event) => {
			if (event.guid === downloadGuid && this.downloadFilename) {
				if (event.state === 'completed') {
					pBar.stop();
					console.log('Download completed');
					this.emitProgress('downloading', 'Download complete', 85);
					downloadCompleteResolve(this.downloadFilename);
				} else if (event.state === 'inProgress') {
					const { receivedBytes, totalBytes } = event;

					if (pBar.isActive) {
						pBar.update(receivedBytes, {
							total_mb: Number((totalBytes / 1024 / 1024).toFixed(2)),
							current_mb: Number((receivedBytes / 1024 / 1024).toFixed(2)),
						});
					} else {
						pBar.start(totalBytes, receivedBytes, { prefix: 'Downloading' });
					}

					const downloadPercent =
						totalBytes > 0 ? receivedBytes / totalBytes : 0;
					const scaledPercent = 76 + downloadPercent * 8;
					this.emitProgress(
						'downloading',
						`Downloading... ${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
						scaledPercent,
						{
							downloadBytes: receivedBytes,
							totalBytes: totalBytes,
						},
					);
				} else if (event.state === 'canceled') {
					pBar.stop();
					throw new Error('Download was canceled');
				}
			}
		});

		console.log('Waiting for download start event...');
		setTimeout(async () => {
			if (!downloadGuid) {
				// click button again when download has not started after 10 seconds
				console.log(
					'Download not started after 10 seconds, clicking button again...',
				);
				await page.click(Selectors.DW_DOWNLOAD_BUTTON);
			}
		}, 10_000);

		// click the download button and wait for download to complete
		await Promise.all([
			page.click(Selectors.DW_DOWNLOAD_BUTTON),
			downloadCompletePromise,
		]);

		console.log('Download complete, detaching CDP session...');

		// clean up CDP session
		await client.detach();
	}
}
