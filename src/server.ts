import { join } from 'node:path';
import type { SoundcloudTrack } from 'soundcloud.ts';
import { AudioProcessor } from './audioProcessor';
import { HypedditDownloader } from './hypeddit';
import { jobStore } from './jobStore';
import { SoundcloudClient } from './soundcloud';
import type { Job, Metadata } from './types';
import {
	extractHypedditUrl,
	getDefaultMetadata,
	getFfmpegBin,
	getFfprobeBin,
	validateHypedditUrl,
	validateSoundcloudUrl,
} from './utils';

const ffmpegBin = await getFfmpegBin();
const ffprobeBin = await getFfprobeBin();

function getRequiredEnv(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`${name} is required. Please set it in your .env file.`);
	}
	return value;
}

const SC_COMMENT = getRequiredEnv('SC_COMMENT');
const HYPEDDIT_NAME = getRequiredEnv('HYPEDDIT_NAME');
const HYPEDDIT_EMAIL = getRequiredEnv('HYPEDDIT_EMAIL');

const soundcloudClient = new SoundcloudClient();
const audioProcessor = new AudioProcessor(ffmpegBin, ffprobeBin);

let hypedditDownloader: HypedditDownloader | null = null;

function serializeTrack(track: SoundcloudTrack): Job['track'] {
	return {
		title: track.title,
		artworkUrl: track.artwork_url,
		purchaseUrl: track.purchase_url ?? undefined,
		description: track.description ?? undefined,
		user: {
			username: track.user.username,
			fullName: track.user.full_name ?? undefined,
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
	if (!job || !job.hypedditUrl) return;

	try {
		jobStore.updateProgress(
			jobId,
			'initializing_browser',
			'Launching browser...',
		);

		hypedditDownloader = new HypedditDownloader({
			name: HYPEDDIT_NAME,
			email: HYPEDDIT_EMAIL,
			comment: SC_COMMENT,
			headless: true,
		});

		hypedditDownloader.setProgressCallback((stage, message, extra) => {
			jobStore.updateProgress(jobId, stage, message, extra);
		});

		await hypedditDownloader.initialize();

		jobStore.updateProgress(
			jobId,
			'handling_gates',
			'Processing Hypeddit gates...',
			25,
		);

		const downloadFilename = await hypedditDownloader.downloadAudio(
			job.hypedditUrl,
		);
		await hypedditDownloader.close();
		hypedditDownloader = null;

		if (!downloadFilename) {
			jobStore.setError(jobId, 'Download failed - no file received');
			return;
		}

		jobStore.update(jobId, { downloadFilename });

		jobStore.updateProgress(jobId, 'processing_audio', 'Fetching artwork...');

		if (job.track?.artworkUrl) {
			const artwork = await soundcloudClient.fetchArtwork(job.track.artworkUrl);
			jobStore.update(jobId, {
				artworkBuffer: artwork.buffer,
				artworkFileName: artwork.fileName,
			});
		}

		jobStore.updateProgress(jobId, 'ready', 'Ready for metadata editing', 100);
	} catch (error) {
		if (hypedditDownloader) {
			await hypedditDownloader.close();
			hypedditDownloader = null;
		}
		const message =
			error instanceof Error ? error.message : 'Unknown error occurred';
		jobStore.setError(jobId, message);
	}
}

const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, options?: { status?: number }): Response {
	return Response.json(data, {
		status: options?.status || 200,
		headers: corsHeaders,
	});
}

function fileResponse(
	body: BodyInit | null,
	headers: Record<string, string>,
): Response {
	return new Response(body, {
		headers: { ...corsHeaders, ...headers },
	});
}

function sseResponse(stream: ReadableStream): Response {
	return new Response(stream, {
		headers: {
			...corsHeaders,
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			Connection: 'keep-alive',
		},
	});
}

const server = Bun.serve({
	port: 3000,
	// Increase idle timeout for long-running operations (browser automation, downloads)
	idleTimeout: 255, // ~4 minutes (max allowed)
	routes: {
		// CORS preflight handler for all routes
		'/*': {
			OPTIONS: () =>
				new Response(null, {
					status: 204,
					headers: corsHeaders,
				}),
		},
		'/': () =>
			new Response('Hypeddit SoundCloud Downloader API is running!', {
				headers: corsHeaders,
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
						headless: false,
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
					const { soundcloudUrl } = body as { soundcloudUrl?: string };

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

					const job = jobStore.create(soundcloudUrl);
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

					const hypedditUrl = extractHypedditUrl(track);
					const defaultMetadata = getDefaultMetadata(track);

					const updatedJob = jobStore.update(job.id, {
						track: serializeTrack(track),
						hypedditUrl: hypedditUrl?.url ?? null,
						defaultMetadata,
						progress: {
							stage: hypedditUrl ? 'pending' : 'waiting_hypeddit',
							message: hypedditUrl
								? 'Ready to start download'
								: 'Hypeddit URL not found - manual input required',
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
							{ error: 'hypedditUrl is required' },
							{ status: 400 },
						);
					}

					const validation = validateHypedditUrl(hypedditUrl);
					if (validation !== true) {
						return jsonResponse({ error: validation }, { status: 400 });
					}

					jobStore.update(jobId, { hypedditUrl });

					return jsonResponse({ success: true, hypedditUrl });
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
						return jsonResponse(
							{ error: 'Hypeddit URL not set' },
							{ status: 400 },
						);
					}

					if (
						job.progress.stage !== 'pending' &&
						job.progress.stage !== 'waiting_hypeddit' &&
						job.progress.stage !== 'error'
					) {
						return jsonResponse(
							{ error: 'Job is already in progress or completed' },
							{ status: 400 },
						);
					}

					runDownloadProcess(jobId);

					return jsonResponse({ success: true, message: 'Download started' });
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
				const jobId = req.params.id;
				const job = jobStore.get(jobId);

				if (!job) {
					return jsonResponse({ error: 'Job not found' }, { status: 404 });
				}

				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();

						const initialData = `data: ${JSON.stringify(job.progress)}\n\n`;
						controller.enqueue(encoder.encode(initialData));

						const unsubscribe = jobStore.subscribe(jobId, (progress) => {
							const data = `data: ${JSON.stringify(progress)}\n\n`;
							try {
								controller.enqueue(encoder.encode(data));
							} catch {
								unsubscribe();
							}

							if (progress.stage === 'ready' || progress.stage === 'error') {
								setTimeout(() => {
									try {
										controller.close();
									} catch {
										// Already closed
									}
								}, 100);
								unsubscribe();
							}
						});

						req.signal.addEventListener('abort', () => {
							unsubscribe();
							try {
								controller.close();
							} catch {
								// Already closed
							}
						});
					},
				});

				return sseResponse(stream);
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
					track: job.track,
					defaultMetadata: job.defaultMetadata,
					progress: job.progress,
					downloadFilename: job.downloadFilename,
					hasArtwork: !!job.artworkBuffer,
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

		'/api/job/:id/metadata': {
			POST: async (req) => {
				try {
					const jobId = req.params.id;
					const job = jobStore.get(jobId);

					if (!job) {
						return jsonResponse({ error: 'Job not found' }, { status: 404 });
					}

					if (!job.downloadFilename) {
						return jsonResponse(
							{ error: 'No downloaded file available' },
							{ status: 400 },
						);
					}

					const contentType = req.headers.get('content-type') || '';
					let metadata: Metadata;
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

						const artworkFile = formData.get('artwork');
						if (artworkFile instanceof File) {
							customArtwork = {
								buffer: await artworkFile.arrayBuffer(),
								fileName: artworkFile.name,
							};
						}
					} else {
						const body = await req.json();
						metadata = body as Metadata;
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
						job.downloadFilename,
						metadata,
						artwork,
						'always',
					);

					const outputFilename = outputPath.split('/').pop() || outputPath;
					jobStore.update(jobId, { outputFilename });

					jobStore.updateProgress(jobId, 'ready', 'Audio processing complete');

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

				return new Response(Bun.file(filePath), {
					headers: {
						...corsHeaders,
						'Content-Type': 'audio/mpeg',
						'Content-Disposition': `attachment; filename="${filename}"`,
					},
				});
			},
		},
	},
	error: async (err) => {
		console.error('Server error:', err);
		if (hypedditDownloader) {
			await hypedditDownloader.close();
			hypedditDownloader = null;
		}
		return jsonResponse({ error: 'Internal Server Error' }, { status: 500 });
	},
});

console.log(`Server is running on ${server.url}`);
