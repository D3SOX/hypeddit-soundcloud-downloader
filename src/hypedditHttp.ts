import { join } from 'node:path';
import type { ProgressCallback } from './hypeddit';
import type { HypedditConfig } from './types';

// Steps whose Hypeddit "gate" is purely client-side: clicking through them only
// toggles CSS classes and, on the download request, declares the step as skipped
// via skip_gate_steps[]. The server performs no verification for these, so they
// can be satisfied without a browser. Steps that are actually verified server-side
// (e.g. Spotify `sp`, which needs a real OAuth authorization) are intentionally
// excluded so the caller falls back to the browser flow.
const BROWSERLESS_STEPS = new Set(['email', 'sc', 'ig', 'tk', 'yt', 'fb']);

const HYPEDDIT_ORIGIN = 'https://hypeddit.com';
const USER_AGENT =
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface GateData {
	csrfToken: string;
	gvt: string;
	uid: string;
	steps: string[];
	wrndk: string;
	fanGateId: string;
	isSkippable: string;
	externalId: string;
	duration: number;
}

function matchHiddenInput(html: string, id: string): string | null {
	const patterns = [
		new RegExp(`id=["']${id}["'][^>]*value=["']([^"']*)["']`),
		new RegExp(`value=["']([^"']*)["'][^>]*id=["']${id}["']`),
	];
	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1] !== undefined) {
			return match[1];
		}
	}
	return null;
}

function parseGateData(html: string): GateData | null {
	const csrfToken = html.match(
		/name=["']csrf-token["'][^>]*content=["']([^"']+)["']/,
	)?.[1];
	const gvt = matchHiddenInput(html, 'gvt');
	const uid = matchHiddenInput(html, 'current_download_file_listner');
	const rawSteps = matchHiddenInput(html, 'nwSteps');
	const wrndk = matchHiddenInput(html, 'wrndk');
	const fanGateId = matchHiddenInput(html, 'fan_gate_id');

	if (!csrfToken || !gvt || !uid || !rawSteps || !wrndk || !fanGateId) {
		return null;
	}

	const externalId =
		html.match(/externID["']?\s*:\s*["']([^"']+)["']/)?.[1] ?? '';
	const durationRaw = Number(matchHiddenInput(html, 'duration'));
	const duration =
		Number.isFinite(durationRaw) && durationRaw > 0
			? durationRaw
			: 3 * 60 * 1000;

	return {
		csrfToken,
		gvt,
		uid,
		steps: rawSteps.split(',').filter(Boolean),
		wrndk,
		fanGateId,
		isSkippable: matchHiddenInput(html, 'is_skippable') ?? '0',
		externalId,
		duration,
	};
}

// Smart-link selection pages list multiple platforms; follow the Hypeddit anchor.
function findSmartLinkHypedditUrl(html: string): string | null {
	const anchor = html.match(
		/<a[^>]*data-type=["']hypeddit["'][^>]*href=["']([^"']+)["']/,
	)?.[1];
	if (anchor) {
		return anchor;
	}
	return (
		html.match(
			/<a[^>]*href=["']([^"']+)["'][^>]*data-type=["']hypeddit["']/,
		)?.[1] ?? null
	);
}

function filenameFromContentDisposition(value: string | null): string | null {
	if (!value) {
		return null;
	}
	const star = value.match(/filename\*=(?:UTF-8'')?([^;]+)/i)?.[1];
	if (star) {
		return decodeURIComponent(star.replace(/["']/g, ''));
	}
	const plain = value.match(/filename=["']?([^"';]+)["']?/i)?.[1];
	return plain ? plain.trim() : null;
}

export class HypedditHttpDownloader {
	private readonly config: HypedditConfig;
	private readonly progressCallback: ProgressCallback | null;
	private cookies = new Map<string, string>();
	private csrfToken = '';

	constructor(config: HypedditConfig, progressCallback?: ProgressCallback) {
		this.config = config;
		this.progressCallback = progressCallback ?? null;
	}

	// Attempts to download the file without a browser. Returns the saved filename,
	// or null if the gate needs real verification and the browser flow must be used.
	async tryDownload(url: string): Promise<string | null> {
		try {
			const { html, finalUrl } = await this.fetchGatePage(url);
			const gate = parseGateData(html);
			if (!gate) {
				console.log(
					'Browserless: could not parse gate data, falling back to browser',
				);
				return null;
			}
			this.csrfToken = gate.csrfToken;

			const unsupported = gate.steps.filter(
				(step) => !BROWSERLESS_STEPS.has(step),
			);
			if (unsupported.length) {
				console.log(
					`Browserless: gate has steps requiring a browser (${unsupported.join(', ')}), falling back`,
				);
				return null;
			}

			console.log(
				`Browserless: attempting HTTP download for gates [${gate.steps.join(', ')}]`,
			);
			this.progressCallback?.(
				'handling_gates',
				'Handling gates without browser...',
				40,
			);

			await this.post('/gate/ge', finalUrl, {
				vt: gate.gvt,
				uid: gate.uid,
			});

			if (gate.steps.includes('email')) {
				await this.post('/verifyEmailAddress', finalUrl, {
					validateEmailAddress: this.config.email,
					fan_gate_id: gate.fanGateId,
					email_name: this.config.name,
					adcode: '',
					hypesource: '',
				});
			}

			const downloadUrl = await this.requestDownload(gate, finalUrl);
			if (!downloadUrl) {
				console.log(
					'Browserless: server did not grant download, falling back to browser',
				);
				return null;
			}

			return await this.saveFile(downloadUrl);
		} catch (error) {
			console.log(
				`Browserless attempt failed (${error instanceof Error ? error.message : 'unknown error'}), falling back to browser`,
			);
			return null;
		}
	}

	private async requestDownload(
		gate: GateData,
		referer: string,
	): Promise<string | null> {
		const body = new URLSearchParams({
			file: gate.uid,
			download_visit: 'true',
			profile_downloads: 'true',
			time: String(Math.floor(Math.random() * gate.duration)),
			sc_comment_text: '',
			yt_comment_text: '',
			page: 'nonsingle',
			is_skippable: gate.isSkippable,
			steps: gate.steps.join(','),
			email: this.config.email,
			download_action: 'DOWNLOAD',
			wrndk: gate.wrndk,
			is_mobile: '',
			external_id: gate.externalId,
			hypesource: '',
			adcode: '',
			gvf: '0',
		});
		// Every non-email step is a client-side gate; declare it as skipped.
		for (const step of gate.steps) {
			if (step !== 'email') {
				body.append('skip_gate_steps[]', step);
			}
		}

		const response = await this.post('/gate/download/ul', referer, body);
		const result = (await response.json()) as {
			download_status?: boolean;
			URL?: string;
		};
		if (result.download_status && result.URL) {
			return result.URL;
		}
		return null;
	}

	private async saveFile(downloadUrl: string): Promise<string> {
		this.progressCallback?.('downloading', 'Downloading file...', 76);
		const response = await fetch(downloadUrl);
		if (!response.ok) {
			throw new Error(`Download request failed: ${response.status}`);
		}

		const filename =
			filenameFromContentDisposition(
				response.headers.get('content-disposition'),
			) ??
			filenameFromContentDisposition(
				decodeURIComponent(downloadUrl).match(
					/response-content-disposition=([^&]+)/,
				)?.[1] ?? null,
			) ??
			'download';

		const totalBytes = Number(response.headers.get('content-length')) || 0;
		const writer = Bun.file(join('./downloads', filename)).writer();
		let receivedBytes = 0;
		let lastEmit = 0;

		if (response.body) {
			const reader = response.body.getReader();
			while (true) {
				const { done, value: chunk } = await reader.read();
				if (done) {
					break;
				}
				writer.write(chunk);
				receivedBytes += chunk.byteLength;

				// throttle progress events to avoid flooding the SSE stream
				const now = Date.now();
				if (now - lastEmit > 250 && totalBytes > 0) {
					lastEmit = now;
					const downloadPercent = receivedBytes / totalBytes;
					this.progressCallback?.(
						'downloading',
						`Downloading... ${(receivedBytes / 1024 / 1024).toFixed(1)} / ${(totalBytes / 1024 / 1024).toFixed(1)} MB`,
						76 + downloadPercent * 8,
						{ downloadBytes: receivedBytes, totalBytes },
					);
				}
			}
		}
		await writer.end();

		console.log(`Browserless: downloaded ${filename}`);
		this.progressCallback?.('downloading', 'Download complete', 85);
		return filename;
	}

	private async fetchGatePage(
		url: string,
	): Promise<{ html: string; finalUrl: string }> {
		this.progressCallback?.('handling_gates', 'Fetching Hypeddit gate...', 30);
		let finalUrl = url;
		let html = await this.get(finalUrl);

		// Follow a smart-link selection page to the actual Hypeddit gate.
		if (!matchHiddenInput(html, 'gvt')) {
			const smartLinkUrl = findSmartLinkHypedditUrl(html);
			if (smartLinkUrl) {
				console.log(`Browserless: following smart link to ${smartLinkUrl}`);
				finalUrl = smartLinkUrl;
				html = await this.get(finalUrl);
			}
		}

		return { html, finalUrl };
	}

	private async get(url: string): Promise<string> {
		const response = await fetch(url, {
			headers: { 'User-Agent': USER_AGENT },
			redirect: 'follow',
		});
		this.storeCookies(response);
		return await response.text();
	}

	private async post(
		path: string,
		referer: string,
		body: Record<string, string> | URLSearchParams,
	): Promise<Response> {
		const params =
			body instanceof URLSearchParams ? body : new URLSearchParams(body);
		const response = await fetch(`${HYPEDDIT_ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'User-Agent': USER_AGENT,
				'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
				Accept: 'application/json, text/javascript, */*; q=0.01',
				'X-Requested-With': 'XMLHttpRequest',
				'X-CSRF-TOKEN': this.csrfToken,
				Origin: HYPEDDIT_ORIGIN,
				Referer: referer,
				Cookie: this.cookieHeader(),
			},
			body: params.toString(),
		});
		this.storeCookies(response);
		return response;
	}

	private storeCookies(response: Response): void {
		const setCookie = response.headers.getSetCookie?.() ?? [];
		for (const entry of setCookie) {
			const pair = entry.split(';')[0] ?? '';
			const eq = pair.indexOf('=');
			if (eq > 0) {
				this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
			}
		}
	}

	private cookieHeader(): string {
		return Array.from(this.cookies.entries())
			.map(([name, value]) => `${name}=${value}`)
			.join('; ');
	}
}
