import { describe, expect, spyOn, test } from 'bun:test';
import type { Page } from 'puppeteer';
import { GaterushDownloader } from './gaterush';

describe('GaterushDownloader cancellation', () => {
	test('rejects a pending download wait before closing the browser', async () => {
		const downloader = new GaterushDownloader({
			comment: '',
			browserMode: 'headless',
		});
		let rejectPending = (_error: Error) => {};
		const pending = new Promise<void>((_resolve, reject) => {
			rejectPending = reject;
		});
		const settled = pending.catch((error: unknown) => error);
		let browserClosed = false;
		const events: string[] = [];

		Object.assign(downloader, {
			cancelPendingDownloadWait: () => {
				events.push('cancel');
				rejectPending(new Error('Download was canceled'));
			},
			browserLaunch: {
				close: async () => {
					events.push('close');
					browserClosed = true;
				},
			},
		});

		await downloader.close();

		expect(events).toEqual(['cancel', 'close']);
		expect(browserClosed).toBeTrue();
		expect(await settled).toEqual(new Error('Download was canceled'));
	});
});

describe('GateRush expired OAuth after interactive login', () => {
	test('reconnects after a slow login closes the expired popup', async () => {
		let now = 0;
		const clock = spyOn(Date, 'now').mockImplementation(() => now);
		let loginChecks = 0;
		let popupClosed = false;
		let reconnects = 0;
		const context = { cookies: async () => [] };
		const popup = {
			isClosed: () => popupClosed,
			url: () => 'https://secure.soundcloud.com/authorize',
			bringToFront: async () => {
				now = 61_000;
			},
			browserContext: () => context,
			evaluate: async () => {
				popupClosed = ++loginChecks >= 3;
				return {
					text: popupClosed ? '' : 'Sign in or create an account',
					hasApproval: false,
				};
			},
		};
		const gate = {
			isClosed: () => false,
			browserContext: () => context,
			evaluate: async () => reconnects > 0,
			$eval: async () => {
				reconnects++;
			},
		} as unknown as Page;
		const downloader = new GaterushDownloader({
			comment: '',
			browserMode: 'headed',
		});
		Object.assign(downloader, { browser: { pages: async () => [popup] } });
		try {
			// biome-ignore lint/complexity/useLiteralKeys: Test the private OAuth loop without exposing it publicly.
			await downloader['completeSoundcloudOauth'](gate);
			expect(reconnects).toBe(1);
			expect(popupClosed).toBeTrue();
		} finally {
			clock.mockRestore();
		}
	});
});
