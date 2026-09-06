import { useCallback, useEffect, useRef, useState } from 'react';
import { Toaster, toast } from 'sonner';
import type { BrowserMode, OutputFormat } from '../../../src/types';
import './App.css';
import { resolveApiBase } from './apiBase';
import {
	parseAvailableBrowserModes,
	parseBrowserViewUrl,
	readRequestedBrowserMode,
	readRequestedOutputFormat,
	readStoredBrowserMode,
	readStoredOutputFormat,
	shouldAutoStartDeepLink,
	shouldUseEmbeddedLayout,
} from './deepLink';
import { RemoteBrowserPanel } from './RemoteBrowserPanel';
import { REMOTE_POINTER_RELEASE_EVENT } from './remoteBrowser';

type Step = 'url' | 'gate' | 'download' | 'metadata' | 'complete';

interface Metadata {
	title?: string;
	artist?: string;
	album?: string;
	genre?: string;
}

interface TrackInfo {
	title: string;
	artworkUrl: string | null;
	user: { username: string; fullName?: string; avatarUrl: string };
	genre?: string;
}

interface JobProgress {
	stage: string;
	message: string;
	percent: number;
	currentGate?: string;
	downloadBytes?: number;
	totalBytes?: number;
	browserless?: boolean;
	browserActive?: boolean;
	bandcampAlbumTracks?: BandcampAlbumTrackChoice[];
	queuePosition?: number;
}

const GATE_PROGRESS_STAGES = new Set([
	'queued',
	'initializing_browser',
	'preparing_logins',
	'handling_gates',
	'waiting_bandcamp_track',
	'cancelling',
]);

const ACTIVE_JOB_STAGES = new Set([
	'queued',
	'initializing_browser',
	'preparing_logins',
	'handling_gates',
	'waiting_bandcamp_track',
	'downloading',
	'processing_audio',
	'cancelling',
]);

interface BandcampAlbumTrackChoice {
	title: string;
	url: string;
	score: number;
}

interface JobState {
	jobId: string | null;
	track: TrackInfo | null;
	hypedditUrl: string | null;
	defaultMetadata: Metadata | null;
	existingMetadata: Metadata | null;
	hasExistingArtwork: boolean;
	outputFormat: OutputFormat;
	progress: JobProgress | null;
	downloadFilename: string | null;
	outputFilename: string | null;
	sourceIsLossless: boolean | null;
	warning: string | null;
	error: string | null;
}

const API_BASE = resolveApiBase(
	typeof window === 'undefined' ? undefined : window.location,
	import.meta.env.PUBLIC_API_BASE_URL,
);
const BROWSER_MODE_STORAGE_KEY = 'sc-gate-dl-browser-mode';
const OUTPUT_FORMAT_STORAGE_KEY = 'sc-gate-dl-output-format';
const BROWSER_MODE_LABELS: Record<BrowserMode, string> = {
	headless: 'Headless',
	xvfb: 'Invisible headed (Xvfb)',
	headed: 'Visible headed window',
};

const ALLOWED_HOST_ORIGINS = new Set([
	'https://soundcloud.com',
	'https://www.soundcloud.com',
	'https://m.soundcloud.com',
	'http://localhost:4321',
	'http://127.0.0.1:4321',
]);

function notifyParent(
	type: 'file-download' | 'new-download' | 'job' | 'cancelled' | 'ready',
	payload?: { jobId?: string },
) {
	if (window.parent === window) return;
	window.parent.postMessage({ source: 'sc-gate-dl', type, ...payload }, '*');
}

/** Promo fluff often glued onto SoundCloud / gate titles. */
const PROMO_TAG = String.raw`free\s*d(?:own)?l(?:oad)?s?|free[\s._-]*dl|freedl|out\s*now|premiere|exclusive`;

export function cleanPromoTags(value: string): string {
	if (!value) return value;

	let result = value;
	result = result.replace(
		new RegExp(
			String.raw`\s*[\[\(\{]\s*(?:${PROMO_TAG})\s*[\]\)\}]\s*(?:[-–—|/:·•]+\s*)?`,
			'gi',
		),
		' ',
	);
	result = result.replace(
		new RegExp(
			String.raw`(?:\s*[-–—|/·•*]+\s*|\s+)(?:${PROMO_TAG})(?:\s*\*+)?\s*$`,
			'gi',
		),
		'',
	);
	result = result.replace(
		new RegExp(String.raw`(?:${PROMO_TAG})\s*$`, 'gi'),
		'',
	);
	result = result.replace(
		new RegExp(String.raw`^\s*(?:${PROMO_TAG})(?:\s*[-–—|/·•]+\s*|\s+)`, 'gi'),
		'',
	);
	result = result.replace(/\s{2,}/g, ' ');
	result = result.replace(/^[\s\-–—|/·•]+|[\s\-–—|/·•]+$/g, '');
	return result.trim();
}

export function shouldActivateBrowserView(
	browserMode: BrowserMode,
	progress: Pick<JobProgress, 'browserActive'>,
	browserViewUrl: string | null,
): boolean {
	return (
		browserMode === 'headed' &&
		progress.browserActive === true &&
		Boolean(browserViewUrl)
	);
}

export function shouldAutoCloseBrowserView(
	stage: JobProgress['stage'],
	alreadyClosed: boolean,
): boolean {
	return stage === 'downloading' && !alreadyClosed;
}

function normalizedArtistCredits(value: string): string[] {
	return value
		.normalize('NFKD')
		.replace(/\p{M}/gu, '')
		.toLocaleLowerCase()
		.replace(/\b(?:featuring|feat|ft|with|versus|vs)\.?\b/gu, '&')
		.split(/\s*(?:,|&|\+|×)\s*|\s+and\s+/u)
		.map((credit) => credit.replace(/[^\p{L}\p{N}]+/gu, ''))
		.filter(Boolean)
		.sort();
}

function artistCreditsMatch(left: string, right: string): boolean {
	const leftCredits = normalizedArtistCredits(left);
	const rightCredits = normalizedArtistCredits(right);
	return (
		leftCredits.length > 0 &&
		leftCredits.length === rightCredits.length &&
		leftCredits.every((credit, index) => credit === rightCredits[index])
	);
}

/** Strip a leading/trailing artist credit even when its separators differ. */
export function stripDuplicateArtistFromTitle(
	title: string,
	artist: string,
): string {
	const trimmedArtist = artist.trim();
	const trimmedTitle = title.trim();
	if (!trimmedArtist || !trimmedTitle) return trimmedTitle;

	for (const separator of trimmedTitle.matchAll(/\s+[-–—|:]\s+/gu)) {
		const index = separator.index;
		const left = trimmedTitle.slice(0, index).trim();
		const right = trimmedTitle.slice(index + separator[0].length).trim();
		if (artistCreditsMatch(left, trimmedArtist)) return right;
		if (artistCreditsMatch(right, trimmedArtist)) return left;
	}

	return trimmedTitle;
}

export function cleanMetadataFields(meta: Metadata): Metadata {
	const artist = cleanPromoTags(meta.artist || '');
	const title = stripDuplicateArtistFromTitle(
		cleanPromoTags(meta.title || ''),
		artist,
	);
	return {
		title,
		artist,
		album: cleanPromoTags(meta.album || ''),
		genre: cleanPromoTags(meta.genre || ''),
	};
}

function metadataNeedsCleanup(meta: Metadata): boolean {
	const cleaned = cleanMetadataFields(meta);
	return (
		(meta.title || '') !== (cleaned.title || '') ||
		(meta.artist || '') !== (cleaned.artist || '') ||
		(meta.album || '') !== (cleaned.album || '') ||
		(meta.genre || '') !== (cleaned.genre || '')
	);
}

function sanitizeFilenamePart(value: string): string {
	return value
		.replace(/[<>:"/\\|?*]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function artistTitleFilename(
	artist?: string,
	title?: string,
	extension = '.mp3',
): string {
	const safeArtist = sanitizeFilenamePart(artist || '') || 'Unknown Artist';
	const safeTitle = sanitizeFilenamePart(title || '') || 'Unknown Title';
	return `${safeArtist} - ${safeTitle}${extension}`;
}

function needsMp3Conversion(filename: string): boolean {
	const lower = filename.toLowerCase();
	return (
		lower.endsWith('.wav') ||
		lower.endsWith('.aiff') ||
		lower.endsWith('.aif') ||
		lower.endsWith('.flac') ||
		lower.endsWith('.m4a') ||
		lower.endsWith('.aac') ||
		lower.endsWith('.ogg') ||
		lower.endsWith('.opus') ||
		lower.endsWith('.webm')
	);
}

function previewProcessedFilename(
	downloadFilename: string | null,
	options: {
		nameAsArtistTitle: boolean;
		artist?: string;
		title?: string;
		outputFormat: OutputFormat;
	},
): string {
	if (!downloadFilename) return '';
	const extension = options.outputFormat === 'flac' ? '.flac' : '.mp3';
	if (options.nameAsArtistTitle) {
		return artistTitleFilename(options.artist, options.title, extension);
	}
	if (options.outputFormat === 'flac') {
		return downloadFilename.replace(/\.[^.]+$/i, '.flac');
	}
	if (needsMp3Conversion(downloadFilename)) {
		return downloadFilename.replace(
			/\.(wav|aiff|aif|flac|m4a|aac|ogg|opus|webm)$/i,
			'.mp3',
		);
	}
	return downloadFilename;
}

export default function App() {
	const [step, setStep] = useState<Step>('url');
	const [soundcloudUrl, setSoundcloudUrl] = useState('');
	const [hypedditUrlInput, setHypedditUrlInput] = useState('');
	const [skipAutomaticHypedditFetch, setSkipAutomaticHypedditFetch] =
		useState(false);
	const [browserMode, setBrowserMode] = useState<BrowserMode>('headless');
	const [lastAttemptedBrowserMode, setLastAttemptedBrowserMode] =
		useState<BrowserMode | null>(null);
	const [availableBrowserModes, setAvailableBrowserModes] = useState<
		BrowserMode[]
	>(['headless', 'headed']);
	const [browserModeHydrated, setBrowserModeHydrated] = useState(false);
	const [browserViewUrl, setBrowserViewUrl] = useState<string | null>(null);
	const [browserViewActive, setBrowserViewActive] = useState(false);
	const [browserViewOpen, setBrowserViewOpen] = useState(false);
	const [embedded, setEmbedded] = useState(false);
	const [outputFormat, setOutputFormat] = useState<OutputFormat>('mp3-320');
	const [job, setJob] = useState<JobState>({
		jobId: null,
		track: null,
		hypedditUrl: null,
		defaultMetadata: null,
		existingMetadata: null,
		hasExistingArtwork: false,
		outputFormat: 'mp3-320',
		progress: null,
		downloadFilename: null,
		outputFilename: null,
		sourceIsLossless: null,
		warning: null,
		error: null,
	});
	const [metadata, setMetadata] = useState<Metadata>({
		title: '',
		artist: '',
		album: '',
		genre: '',
	});

	useEffect(() => {
		let cancelled = false;
		setEmbedded(shouldUseEmbeddedLayout(window.location.search));

		const hydrateBrowserModes = async () => {
			let modes: BrowserMode[] = ['headless', 'headed'];
			let viewUrl: string | null = null;
			try {
				const response = await fetch(`${API_BASE}/api/capabilities`);
				if (response.ok) {
					const capabilities = await response.json();
					modes = parseAvailableBrowserModes(capabilities);
					viewUrl = parseBrowserViewUrl(capabilities, window.location.hostname);
				}
			} catch {
				// Keep the portable modes when the API is unavailable.
			}

			if (cancelled) return;
			setAvailableBrowserModes(modes);
			setBrowserViewUrl(viewUrl);
			const requestedMode = readRequestedBrowserMode(window.location.search);
			let storedMode: BrowserMode | null = null;
			let storedFormat: ReturnType<typeof readStoredOutputFormat> = null;
			try {
				storedMode = readStoredBrowserMode(
					localStorage,
					BROWSER_MODE_STORAGE_KEY,
				);
				storedFormat = readStoredOutputFormat(
					localStorage,
					OUTPUT_FORMAT_STORAGE_KEY,
				);
			} catch {
				// Storage may be blocked when the Web UI is embedded cross-origin.
			}
			const preferredMode =
				requestedMode && modes.includes(requestedMode)
					? requestedMode
					: storedMode && modes.includes(storedMode)
						? storedMode
						: null;
			if (preferredMode) {
				setBrowserMode(preferredMode);
				if (requestedMode === preferredMode) {
					try {
						localStorage.setItem(BROWSER_MODE_STORAGE_KEY, preferredMode);
					} catch {
						// The requested mode still applies for this session.
					}
				}
			}
			const requestedFormat = readRequestedOutputFormat(window.location.search);
			const preferredFormat = requestedFormat ?? storedFormat;
			if (preferredFormat) {
				setOutputFormat(preferredFormat);
				if (requestedFormat === preferredFormat) {
					try {
						localStorage.setItem(OUTPUT_FORMAT_STORAGE_KEY, preferredFormat);
					} catch {
						// The requested format still applies for this session.
					}
				}
			}
			setBrowserModeHydrated(true);
		};

		void hydrateBrowserModes();
		return () => {
			cancelled = true;
		};
	}, []);

	const updateBrowserMode = (mode: BrowserMode) => {
		setBrowserMode(mode);
		if (mode !== 'headed') {
			setBrowserViewOpen(false);
			setBrowserViewActive(false);
		}
		try {
			localStorage.setItem(BROWSER_MODE_STORAGE_KEY, mode);
		} catch {
			// Keep the in-memory selection when persistent storage is unavailable.
		}
	};

	const updateOutputFormat = (format: OutputFormat) => {
		setOutputFormat(format);
		try {
			localStorage.setItem(OUTPUT_FORMAT_STORAGE_KEY, format);
		} catch {
			// Keep the in-memory selection when persistent storage is unavailable.
		}
	};
	const [customArtwork, setCustomArtwork] = useState<File | null>(null);
	const [nameAsArtistTitle, setNameAsArtistTitle] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const artworkInputRef = useRef<HTMLInputElement>(null);
	const cleanupToastShownRef = useRef(false);
	const browserViewAutoClosedRef = useRef(false);
	const browserViewAutoOpenedRef = useRef(false);
	const autoStartedFromQueryRef = useRef(false);
	const eventSourceRef = useRef<EventSource | null>(null);
	const cancelRequestedRef = useRef(false);
	const unloadJobRef = useRef<{ jobId: string | null; stage?: string }>({
		jobId: null,
	});
	const formatPercent = (value?: number) => Math.round(value ?? 0);

	useEffect(() => {
		unloadJobRef.current = {
			jobId: job.jobId,
			stage: job.progress?.stage,
		};
	}, [job.jobId, job.progress?.stage]);

	useEffect(() => {
		const cancelJobOnUnload = () => {
			if (cancelRequestedRef.current) return;
			const { jobId, stage } = unloadJobRef.current;
			if (!jobId || !stage || !ACTIVE_JOB_STAGES.has(stage)) return;
			cancelRequestedRef.current = true;
			const url = `${API_BASE}/api/job/${encodeURIComponent(jobId)}/cancel`;
			// Prefer keepalive fetch: sendBeacon is easy to drop for cross-origin
			// POSTs, and pagehide is more reliable than beforeunload for iframes/tabs.
			void fetch(url, { method: 'POST', keepalive: true }).catch(() => {});
		};
		window.addEventListener('pagehide', cancelJobOnUnload);
		window.addEventListener('beforeunload', cancelJobOnUnload);
		return () => {
			window.removeEventListener('pagehide', cancelJobOnUnload);
			window.removeEventListener('beforeunload', cancelJobOnUnload);
		};
	}, []);

	const showCleanupSoundcloudToast = useCallback(() => {
		toast('Cleanup your SoundCloud account?', {
			description: 'This will unfollow, unlike, and delete comments/reposts.',
			closeButton: false,
			duration: Infinity,
			action: {
				label: 'Confirm',
				onClick: async () => {
					const toastId = toast.loading('Cleaning up SoundCloud account...');

					try {
						const response = await fetch(`${API_BASE}/api/soundcloud/cleanup`, {
							method: 'POST',
						});
						const data = await response.json();

						if (!response.ok) {
							throw new Error(
								data.error || 'Failed to cleanup SoundCloud account',
							);
						}

						const parts: string[] = [];
						if (data.unfollowed > 0) {
							parts.push(
								`${data.unfollowed} unfollow${data.unfollowed === 1 ? '' : 's'}`,
							);
						}
						if (data.unliked > 0) {
							parts.push(
								`${data.unliked} unlike${data.unliked === 1 ? '' : 's'}`,
							);
						}
						if (data.deletedComments > 0) {
							parts.push(
								`${data.deletedComments} comment${data.deletedComments === 1 ? '' : 's'} deleted`,
							);
						}
						if (data.deletedReposts > 0) {
							parts.push(
								`${data.deletedReposts} repost${data.deletedReposts === 1 ? '' : 's'} deleted`,
							);
						}

						const description =
							parts.length > 0 ? parts.join(', ') : 'No items to clean up.';

						toast.success('SoundCloud account cleanup completed.', {
							id: toastId,
							description,
						});
					} catch (err) {
						toast.error('Cleanup failed', {
							id: toastId,
							description: err instanceof Error ? err.message : 'Unknown error',
						});
					}
				},
			},
			cancel: {
				label: 'Cancel',
				onClick: () => {},
			},
		});
	}, []);

	// Start download process
	const startDownload = useCallback(
		async (jobId: string, retryBrowserMode?: BrowserMode) => {
			const effectiveBrowserMode = retryBrowserMode ?? browserMode;
			setLastAttemptedBrowserMode(effectiveBrowserMode);
			cancelRequestedRef.current = false;
			browserViewAutoClosedRef.current = false;
			browserViewAutoOpenedRef.current = false;
			setStep('gate');
			setJob((prev) => ({
				...prev,
				error: null,
				progress: {
					stage: 'handling_gates',
					message: 'Entering gate...',
					percent: 0,
				},
			}));
			cleanupToastShownRef.current = false;
			eventSourceRef.current?.close();
			eventSourceRef.current = null;
			notifyParent('job', { jobId });

			try {
				const response = await fetch(`${API_BASE}/api/job/${jobId}/start`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						browserMode: effectiveBrowserMode,
					}),
				});

				if (!response.ok) {
					const data = await response.json();
					throw new Error(data.error || 'Failed to start download');
				}

				// Connect to SSE for progress updates
				const eventSource = new EventSource(
					`${API_BASE}/api/job/${jobId}/events`,
				);
				eventSourceRef.current = eventSource;

				eventSource.onmessage = (event) => {
					const progress: JobProgress = JSON.parse(event.data);
					setJob((prev) => ({ ...prev, progress }));
					if (
						progress.stage !== 'downloading' &&
						!browserViewAutoOpenedRef.current &&
						shouldActivateBrowserView(
							effectiveBrowserMode,
							progress,
							browserViewUrl,
						)
					) {
						browserViewAutoOpenedRef.current = true;
						setBrowserViewActive(true);
						setBrowserViewOpen(true);
					}

					if (progress.stage === 'downloading') {
						if (
							shouldAutoCloseBrowserView(
								progress.stage,
								browserViewAutoClosedRef.current,
							)
						) {
							browserViewAutoClosedRef.current = true;
							setBrowserViewOpen(false);
						}
						setStep('download');
					} else if (progress.stage === 'processing_audio') {
						setStep('metadata');
					} else if (GATE_PROGRESS_STAGES.has(progress.stage)) {
						setStep('gate');
					}

					// Browserless downloads never touch the SoundCloud account, so there
					// is nothing to clean up afterwards.
					if (
						progress.stage === 'downloading' &&
						(progress.downloadBytes || progress.totalBytes) &&
						!progress.browserless &&
						!cleanupToastShownRef.current
					) {
						showCleanupSoundcloudToast();
						cleanupToastShownRef.current = true;
					}

					if (progress.stage === 'ready') {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
						eventSource.close();
						eventSourceRef.current = null;
						notifyParent('ready');
						fetch(`${API_BASE}/api/job/${jobId}`)
							.then((res) => res.json())
							.then((data) => {
								setJob((prev) => ({
									...prev,
									downloadFilename: data.downloadFilename,
									outputFilename: data.outputFilename,
									existingMetadata: data.existingMetadata,
									hasExistingArtwork: !!data.hasExistingArtwork,
									outputFormat: data.outputFormat,
									sourceIsLossless: data.sourceIsLossless,
								}));
								setStep(
									data.outputFormat === 'original' ? 'complete' : 'metadata',
								);
							})
							.catch((err) => {
								setJob((prev) => ({
									...prev,
									error:
										err instanceof Error ? err.message : 'Failed to load job',
								}));
							});
					} else if (progress.stage === 'waiting_bandcamp_track') {
						setJob((prev) => ({
							...prev,
							progress,
							error: null,
						}));
					} else if (progress.stage === 'error') {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
						eventSource.close();
						eventSourceRef.current = null;
						setJob((prev) => ({ ...prev, error: progress.message }));
					} else if (progress.stage === 'cancelled') {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
						eventSource.close();
						eventSourceRef.current = null;
						setJob((prev) => ({
							...prev,
							progress,
							error: null,
						}));
						setStep('url');
						notifyParent('cancelled');
					}
				};

				eventSource.onerror = () => {
					if (eventSource.readyState === EventSource.CONNECTING) return;
					eventSource.close();
					if (eventSourceRef.current === eventSource) {
						eventSourceRef.current = null;
					}
					setJob((prev) => ({
						...prev,
						error: 'Lost connection to download progress',
					}));
				};
			} catch (err) {
				setJob((prev) => ({
					...prev,
					error: err instanceof Error ? err.message : 'Unknown error',
					progress: {
						stage: 'error',
						message: err instanceof Error ? err.message : 'Unknown error',
						percent: 0,
					},
				}));
			}
		},
		[browserMode, browserViewUrl, showCleanupSoundcloudToast],
	);

	const cancelDownload = useCallback(async () => {
		const jobId = job.jobId;
		if (!jobId || cancelRequestedRef.current) return;
		cancelRequestedRef.current = true;

		try {
			const response = await fetch(`${API_BASE}/api/job/${jobId}/cancel`, {
				method: 'POST',
			});
			if (!response.ok) {
				cancelRequestedRef.current = false;
				const data = await response.json().catch(() => ({}));
				setJob((prev) => ({
					...prev,
					error:
						(data as { error?: string }).error || 'Failed to cancel download',
				}));
				return;
			}
		} catch (err) {
			cancelRequestedRef.current = false;
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Failed to cancel download',
			}));
			return;
		}

		eventSourceRef.current?.close();
		eventSourceRef.current = null;

		setJob((prev) => ({
			...prev,
			progress: {
				stage: 'cancelled',
				message: 'Download cancelled',
				percent: prev.progress?.percent ?? 0,
			},
			error: null,
		}));
		setStep('url');
		setBrowserViewOpen(false);
		setBrowserViewActive(false);
		notifyParent('cancelled');
	}, [job.jobId]);

	// Parent userscript panel X → cancel in-progress job
	useEffect(() => {
		const onMessage = (event: MessageEvent) => {
			if (!ALLOWED_HOST_ORIGINS.has(event.origin)) return;
			const data = event.data;
			if (data?.source !== 'sc-gate-dl-host') return;
			if (data.type === 'cancel') {
				void cancelDownload();
			} else if (data.type === 'release-remote-pointer') {
				window.dispatchEvent(new Event(REMOTE_POINTER_RELEASE_EVENT));
			}
		};
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [cancelDownload]);

	const createJob = useCallback(
		async (url: string, formatOverride?: OutputFormat) => {
			const trimmed = url.trim();
			if (!trimmed) return;

			const format = formatOverride ?? outputFormat;

			setIsLoading(true);
			setJob((prev) => ({ ...prev, warning: null, error: null }));

			try {
				const response = await fetch(`${API_BASE}/api/job`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						soundcloudUrl: trimmed,
						skipAutomaticHypedditFetch,
						outputFormat: format,
					}),
				});

				const data = await response.json();

				if (!response.ok) {
					throw new Error(data.error || 'Failed to create job');
				}

				setJob((prev) => ({
					...prev,
					jobId: data.jobId,
					track: data.track,
					hypedditUrl: data.hypedditUrl,
					defaultMetadata: data.defaultMetadata,
					existingMetadata: null,
					hasExistingArtwork: false,
					outputFormat: format,
					warning: data.soundcloudDownloadWarning ?? null,
					error: null,
				}));

				if (data.defaultMetadata) {
					setMetadata(data.defaultMetadata);
				}

				if (skipAutomaticHypedditFetch || data.needsHypedditUrl) {
					setStep('gate');
				} else {
					startDownload(data.jobId);
				}
			} catch (err) {
				setJob((prev) => ({
					...prev,
					error: err instanceof Error ? err.message : 'Unknown error',
				}));
			} finally {
				setIsLoading(false);
			}
		},
		[skipAutomaticHypedditFetch, outputFormat, startDownload],
	);

	// Create job with SoundCloud URL
	const handleSoundcloudSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		void createJob(soundcloudUrl);
	};

	// Userscript / deep-link: ?url=&outputFormat= pre-fills and starts a job
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		let queryUrl = params.get('url') || params.get('soundcloudUrl');
		if (
			!shouldAutoStartDeepLink(
				browserModeHydrated,
				autoStartedFromQueryRef.current,
				queryUrl,
			)
		) {
			return;
		}
		autoStartedFromQueryRef.current = true;

		// New SC listen layout may pass /n/artist/track — normalize to /artist/track
		try {
			const parsed = new URL(queryUrl);
			const parts = parsed.pathname.split('/').filter(Boolean);
			if (parts[0] === 'n' && parts.length >= 3) {
				parsed.pathname = `/${parts[1]}/${parts[2]}`;
				parsed.search = '';
				parsed.hash = '';
				queryUrl = parsed.toString();
			}
		} catch {
			// keep queryUrl as-is
		}

		// Format is already hydrated from the query/localStorage before this runs.
		const format =
			readRequestedOutputFormat(window.location.search) ?? undefined;
		setSoundcloudUrl(queryUrl);
		void createJob(queryUrl, format);
	}, [browserModeHydrated, createJob]);

	// Set Hypeddit URL and start download
	const handleHypedditSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!hypedditUrlInput.trim() || !job.jobId) return;

		setIsLoading(true);

		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/hypeddit`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ hypedditUrl: hypedditUrlInput }),
				},
			);

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to set Hypeddit URL');
			}

			setJob((prev) => ({ ...prev, hypedditUrl: hypedditUrlInput }));
			startDownload(job.jobId);
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	/** No gate found — download the SoundCloud track itself via yt-dlp. */
	const handleYtdlpSoundcloudDownload = async () => {
		if (!job.jobId || !soundcloudUrl.trim()) return;

		setIsLoading(true);
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/hypeddit`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ hypedditUrl: soundcloudUrl }),
				},
			);

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to start yt-dlp download');
			}

			setJob((prev) => ({ ...prev, hypedditUrl: soundcloudUrl }));
			startDownload(job.jobId);
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	const handleBandcampTrackSelect = async (trackUrl: string) => {
		if (!job.jobId) return;

		setIsLoading(true);
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/bandcamp-track`,
				{
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ trackUrl }),
				},
			);
			const data = await response.json();
			if (!response.ok) {
				throw new Error(data.error || 'Failed to select Bandcamp track');
			}
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	// Process metadata and finalize
	const processMetadata = async (preserveMetadata = false) => {
		if (!job.jobId) return;

		setIsLoading(true);

		try {
			let response: Response;

			if (preserveMetadata) {
				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						preserveMetadata: true,
						nameAsArtistTitle,
						title: metadata.title,
						artist: metadata.artist,
						album: metadata.album,
						genre: metadata.genre,
					}),
				});
			} else if (customArtwork) {
				const formData = new FormData();
				formData.append('title', metadata.title || '');
				formData.append('artist', metadata.artist || '');
				formData.append('album', metadata.album || '');
				formData.append('genre', metadata.genre || '');
				formData.append('nameAsArtistTitle', String(nameAsArtistTitle));
				formData.append('artwork', customArtwork);

				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					body: formData,
				});
			} else {
				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ ...metadata, nameAsArtistTitle }),
				});
			}

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to process audio');
			}

			setJob((prev) => ({ ...prev, outputFilename: data.outputFilename }));
			setStep('complete');
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
			}));
		} finally {
			setIsLoading(false);
		}
	};

	const handleMetadataSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		void processMetadata();
	};

	const defaultMetadataValues: Metadata = job.defaultMetadata ?? {
		title: '',
		artist: '',
		album: '',
		genre: '',
	};
	const canCleanupMetadata = metadataNeedsCleanup(metadata);
	const outputFilenamePreview = previewProcessedFilename(job.downloadFilename, {
		nameAsArtistTitle,
		artist: metadata.artist,
		title: metadata.title,
		outputFormat: job.outputFormat,
	});
	const isHandlingGate =
		step === 'gate' && GATE_PROGRESS_STAGES.has(job.progress?.stage ?? '');
	const isCancelling = job.progress?.stage === 'cancelling';
	const existingTagRows = (
		[
			{ key: 'title', label: 'Title' },
			{ key: 'artist', label: 'Artist' },
			{ key: 'album', label: 'Album' },
			{ key: 'genre', label: 'Genre' },
		] as const
	)
		.map(({ key, label }) => ({
			key,
			label,
			existingValue: job.existingMetadata?.[key]?.trim() || '',
		}))
		.filter(({ existingValue }) => existingValue);
	const hasExistingMetadata =
		existingTagRows.length > 0 || job.hasExistingArtwork;

	const copyExistingArtwork = async () => {
		if (!job.jobId || !job.hasExistingArtwork) return;
		try {
			const response = await fetch(
				`${API_BASE}/api/job/${job.jobId}/existing-artwork`,
			);
			if (!response.ok) {
				throw new Error('Failed to load existing cover art');
			}
			const blob = await response.blob();
			const extension = blob.type === 'image/png' ? 'png' : 'jpg';
			setCustomArtwork(
				new File([blob], `existing-cover.${extension}`, {
					type: blob.type || 'image/jpeg',
				}),
			);
		} catch (err) {
			toast.error('Could not copy cover art', {
				description: err instanceof Error ? err.message : 'Unknown error',
			});
		}
	};

	// Reset and start over
	const handleReset = () => {
		cancelRequestedRef.current = false;
		notifyParent('new-download');
		setSoundcloudUrl('');
		setHypedditUrlInput('');
		setSkipAutomaticHypedditFetch(false);
		setJob({
			jobId: null,
			track: null,
			hypedditUrl: null,
			defaultMetadata: null,
			existingMetadata: null,
			hasExistingArtwork: false,
			outputFormat,
			progress: null,
			downloadFilename: null,
			outputFilename: null,
			sourceIsLossless: null,
			warning: null,
			error: null,
		});
		setMetadata({ title: '', artist: '', album: '', genre: '' });
		setCustomArtwork(null);
		if (artworkInputRef.current) {
			artworkInputRef.current.value = '';
		}
		setNameAsArtistTitle(false);
		setBrowserViewOpen(false);
		setBrowserViewActive(false);
		setStep('url');
	};

	const handleInitializeLogins = async () => {
		toast('Initialize logins?', {
			description:
				'This opens a browser on the server to initialize SoundCloud and Spotify logins. Use View Browser to interact with it or solve a captcha.',
			closeButton: false,
			duration: Infinity,
			action: {
				label: 'Confirm',
				onClick: async () => {
					if (browserViewUrl) {
						setBrowserViewActive(true);
						setBrowserViewOpen(true);
					}
					const toastId = toast.loading('Initializing logins...');

					try {
						const response = await fetch(`${API_BASE}/api/logins/initialize`, {
							method: 'POST',
						});
						const data = await response.json();

						if (!response.ok) {
							throw new Error(data.error || 'Failed to initialize logins');
						}

						toast.success('Logins initialized successfully.', {
							id: toastId,
						});
					} catch (err) {
						toast.error('Login initialization failed', {
							id: toastId,
							description: err instanceof Error ? err.message : 'Unknown error',
						});
					} finally {
						setBrowserViewOpen(false);
						setBrowserViewActive(false);
					}
				},
			},
			cancel: {
				label: 'Cancel',
				onClick: () => {},
			},
		});
	};

	return (
		<div className="app">
			<Toaster richColors closeButton theme="dark" />
			{browserViewUrl && browserViewActive ? (
				<RemoteBrowserPanel
					open={browserViewOpen}
					viewUrl={browserViewUrl}
					onOpen={() => setBrowserViewOpen(true)}
					onClose={() => setBrowserViewOpen(false)}
				/>
			) : null}
			{!embedded && (
				<header className="header">
					<div className="logo">
						<span className="logo-icon">&#9654;</span>
						<h1>sc-gate-dl</h1>
					</div>
					<p className="tagline">
						Download & tag SoundCloud tracks from Hypeddit, Droploud, GateRush,
						DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, or a
						direct download link
					</p>
				</header>
			)}

			{/* Step indicator */}
			<div className="steps">
				<div
					className={`step ${step === 'url' ? 'active' : ''} ${['gate', 'download', 'metadata', 'complete'].includes(step) ? 'completed' : ''}`}
				>
					<span className="step-number">1</span>
					<span className="step-label">SoundCloud</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'gate' ? 'active' : ''} ${['download', 'metadata', 'complete'].includes(step) ? 'completed' : ''}`}
				>
					<span className="step-number">2</span>
					<span className="step-label">Gate</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'download' ? 'active' : ''} ${['metadata', 'complete'].includes(step) ? 'completed' : ''}`}
				>
					<span className="step-number">3</span>
					<span className="step-label">Download</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'metadata' ? 'active' : ''} ${step === 'complete' ? 'completed' : ''}`}
				>
					<span className="step-number">4</span>
					<span className="step-label">Metadata</span>
				</div>
				<div className="step-connector" />
				<div
					className={`step ${step === 'complete' ? 'active completed' : ''}`}
				>
					<span className="step-number">5</span>
					<span className="step-label">Done</span>
				</div>
			</div>

			{/* Error display */}
			{job.error && (
				<div className="error-banner">
					<div className="error-banner-message">
						<span className="error-icon">!</span>
						<span>{job.error}</span>
					</div>
					<div className="error-banner-actions">
						{job.jobId && job.progress?.stage === 'error'
							? availableBrowserModes
									.filter(
										(mode) =>
											mode !== (lastAttemptedBrowserMode ?? browserMode),
									)
									.map((mode) => (
										<button
											type="button"
											key={mode}
											onClick={() => {
												updateBrowserMode(mode);
												void startDownload(job.jobId as string, mode);
											}}
										>
											Retry with {BROWSER_MODE_LABELS[mode]}
										</button>
									))
							: null}
						<button
							type="button"
							onClick={() => setJob((prev) => ({ ...prev, error: null }))}
						>
							Dismiss
						</button>
					</div>
				</div>
			)}

			{job.warning && (
				<div className="warning-banner" role="status">
					<span className="warning-icon">!</span>
					<span>{job.warning}</span>
					<button
						type="button"
						onClick={() => setJob((prev) => ({ ...prev, warning: null }))}
					>
						Dismiss
					</button>
				</div>
			)}

			{/* Track preview */}
			{job.track && step !== 'url' && (
				<div className="track-preview">
					<img
						src={(job.track.artworkUrl || job.track.user.avatarUrl).replace(
							'large',
							't300x300',
						)}
						alt="Track artwork"
						className="track-artwork"
					/>
					<div className="track-info">
						<h3>{job.track.title}</h3>
						<p>{job.track.user.fullName || job.track.user.username}</p>
					</div>
				</div>
			)}

			{/* Step content */}
			<div className="content">
				{/* Step 1: SoundCloud URL */}
				{step === 'url' && (
					<form
						onSubmit={handleSoundcloudSubmit}
						className="form animate-slide-up"
					>
						<div className="form-group">
							<label htmlFor="soundcloud-url">SoundCloud Track URL</label>
							<input
								id="soundcloud-url"
								type="url"
								name="soundcloud-track-url"
								value={soundcloudUrl}
								onChange={(e) => setSoundcloudUrl(e.target.value)}
								placeholder="https://soundcloud.com/artist/track"
								autoComplete="off"
								required
								disabled={isLoading}
							/>
						</div>
						<div className="url-settings">
							<div className="form-group url-settings-format">
								<label htmlFor="output-format">Output Format</label>
								<select
									id="output-format"
									value={outputFormat}
									onChange={(e) =>
										updateOutputFormat(e.target.value as OutputFormat)
									}
									disabled={isLoading || isCancelling}
								>
									<option value="mp3-320">MP3 320 kbps</option>
									<option value="flac">FLAC</option>
									<option value="original">Original file</option>
								</select>
							</div>
							<div className="form-group url-settings-format">
								<label htmlFor="browser-mode">Browser Mode</label>
								<select
									id="browser-mode"
									value={browserMode}
									onChange={(e) =>
										updateBrowserMode(e.target.value as BrowserMode)
									}
									disabled={isLoading}
								>
									{availableBrowserModes.map((mode) => (
										<option key={mode} value={mode}>
											{BROWSER_MODE_LABELS[mode]}
										</option>
									))}
								</select>
							</div>
							<div className="checkbox-settings">
								<label className="checkbox-row" htmlFor="skip-hypeddit-fetch">
									<input
										id="skip-hypeddit-fetch"
										type="checkbox"
										checked={skipAutomaticHypedditFetch}
										onChange={(e) =>
											setSkipAutomaticHypedditFetch(e.target.checked)
										}
										disabled={isLoading}
									/>
									<span>Skip automatic gate link fetching</span>
								</label>
							</div>
						</div>
						<button type="submit" className="btn-primary" disabled={isLoading}>
							{isLoading ? (
								<>
									<span className="spinner" />
									Fetching...
								</>
							) : (
								'Fetch Track'
							)}
						</button>
					</form>
				)}

				{/* Step 2: Gate URL (if needed) */}
				{step === 'gate' && !isHandlingGate && (
					<div className="form animate-slide-up">
						<div className="notice">
							<span className="notice-icon">i</span>
							<p>
								{skipAutomaticHypedditFetch
									? 'Automatic gate lookup is disabled. Enter a gate URL manually, or download the SoundCloud track via yt-dlp.'
									: 'Gate URL not found in track. Enter a Hypeddit, Droploud, GateRush, DownloadGater, StillHype, PumpYourSound, MyPressKit, Bandcamp, or direct download URL, or download via yt-dlp from SoundCloud.'}
							</p>
						</div>
						<form onSubmit={handleHypedditSubmit}>
							<div className="form-group">
								<label htmlFor="hypeddit-url">Gate URL</label>
								<input
									id="hypeddit-url"
									type="url"
									name="hypeddit-url"
									value={hypedditUrlInput}
									onChange={(e) => setHypedditUrlInput(e.target.value)}
									placeholder="https://hypeddit.com/... / droploud.com/gate/... / gaterush.me/... / downloadgater.com/g/... / stillhype.io/g/... / pumpyoursound.com/f/... / artist.bandcamp.com/track/... / https://www.dropbox.com/...?dl=1"
									autoComplete="off"
									required
									disabled={isLoading}
								/>
							</div>
							<div className="form-group">
								<label htmlFor="browser-mode-gate">Browser Mode</label>
								<select
									id="browser-mode-gate"
									value={browserMode}
									onChange={(e) =>
										updateBrowserMode(e.target.value as BrowserMode)
									}
									disabled={isLoading}
								>
									{availableBrowserModes.map((mode) => (
										<option key={mode} value={mode}>
											{BROWSER_MODE_LABELS[mode]}
										</option>
									))}
								</select>
							</div>
							<button
								type="submit"
								className="btn-primary"
								disabled={isLoading}
							>
								{isLoading ? (
									<>
										<span className="spinner" />
										Starting...
									</>
								) : (
									'Start Download'
								)}
							</button>
						</form>
						<div className="form-divider" aria-hidden="true">
							<span>or</span>
						</div>
						<button
							type="button"
							className="btn-secondary btn-full"
							disabled={isLoading || !soundcloudUrl.trim()}
							onClick={handleYtdlpSoundcloudDownload}
						>
							{isLoading ? (
								<>
									<span className="spinner" />
									Starting...
								</>
							) : (
								'Download via yt-dlp from SoundCloud'
							)}
						</button>
					</div>
				)}

				{/* Steps 2–3: Gate handling, then download progress */}
				{(isHandlingGate || step === 'download') && (
					<div className="progress-container animate-slide-up">
						{job.progress?.stage === 'waiting_bandcamp_track' ? (
							<div className="bandcamp-track-picker">
								<div className="notice">
									<span className="notice-icon">i</span>
									<p>
										{job.progress.message ||
											'Could not auto-match a Bandcamp album track. Pick one to download.'}
									</p>
								</div>
								<ul className="bandcamp-track-list">
									{(job.progress.bandcampAlbumTracks ?? []).map((track) => (
										<li key={track.url}>
											<button
												type="button"
												className="bandcamp-track-option"
												disabled={isLoading}
												onClick={() =>
													void handleBandcampTrackSelect(track.url)
												}
											>
												<span className="bandcamp-track-title">
													{track.title}
												</span>
												{track.score > 0 ? (
													<span className="bandcamp-track-score">
														{Math.round(track.score * 100)}% match
													</span>
												) : null}
											</button>
										</li>
									))}
								</ul>
								<button
									type="button"
									className="btn-secondary btn-cancel-download"
									onClick={() => void cancelDownload()}
									disabled={isLoading || isCancelling}
								>
									Cancel download
								</button>
							</div>
						) : (
							<>
								<div className="progress-stage">
									<span className="stage-label">
										{job.progress?.message ||
											(job.progress?.downloadBytes !== undefined
												? 'Downloading...'
												: 'Initializing...')}
									</span>
									{job.progress?.currentGate && (
										<span className="gate-badge">
											{job.progress.currentGate.toUpperCase()}
										</span>
									)}
								</div>
								{isHandlingGate && (
									<div
										className="progress-bar"
										role="progressbar"
										aria-label="Gate progress"
										aria-valuetext={job.progress?.message || 'Handling gate'}
									>
										<div className="progress-fill progress-fill-indeterminate" />
									</div>
								)}
								{step === 'download' && (
									<>
										<div className="progress-bar">
											{typeof job.progress?.totalBytes === 'number' ? (
												<div
													className="progress-fill"
													style={{ width: `${job.progress?.percent || 0}%` }}
												/>
											) : (
												<div className="progress-fill progress-fill-indeterminate" />
											)}
										</div>
										<div className="progress-stats">
											{typeof job.progress?.totalBytes === 'number' ? (
												<span>{formatPercent(job.progress?.percent)}%</span>
											) : null}
											{job.progress?.downloadBytes !== undefined && (
												<span>
													{(job.progress.downloadBytes / 1024 / 1024).toFixed(
														1,
													)}
													{typeof job.progress.totalBytes === 'number'
														? ` / ${(job.progress.totalBytes / 1024 / 1024).toFixed(1)}`
														: ''}{' '}
													MB
												</span>
											)}
										</div>
									</>
								)}
								<button
									type="button"
									className="btn-secondary btn-cancel-download"
									onClick={() => void cancelDownload()}
									disabled={isCancelling}
								>
									Cancel download
								</button>
							</>
						)}
					</div>
				)}

				{/* Step 4: Metadata */}
				{step === 'metadata' && job.progress?.stage === 'processing_audio' && (
					<div className="progress-container animate-slide-up">
						<div className="progress-stage">
							<span className="stage-label">{job.progress.message}</span>
						</div>
					</div>
				)}
				{step === 'metadata' && job.progress?.stage !== 'processing_audio' && (
					<form
						onSubmit={handleMetadataSubmit}
						className="form metadata-form animate-slide-up"
					>
						{job.outputFormat === 'flac' && job.sourceIsLossless === false ? (
							<div className="notice">
								<span className="notice-icon">i</span>
								<p>
									The downloaded source is lossy. It will be converted to FLAC
									as selected, but the conversion cannot restore lost audio
									quality.
								</p>
							</div>
						) : null}
						{hasExistingMetadata ? (
							<div className="existing-metadata">
								<div>
									<h3>Existing MP3 Metadata</h3>
									<p>
										Copy a tag or cover into the form, or keep the file’s tags
										unchanged for the whole download.
									</p>
								</div>
								<ul className="existing-metadata-list">
									{existingTagRows.map(({ key, label, existingValue }) => (
										<li key={key} className="existing-metadata-row">
											<span className="existing-metadata-label">{label}</span>
											<span className="existing-metadata-value">
												{existingValue}
											</span>
											<button
												type="button"
												className="btn-copy-existing"
												disabled={isLoading}
												title={`Copy ${label.toLowerCase()} into the form`}
												aria-label={`Copy ${label.toLowerCase()} into the form`}
												onClick={() =>
													setMetadata((prev) => ({
														...prev,
														[key]: existingValue,
													}))
												}
											>
												<svg
													viewBox="0 0 24 24"
													width="14"
													height="14"
													aria-hidden="true"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												>
													<rect x="9" y="9" width="13" height="13" rx="2" />
													<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
												</svg>
											</button>
										</li>
									))}
									{job.hasExistingArtwork && job.jobId ? (
										<li className="existing-metadata-row">
											<span className="existing-metadata-label">Cover</span>
											<span className="existing-metadata-value">
												<img
													src={`${API_BASE}/api/job/${job.jobId}/existing-artwork`}
													alt="Existing cover art"
													className="existing-metadata-cover"
												/>
											</span>
											<button
												type="button"
												className="btn-copy-existing"
												disabled={isLoading}
												title="Copy cover art into the form"
												aria-label="Copy cover art into the form"
												onClick={() => void copyExistingArtwork()}
											>
												<svg
													viewBox="0 0 24 24"
													width="14"
													height="14"
													aria-hidden="true"
													fill="none"
													stroke="currentColor"
													strokeWidth="2"
													strokeLinecap="round"
													strokeLinejoin="round"
												>
													<rect x="9" y="9" width="13" height="13" rx="2" />
													<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
												</svg>
											</button>
										</li>
									) : null}
								</ul>
								<button
									type="button"
									className="btn-secondary"
									disabled={isLoading}
									onClick={() => void processMetadata(true)}
								>
									Use this metadata as-is
								</button>
							</div>
						) : null}
						<div className="metadata-grid">
							<div className="artwork-section">
								<div className="artwork-preview">
									{customArtwork ? (
										<img
											src={URL.createObjectURL(customArtwork)}
											alt="Custom artwork"
										/>
									) : job.jobId ? (
										<img
											src={`${API_BASE}/api/job/${job.jobId}/artwork`}
											alt="Track artwork"
										/>
									) : (
										<div className="artwork-placeholder">No artwork</div>
									)}
								</div>
								<label className="artwork-upload">
									<input
										ref={artworkInputRef}
										type="file"
										accept="image/*"
										disabled={isLoading}
										onChange={(e) =>
											setCustomArtwork(e.target.files?.[0] || null)
										}
									/>
									<span>Change Artwork</span>
								</label>
								{customArtwork ? (
									<button
										type="button"
										className="btn-artwork-action"
										disabled={isLoading}
										onClick={() => {
											setCustomArtwork(null);
											if (artworkInputRef.current) {
												artworkInputRef.current.value = '';
											}
										}}
									>
										Reset Artwork
									</button>
								) : null}
								{canCleanupMetadata ? (
									<button
										type="button"
										className="btn-secondary btn-auto-cleanup"
										disabled={isLoading}
										title="Remove promo tags like [FREE DL] or [PREMIERE] and duplicate Artist - / - Artist from the title"
										onClick={() =>
											setMetadata((prev) => cleanMetadataFields(prev))
										}
									>
										Auto-Cleanup
									</button>
								) : null}
							</div>

							<div className="fields-section">
								{(
									[
										{
											key: 'title',
											label: 'Title',
											placeholder: 'Track title',
										},
										{
											key: 'artist',
											label: 'Artist',
											placeholder: 'Artist name',
										},
										{
											key: 'album',
											label: 'Album',
											placeholder: 'Album name',
										},
										{
											key: 'genre',
											label: 'Genre',
											placeholder: 'Genre',
										},
									] as const
								).map(({ key, label, placeholder }) => {
									const currentValue = metadata[key] || '';
									const defaultValue = defaultMetadataValues[key] || '';
									const isDirty = currentValue !== defaultValue;
									return (
										<div className="form-group" key={key}>
											<label htmlFor={`meta-${key}`}>{label}</label>
											<div
												className={`field-with-reset${isDirty ? ' has-reset' : ''}`}
											>
												<input
													id={`meta-${key}`}
													type="text"
													value={currentValue}
													disabled={isLoading}
													onChange={(e) =>
														setMetadata((prev) => ({
															...prev,
															[key]: e.target.value,
														}))
													}
													placeholder={placeholder}
												/>
												{isDirty ? (
													<button
														type="button"
														className="btn-reset-field"
														disabled={isLoading}
														title={`Reset ${label.toLowerCase()} to default`}
														aria-label={`Reset ${label.toLowerCase()} to default`}
														onClick={() =>
															setMetadata((prev) => ({
																...prev,
																[key]: defaultValue,
															}))
														}
													>
														<svg
															viewBox="0 0 24 24"
															width="14"
															height="14"
															aria-hidden="true"
															fill="none"
															stroke="currentColor"
															strokeWidth="2"
															strokeLinecap="round"
															strokeLinejoin="round"
														>
															<path d="M3 12a9 9 0 1 0 3-6.7" />
															<path d="M3 4v5h5" />
														</svg>
													</button>
												) : null}
											</div>
										</div>
									);
								})}
							</div>
						</div>

						<div className="filename-preview">
							<label className="checkbox-row" htmlFor="name-as-artist-title">
								<input
									id="name-as-artist-title"
									type="checkbox"
									checked={nameAsArtistTitle}
									disabled={isLoading}
									onChange={(e) => setNameAsArtistTitle(e.target.checked)}
								/>
								<span>Name file as ARTIST - TITLE</span>
							</label>
							<div className="form-group">
								<label htmlFor="output-filename-preview">Filename</label>
								<input
									id="output-filename-preview"
									type="text"
									className="filename-preview-input mono"
									value={outputFilenamePreview}
									disabled
									readOnly
								/>
							</div>
						</div>

						<button type="submit" className="btn-primary" disabled={isLoading}>
							{isLoading ? (
								<>
									<span className="spinner" />
									Processing...
								</>
							) : (
								'Process & Finalize'
							)}
						</button>
					</form>
				)}

				{/* Step 5: Complete */}
				{step === 'complete' && (
					<div className="complete-container animate-slide-up">
						<div className="success-icon">&#10003;</div>
						<h2>Download Ready!</h2>
						<p className="filename mono">
							{job.outputFilename || job.downloadFilename}
						</p>
						<div className="complete-actions">
							{/* Navigate independently of the panel; the API serves an attachment. */}
							<a
								href={`${API_BASE}/api/job/${job.jobId}/file`}
								target="_blank"
								rel="noopener noreferrer"
								className="btn-primary"
								onClick={() => notifyParent('file-download')}
							>
								{job.outputFormat === 'original'
									? 'Download Original'
									: job.outputFormat === 'flac'
										? 'Download FLAC'
										: 'Download MP3'}
							</a>
							<button
								type="button"
								onClick={handleReset}
								className="btn-secondary"
							>
								Start New Download
							</button>
						</div>
					</div>
				)}
			</div>

			{!embedded && (
				<footer className="footer">
					<div className="footer-buttons">
						<button
							type="button"
							className="btn-secondary btn-cleanup"
							onClick={handleInitializeLogins}
						>
							Initialize Logins
						</button>
						<button
							type="button"
							className="btn-secondary btn-cleanup"
							onClick={showCleanupSoundcloudToast}
						>
							Cleanup SoundCloud
						</button>
					</div>
					<p>
						Built for personal use &middot;{' '}
						<a
							href="https://github.com/D3SOX/sc-gate-dl"
							target="_blank"
							rel="noopener noreferrer"
						>
							GitHub
						</a>
					</p>
				</footer>
			)}
		</div>
	);
}
