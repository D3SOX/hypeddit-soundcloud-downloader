import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { HypedditConfig } from './types';
import { loadCookies, REPO_URL, timeout } from './utils';

export class HypedditDownloader {
	private browser!: Browser; // null-asserted because it is initialized async and every call to it comes logically after the init
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private spotifyCookiesExists = false;

	constructor(config: HypedditConfig) {
		this.config = config;
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

	async prepareLogins() {
		// for the login to be available from the cookies we have to open the soundcloud page
		// in a new tab first and do some interaction
		const soundCloudPage = await this.browser.newPage();
		soundCloudPage.setViewport({ width: 1920, height: 1080 });
		await soundCloudPage.goto('https://soundcloud.com/messages');
		await soundCloudPage.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });
		await soundCloudPage.click('a[href="/you/library"]');
		await timeout(100);
		await soundCloudPage.close();

		// same for spotify
		const spotifyPage = await this.browser.newPage();
		spotifyPage.setViewport({ width: 1920, height: 1080 });
		await spotifyPage.goto('http://accounts.spotify.com/');
		await spotifyPage.waitForNetworkIdle({ timeout: 30_000, idleTime: 10 });
		await spotifyPage.click('#account-settings-link');
		await timeout(100);
		await spotifyPage.close();
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to Hypeddit post...');
		const page = await this.browser.newPage();
		await page.setViewport({ width: 1920, height: 1080 });
		await page.goto(url);
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

		const gates: Record<string, (page: Page) => Promise<void>> = {
			email: (p) => this.handleEmailSlide(p),
			sc: (p) => this.handleSoundcloudSlide(p),
			ig: (p) => this.handleInstagramSlide(p),
			sp: (p) => this.handleSpotifySlide(p),
			dw: (p) => this.handleDownloadSlide(p),
		};

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

		return this.downloadFilename;
	}

	async close() {
		await this.browser.close();
	}

	private async handleEmailSlide(page: Page) {
		const nextButton = await page.waitForSelector('#email_to_downloads_next');
		if (!nextButton) {
			throw new Error('Next button not found');
		}
		await page.type('#email_name', this.config.name);
		await page.type('#email_address', this.config.email);
		await nextButton.click();
	}

	private async handleSoundcloudSlide(page: Page) {
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
		await page.type('#sc_comment_text', this.config.comment);
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

		const submitApprovalButton =
			await soundCloudWindow.waitForSelector('#submit_approval');
		if (!submitApprovalButton) {
			throw new Error('Submit approval button not found');
		}
		await submitApprovalButton.click();
	}

	private async handleInstagramSlide(page: Page) {
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
			const button = await page.$(
				'#instagram_status .hype-btn-instagram.undone',
			);

			if (!button) {
				break;
			}

			await page.click('#instagram_status .hype-btn-instagram.undone');

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
		await page.waitForSelector('#skipper_ig_next');
		await page.click('#skipper_ig_next');
	}

	private async handleSpotifySlide(page: Page) {
		// check if #skipper_sp exists, if yes we can just click it to skip this step
		const skipperSp = await page.evaluate(() => {
			return document.querySelector('#skipper_sp') !== null;
		});
		if (skipperSp) {
			console.log('Spotify gate can be skipped for this post. Skipping...');
			await page.click('#skipper_sp');
			return;
		}

		if (!this.spotifyCookiesExists) {
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
		const browserWindows = await this.browser.pages(true);
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
	}

	private async handleDownloadSlide(page: Page) {
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
			this.downloadFilename = event.suggestedFilename;
			console.log('Download started:', this.downloadFilename);
		});

		// listen for download status changes
		client.on('Browser.downloadProgress', (event) => {
			if (event.guid === downloadGuid && this.downloadFilename) {
				if (event.state === 'completed') {
					console.log('Download completed:', this.downloadFilename);
					downloadCompleteResolve(this.downloadFilename);
				} else if (event.state === 'inProgress') {
					const { receivedBytes, totalBytes } = event;
					const progress = Math.round((receivedBytes / totalBytes) * 100);
					console.log(
						'Download in progress:',
						this.downloadFilename,
						`${progress}%`,
					);
				} else if (event.state === 'canceled') {
					throw new Error('Download was canceled');
				}
			}
		});

		// click the download button and wait for download to complete
		await Promise.all([downloadButton.click(), downloadCompletePromise]);

		// clean up CDP session
		await client.detach();
	}
}
