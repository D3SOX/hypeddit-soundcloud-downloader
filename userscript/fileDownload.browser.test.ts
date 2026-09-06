import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchAppBrowser } from '../src/browserLaunch';

test.each([false, true])(
	'file download survives panel auto-close (separate API origin: %s)',
	async (separateApiOrigin) => {
		const appSource = await Bun.file(
			new URL('../webui/src/components/App.tsx', import.meta.url),
		).text();
		// Exercise the actual completion link and parent notification with the full
		// userscript, without running a gate or downloading somebody's track.
		const linkStart = appSource.lastIndexOf(
			'<a\n',
			appSource.indexOf("onClick={() => notifyParent('file-download')}"),
		);
		const linkEnd = appSource.indexOf('</a>', linkStart) + 4;
		const notifyStart = appSource.indexOf('function notifyParent(');
		const notifyEnd = appSource.indexOf('\n/**', notifyStart);
		expect(linkStart).toBeGreaterThan(0);
		expect(notifyStart).toBeGreaterThan(0);
		const bundle = await Bun.build({
			entrypoints: ['download-fixture'],
			target: 'browser',
			plugins: [
				{
					name: 'download-fixture',
					setup(build) {
						build.onResolve({ filter: /^react(?:-dom)?\// }, ({ path }) => ({
							path: Bun.resolveSync(
								path,
								new URL('../webui/', import.meta.url).pathname,
							),
						}));
						build.onResolve({ filter: /^download-fixture$/ }, () => ({
							path: 'download-fixture',
							namespace: 'fixture',
						}));
						build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
							loader: 'tsx',
							resolveDir: new URL('../webui', import.meta.url).pathname,
							contents: `
						import { createRoot } from 'react-dom/client';
						const API_BASE = location.origin${separateApiOrigin ? ".replace('localhost', '127.0.0.1')" : ''};
						const job = { jobId: 'fixture', outputFormat: 'mp3-320' };
						${appSource.slice(notifyStart, notifyEnd)}
						createRoot(document.getElementById('root')).render(${appSource.slice(linkStart, linkEnd)});
					`,
						}));
					},
				},
			],
		});
		expect(bundle.success).toBeTrue();
		const output = bundle.outputs[0];
		if (!output) throw new Error('Download fixture bundle is missing');
		const script = await output.text();
		const responseReady = Promise.withResolvers<void>();
		const fileRequested = Promise.withResolvers<void>();
		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				if (new URL(request.url).pathname.endsWith('/file')) {
					fileRequested.resolve();
					await responseReady.promise;
					return new Response('fixture audio', {
						headers: {
							'Content-Type': 'audio/mpeg',
							'Content-Disposition': 'attachment; filename="fixture.mp3"',
						},
					});
				}
				if (new URL(request.url).pathname === '/fixture.js') {
					return new Response(script, {
						headers: { 'Content-Type': 'text/javascript' },
					});
				}
				return new Response(
					'<div id="root"></div><script type="module" src="/fixture.js"></script>',
					{
						headers: { 'Content-Type': 'text/html' },
					},
				);
			},
		});
		const downloadPath = await mkdtemp(join(tmpdir(), 'sc-gate-dl-file-'));
		const browser = await launchAppBrowser({
			headless: true,
			humanize: false,
			// The user has already allowed the local Web UI to load in SoundCloud.
			args: ['--disable-features=LocalNetworkAccessChecks'],
		});
		try {
			const cdp = await browser.target().createCDPSession();
			await cdp.send('Browser.setDownloadBehavior', {
				behavior: 'allow',
				downloadPath,
				eventsEnabled: true,
			});
			const completed = Promise.withResolvers<string>();
			cdp.on('Browser.downloadProgress', (event) => {
				if (event.state !== 'inProgress') completed.resolve(event.state);
			});
			const page = await browser.newPage();
			await page.setRequestInterception(true);
			page.on('request', (request) => {
				if (request.url().startsWith('https://soundcloud.com/')) {
					void request.respond({
						contentType: 'text/html',
						body: '<html><body>SoundCloud fixture</body></html>',
					});
				} else void request.continue();
			});
			await page.goto('https://soundcloud.com/artist/track');
			const base = `http://localhost:${server.port}`;
			await page.evaluate((base) => {
				localStorage.setItem('sc-gate-dl-webui-base', base);
			}, base);
			await page.evaluate(
				await Bun.file(new URL('./sc-gate-dl.user.js', import.meta.url)).text(),
			);
			await page.evaluate((base) => {
				const panel = document.createElement('div');
				panel.id = 'sc-gate-dl-panel';
				const iframe = document.createElement('iframe');
				iframe.src = base;
				panel.appendChild(iframe);
				document.body.appendChild(panel);
			}, base);
			const frame = await page.waitForFrame((frame) =>
				frame.url().startsWith(base),
			);
			await frame.waitForSelector('a');
			await frame.$eval('a', (link) => link.click());
			await Promise.race([
				fileRequested.promise,
				Bun.sleep(3_000).then(() => {
					throw new Error('The file request did not start');
				}),
			]);
			await page.waitForFunction(
				() => document.getElementById('sc-gate-dl-panel')?.hidden,
				{ polling: 50, timeout: 5_000 },
			);
			responseReady.resolve();
			const result = await Promise.race([
				completed.promise,
				Bun.sleep(2_000).then(() => 'no download'),
			]);
			expect(result).toBe('completed');
			expect(await Bun.file(join(downloadPath, 'fixture.mp3')).text()).toBe(
				'fixture audio',
			);
		} finally {
			responseReady.resolve();
			await browser.close();
			await server.stop(true);
			await rm(downloadPath, { recursive: true, force: true });
		}
	},
	20_000,
);
