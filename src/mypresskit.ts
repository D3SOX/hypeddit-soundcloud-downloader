import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Presets, SingleBar } from 'cli-progress';
import type { Browser, Page } from 'puppeteer';
import {
	browserModeToLaunchOptions,
	CancellableBrowserLaunch,
} from './browserLaunch';
import type { ProgressCallback } from './hypeddit';
import { safeFetch } from './safeOutboundUrl';
import Selectors from './selectors';
import { waitForSoundcloudLogin } from './soundcloudLogin';
import type { HypedditConfig } from './types';
import { loadCookies, sanitizeFilenamePart, timeout } from './utils';

const SC_AUTHORIZE_RE = /secure\.soundcloud\.com\/authorize/i;
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type GateStep = {
	index: number;
	type: string;
	targetUrl: string | null;
	required: boolean;
};

type VerifyBody = {
	unlockState?: { unlocked?: boolean; remaining?: number[]; total?: number };
	completedStepIndexes?: number[];
	downloadToken?: string | null;
	capturedEmail?: string | null;
};

function filenameFromContentDisposition(value: string | null): string | null {
	if (!value) return null;
	const star = value.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
	if (star) {
		const raw = star.replace(/["']/g, '');
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}
	const plain = value.match(/filename=["']?([^"';]+)["']?/i)?.[1];
	return plain ? plain.trim() : null;
}

function safeDecodeURIComponent(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function safePageUrl(page: Page): string {
	try {
		if (page.isClosed()) return '';
		return page.url();
	} catch {
		return '';
	}
}

export class MypresskitDownloader {
	private browser!: Browser;
	private readonly browserLaunch = new CancellableBrowserLaunch();
	private config: HypedditConfig;
	private progressCallback: ProgressCallback | null = null;
	private readonly downloadAbortController = new AbortController();

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
		this.browser = await this.browserLaunch.launch({
			...browserModeToLaunchOptions(this.config.browserMode),
			userDataDir: this.config.userDataDir ?? './browser-data',
			// SC OAuth authorize popup shares session cookies more reliably with this.
			args: ['--fingerprint-allow-3p-cookies'],
		});

		const browserContext = this.browser.defaultBrowserContext();
		const soundCloudCookies = await loadCookies('soundcloud-cookies.json');
		await browserContext.setCookie(...soundCloudCookies);
	}

	async prepareLogins() {
		const soundCloudPage = await this.browser.newPage();
		await soundCloudPage.setViewport({ width: 1920, height: 1080 });
		await soundCloudPage.goto('https://soundcloud.com/messages');

		try {
			await soundCloudPage.waitForSelector(
				Selectors.SOUNDCLOUD_CAPTCHA_CONTAINER,
				{ timeout: 5_000 },
			);
			console.log(
				'MyPressKit: SoundCloud captcha present during login warm-up; solve it in the browser window if needed.',
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
		console.log('Navigating to MyPressKit gate...');
		this.emitProgress('handling_gates', 'Navigating to MyPressKit gate...', 25);

		const page = await this.browser.newPage();
		try {
			await page.setViewport({ width: 1920, height: 1080 });
			await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
			try {
				await page.waitForNetworkIdle({ timeout: 15_000, idleTime: 10 });
			} catch {
				// continue
			}

			await this.dismissCookies(page);
			const gate = await this.parseGate(page);
			if (!gate.id) {
				throw new Error('MyPressKit: could not determine gate id from page.');
			}
			console.log(
				`MyPressKit gate ${gate.id} (${gate.handle ?? 'unknown'}) — ${gate.steps.length} steps`,
			);

			const stepsByIndex = new Map(gate.steps.map((s) => [s.index, s]));
			for (let round = 0; round < 12; round++) {
				const verify = await this.readVerify(page, gate.id);
				if (verify.downloadToken && verify.unlockState?.unlocked) {
					console.log('MyPressKit unlocked');
					return await this.downloadWithToken(
						page,
						gate.id,
						verify.downloadToken,
						url,
					);
				}

				const remaining = (verify.unlockState?.remaining ?? []).map(Number);
				if (remaining.length === 0) {
					if (verify.downloadToken) {
						return await this.downloadWithToken(
							page,
							gate.id,
							verify.downloadToken,
							url,
						);
					}
					break;
				}

				const stepIndex = remaining[0];
				if (stepIndex === undefined) break;
				const step = stepsByIndex.get(stepIndex) ?? {
					index: stepIndex,
					type: 'soundcloud-follow',
					targetUrl: null,
					required: true,
				};
				console.log(
					`MyPressKit remaining=${JSON.stringify(remaining)} → step ${step.index} (${step.type})`,
				);
				this.emitProgress(
					'handling_gates',
					`MyPressKit: ${step.type}...`,
					35 + Math.min(40, round * 5),
					{
						currentGate: step.type.startsWith('soundcloud-') ? 'sc' : 'social',
					},
				);

				await this.runStep(page, gate.id, step);
				await this.waitForStepProgress(page, gate.id, step.index, verify);
			}

			const finalVerify = await this.readVerify(page, gate.id);
			if (finalVerify.downloadToken) {
				return await this.downloadWithToken(
					page,
					gate.id,
					finalVerify.downloadToken,
					url,
				);
			}
			throw new Error(
				'MyPressKit download never unlocked after completing gate steps.',
			);
		} finally {
			if (!page.isClosed()) {
				await page.close().catch(() => {});
			}
		}
	}

	async close() {
		this.downloadAbortController.abort();
		await this.browserLaunch.close();
	}

	private async dismissCookies(page: Page) {
		await page
			.evaluate(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const accept = buttons.find((b) =>
					/accept all/i.test((b.textContent || '').trim()),
				);
				accept?.click();
			})
			.catch(() => {});
	}

	private async parseGate(page: Page): Promise<{
		id: string | null;
		handle: string | null;
		steps: GateStep[];
	}> {
		await page
			.waitForFunction(
				() =>
					!!document.querySelector('audio[src*="/api/download-gates/"]') ||
					Array.from(document.querySelectorAll('button')).some((b) =>
						/follow on soundcloud|repost track|like track|comment on track|complete all steps/i.test(
							(b.textContent || '').trim(),
						),
					),
				{ timeout: 30_000 },
			)
			.catch(() => {});

		return page.evaluate(() => {
			const html = document.documentElement.innerHTML;
			const handle = location.pathname.match(/\/gate\/([^/?#]+)/)?.[1] ?? null;
			const fromAudio = document
				.querySelector('audio[src*="/api/download-gates/"]')
				?.getAttribute('src')
				?.match(/\/api\/download-gates\/(\d+)\//)?.[1];
			const fromHtml = html.match(/\/api\/download-gates\/(\d+)\//)?.[1];
			const fromJson = html.match(/"id":(\d+),"handle":"[^"]+","title":/)?.[1];
			const id = fromAudio || fromHtml || fromJson || null;

			let steps: GateStep[] = [];
			const rawCandidates = [
				...html.matchAll(/\\"gateSteps\\":(\[[\s\S]*?\])/g),
				...html.matchAll(/"gateSteps":(\[[\s\S]*?\])/g),
			];
			for (const match of rawCandidates) {
				let raw = match[1];
				if (!raw) continue;
				if (raw.includes('\\"')) {
					raw = raw
						.replace(/\\"/g, '"')
						.replace(/\\\\/g, '\\')
						.replace(/\\n/g, '\n');
				}
				try {
					const parsed = JSON.parse(raw) as GateStep[];
					if (Array.isArray(parsed) && parsed.length > 0) {
						steps = parsed;
						break;
					}
				} catch {
					// try next
				}
			}

			return { id, handle, steps };
		});
	}

	private async readVerify(page: Page, gateId: string): Promise<VerifyBody> {
		const result = await page.evaluate(async (id) => {
			const res = await fetch(
				`/api/download-gates/${encodeURIComponent(id)}/verify-step`,
				{ credentials: 'include', signal: AbortSignal.timeout(15_000) },
			);
			if (!res.ok) {
				return { ok: false as const, status: res.status };
			}
			return { ok: true as const, body: (await res.json()) as VerifyBody };
		}, gateId);
		if (!result.ok) {
			throw new Error(`MyPressKit verify-step failed (${result.status})`);
		}
		return result.body;
	}

	private async runStep(page: Page, gateId: string, step: GateStep) {
		if (step.type === 'email-capture') {
			await this.submitEmail(page, gateId, step.index);
			return;
		}

		if (step.type.startsWith('spotify-')) {
			throw new Error(
				`MyPressKit Spotify steps are not supported yet (got “${step.type}”).`,
			);
		}

		if (step.type.startsWith('soundcloud-')) {
			await this.runOauthStep(page, gateId, step);
			return;
		}

		// Generic social / open-link step
		await page.evaluate(
			async (id, stepIndex) => {
				await fetch(
					`/api/download-gates/${encodeURIComponent(id)}/track-step`,
					{
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						credentials: 'include',
						body: JSON.stringify({ stepIndex }),
						signal: AbortSignal.timeout(15_000),
					},
				);
			},
			gateId,
			step.index,
		);
	}

	private async submitEmail(page: Page, gateId: string, stepIndex: number) {
		const email = this.config.email?.trim();
		if (!email) {
			throw new Error(
				'This MyPressKit gate requires an email. Set HYPEDDIT_EMAIL in your .env file.',
			);
		}
		await page.evaluate(
			async (id, index, value) => {
				const input = document.querySelector(
					'input[type="email"]',
				) as HTMLInputElement | null;
				if (input) {
					const setter = Object.getOwnPropertyDescriptor(
						HTMLInputElement.prototype,
						'value',
					)?.set;
					setter?.call(input, value);
					input.dispatchEvent(new Event('input', { bubbles: true }));
					input.dispatchEvent(new Event('change', { bubbles: true }));
				}
				await fetch(`/api/download-gates/${encodeURIComponent(id)}/email`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					credentials: 'include',
					body: JSON.stringify({ email: value, stepIndex: index }),
					signal: AbortSignal.timeout(15_000),
				});
			},
			gateId,
			stepIndex,
			email,
		);
	}

	private async runOauthStep(page: Page, gateId: string, step: GateStep) {
		if (step.type === 'soundcloud-comment') {
			const comment = this.config.comment.trim();
			if (comment.length < 2) {
				throw new Error(
					'This MyPressKit gate requires SC_COMMENT (at least 2 characters).',
				);
			}
			await page.evaluate((text) => {
				const ta = document.querySelector(
					'textarea',
				) as HTMLTextAreaElement | null;
				if (!ta) return;
				const setter = Object.getOwnPropertyDescriptor(
					HTMLTextAreaElement.prototype,
					'value',
				)?.set;
				setter?.call(ta, text);
				ta.dispatchEvent(new Event('input', { bubbles: true }));
				ta.dispatchEvent(new Event('change', { bubbles: true }));
			}, comment);
		}

		const popupPromise = new Promise<Page | null>((resolve) => {
			const onTarget = async (target: { page: () => Promise<Page | null> }) => {
				const p = await target.page().catch(() => null);
				if (!p) return;
				clearTimeout(timer);
				this.browser.off('targetcreated', onTarget);
				resolve(p);
			};
			const timer = setTimeout(() => {
				this.browser.off('targetcreated', onTarget);
				resolve(null);
			}, 20_000);
			this.browser.on('targetcreated', onTarget);
		});

		const openMethod = await page.evaluate(
			(stepIndex, stepType, comment, id) => {
				const labels: Record<string, RegExp> = {
					'soundcloud-follow': /follow on soundcloud/i,
					'soundcloud-repost': /repost/i,
					'soundcloud-like': /like track/i,
					'soundcloud-comment': /comment on track/i,
				};
				const re = labels[stepType];
				const buttons = Array.from(
					document.querySelectorAll('button'),
				) as HTMLButtonElement[];
				const btn = re
					? buttons.find(
							(b) => !b.disabled && re.test((b.textContent || '').trim()),
						)
					: null;
				if (btn) {
					btn.click();
					return 'ui';
				}
				const params = new URLSearchParams({
					gate: id,
					step: String(stepIndex),
					popup: '1',
				});
				if (stepType === 'soundcloud-comment') params.set('comment', comment);
				window.open(
					`/api/download-gates/oauth/soundcloud/start?${params}`,
					'mpk-gate-oauth',
					'width=520,height=720',
				);
				return 'direct';
			},
			step.index,
			step.type,
			this.config.comment.trim(),
			gateId,
		);
		console.log(`MyPressKit OAuth open (${openMethod}) for step ${step.index}`);

		let oauthPage = await popupPromise;
		if (!oauthPage) oauthPage = await this.findSoundcloudOauthPage();
		if (oauthPage) {
			await this.completeSoundcloudOauth(oauthPage);
		} else {
			console.log('MyPressKit: no OAuth popup — polling verify-step');
		}
	}

	private async waitForStepProgress(
		page: Page,
		gateId: string,
		stepIndex: number,
		before: VerifyBody,
	) {
		const beforeSet = new Set((before.completedStepIndexes ?? []).map(Number));
		const deadline = Date.now() + 90_000;
		while (Date.now() < deadline) {
			const verify = await this.readVerify(page, gateId);
			if (verify.downloadToken && verify.unlockState?.unlocked) return;
			const completed = new Set(
				(verify.completedStepIndexes ?? []).map(Number),
			);
			if (completed.has(stepIndex) && !beforeSet.has(stepIndex)) {
				console.log(`MyPressKit step ${stepIndex} complete`);
				return;
			}
			const remaining = (verify.unlockState?.remaining ?? []).map(Number);
			if (!remaining.includes(stepIndex)) {
				console.log(`MyPressKit step ${stepIndex} no longer remaining`);
				return;
			}
			await timeout(1000);
		}
		throw new Error(
			`MyPressKit timed out waiting for step ${stepIndex} to complete.`,
		);
	}

	private async findSoundcloudOauthPage(): Promise<Page | null> {
		for (const candidate of await this.browser.pages()) {
			if (candidate.isClosed()) continue;
			if (SC_AUTHORIZE_RE.test(safePageUrl(candidate))) return candidate;
		}
		return null;
	}

	private async completeSoundcloudOauth(startPage: Page) {
		const hardDeadline = Date.now() + 12 * 60_000;
		let deadline = Date.now() + 180_000;
		let lastAllowAt = 0;
		let sawAuthorize = false;
		let allowClicks = 0;

		while (Date.now() < deadline) {
			const oauthPage =
				(await this.findSoundcloudOauthPage()) ??
				(SC_AUTHORIZE_RE.test(safePageUrl(startPage)) && !startPage.isClosed()
					? startPage
					: null);

			if (oauthPage && !oauthPage.isClosed()) {
				sawAuthorize = true;
				const canRetry = Date.now() - lastAllowAt > 3_000;
				if (lastAllowAt === 0 || canRetry) {
					const allowed = await this.clickSoundcloudOauthAllow(oauthPage);
					if (allowed) {
						deadline = Math.min(
							hardDeadline,
							Math.max(deadline, Date.now() + 120_000),
						);
						allowClicks += 1;
						lastAllowAt = Date.now();
						console.log(
							`MyPressKit: SoundCloud Allow clicked (${allowClicks})`,
						);
						await timeout(1_500);
						continue;
					}
				}
				await timeout(400);
				continue;
			}

			if (sawAuthorize || startPage.isClosed()) {
				await timeout(800);
				return;
			}
			await timeout(400);
		}

		throw new Error(
			'Timed out waiting for SoundCloud OAuth Allow / MyPressKit callback.',
		);
	}

	private async clickSoundcloudOauthAllow(oauthPage: Page): Promise<boolean> {
		await oauthPage.bringToFront().catch(() => {});

		await waitForSoundcloudLogin(oauthPage, {
			interactive: this.config.browserMode !== 'headless',
			onWaiting: () => {
				this.emitProgress(
					'handling_gates',
					'Waiting for SoundCloud login in browser…',
					50,
					{ currentGate: 'soundcloud', browserActive: true },
				);
			},
		});

		const clicked = await oauthPage
			.evaluate(() => {
				const buttons = Array.from(document.querySelectorAll('button'));
				const allow = buttons.find((b) =>
					/^(allow|connect|authorize|accept)$/i.test(
						(b.textContent || '').trim(),
					),
				);
				if (allow) {
					(allow as HTMLButtonElement).click();
					return true;
				}
				const byId = document.querySelector(
					'button#submit_approval, button[name="accept"]',
				) as HTMLButtonElement | null;
				if (byId) {
					byId.click();
					return true;
				}
				return false;
			})
			.catch(() => false);

		return clicked;
	}

	private async downloadWithToken(
		page: Page,
		gateId: string,
		token: string,
		referer: string,
	): Promise<string> {
		this.emitProgress('handling_gates', 'Preparing MyPressKit download...', 75);
		const downloadUrl = `https://www.mypresskit.info/api/download-gates/${encodeURIComponent(gateId)}/download?token=${encodeURIComponent(token)}`;
		const cookies = await page.cookies(downloadUrl);
		const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');

		await mkdir('./downloads', { recursive: true });
		this.emitProgress('downloading', 'Downloading MyPressKit file...', 0);

		const { response, url: finalUrl } = await safeFetch(downloadUrl, {
			headers: {
				Cookie: cookieHeader,
				Referer: referer,
				'User-Agent': USER_AGENT,
				Accept: '*/*',
			},
			signal: AbortSignal.any([
				this.downloadAbortController.signal,
				AbortSignal.timeout(120_000),
			]),
		});

		if (!response.ok || !response.body) {
			throw new Error(
				`MyPressKit file download failed (${response.status} ${response.statusText}) from ${finalUrl}`,
			);
		}

		const fromHeader = filenameFromContentDisposition(
			response.headers.get('content-disposition'),
		);
		let suggested =
			sanitizeFilenamePart(basename(fromHeader || '')) ||
			sanitizeFilenamePart(
				safeDecodeURIComponent(basename(new URL(finalUrl).pathname)),
			) ||
			`mypresskit-${gateId}`;
		if (!/\.[a-z0-9]{2,5}$/i.test(suggested)) {
			suggested = `${suggested}.wav`;
		}

		const target = join('./downloads', suggested);
		const totalBytes = Number(response.headers.get('content-length')) || 0;
		const writer = Bun.file(target).writer();
		const reader = response.body.getReader();
		let received = 0;
		let completed = false;
		let lastProgressEmit = 0;
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

		const emitDownloadProgress = (force = false) => {
			const now = Date.now();
			if (
				!force &&
				now - lastProgressEmit < 250 &&
				!(totalBytes > 0 && received >= totalBytes)
			) {
				return;
			}
			lastProgressEmit = now;
			const currentMb = Number((received / 1024 / 1024).toFixed(2));
			if (totalBytes > 0) {
				if (pBar.isActive) {
					pBar.update(received, {
						total_mb: Number((totalBytes / 1024 / 1024).toFixed(2)),
						current_mb: currentMb,
					});
				} else {
					pBar.start(totalBytes, received, { prefix: 'Downloading' });
				}
				const percent = Math.min(100, (received / totalBytes) * 100);
				this.emitProgress(
					'downloading',
					`Downloading... ${currentMb.toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
					percent,
					{ downloadBytes: received, totalBytes },
				);
				return;
			}
			this.emitProgress(
				'downloading',
				`Downloading... ${currentMb.toFixed(1)} MB`,
				0,
				{ downloadBytes: received },
			);
		};

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				received += value.byteLength;
				if (received > MAX_DOWNLOAD_BYTES) {
					await reader.cancel();
					throw new Error(
						`MyPressKit download too large (${received} bytes; max ${MAX_DOWNLOAD_BYTES})`,
					);
				}
				writer.write(value);
				emitDownloadProgress();
			}
			await writer.end();
			completed = true;
			emitDownloadProgress(true);
			this.emitProgress('downloading', 'Download complete', 100, {
				downloadBytes: received,
				...(totalBytes > 0 ? { totalBytes } : {}),
			});
		} finally {
			pBar.stop();
			if (!completed) {
				try {
					await writer.end();
				} catch {
					// ignore
				}
				await rm(target, { force: true }).catch(() => {});
			}
		}

		console.log('MyPressKit saved:', target);
		return suggested;
	}
}
