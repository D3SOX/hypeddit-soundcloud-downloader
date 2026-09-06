import { AsyncLocalStorage } from 'node:async_hooks';
import { cp, mkdir, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { SoundcloudTrack } from 'soundcloud.ts';
import { hasZipSignature, resolveDownloadedAudio } from './archiveAudio';
import { AudioProcessor } from './audioProcessor';
import { isXvfbSupported } from './browserLaunch';
import { attachmentContentDisposition } from './contentDisposition';
import { DirectDownloader } from './directDownload';
import { cleanupCancelledDownloadArtifacts } from './downloadCleanup';
import { DownloadgaterDownloader } from './downloadgater';
import { renameDownloadFileExclusive } from './downloadRename';
import {
	deleteAfterDownloadEnabled,
	streamWithSuccessfulDownloadCleanup,
} from './downloadRetention';
import { DroploudDownloader } from './droploud';
import { GaterushDownloader } from './gaterush';
import { HypedditDownloader } from './hypeddit';
import { HypedditHttpDownloader } from './hypedditHttp';
import { JobQueue } from './jobQueue';
import { jobStore } from './jobStore';
import { MypresskitDownloader } from './mypresskit';
import { PumpyoursoundDownloader } from './pumpyoursound';
import { isAllowedCorsOrigin } from './serverCors';
import { SoundcloudClient } from './soundcloud';
import { isSoundcloudDownloadEnabled } from './soundcloudDownload';
import { StillhypeDownloader } from './stillhype';
import {
	type BrowserMode,
	isBrowserMode,
	type Job,
	type Metadata,
	type OutputFormat,
} from './types';
import {
	artistTitleFilename,
	extractAndResolveGateUrl,
	getDefaultMetadata,
	getFfmpegBin,
	getFfprobeBin,
	isMp3Format,
	resolveGateUrlOrFollow,
	validateGateUrl,
	validateSoundcloudUrl,
} from './utils';
import { canAccessSoundcloudOriginalDownload, YtDlpDownloader } from './ytdlp';

const ffmpegBin = await getFfmpegBin();
const ffprobeBin = await getFfprobeBin();

const SHARED_BROWSER_DATA = './browser-data';

function getRequiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required. Please set it in your .env file.`);
	}
	return value;
}

function getOptionalEnv(name: string): string | undefined {
	return process.env[name] || undefined;
}

const SC_COMMENT = getRequiredEnv('SC_COMMENT');
if (SC_COMMENT.trim().length < 2) {
	throw new Error(
		'SC_COMMENT must be at least 2 characters (Droploud disables Connect otherwise).',
	);
}
const HYPEDDIT_NAME = getOptionalEnv('HYPEDDIT_NAME');
const HYPEDDIT_EMAIL = getOptionalEnv('HYPEDDIT_EMAIL');
const BROWSER_VIEW_URL = getOptionalEnv('BROWSER_VIEW_URL');
const DELETE_AFTER_DOWNLOAD = deleteAfterDownloadEnabled(
	process.env.SC_GATE_DL_DELETE_AFTER_DOWNLOAD,
);

const soundcloudClient = new SoundcloudClient();
const audioProcessor = new AudioProcessor(ffmpegBin, ffprobeBin);
const availableBrowserModes: BrowserMode[] = isXvfbSupported()
	? ['headless', 'xvfb', 'headed']
	: ['headless', 'headed'];

async function renameDownloadFile(
	jobId: string,
	currentFilename: string,
	desiredFilename: string,
): Promise<string> {
	return renameDownloadFileExclusive({
		downloadsDir: './downloads',
		jobId,
		currentFilename,
		desiredFilename,
		isOwnedByOtherJob: (filename, excludeJobId) =>
			jobStore.isFilenameOwnedByOtherJob(filename, excludeJobId),
		claimFilenames: (id, filename) => {
			jobStore.update(id, {
				outputFilename: filename,
				downloadFilename: filename,
			});
		},
	});
}

type AnyDownloader = {
	close(): Promise<void>;
};

/** Per-job browser handles so concurrent jobs cannot close each other. */
const activeDownloaders = new Map<string, AnyDownloader>();
/** Job-scoped Chromium profiles under ./browser-data/jobs/<jobId>. */
const jobProfileDirs = new Map<string, string>();
/** In-flight close+profile cleanup so SIGINT cannot delete a profile mid-close. */
const closingJobs = new Map<string, Promise<void>>();
/** Share cleanup between a timed-out endpoint and eventual task completion. */
const cancelledDownloadCleanups = new Map<string, Promise<void>>();

const jobQueue = new JobQueue({
	onQueued: (jobId, position) => {
		if (jobStore.isCancelled(jobId)) return;
		jobStore.updateProgress(
			jobId,
			'queued',
			position === 1
				? 'Waiting for the active download — next in queue'
				: `Waiting for the active download — queue position ${position}`,
			0,
			{ queuePosition: position },
		);
	},
	onTaskError: (jobId, error) => {
		if (jobStore.isCancelled(jobId)) return;
		jobStore.setError(
			jobId,
			error instanceof Error ? error.message : 'Download queue task failed',
		);
	},
});

/**
 * Job profiles start empty, which drops the SoundCloud session from Initialize
 * Logins (stored in ./browser-data). Seed each job dir from that shared profile
 * so OAuth still sees a logged-in session while jobs stay isolated.
 */
async function prepareJobUserDataDir(jobId: string): Promise<string> {
	const userDataDir = join(SHARED_BROWSER_DATA, 'jobs', jobId);
	await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
	await mkdir(userDataDir, { recursive: true });

	const sharedDefault = join(SHARED_BROWSER_DATA, 'Default');
	const skipDirNames = new Set([
		'Cache',
		'Code Cache',
		'GPUCache',
		'GrShaderCache',
		'ShaderCache',
		'DawnGraphiteCache',
		'DawnWebGPUCache',
		'Service Worker',
		'Blob',
		'File System',
	]);

	try {
		await cp(sharedDefault, join(userDataDir, 'Default'), {
			recursive: true,
			filter: (source) => {
				const name = basename(source);
				if (name === 'LOCK' || name === 'SingletonLock') return false;
				if (skipDirNames.has(name)) return false;
				return true;
			},
		});
	} catch {
		// No shared profile yet — soundcloud-cookies.json injection still applies.
	}

	return userDataDir;
}

async function closeJobDownloader(jobId: string): Promise<void> {
	const existing = closingJobs.get(jobId);
	if (existing) return existing;

	const downloader = activeDownloaders.get(jobId);
	const profileDir = jobProfileDirs.get(jobId);
	activeDownloaders.delete(jobId);
	jobProfileDirs.delete(jobId);

	const closing = (async () => {
		await downloader?.close().catch(() => {});
		if (profileDir) {
			await rm(profileDir, { recursive: true, force: true }).catch(() => {});
		}
	})();
	closingJobs.set(jobId, closing);
	await closing.finally(() => closingJobs.delete(jobId));
}

async function closeAllDownloaders(): Promise<void> {
	const ids = new Set([
		...activeDownloaders.keys(),
		...jobProfileDirs.keys(),
		...closingJobs.keys(),
	]);
	await Promise.all([...ids].map((id) => closeJobDownloader(id)));
}

async function cleanupCancelledJobDownloads(
	jobId: string,
	sweepIncomplete = true,
): Promise<void> {
	const existing = cancelledDownloadCleanups.get(jobId);
	if (existing) return existing;
	const cleanup = (async () => {
		const job = jobStore.get(jobId);
		const removed = await cleanupCancelledDownloadArtifacts({
			filenames: [job?.downloadFilename, job?.outputFilename],
			sweepIncomplete,
		});
		if (removed.length > 0) {
			console.log(
				`Removed cancelled download artifacts: ${removed.join(', ')}`,
			);
		}
		if (job?.downloadFilename || job?.outputFilename) {
			jobStore.update(jobId, {
				downloadFilename: null,
				outputFilename: null,
			});
		}
	})();
	cancelledDownloadCleanups.set(jobId, cleanup);
	return cleanup;
}

function serializeTrack(track: SoundcloudTrack): Job['track'] {
	return {
		title: track.title,
		artworkUrl: track.artwork_url || null,
		purchaseUrl: track.purchase_url ?? undefined,
		description: track.description ?? undefined,
		user: {
			username: track.user.username,
			fullName: track.user.full_name ?? undefined,
			avatarUrl: track.user.avatar_url,
		},
		publisherMetadata: track.publisher_metadata
			? {
					artist: track.publisher_metadata.artist ?? undefined,
					albumTitle: track.publisher_metadata.album_title ?? undefined,
				}
			: undefined,
		genre: track.genre ?? undefined,
	};
}

async function runDownloadProcess(jobId: string): Promise<void> {
	const job = jobStore.get(jobId);
	if (!job?.hypedditUrl) return;

	const throwIfCancelled = () => {
		if (jobStore.isCancelled(jobId)) {
			throw new Error('Download cancelled');
		}
	};

	try {
		throwIfCancelled();
		jobStore.updateProgress(
			jobId,
			'handling_gates',
			'Resolving download source...',
			0,
		);
		const resolved = await resolveGateUrlOrFollow(job.hypedditUrl);
		throwIfCancelled();
		if (!resolved) {
			jobStore.setError(jobId, 'Unsupported gate URL');
			return;
		}
		if (resolved.url !== job.hypedditUrl) {
			jobStore.update(jobId, { hypedditUrl: resolved.url });
		}
		const { url: downloadSourceUrl, provider } = resolved;

		const emitProgress = (
			stage: Job['progress']['stage'],
			message: string,
			percent: number,
			extra?: Partial<Job['progress']>,
		) => {
			if (jobStore.isCancelled(jobId)) return;
			let stagePercent = percent;
			if (stage === 'downloading') {
				if (
					extra?.downloadBytes !== undefined &&
					extra.totalBytes !== undefined &&
					extra.totalBytes > 0
				) {
					stagePercent = Math.min(
						100,
						Math.max(0, (extra.downloadBytes / extra.totalBytes) * 100),
					);
				}
			}
			jobStore.updateProgress(jobId, stage, message, stagePercent, extra);
		};

		const gateConfigBase = {
			name: HYPEDDIT_NAME,
			email: HYPEDDIT_EMAIL,
			comment: SC_COMMENT,
			browserMode: job.browserMode,
		};

		const prepareBrowserConfig = async () => {
			throwIfCancelled();
			const userDataDir = await prepareJobUserDataDir(jobId);
			jobProfileDirs.set(jobId, userDataDir);
			if (jobStore.isCancelled(jobId)) {
				jobProfileDirs.delete(jobId);
				await rm(userDataDir, { recursive: true, force: true });
				throw new Error('Download cancelled');
			}
			return { ...gateConfigBase, userDataDir };
		};

		let downloadFilename: string | null = null;

		if (provider === 'bandcamp' || provider === 'soundcloud') {
			const sourceLabel = provider === 'bandcamp' ? 'Bandcamp' : 'SoundCloud';
			jobStore.updateProgress(
				jobId,
				provider === 'bandcamp' ? 'handling_gates' : 'downloading',
				provider === 'bandcamp'
					? 'Resolving Bandcamp track...'
					: 'Downloading from SoundCloud via yt-dlp...',
				0,
				{ browserless: true },
			);
			const ytDlpDownloader = new YtDlpDownloader(sourceLabel);
			activeDownloaders.set(jobId, ytDlpDownloader);
			ytDlpDownloader.setProgressCallback(emitProgress);
			downloadFilename = await ytDlpDownloader.downloadAudio(
				downloadSourceUrl,
				{
					matchTitle: job.track?.title,
					onAlbumMatchFailed: async (error) => {
						throwIfCancelled();
						jobStore.update(jobId, {
							bandcampAlbumTracks: error.tracks,
							error: null,
						});
						const message = error.matchTitle
							? `Could not match “${error.matchTitle}” — pick a Bandcamp track`
							: 'Pick a track from the Bandcamp album';
						jobStore.updateProgress(
							jobId,
							'waiting_bandcamp_track',
							message,
							45,
							{
								browserless: true,
								bandcampAlbumTracks: error.tracks,
							},
						);
						const selectedUrl =
							await jobStore.waitForBandcampTrackSelection(jobId);
						throwIfCancelled();
						if (!selectedUrl) {
							throw new Error('Download cancelled');
						}
						jobStore.update(jobId, { bandcampAlbumTracks: null });
						jobStore.updateProgress(
							jobId,
							'handling_gates',
							'Resolving selected Bandcamp track...',
							0,
							{ browserless: true },
						);
						return selectedUrl;
					},
				},
			);
			throwIfCancelled();
		} else if (provider === 'droploud') {
			jobStore.updateProgress(
				jobId,
				'initializing_browser',
				'Launching browser for Droploud...',
				10,
			);
			const droploudDownloader = new DroploudDownloader(
				await prepareBrowserConfig(),
			);
			activeDownloaders.set(jobId, droploudDownloader);
			droploudDownloader.setProgressCallback(emitProgress);
			await droploudDownloader.initialize();
			throwIfCancelled();
			jobStore.updateProgress(
				jobId,
				'handling_gates',
				'Processing Droploud gates...',
				25,
				{ browserActive: job.browserMode === 'headed' },
			);
			downloadFilename =
				await droploudDownloader.downloadAudio(downloadSourceUrl);
			throwIfCancelled();
		} else if (provider === 'gaterush') {
			jobStore.updateProgress(
				jobId,
				'initializing_browser',
				'Launching browser for GateRush...',
				10,
			);
			const gaterushDownloader = new GaterushDownloader(
				await prepareBrowserConfig(),
			);
			activeDownloaders.set(jobId, gaterushDownloader);
			gaterushDownloader.setProgressCallback(emitProgress);
			await gaterushDownloader.initialize();
			throwIfCancelled();
			jobStore.updateProgress(
				jobId,
				'handling_gates',
				'Processing GateRush gates...',
				25,
				{ browserActive: job.browserMode === 'headed' },
			);
			downloadFilename =
				await gaterushDownloader.downloadAudio(downloadSourceUrl);
			throwIfCancelled();
		} else if (provider === 'downloadgater') {
			jobStore.updateProgress(
				jobId,
				'initializing_browser',
				'Launching browser for DownloadGater...',
				10,
			);
			const downloadgaterDownloader = new DownloadgaterDownloader(
				await prepareBrowserConfig(),
			);
			activeDownloaders.set(jobId, downloadgaterDownloader);
			downloadgaterDownloader.setProgressCallback(emitProgress);
			await downloadgaterDownloader.initialize();
			throwIfCancelled();
			jobStore.updateProgress(
				jobId,
				'handling_gates',
				'Processing DownloadGater gates...',
				25,
				{ browserActive: job.browserMode === 'headed' },
			);
			downloadFilename =
				await downloadgaterDownloader.downloadAudio(downloadSourceUrl);
			throwIfCancelled();
		} else if (provider === 'stillhype') {
			jobStore.updateProgress(
				jobId,
				'initializing_browser',
				'Launching browser for StillHype...',
				10,
			);
			const stillhypeDownloader = new StillhypeDownloader(
				await prepareBrowserConfig(),
			);
			activeDownloaders.set(jobId, stillhypeDownloader);
			stillhypeDownloader.setProgressCallback(emitProgress);
			await stillhypeDownloader.initialize();
			throwIfCancelled();
			jobStore.updateProgress(
				jobId,
				'handling_gates',
				'Processing StillHype gates...',
				25,
				{ browserActive: job.browserMode === 'headed' },
			);
			downloadFilename =
				await stillhypeDownloader.downloadAudio(downloadSourceUrl);
			throwIfCancelled();
		} else if (provider === 'pumpyoursound') {
			jobStore.updateProgress(
				jobId,
				'initializing_browser',
				'Launching browser for PumpYourSound...',
				10,
			);
			const pumpyoursoundDownloader = new PumpyoursoundDownloader(
				await prepareBrowserConfig(),
			);
			activeDownloaders.set(jobId, pumpyoursoundDownloader);
			pumpyoursoundDownloader.setProgressCallback(emitProgress);
			await pumpyoursoundDownloader.initialize();
			throwIfCancelled();
			jobStore.updateProgress(
				jobId,
				'handling_gates',
				'Processing PumpYourSound gates...',
				25,
				{ browserActive: job.browserMode === 'headed' },
			);
			downloadFilename =
				await pumpyoursoundDownloader.downloadAudio(downloadSourceUrl);
			throwIfCancelled();
		} else if (provider === 'mypresskit') {
			jobStore.updateProgress(
				jobId,
				'initializing_browser',
				'Launching browser for MyPressKit...',
				10,
			);
			const mypresskitDownloader = new MypresskitDownloader(
				await prepareBrowserConfig(),
			);
			activeDownloaders.set(jobId, mypresskitDownloader);
			mypresskitDownloader.setProgressCallback(emitProgress);
			await mypresskitDownloader.initialize();
			throwIfCancelled();
			jobStore.updateProgress(
				jobId,
				'handling_gates',
				'Processing MyPressKit gates...',
				25,
				{ browserActive: job.browserMode === 'headed' },
			);
			downloadFilename =
				await mypresskitDownloader.downloadAudio(downloadSourceUrl);
			throwIfCancelled();
		} else if (provider === 'direct') {
			jobStore.updateProgress(
				jobId,
				'downloading',
				'Downloading direct file...',
				0,
				{ browserless: true },
			);
			const directDownloader = new DirectDownloader();
			activeDownloaders.set(jobId, directDownloader);
			directDownloader.setProgressCallback(emitProgress);
			downloadFilename =
				await directDownloader.downloadAudio(downloadSourceUrl);
			throwIfCancelled();
		} else {
			// Hypeddit: always try plain HTTP first (email + social skip gates).
			jobStore.updateProgress(
				jobId,
				'handling_gates',
				'Trying browserless Hypeddit download...',
				15,
			);
			const httpDownloader = new HypedditHttpDownloader(
				gateConfigBase,
				emitProgress,
			);
			activeDownloaders.set(jobId, httpDownloader);
			downloadFilename = await httpDownloader.tryDownload(downloadSourceUrl);
			throwIfCancelled();

			// Always try HTTP first. Fall back to the browser (headless or
			// headful per job setting) when the gate needs real verification
			// (e.g. Spotify).
			if (!downloadFilename) {
				jobStore.updateProgress(
					jobId,
					'initializing_browser',
					'Launching browser for Hypeddit...',
					10,
				);

				const hypedditDownloader = new HypedditDownloader(
					await prepareBrowserConfig(),
				);
				activeDownloaders.set(jobId, hypedditDownloader);
				hypedditDownloader.setProgressCallback(emitProgress);
				await hypedditDownloader.initialize();
				throwIfCancelled();

				jobStore.updateProgress(
					jobId,
					'handling_gates',
					'Processing Hypeddit gates...',
					25,
					{ browserActive: job.browserMode === 'headed' },
				);

				downloadFilename =
					await hypedditDownloader.downloadAudio(downloadSourceUrl);
				throwIfCancelled();
			}
		}

		if (jobStore.isCancelled(jobId)) {
			return;
		}

		if (!downloadFilename) {
			jobStore.setError(jobId, 'Download failed - no file received');
			return;
		}

		jobStore.update(jobId, { downloadFilename });
		const downloadedPath = join('./downloads', downloadFilename);
		const signature = new Uint8Array(
			await Bun.file(downloadedPath).slice(0, 4).arrayBuffer(),
		);
		if (hasZipSignature(signature)) {
			jobStore.updateProgress(
				jobId,
				'processing_audio',
				'Extracting audio from ZIP...',
				85,
			);
		}
		downloadFilename = await resolveDownloadedAudio(downloadFilename);
		jobStore.update(jobId, { downloadFilename });
		throwIfCancelled();
		if (job.outputFormat === 'flac') {
			const sourceIsLossless = await audioProcessor.isLosslessAudio(
				join('./downloads', downloadFilename),
			);
			jobStore.update(jobId, { sourceIsLossless });
		}

		if (job.outputFormat === 'original') {
			jobStore.update(jobId, { outputFilename: downloadFilename });
			jobStore.updateProgress(jobId, 'ready', 'Original file ready', 100);
			return;
		}

		if (isMp3Format(downloadFilename)) {
			const downloadedPath = join('./downloads', downloadFilename);
			const existingMetadata =
				await audioProcessor.readMp3Metadata(downloadedPath);
			const existingArtwork =
				await audioProcessor.extractMp3CoverArt(downloadedPath);
			jobStore.update(jobId, {
				existingMetadata: existingMetadata ?? {},
				existingArtworkBuffer: existingArtwork?.buffer ?? null,
				existingArtworkFileName: existingArtwork?.fileName ?? null,
			});
		} else {
			jobStore.update(jobId, {
				existingMetadata: null,
				existingArtworkBuffer: null,
				existingArtworkFileName: null,
			});
		}

		throwIfCancelled();

		jobStore.updateProgress(
			jobId,
			'processing_audio',
			'Fetching artwork...',
			90,
		);

		const artworkFetchUrl = job.track?.artworkUrl || job.track?.user.avatarUrl;
		if (artworkFetchUrl) {
			try {
				const artwork = await soundcloudClient.fetchArtwork(artworkFetchUrl);
				jobStore.update(jobId, {
					artworkBuffer: artwork.buffer,
					artworkFileName: artwork.fileName,
				});
			} catch (error) {
				console.warn(
					`Failed to fetch artwork: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}

		if (jobStore.isCancelled(jobId)) {
			return;
		}

		jobStore.updateProgress(jobId, 'ready', 'Ready for metadata editing', 100);
	} catch (error) {
		if (jobStore.isCancelled(jobId)) {
			// The cancel endpoint publishes the terminal state after this task has
			// released the serial queue slot.
			return;
		}
		const message =
			error instanceof Error ? error.message : 'Unknown error occurred';
		jobStore.setError(jobId, message);
	} finally {
		await closeJobDownloader(jobId);
		if (jobStore.isCancelled(jobId)) {
			await cleanupCancelledJobDownloads(jobId);
		}
	}
}

const requestAls = new AsyncLocalStorage<Request>();

function corsHeaders(): Record<string, string> {
	const req = requestAls.getStore();
	const origin = req?.headers.get('Origin');
	const headers: Record<string, string> = {
		'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
		'Access-Control-Allow-Headers':
			'Content-Type, Authorization, Access-Control-Request-Private-Network',
		// Chrome Private Network Access: allow soundcloud.com → localhost:3000 (userscript)
		'Access-Control-Allow-Private-Network': 'true',
		Vary: 'Origin',
	};
	if (origin && req && isAllowedCorsOrigin(req.url, origin)) {
		headers['Access-Control-Allow-Origin'] = origin;
	}
	return headers;
}

function jsonResponse(data: unknown, options?: { status?: number }): Response {
	return Response.json(data, {
		status: options?.status || 200,
		headers: corsHeaders(),
	});
}

function fileResponse(
	body: BodyInit | null,
	headers: Record<string, string>,
): Response {
	return new Response(body, {
		headers: { ...corsHeaders(), ...headers },
	});
}

function sseResponse(stream: ReadableStream): Response {
	return new Response(stream, {
		headers: {
			...corsHeaders(),
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

type RouteHandler = (req: Request) => Response | Promise<Response>;

function wrapRouteHandler(handler: RouteHandler): RouteHandler {
	return (req) => requestAls.run(req, () => handler(req));
}

function wrapRoutes<Path extends string>(
	routes: Bun.Serve.Routes<undefined, Path>,
): Bun.Serve.Routes<undefined, Path> {
	const wrapped: Record<string, unknown> = {};
	for (const [path, handler] of Object.entries(routes)) {
		if (typeof handler === 'function') {
			wrapped[path] = wrapRouteHandler(handler as RouteHandler);
		} else if (handler && typeof handler === 'object') {
			const methodHandlers: Record<string, unknown> = {};
			for (const [method, fn] of Object.entries(
				handler as Record<string, unknown>,
			)) {
				methodHandlers[method] =
					typeof fn === 'function' ? wrapRouteHandler(fn as RouteHandler) : fn;
			}
			wrapped[path] = methodHandlers;
		} else {
			wrapped[path] = handler;
		}
	}
	return wrapped as Bun.Serve.Routes<undefined, Path>;
}

const server = Bun.serve({
	port: 3000,
	// Increase idle timeout for long-running operations (browser automation, downloads)
	idleTimeout: 255, // ~4 minutes (max allowed)
	routes: wrapRoutes({
		// CORS preflight handler for all routes
		'/*': {
			OPTIONS: () =>
				new Response(null, {
					status: 204,
					headers: corsHeaders(),
				}),
		},
		'/': () =>
			new Response('sc-gate-dl API is running!', {
				headers: corsHeaders(),
			}),
		'/api/capabilities': () =>
			jsonResponse({
				browserModes: availableBrowserModes,
				browserViewUrl: BROWSER_VIEW_URL ?? null,
			}),

		'/api/soundcloud/cleanup': {
			POST: async () => {
				try {
					const result = await soundcloudClient.cleanup(false);
					if (!result) {
						return jsonResponse({
							success: false,
							message: 'Cleanup cancelled',
						});
					}
					return jsonResponse({ success: true, ...result });
				} catch (error) {
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/logins/initialize': {
			POST: async () => {
				let loginDownloader: HypedditDownloader | null = null;
				try {
					loginDownloader = new HypedditDownloader({
						name: HYPEDDIT_NAME,
						email: HYPEDDIT_EMAIL,
						comment: SC_COMMENT,
						browserMode: 'headed',
					});

					await loginDownloader.initialize();
					await loginDownloader.prepareLogins();
					await loginDownloader.close();
					loginDownloader = null;

					return jsonResponse({ success: true });
				} catch (error) {
					if (loginDownloader) {
						await loginDownloader.close();
						loginDownloader = null;
					}
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/job': {
			POST: async (req) => {
				try {
					const body = await req.json();
					const { soundcloudUrl, skipAutomaticHypedditFetch, outputFormat } =
						body as {
							soundcloudUrl?: string;
							skipAutomaticHypedditFetch?: boolean;
							outputFormat?: OutputFormat;
						};

					if (!soundcloudUrl) {
						return jsonResponse(
							{ error: 'soundcloudUrl is required' },
							{ status: 400 },
						);
					}

					const validation = validateSoundcloudUrl(soundcloudUrl);
					if (validation !== true) {
						return jsonResponse({ error: validation }, { status: 400 });
					}

					if (
						outputFormat !== undefined &&
						outputFormat !== 'original' &&
						outputFormat !== 'mp3-320' &&
						outputFormat !== 'flac'
					) {
						return jsonResponse(
							{
								error: 'outputFormat must be "original", "mp3-320", or "flac"',
							},
							{ status: 400 },
						);
					}

					const job = jobStore.create(soundcloudUrl, outputFormat ?? 'mp3-320');
					jobStore.updateProgress(
						job.id,
						'fetching_track',
						'Fetching SoundCloud track...',
						5,
					);

					let track: SoundcloudTrack;
					try {
						track = await soundcloudClient.getTrack(soundcloudUrl);
					} catch (error) {
						jobStore.setError(
							job.id,
							`Failed to fetch track: ${error instanceof Error ? error.message : 'Unknown error'}`,
						);
						return jsonResponse(
							{
								jobId: job.id,
								error: job.error,
							},
							{ status: 400 },
						);
					}

					// A creator-enabled SoundCloud download is the preferred source: it
					// bypasses gates and lets yt-dlp select the original `download` format.
					const creatorDownloadAvailable = isSoundcloudDownloadEnabled(track);
					const soundcloudDownloadEnabled =
						creatorDownloadAvailable &&
						(await canAccessSoundcloudOriginalDownload(soundcloudUrl));
					const soundcloudDownloadWarning =
						creatorDownloadAvailable && !soundcloudDownloadEnabled
							? 'This track has a creator-enabled SoundCloud download, but yt-dlp could not access it. Add or refresh soundcloud-cookies.json to use the original download; continuing with the gate instead.'
							: null;
					const hypedditUrl = soundcloudDownloadEnabled
						? { url: soundcloudUrl, provider: 'soundcloud' as const }
						: skipAutomaticHypedditFetch
							? null
							: await extractAndResolveGateUrl(track);
					const defaultMetadata = getDefaultMetadata(track);

					const updatedJob = jobStore.update(job.id, {
						track: serializeTrack(track),
						hypedditUrl: hypedditUrl?.url ?? null,
						defaultMetadata,
						progress: {
							stage: hypedditUrl ? 'pending' : 'waiting_hypeddit',
							message: hypedditUrl
								? soundcloudDownloadEnabled
									? 'Creator-enabled SoundCloud download ready'
									: 'Ready to start download'
								: skipAutomaticHypedditFetch
									? 'Automatic gate lookup skipped - manual input required'
									: 'Gate URL not found - manual input required',
							percent: 10,
						},
					});

					if (!updatedJob) {
						return jsonResponse(
							{ error: 'Job not found after update' },
							{ status: 500 },
						);
					}

					return jsonResponse({
						jobId: job.id,
						track: updatedJob.track,
						hypedditUrl: updatedJob.hypedditUrl,
						defaultMetadata: updatedJob.defaultMetadata,
						outputFormat: updatedJob.outputFormat,
						soundcloudDownloadWarning,
						needsHypedditUrl: !hypedditUrl,
					});
				} catch (error) {
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/job/:id/hypeddit': {
			POST: async (req) => {
				try {
					const jobId = req.params.id;
					const job = jobStore.get(jobId);

					if (!job) {
						return jsonResponse({ error: 'Job not found' }, { status: 404 });
					}

					const body = await req.json();
					const { hypedditUrl } = body as { hypedditUrl?: string };

					if (!hypedditUrl) {
						return jsonResponse(
							{ error: 'Gate URL (hypedditUrl) is required' },
							{ status: 400 },
						);
					}

					const validation = validateGateUrl(hypedditUrl);
					if (validation !== true) {
						return jsonResponse({ error: validation }, { status: 400 });
					}

					const resolved = await resolveGateUrlOrFollow(hypedditUrl);
					if (!resolved) {
						return jsonResponse(
							{ error: 'Could not extract a supported URL' },
							{ status: 400 },
						);
					}

					jobStore.update(jobId, { hypedditUrl: resolved.url });

					return jsonResponse({ success: true, hypedditUrl: resolved.url });
				} catch (error) {
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/job/:id/bandcamp-track': {
			POST: async (req) => {
				try {
					const jobId = req.params.id;
					const job = jobStore.get(jobId);

					if (!job) {
						return jsonResponse({ error: 'Job not found' }, { status: 404 });
					}

					if (job.progress.stage !== 'waiting_bandcamp_track') {
						return jsonResponse(
							{ error: 'Job is not waiting for a Bandcamp track selection' },
							{ status: 400 },
						);
					}

					const body = await req.json();
					const { trackUrl } = body as { trackUrl?: string };

					if (!trackUrl || typeof trackUrl !== 'string') {
						return jsonResponse(
							{ error: 'trackUrl is required' },
							{ status: 400 },
						);
					}

					const allowed = job.bandcampAlbumTracks ?? [];
					const match = allowed.find((t) => t.url === trackUrl);
					if (!match) {
						return jsonResponse(
							{ error: 'trackUrl is not one of the listed album tracks' },
							{ status: 400 },
						);
					}

					const resolved = jobStore.resolveBandcampTrackSelection(
						jobId,
						match.url,
					);
					if (!resolved) {
						return jsonResponse(
							{ error: 'No pending Bandcamp track selection' },
							{ status: 409 },
						);
					}

					return jsonResponse({
						success: true,
						trackUrl: match.url,
						title: match.title,
					});
				} catch (error) {
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/job/:id/start': {
			POST: async (req) => {
				try {
					const jobId = req.params.id;
					const job = jobStore.get(jobId);

					if (!job) {
						return jsonResponse({ error: 'Job not found' }, { status: 404 });
					}

					if (!job.hypedditUrl) {
						return jsonResponse({ error: 'Gate URL not set' }, { status: 400 });
					}

					if (
						job.progress.stage !== 'pending' &&
						job.progress.stage !== 'waiting_hypeddit' &&
						job.progress.stage !== 'error' &&
						job.progress.stage !== 'cancelled'
					) {
						return jsonResponse(
							{ error: 'Job is already in progress or completed' },
							{ status: 400 },
						);
					}

					jobStore.clearCancelled(jobId);
					cancelledDownloadCleanups.delete(jobId);

					try {
						const body = (await req.json()) as Record<string, unknown>;
						let browserMode: Job['browserMode'] | undefined;
						if (body.browserMode !== undefined) {
							if (!isBrowserMode(body.browserMode)) {
								return jsonResponse(
									{ error: 'Invalid browser mode' },
									{ status: 400 },
								);
							}
							if (!availableBrowserModes.includes(body.browserMode)) {
								return jsonResponse(
									{ error: 'Xvfb browser mode is only available on Linux' },
									{ status: 400 },
								);
							}
							browserMode = body.browserMode;
						} else if (
							typeof body.headless === 'boolean' &&
							body.xvfb === undefined
						) {
							// Backward compatibility for clients predating the mode selector.
							browserMode = body.headless ? 'headless' : 'headed';
						} else if (body.headless !== undefined || body.xvfb !== undefined) {
							return jsonResponse(
								{
									error:
										'Use browserMode instead of headless/xvfb combinations',
								},
								{ status: 400 },
							);
						}
						if (browserMode) jobStore.update(jobId, { browserMode });
					} catch {
						// No/empty JSON body — keep job default / BROWSER_HEADLESS
					}

					const queueResult = jobQueue.enqueue(jobId, () =>
						runDownloadProcess(jobId),
					);

					return jsonResponse({
						success: true,
						queued: queueResult.queued,
						queuePosition: queueResult.position || undefined,
						message: queueResult.queued
							? `Download queued at position ${queueResult.position}`
							: 'Download started',
					});
				} catch (error) {
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/job/:id/cancel': {
			POST: async (req) => {
				try {
					const jobId = req.params.id;
					const job = jobStore.get(jobId);

					if (!job) {
						return jsonResponse({ error: 'Job not found' }, { status: 404 });
					}

					const stage = job.progress.stage;
					if (stage === 'queued' && jobQueue.cancel(jobId)) {
						jobStore.cancel(jobId);
						return jsonResponse({
							success: true,
							message: 'Queued download cancelled',
						});
					}
					if (stage === 'ready' || stage === 'cancelled') {
						jobStore.cancel(jobId);
						await closeJobDownloader(jobId);
						await cleanupCancelledJobDownloads(jobId, false);
						jobQueue.releaseActive(jobId);
						return jsonResponse({ success: true, message: 'Cancelled' });
					}

					jobStore.requestCancellation(jobId);
					const teardown = (async () => {
						// The task owns the shared downloads directory until its final cleanup
						// completes. JobQueue advances automatically when this resolves.
						await closeJobDownloader(jobId);
						await jobQueue.waitForCompletion(jobId);
						jobStore.cancel(jobId, 'Download cancelled');
					})();
					const teardownCompleted = await Promise.race([
						teardown.then(() => true),
						Bun.sleep(10_000).then(() => false),
					]);
					if (!teardownCompleted) {
						console.warn(
							`Cancellation teardown is still pending for ${jobId}; retaining its queue slot`,
						);
						return jsonResponse(
							{ success: true, message: 'Cancellation is still in progress' },
							{ status: 202 },
						);
					}

					return jsonResponse({ success: true, message: 'Download cancelled' });
				} catch (error) {
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/job/:id/events': {
			GET: (req) => {
				try {
					const jobId = req.params.id;
					const job = jobStore.get(jobId);

					if (!job) {
						return jsonResponse({ error: 'Job not found' }, { status: 404 });
					}

					const stream = new ReadableStream({
						start(controller) {
							const encoder = new TextEncoder();
							let cleanedUp = false;
							let unsubscribe: (() => void) | null = null;
							let heartbeat: ReturnType<typeof setInterval> | null = null;

							const cleanup = () => {
								if (cleanedUp) return;
								cleanedUp = true;
								if (heartbeat !== null) {
									clearInterval(heartbeat);
									heartbeat = null;
								}
								unsubscribe?.();
								unsubscribe = null;
							};

							const closeStream = () => {
								cleanup();
								try {
									controller.close();
								} catch {
									// Already closed
								}
							};

							const safeEnqueue = (chunk: string): boolean => {
								if (cleanedUp) return false;
								try {
									controller.enqueue(encoder.encode(chunk));
									return true;
								} catch {
									cleanup();
									return false;
								}
							};

							if (!safeEnqueue(`data: ${JSON.stringify(job.progress)}\n\n`)) {
								return;
							}

							// Keep the SSE connection alive during long silent stretches
							// (e.g. yt-dlp downloads up to 10 minutes with no progress events).
							// Bun closes idle connections after idleTimeout (~255s).
							heartbeat = setInterval(() => {
								safeEnqueue(': keepalive\n\n');
							}, 30_000);

							unsubscribe = jobStore.subscribe(jobId, (progress) => {
								if (!safeEnqueue(`data: ${JSON.stringify(progress)}\n\n`)) {
									return;
								}

								if (
									progress.stage === 'ready' ||
									progress.stage === 'error' ||
									progress.stage === 'cancelled'
								) {
									setTimeout(closeStream, 100);
								}
							});

							// subscribe() does not replay — close if the job is already done.
							if (
								job.progress.stage === 'ready' ||
								job.progress.stage === 'error' ||
								job.progress.stage === 'cancelled'
							) {
								setTimeout(closeStream, 100);
							}

							req.signal.addEventListener('abort', closeStream);
						},
					});

					return sseResponse(stream);
				} catch (error) {
					console.error('SSE setup failed:', error);
					return jsonResponse(
						{ error: 'Failed to open event stream' },
						{ status: 500 },
					);
				}
			},
		},

		'/api/job/:id': {
			GET: (req) => {
				const jobId = req.params.id;
				const job = jobStore.get(jobId);

				if (!job) {
					return jsonResponse({ error: 'Job not found' }, { status: 404 });
				}

				return jsonResponse({
					id: job.id,
					soundcloudUrl: job.soundcloudUrl,
					hypedditUrl: job.hypedditUrl,
					bandcampAlbumTracks: job.bandcampAlbumTracks,
					track: job.track,
					defaultMetadata: job.defaultMetadata,
					existingMetadata: job.existingMetadata,
					outputFormat: job.outputFormat,
					browserMode: job.browserMode,
					progress: job.progress,
					downloadFilename: job.downloadFilename,
					outputFilename: job.outputFilename,
					sourceIsLossless: job.sourceIsLossless,
					hasArtwork: !!job.artworkBuffer,
					hasExistingArtwork: !!job.existingArtworkBuffer,
					error: job.error,
				});
			},
		},

		'/api/job/:id/artwork': {
			GET: (req) => {
				const jobId = req.params.id;
				const job = jobStore.get(jobId);

				if (!job) {
					return jsonResponse({ error: 'Job not found' }, { status: 404 });
				}

				if (!job.artworkBuffer) {
					return jsonResponse(
						{ error: 'Artwork not available' },
						{ status: 404 },
					);
				}

				const extension = job.artworkFileName?.split('.').pop() || 'jpg';
				const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';

				return fileResponse(job.artworkBuffer, {
					'Content-Type': mimeType,
					'Content-Disposition': `inline; filename="${job.artworkFileName || 'artwork.jpg'}"`,
				});
			},
		},

		'/api/job/:id/existing-artwork': {
			GET: (req) => {
				const jobId = req.params.id;
				const job = jobStore.get(jobId);

				if (!job) {
					return jsonResponse({ error: 'Job not found' }, { status: 404 });
				}

				if (!job.existingArtworkBuffer) {
					return jsonResponse(
						{ error: 'Existing artwork not available' },
						{ status: 404 },
					);
				}

				const extension =
					job.existingArtworkFileName?.split('.').pop() || 'jpg';
				const mimeType = extension === 'png' ? 'image/png' : 'image/jpeg';

				return fileResponse(job.existingArtworkBuffer, {
					'Content-Type': mimeType,
					'Content-Disposition': `inline; filename="${job.existingArtworkFileName || 'existing-cover.jpg'}"`,
				});
			},
		},

		'/api/job/:id/metadata': {
			POST: async (req) => {
				try {
					const jobId = req.params.id;
					const job = jobStore.get(jobId);

					if (!job) {
						return jsonResponse({ error: 'Job not found' }, { status: 404 });
					}

					if (!job.downloadFilename && !job.outputFilename) {
						return jsonResponse(
							{ error: 'No downloaded file available' },
							{ status: 400 },
						);
					}

					const contentType = req.headers.get('content-type') || '';
					let metadata: Metadata;
					let preserveMetadata = false;
					let nameAsArtistTitle = false;
					let customArtwork: { buffer: ArrayBuffer; fileName: string } | null =
						null;

					if (contentType.includes('multipart/form-data')) {
						const formData = await req.formData();
						metadata = {
							title: formData.get('title')?.toString() || undefined,
							artist: formData.get('artist')?.toString() || undefined,
							album: formData.get('album')?.toString() || undefined,
							genre: formData.get('genre')?.toString() || undefined,
						};
						preserveMetadata = formData.get('preserveMetadata') === 'true';
						nameAsArtistTitle = formData.get('nameAsArtistTitle') === 'true';

						const artworkFile = formData.get('artwork');
						if (artworkFile instanceof File) {
							customArtwork = {
								buffer: await artworkFile.arrayBuffer(),
								fileName: artworkFile.name,
							};
						}
					} else {
						const body = (await req.json()) as Metadata & {
							preserveMetadata?: boolean;
							nameAsArtistTitle?: boolean;
						};
						metadata = {
							title: body.title,
							artist: body.artist,
							album: body.album,
							genre: body.genre,
						};
						preserveMetadata = body.preserveMetadata === true;
						nameAsArtistTitle = body.nameAsArtistTitle === true;
					}

					const sourceFilename =
						job.outputFilename || job.downloadFilename || '';
					if (!sourceFilename) {
						return jsonResponse(
							{ error: 'No downloaded file available' },
							{ status: 400 },
						);
					}

					if (preserveMetadata && !isMp3Format(sourceFilename)) {
						return jsonResponse(
							{
								error: 'Existing metadata can only be preserved for MP3 files',
							},
							{ status: 400 },
						);
					}

					if (job.outputFormat === 'original' || preserveMetadata) {
						let outputFilename = sourceFilename;
						if (nameAsArtistTitle) {
							outputFilename = await renameDownloadFile(
								jobId,
								sourceFilename,
								artistTitleFilename(
									metadata.artist,
									metadata.title,
									extname(sourceFilename) || '.mp3',
								),
							);
						}
						jobStore.update(jobId, {
							outputFilename,
							downloadFilename: outputFilename,
						});
						jobStore.updateProgress(
							jobId,
							'ready',
							job.outputFormat === 'original'
								? 'Original file ready'
								: 'Existing MP3 metadata preserved',
							100,
						);
						return jsonResponse({
							success: true,
							outputFilename,
						});
					}

					jobStore.updateProgress(
						jobId,
						'processing_audio',
						'Processing audio...',
						95,
					);

					const artwork =
						customArtwork ||
						(job.artworkBuffer && job.artworkFileName
							? {
									buffer: job.artworkBuffer,
									fileName: job.artworkFileName,
								}
							: null);

					if (!artwork?.buffer) {
						return jsonResponse(
							{ error: 'No artwork available' },
							{ status: 400 },
						);
					}

					const outputPath = await audioProcessor.processAudio(
						sourceFilename,
						metadata,
						artwork,
						'always',
						job.outputFormat,
					);

					let outputFilename = basename(outputPath);
					if (nameAsArtistTitle) {
						outputFilename = await renameDownloadFile(
							jobId,
							outputFilename,
							artistTitleFilename(
								metadata.artist,
								metadata.title,
								job.outputFormat === 'flac' ? '.flac' : '.mp3',
							),
						);
					}
					jobStore.update(jobId, {
						outputFilename,
						downloadFilename: outputFilename,
					});

					jobStore.updateProgress(
						jobId,
						'ready',
						'Audio processing complete',
						100,
					);

					return jsonResponse({
						success: true,
						outputFilename,
					});
				} catch (error) {
					return jsonResponse(
						{
							error: error instanceof Error ? error.message : 'Unknown error',
						},
						{ status: 500 },
					);
				}
			},
		},

		'/api/job/:id/file': {
			GET: (req) => {
				const jobId = req.params.id;
				const job = jobStore.get(jobId);

				if (!job) {
					return jsonResponse({ error: 'Job not found' }, { status: 404 });
				}

				const filename = job.outputFilename || job.downloadFilename;
				if (!filename) {
					return jsonResponse({ error: 'No file available' }, { status: 404 });
				}

				const filePath = join('./downloads', filename);
				const file = Bun.file(filePath);
				const body = DELETE_AFTER_DOWNLOAD
					? streamWithSuccessfulDownloadCleanup(
							file.stream(),
							async () => {
								await rm(filePath, { force: true });
								const current = jobStore.get(jobId);
								if (
									current?.outputFilename === filename ||
									current?.downloadFilename === filename
								) {
									jobStore.update(jobId, {
										outputFilename: null,
										downloadFilename: null,
									});
								}
								console.log(
									`Deleted downloaded file after transfer: ${filename}`,
								);
							},
							req.signal,
						)
					: file;

				return new Response(body, {
					headers: {
						...corsHeaders(),
						'Content-Type': file.type || 'application/octet-stream',
						'Content-Disposition': attachmentContentDisposition(filename),
					},
				});
			},
		},
	}),
	error: ((err: Error, request?: Request) => {
		console.error('Server error:', err);
		const respond = () =>
			jsonResponse({ error: 'Internal Server Error' }, { status: 500 });
		// Bun may pass Request as a second runtime arg (typed API is 1-arg).
		// Restore ALS so CORS uses the request Origin instead of *.
		if (request instanceof Request) {
			return requestAls.run(request, respond);
		}
		return respond();
	}) as (err: Error) => Response | Promise<Response>,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`Received ${signal}, closing active browsers...`);
	await closeAllDownloaders();
	process.exit(0);
}

process.on('SIGINT', () => {
	void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
	void shutdown('SIGTERM');
});

console.log(`Server is running on ${server.url}`);
