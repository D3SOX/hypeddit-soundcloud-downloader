import { Presets, SingleBar } from 'cli-progress';
import type { Browser, Page } from 'puppeteer';
import { CancellableBrowserLaunch } from './browserLaunch';
import type { ProgressCallback } from './hypeddit';
import Selectors from './selectors';
import {
	isSoundcloudLoginPage,
	saveSoundcloudLogin,
	waitForSoundcloudLogin,
} from './soundcloudLogin';
import type { HypedditConfig } from './types';
import { loadCookies, timeout } from './utils';

export class GaterushDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private downloadFilename: string | null = null;
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;
	private cancelPendingDownloadWait: (() => void) | null = null;

	constructor(config: HypedditConfig) {
		this.config = config;
	}

	setProgressCallback(callback: ProgressCallback): void {
		this.progressCallback = callback;
	}

	private emitProgress(
		stage: Parameters<ProgressCallback>[0],
		message: string,
		percent: number,
		extra?: Parameters<ProgressCallback>[3],
	): void {
		this.progressCallback?.(stage, message, percent, extra);
	}

	async initialize() {
		this.browser = await this.browserLaunch.launchConfigured(this.config);

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
	}

	async prepareLogins() {
		const soundCloudPage = await this.browser.newPage();
		soundCloudPage.setViewport({ width: 1920, height: 1080 });
		await soundCloudPage.goto('https://soundcloud.com/messages');

		try {
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ timeout: 5_000 },
			);
			console.log(
				'GateRush: SoundCloud captcha present during login warm-up; solve it in the browser window if needed.',
			);
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ hidden: true, timeout: 120_000 },
			);
		} catch {
			// no captcha
		}

		await soundCloudPage.waitForSelector(Selectors.SOUNDCLOUD_LIBRARY_LINK, {
			timeout: 30_000,
		});
		await Promise.all([
			soundCloudPage.click(Selectors.SOUNDCLOUD_LIBRARY_LINK),
			soundCloudPage.waitForNavigation({ waitUntil: 'domcontentloaded' }),
		]);
		await soundCloudPage.waitForFunction(() =>
			window.location.href.includes('/you/library'),
		);
		await soundCloudPage.close();
	}

	async downloadAudio(url: string): Promise<string | null> {
		console.log('Navigating to GateRush gate...');
		this.emitProgress('handling_gates', 'Navigating to GateRush gate...', 25);

		const page = await this.browser.newPage();
		this.downloadFilename = null;
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(url, { waitUntil: 'domcontentloaded' });
			await page.waitForSelector(Selectors.GATERUSH_STEP);
			await this.dismissCookieBanner(page);

			while (true) {
				const next = await page.waitForFunction(
					(selectors) => {
						const download = document.querySelector<HTMLButtonElement>(
							selectors.GATERUSH_DOWNLOAD_BUTTON,
						);
						if (download && !download.disabled) return 'download';
						const step = document.querySelector(selectors.GATERUSH_STEP);
						if (!step || step.classList.contains('leaving')) return false;
						if (step.querySelector(selectors.GATERUSH_EMAIL_INPUT))
							return 'email';
						if (document.querySelector(selectors.GATERUSH_SC_CONNECT))
							return 'soundcloud';
						if (document.querySelector(selectors.GATERUSH_IG_ACCOUNT_BUTTON))
							return 'instagram';
						return 'unsupported';
					},
					{ timeout: 60_000 },
					Selectors,
				);
				const step = await next.jsonValue();
				await next.dispose();
				if (step === 'download') break;

				if (step === 'email') {
					this.emitProgress(
						'handling_gates',
						'Submitting GateRush email...',
						30,
						{
							currentGate: 'email',
						},
					);
					await this.handleEmail(page);
				} else if (step === 'soundcloud') {
					this.emitProgress(
						'handling_gates',
						'Connecting SoundCloud on GateRush...',
						45,
						{ currentGate: 'sc' },
					);
					await this.handleSoundcloudConnect(page);
				} else if (step === 'instagram') {
					this.emitProgress(
						'handling_gates',
						'Handling GateRush Instagram follows...',
						60,
						{ currentGate: 'ig' },
					);
					await this.handleInstagram(page);
				} else {
					const title = await page.$eval(
						`${Selectors.GATERUSH_STEP} .step-title`,
						(el) => el.textContent?.trim(),
					);
					throw new Error(`Unsupported GateRush step: ${title || 'unknown'}`);
				}
			}

			await this.handleDownload(page);
			return this.downloadFilename;
		} finally {
			await page.close().catch(() => {});
		}
	}

	async close() {
		this.cancelPendingDownloadWait?.();
		this.cancelPendingDownloadWait = null;
		await this.browserLaunch.close();
	}

	private async dismissCookieBanner(page: Page) {
		if (!(await page.$(Selectors.GATERUSH_COOKIE_REJECT))) return;
		const reloads = await page.$eval(
			'#cookieAdToggle',
			(el) => (el as HTMLInputElement).checked,
		);
		// Rejecting the default advertising consent reloads the gate.
		await Promise.all([
			reloads
				? page.waitForNavigation({ waitUntil: 'domcontentloaded' })
				: Promise.resolve(),
			page.$eval(Selectors.GATERUSH_COOKIE_REJECT, (el) =>
				(el as HTMLButtonElement).click(),
			),
		]);
		await page.waitForSelector(Selectors.GATERUSH_STEP);
	}

	private async handleEmail(page: Page) {
		const fillInput = async (selector: string, value: string) => {
			await page.evaluate(
				(sel, val) => {
					const el = document.querySelector<HTMLInputElement>(sel);
					if (!el) return;
					const setter = Object.getOwnPropertyDescriptor(
						window.HTMLInputElement.prototype,
						'value',
					)?.set;
					setter?.call(el, val);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				},
				selector,
				value,
			);
		};

		const nameInput = await page.$(Selectors.GATERUSH_NAME_INPUT);
		if (nameInput) {
			if (!this.config.name) {
				throw new Error(
					'This GateRush gate requires a name. Set HYPEDDIT_NAME in your .env file.',
				);
			}
			await fillInput(Selectors.GATERUSH_NAME_INPUT, this.config.name);
		}

		const emailInput = await page.$(Selectors.GATERUSH_EMAIL_INPUT);
		if (emailInput) {
			if (!this.config.email) {
				throw new Error(
					'This GateRush gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
				);
			}
			await fillInput(Selectors.GATERUSH_EMAIL_INPUT, this.config.email);
		}

		// Humanized pointer clicks can miss this button on the redesigned layout.
		await page.$eval(Selectors.GATERUSH_EMAIL_SUBMIT, (button) =>
			(button as HTMLButtonElement).click(),
		);

		await page.waitForFunction(
			(selector) => {
				const btn = document.querySelector<HTMLButtonElement>(selector);
				return (
					!btn?.disabled || btn.closest('.step')?.classList.contains('leaving')
				);
			},
			{ timeout: 30_000 },
			Selectors.GATERUSH_EMAIL_SUBMIT,
		);

		const failed = await page.evaluate((selector) => {
			const btn = document.querySelector(selector);
			return !!btn && !btn.closest('.step')?.classList.contains('leaving');
		}, Selectors.GATERUSH_EMAIL_SUBMIT);
		if (failed) {
			throw new Error('GateRush email step did not complete');
		}
		await page.waitForSelector(Selectors.GATERUSH_EMAIL_INPUT, {
			hidden: true,
		});
	}

	private async handleSoundcloudConnect(page: Page) {
		const commentInput = await page.$(Selectors.GATERUSH_COMMENT_INPUT);
		if (commentInput) {
			if (!this.config.comment.trim()) {
				throw new Error(
					'SC_COMMENT is required for GateRush SoundCloud connect.',
				);
			}
			await page.evaluate(
				(selector, value) => {
					const el = document.querySelector<HTMLInputElement>(selector);
					if (!el) return;
					const setter = Object.getOwnPropertyDescriptor(
						window.HTMLInputElement.prototype,
						'value',
					)?.set;
					setter?.call(el, value);
					el.dispatchEvent(new Event('input', { bubbles: true }));
					el.dispatchEvent(new Event('change', { bubbles: true }));
				},
				Selectors.GATERUSH_COMMENT_INPUT,
				this.config.comment,
			);
			await timeout(200);
		}

		await page.waitForFunction(
			(selector) => {
				const btn = document.querySelector<HTMLButtonElement>(selector);
				return !!btn && !btn.disabled;
			},
			{},
			Selectors.GATERUSH_SC_CONNECT,
		);

		// Single DOM click — page.click() can double-fire under CloakBrowser humanize.
		await page.evaluate((selector) => {
			document.querySelector<HTMLButtonElement>(selector)?.click();
		}, Selectors.GATERUSH_SC_CONNECT);

		await this.completeSoundcloudOauth(page);

		if (!page.url().includes('gaterush.me')) {
			throw new Error(
				'GateRush redirected this tab for SoundCloud OAuth (popup blocked). Re-run with popups allowed or non-headless.',
			);
		}

		await page.waitForSelector(Selectors.GATERUSH_SC_CONNECT, {
			hidden: true,
			timeout: 90_000,
		});
	}

	/**
	 * Wait for SoundCloud authorize + #submit_approval, approve it, then wait for
	 * GateRush to mark the SoundCloud step complete. Never force-closes Allow.
	 */
	private async completeSoundcloudOauth(gatePage: Page) {
		const startedAt = Date.now();
		let deadline = Date.now() + 120_000;
		let lastLog = 0;
		let lastAllowAt = 0;
		let retryAfterLogin = false;
		let retriedAfterLogin = false;

		while (Date.now() < deadline) {
			if (!gatePage.isClosed()) {
				const gateDone = await gatePage
					.evaluate((selectors) => {
						const step = document.querySelector(selectors.GATERUSH_STEP);
						return (
							!!step && !document.querySelector(selectors.GATERUSH_SC_CONNECT)
						);
					}, Selectors)
					.catch(() => false);
				if (gateDone) {
					await saveSoundcloudLogin(gatePage.browserContext());
					console.log('GateRush: SoundCloud step marked completed.');
					return;
				}
			}

			for (const candidate of await this.browser.pages(true)) {
				if (!(await isSoundcloudLoginPage(candidate))) continue;
				await waitForSoundcloudLogin(candidate, {
					interactive: this.config.browserMode === 'headed',
					onWaiting: () =>
						this.emitProgress(
							'handling_gates',
							'Log in to SoundCloud in the browser to continue...',
							50,
							{ currentGate: 'soundcloud', browserActive: true },
						),
				});
				// GateRush stops watching its popup after 60 seconds, even while
				// the user is still signing in. Finish that popup before retrying.
				retryAfterLogin =
					!retriedAfterLogin && Date.now() - startedAt >= 60_000;
				deadline = Date.now() + 120_000;
				break;
			}

			const authorizePage = await this.findAuthorizePageWithAllow();
			if (authorizePage) {
				// Retry Allow if the form is still up after a previous attempt.
				const canRetry = Date.now() - lastAllowAt > 4_000;
				if (lastAllowAt === 0 || canRetry) {
					const method = await this.clickSoundcloudAllow(authorizePage);
					console.log(
						`GateRush: Allow → ${method} (${authorizePage.url().slice(0, 100)})`,
					);
					if (method !== 'miss') {
						lastAllowAt = Date.now();
						await timeout(2_000);
						continue;
					}
				}
			}

			if (retryAfterLogin) {
				const oauthOpen = (await this.browser.pages(true)).some((candidate) => {
					if (candidate.isClosed() || candidate === gatePage) return false;
					const url = new URL(candidate.url());
					return (
						url.hostname === 'secure.soundcloud.com' ||
						url.pathname === '/callback/soundcloud'
					);
				});
				if (!oauthOpen) {
					const retried = await gatePage.$$eval(
						Selectors.GATERUSH_SC_CONNECT,
						(buttons) => {
							const button = buttons[0] as HTMLButtonElement | undefined;
							if (!button) return false;
							button.click();
							return true;
						},
					);
					if (retried) {
						retryAfterLogin = false;
						retriedAfterLogin = true;
						lastAllowAt = 0;
						deadline = Date.now() + 120_000;
						continue;
					}
				}
			}

			if (Date.now() - lastLog > 5_000) {
				const urls = (await this.browser.pages(true)).map((p) =>
					p.isClosed() ? '(closed)' : p.url(),
				);
				console.log('GateRush OAuth waiting…', urls.join(' | '));
				lastLog = Date.now();
			}

			await timeout(400);
		}

		throw new Error(
			'Timed out waiting for SoundCloud OAuth Allow / GateRush callback.',
		);
	}

	/** Fresh handle for authorize tab that has visible #submit_approval. */
	private async findAuthorizePageWithAllow(): Promise<Page | null> {
		const pages = (await this.browser.pages(true)).filter((p) => !p.isClosed());

		for (const candidate of [...pages].reverse()) {
			if (!/secure\.soundcloud\.com\/authorize/i.test(candidate.url())) {
				continue;
			}
			try {
				for (const frame of candidate.frames()) {
					const hasAllow = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
					if (hasAllow) {
						await hasAllow.dispose().catch(() => {});
						return candidate;
					}
				}
			} catch {
				// detached / navigating
			}
		}

		return null;
	}

	/**
	 * Live authorize HTML:
	 * <form class="connect-form approve-authorize-form">
	 *   <button type="submit" id="submit_approval">Allow</button>
	 * </form>
	 * CloakBrowser ignores plain DOM click() — prefer Puppeteer pointer click.
	 */
	private async clickSoundcloudAllow(oauthPage: Page): Promise<string> {
		try {
			await oauthPage.bringToFront();
		} catch {
			// ignore
		}

		for (const frame of oauthPage.frames()) {
			try {
				const submit = await frame.$(Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (!submit) continue;
				await Promise.race([submit.click({ delay: 40 }), timeout(4_000)]);
				await submit.dispose().catch(() => {});
				return 'trusted-click';
			} catch {
				// frame detached / navigating
			}
		}

		for (const frame of oauthPage.frames()) {
			try {
				const method = await frame.evaluate((selector) => {
					const submit = document.querySelector(
						selector,
					) as HTMLButtonElement | null;
					if (!submit) return null;
					const form = submit.closest('form');
					if (form && typeof form.requestSubmit === 'function') {
						form.requestSubmit(submit);
						return 'requestSubmit';
					}
					submit.click();
					return 'dom-click';
				}, Selectors.SC_SUBMIT_APPROVAL_BUTTON);
				if (method) return method;
			} catch {
				// frame detached / navigating
			}
		}

		return 'miss';
	}

	private async handleInstagram(page: Page) {
		const deadline = Date.now() + 120_000;
		let previousIndex = -1;
		let repeats = 0;
		while (Date.now() < deadline) {
			const nextIndex = await page.evaluate((selector) => {
				const buttons = Array.from(
					document.querySelectorAll<HTMLButtonElement>(selector),
				);
				return buttons.findIndex(
					(btn) => !btn.disabled && !btn.classList.contains('done'),
				);
			}, Selectors.GATERUSH_IG_ACCOUNT_BUTTON);

			if (nextIndex < 0) {
				break;
			}

			repeats = nextIndex === previousIndex ? repeats + 1 : 0;
			previousIndex = nextIndex;
			if (repeats >= 3) {
				throw new Error(
					`GateRush Instagram step stalled on account button ${nextIndex}`,
				);
			}

			const pagesBefore = new Set(await this.browser.pages(true));

			const singleButton = await page.evaluate(
				(selector, index) => {
					const buttons = Array.from(
						document.querySelectorAll<HTMLButtonElement>(selector),
					);
					buttons[index]?.click();
					return buttons[index]?.classList.contains('btn-instagram');
				},
				Selectors.GATERUSH_IG_ACCOUNT_BUTTON,
				nextIndex,
			);

			let popup: Page | undefined;
			const started = Date.now();
			while (!popup && Date.now() - started < 5_000) {
				const pages = await this.browser.pages(true);
				popup = pages.find(
					(candidate) =>
						candidate !== page &&
						!pagesBefore.has(candidate) &&
						candidate.url() !== 'about:blank',
				);
				if (!popup) {
					popup = pages.find(
						(candidate) =>
							candidate !== page &&
							!candidate.url().includes('gaterush.me') &&
							candidate.url() !== 'about:blank',
					);
				}
				if (!popup) await timeout(200);
			}

			if (popup && !popup.isClosed()) {
				try {
					await popup.close();
				} catch {
					// already closed
				}
			}

			if (singleButton) break;
			await timeout(500);
		}

		if (Date.now() >= deadline) {
			throw new Error('GateRush Instagram step timed out');
		}

		// Wait for IG step completion (server-side gate-step POST)
		await page.waitForSelector(Selectors.GATERUSH_IG_ACCOUNT_BUTTON, {
			hidden: true,
			timeout: 30_000,
		});
	}

	private async handleDownload(page: Page) {
		this.emitProgress('handling_gates', 'Preparing GateRush download...', 75);

		const client = await page.createCDPSession();
		await client.send('Browser.setDownloadBehavior', {
			behavior: 'allow',
			downloadPath: './downloads',
			eventsEnabled: true,
		});

		let downloadGuid: string | null = null;
		let downloadCompleteResolve: (value: string) => void;
		let downloadCompleteReject: (reason: Error) => void;
		const downloadCompletePromise = new Promise<string>((resolve, reject) => {
			downloadCompleteResolve = resolve;
			downloadCompleteReject = reject;
		});
		const cancelPendingDownloadWait = () => {
			downloadCompleteReject(new Error('Download was canceled'));
		};
		this.cancelPendingDownloadWait = cancelPendingDownloadWait;
		const downloadTimer = setTimeout(
			() =>
				downloadCompleteReject(
					new Error('GateRush download did not complete in time'),
				),
			10 * 60_000,
		);

		const pBar = new SingleBar(
			{
				format:
					'{prefix} {bar} {percentage}% | {current_mb}/{total_mb} MB | ETA: {eta_formatted}',
				hideCursor: true,
			},
			{
				barCompleteChar: '█',
				barIncompleteChar: '░',
				format: Presets.shades_classic.format,
			},
		);

		client.on('Browser.downloadWillBegin', (event) => {
			downloadGuid = event.guid;
			this.downloadFilename = event.suggestedFilename;
			console.log('Download started:', this.downloadFilename);
			this.emitProgress(
				'downloading',
				`Downloading ${this.downloadFilename}...`,
				0,
			);
		});

		client.on('Browser.downloadProgress', (event) => {
			if (event.guid !== downloadGuid || !this.downloadFilename) return;
			if (event.state === 'completed') {
				pBar.stop();
				console.log('Download completed');
				this.emitProgress('downloading', 'Download complete', 100);
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
				this.emitProgress(
					'downloading',
					`Downloading... ${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
					0,
					{ downloadBytes: receivedBytes, totalBytes },
				);
			} else if (event.state === 'canceled') {
				pBar.stop();
				downloadCompleteReject(new Error('Download was canceled'));
			}
		});

		const clickDownload = async () => {
			await page.click(Selectors.GATERUSH_DOWNLOAD_BUTTON);
		};

		const retryTimer = setTimeout(async () => {
			if (!downloadGuid) {
				console.log(
					'Download not started after 10 seconds, clicking button again...',
				);
				try {
					await clickDownload();
				} catch {
					// ignore retry errors
				}
			}
		}, 10_000);

		try {
			await Promise.all([clickDownload(), downloadCompletePromise]);
		} finally {
			if (this.cancelPendingDownloadWait === cancelPendingDownloadWait) {
				this.cancelPendingDownloadWait = null;
			}
			clearTimeout(downloadTimer);
			clearTimeout(retryTimer);
			pBar.stop();
			await client.detach().catch(() => {});
		}
	}
}
