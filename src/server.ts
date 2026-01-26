import { join } from 'node:path';
import type { SoundcloudTrack } from 'soundcloud.ts';
import { AudioProcessor } from './audioProcessor';
import {
	extractHypedditUrl,
	getDefaultMetadata,
	validateHypedditUrl,
	validateSoundcloudUrl,
} from './flowUtils';
import { HypedditDownloader } from './hypeddit';
import { jobStore } from './jobStore';
import { SoundcloudClient } from './soundcloud';
import type { Job, Metadata } from './types';
import { getFfmpegBin, getFfprobeBin } from './utils';

// Initialize binaries
const ffmpegBin = await getFfmpegBin();
const ffprobeBin = await getFfprobeBin();

// Environment validation
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

// Initialize clients
const soundcloudClient = new SoundcloudClient();
const audioProcessor = new AudioProcessor(ffmpegBin, ffprobeBin);

// Shared downloader instance (single user assumption)
let hypedditDownloader: HypedditDownloader | null = null;

/**
 * Converts SoundcloudTrack to a serializable format
 */
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

/**
 * Runs the download process for a job
 */
async function runDownloadProcess(jobId: string): Promise<void> {
	const job = jobStore.get(jobId);
	if (!job || !job.hypedditUrl) return;

	try {
		// Initialize browser
		jobStore.updateProgress(
			jobId,
			'initializing_browser',
			'Launching browser...',
			10,
		);

		hypedditDownloader = new HypedditDownloader({
			name: HYPEDDIT_NAME,
			email: HYPEDDIT_EMAIL,
			comment: SC_COMMENT,
			headless: true,
		});

		// Set up progress callback
		hypedditDownloader.setProgressCallback((stage, message, percent, extra) => {
			jobStore.updateProgress(jobId, stage, message, percent, extra);
		});

		await hypedditDownloader.initialize();

		// Download audio
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

		// Update job with download info
		jobStore.update(jobId, { downloadFilename });

		// Fetch artwork
		jobStore.updateProgress(
			jobId,
			'processing_audio',
			'Fetching artwork...',
			90,
		);

		if (job.track?.artworkUrl) {
			const artwork = await soundcloudClient.fetchArtwork(job.track.artworkUrl);
			jobStore.update(jobId, {
				artworkBuffer: artwork.buffer,
				artworkFileName: artwork.fileName,
			});
		}

		// Mark as ready for metadata editing
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

// CORS headers for all responses
const corsHeaders: Record<string, string> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Helper to create JSON response with CORS headers
function jsonResponse(data: unknown, options?: { status?: number }): Response {
	return Response.json(data, {
		status: options?.status || 200,
		headers: corsHeaders,
	});
}

// Helper to create file/binary response with CORS headers
function fileResponse(
	body: BodyInit | null,
	headers: Record<string, string>,
): Response {
	return new Response(body, {
		headers: { ...corsHeaders, ...headers },
	});
}

// Helper for SSE response with CORS headers
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
		// Health check
		'/': () =>
			new Response('Hypeddit SoundCloud Downloader API is running!', {
				headers: corsHeaders,
			}),

		// Cleanup SoundCloud account (unfollow/unlike/delete)
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

		// Initialize logins (requires non-headless browser)
		'/api/logins/initialize': {
			POST: async () => {
				let loginDownloader: HypedditDownloader | null = null;
				try {
					// Create a new downloader instance with headless: false for login initialization
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

		// Create a new job with SoundCloud URL
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

					// Create job
					const job = jobStore.create(soundcloudUrl);
					jobStore.updateProgress(
						job.id,
						'fetching_track',
						'Fetching SoundCloud track...',
						5,
					);

					// Fetch track info
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

					// Extract hypeddit URL
					const hypedditUrl = extractHypedditUrl(track);
					const defaultMetadata = getDefaultMetadata(track);

					// Update job with track info
					jobStore.update(job.id, {
						track: serializeTrack(track),
						hypedditUrl,
						defaultMetadata,
						progress: {
							stage: hypedditUrl ? 'pending' : 'waiting_hypeddit',
							message: hypedditUrl
								? 'Ready to start download'
								: 'Hypeddit URL not found - manual input required',
							percent: 10,
						},
					});

					const updatedJob = jobStore.get(job.id)!;

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

		// Set Hypeddit URL for a job (if not auto-detected)
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

		// Start the download process
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

					// Start download process in background
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

		// SSE endpoint for job progress
		'/api/job/:id/events': {
			GET: (req) => {
				const jobId = req.params.id;
				const job = jobStore.get(jobId);

				if (!job) {
					return jsonResponse({ error: 'Job not found' }, { status: 404 });
				}

				// Create SSE stream
				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder();

						// Send initial state
						const initialData = `data: ${JSON.stringify(job.progress)}\n\n`;
						controller.enqueue(encoder.encode(initialData));

						// Subscribe to updates
						const unsubscribe = jobStore.subscribe(jobId, (progress) => {
							const data = `data: ${JSON.stringify(progress)}\n\n`;
							try {
								controller.enqueue(encoder.encode(data));
							} catch {
								// Stream closed
								unsubscribe();
							}

							// Close stream when job is complete or errored
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

						// Handle client disconnect
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

		// Get job status
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

		// Get artwork for a job
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

		// Process audio with metadata
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

					// Use custom artwork or job artwork
					const artwork = customArtwork || {
						buffer: job.artworkBuffer!,
						fileName: job.artworkFileName!,
					};

					if (!artwork.buffer) {
						return jsonResponse(
							{ error: 'No artwork available' },
							{ status: 400 },
						);
					}

					// Process audio
					const outputPath = await audioProcessor.processAudio(
						job.downloadFilename,
						metadata,
						artwork,
						'always', // Always delete lossless for web
					);

					const outputFilename = outputPath.split('/').pop() || outputPath;
					jobStore.update(jobId, { outputFilename });

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

		// Download processed file
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
