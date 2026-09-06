import { describe, expect, test } from 'bun:test';
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
