import { useCallback, useEffect, useState } from 'react';
import './App.css';

type Step = 'url' | 'hypeddit' | 'progress' | 'metadata' | 'complete';

interface Metadata {
	title?: string;
	artist?: string;
	album?: string;
	genre?: string;
}

interface TrackInfo {
	title: string;
	artworkUrl: string;
	user: { username: string; fullName?: string };
	genre?: string;
}

interface JobProgress {
	stage: string;
	message: string;
	percent: number;
	currentGate?: string;
	downloadBytes?: number;
	totalBytes?: number;
}

interface JobState {
	jobId: string | null;
	track: TrackInfo | null;
	hypedditUrl: string | null;
	defaultMetadata: Metadata | null;
	progress: JobProgress | null;
	downloadFilename: string | null;
	outputFilename: string | null;
	error: string | null;
}

const API_BASE = 'http://localhost:3000';

export default function App() {
	const [step, setStep] = useState<Step>('url');
	const [soundcloudUrl, setSoundcloudUrl] = useState('');
	const [hypedditUrlInput, setHypedditUrlInput] = useState('');
	const [job, setJob] = useState<JobState>({
		jobId: null,
		track: null,
		hypedditUrl: null,
		defaultMetadata: null,
		progress: null,
		downloadFilename: null,
		outputFilename: null,
		error: null,
	});
	const [metadata, setMetadata] = useState<Metadata>({
		title: '',
		artist: '',
		album: '',
		genre: '',
	});
	const [customArtwork, setCustomArtwork] = useState<File | null>(null);
	const [isLoading, setIsLoading] = useState(false);
	const [isCleaningUp, setIsCleaningUp] = useState(false);
	const formatPercent = (value?: number) => Math.round(value ?? 0);

	// Create job with SoundCloud URL
	const handleSoundcloudSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!soundcloudUrl.trim()) return;

		setIsLoading(true);
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const response = await fetch(`${API_BASE}/api/job`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ soundcloudUrl }),
			});

			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to create job');
			}

			setJob({
				...job,
				jobId: data.jobId,
				track: data.track,
				hypedditUrl: data.hypedditUrl,
				defaultMetadata: data.defaultMetadata,
				error: null,
			});

			// Pre-fill metadata
			if (data.defaultMetadata) {
				setMetadata(data.defaultMetadata);
			}

			if (data.needsHypedditUrl) {
				setStep('hypeddit');
			} else {
				// Auto-start download
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
	};

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

	// Start download process
	const startDownload = useCallback(async (jobId: string) => {
		setStep('progress');

		try {
			const response = await fetch(`${API_BASE}/api/job/${jobId}/start`, {
				method: 'POST',
			});

			if (!response.ok) {
				const data = await response.json();
				throw new Error(data.error || 'Failed to start download');
			}

			// Connect to SSE for progress updates
			const eventSource = new EventSource(
				`${API_BASE}/api/job/${jobId}/events`,
			);

			eventSource.onmessage = (event) => {
				const progress: JobProgress = JSON.parse(event.data);
				setJob((prev) => ({ ...prev, progress }));

				if (progress.stage === 'ready') {
					eventSource.close();
					setStep('metadata');
				} else if (progress.stage === 'error') {
					eventSource.close();
					setJob((prev) => ({ ...prev, error: progress.message }));
				}
			};

			eventSource.onerror = () => {
				eventSource.close();
			};
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
			}));
		}
	}, []);

	// Process metadata and finalize
	const handleMetadataSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!job.jobId) return;

		setIsLoading(true);

		try {
			let response: Response;

			if (customArtwork) {
				const formData = new FormData();
				formData.append('title', metadata.title || '');
				formData.append('artist', metadata.artist || '');
				formData.append('album', metadata.album || '');
				formData.append('genre', metadata.genre || '');
				formData.append('artwork', customArtwork);

				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					body: formData,
				});
			} else {
				response = await fetch(`${API_BASE}/api/job/${job.jobId}/metadata`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(metadata),
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

	// Reset and start over
	const handleReset = () => {
		setSoundcloudUrl('');
		setHypedditUrlInput('');
		setJob({
			jobId: null,
			track: null,
			hypedditUrl: null,
			defaultMetadata: null,
			progress: null,
			downloadFilename: null,
			outputFilename: null,
			error: null,
		});
		setMetadata({ title: '', artist: '', album: '', genre: '' });
		setCustomArtwork(null);
		setStep('url');
	};

	const handleCleanupSoundcloud = async () => {
		if (isCleaningUp) return;
		const confirmed = window.confirm(
			'Cleanup your SoundCloud account? This will unfollow, unlike, and delete comments/reposts.',
		);
		if (!confirmed) return;

		setIsCleaningUp(true);
		setJob((prev) => ({ ...prev, error: null }));

		try {
			const response = await fetch(`${API_BASE}/api/soundcloud/cleanup`, {
				method: 'POST',
			});
			const data = await response.json();

			if (!response.ok) {
				throw new Error(data.error || 'Failed to cleanup SoundCloud account');
			}

			window.alert('SoundCloud account cleanup completed.');
		} catch (err) {
			setJob((prev) => ({
				...prev,
				error: err instanceof Error ? err.message : 'Unknown error',
			}));
		} finally {
			setIsCleaningUp(false);
		}
	};

	// Refresh job state (for metadata step)
	useEffect(() => {
		if (step === 'metadata' && job.jobId) {
			fetch(`${API_BASE}/api/job/${job.jobId}`)
				.then((res) => res.json())
				.then((data) => {
					setJob((prev) => ({
						...prev,
						downloadFilename: data.downloadFilename,
					}));
				});
		}
	}, [step, job.jobId]);

	return (
		<div className="app">
			<header className="header">
				<div className="logo">
					<span className="logo-icon">&#9654;</span>
					<h1>Hypeddit Downloader</h1>
				</div>
				<p className="tagline">Download & tag SoundCloud tracks from Hypeddit</p>
			</header>

			{/* Step indicator */}
			<div className="steps">
				<div className={`step ${step === 'url' ? 'active' : ''} ${['hypeddit', 'progress', 'metadata', 'complete'].includes(step) ? 'completed' : ''}`}>
					<span className="step-number">1</span>
					<span className="step-label">SoundCloud</span>
				</div>
				<div className="step-connector" />
				<div className={`step ${step === 'hypeddit' ? 'active' : ''} ${['progress', 'metadata', 'complete'].includes(step) ? 'completed' : ''}`}>
					<span className="step-number">2</span>
					<span className="step-label">Hypeddit</span>
				</div>
				<div className="step-connector" />
				<div className={`step ${step === 'progress' ? 'active' : ''} ${['metadata', 'complete'].includes(step) ? 'completed' : ''}`}>
					<span className="step-number">3</span>
					<span className="step-label">Download</span>
				</div>
				<div className="step-connector" />
				<div className={`step ${step === 'metadata' ? 'active' : ''} ${step === 'complete' ? 'completed' : ''}`}>
					<span className="step-number">4</span>
					<span className="step-label">Metadata</span>
				</div>
				<div className="step-connector" />
				<div className={`step ${step === 'complete' ? 'active completed' : ''}`}>
					<span className="step-number">5</span>
					<span className="step-label">Done</span>
				</div>
			</div>

			{/* Error display */}
			{job.error && (
				<div className="error-banner">
					<span className="error-icon">!</span>
					<span>{job.error}</span>
					<button type="button" onClick={() => setJob((prev) => ({ ...prev, error: null }))}>
						Dismiss
					</button>
				</div>
			)}

			{/* Track preview */}
			{job.track && step !== 'url' && (
				<div className="track-preview">
					<img
						src={job.track.artworkUrl?.replace('large', 't300x300') || '/favicon.svg'}
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
					<form onSubmit={handleSoundcloudSubmit} className="form animate-slide-up">
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

				{/* Step 2: Hypeddit URL (if needed) */}
				{step === 'hypeddit' && (
					<form onSubmit={handleHypedditSubmit} className="form animate-slide-up">
						<div className="notice">
							<span className="notice-icon">i</span>
							<p>
								Hypeddit URL not found in track. Please enter it manually.
							</p>
						</div>
						<div className="form-group">
							<label htmlFor="hypeddit-url">Hypeddit URL</label>
							<input
								id="hypeddit-url"
								type="url"
								name="hypeddit-url"
								value={hypedditUrlInput}
								onChange={(e) => setHypedditUrlInput(e.target.value)}
								placeholder="https://hypeddit.com/..."
								autoComplete="off"
								required
								disabled={isLoading}
							/>
						</div>
						<button type="submit" className="btn-primary" disabled={isLoading}>
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
				)}

				{/* Step 3: Progress */}
				{step === 'progress' && (
					<div className="progress-container animate-slide-up">
						<div className="progress-stage">
							<span className="stage-label">{job.progress?.message || 'Initializing...'}</span>
							{job.progress?.currentGate && (
								<span className="gate-badge">{job.progress.currentGate.toUpperCase()}</span>
							)}
						</div>
						<div className="progress-bar">
							<div
								className="progress-fill"
								style={{ width: `${job.progress?.percent || 0}%` }}
							/>
						</div>
						<div className="progress-stats">
							<span>{formatPercent(job.progress?.percent)}%</span>
							{job.progress?.downloadBytes !== undefined &&
								job.progress?.totalBytes !== undefined && (
									<span>
										{(job.progress.downloadBytes / 1024 / 1024).toFixed(1)} /{' '}
										{(job.progress.totalBytes / 1024 / 1024).toFixed(1)} MB
									</span>
								)}
						</div>
					</div>
				)}

				{/* Step 4: Metadata */}
				{step === 'metadata' && (
					<form onSubmit={handleMetadataSubmit} className="form metadata-form animate-slide-up">
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
										type="file"
										accept="image/*"
										onChange={(e) => setCustomArtwork(e.target.files?.[0] || null)}
									/>
									<span>Change Artwork</span>
								</label>
							</div>

							<div className="fields-section">
								<div className="form-group">
									<label htmlFor="meta-title">Title</label>
									<input
										id="meta-title"
										type="text"
										value={metadata.title || ''}
										onChange={(e) =>
											setMetadata((prev) => ({ ...prev, title: e.target.value }))
										}
										placeholder="Track title"
									/>
								</div>
								<div className="form-group">
									<label htmlFor="meta-artist">Artist</label>
									<input
										id="meta-artist"
										type="text"
										value={metadata.artist || ''}
										onChange={(e) =>
											setMetadata((prev) => ({ ...prev, artist: e.target.value }))
										}
										placeholder="Artist name"
									/>
								</div>
								<div className="form-group">
									<label htmlFor="meta-album">Album</label>
									<input
										id="meta-album"
										type="text"
										value={metadata.album || ''}
										onChange={(e) =>
											setMetadata((prev) => ({ ...prev, album: e.target.value }))
										}
										placeholder="Album name"
									/>
								</div>
								<div className="form-group">
									<label htmlFor="meta-genre">Genre</label>
									<input
										id="meta-genre"
										type="text"
										value={metadata.genre || ''}
										onChange={(e) =>
											setMetadata((prev) => ({ ...prev, genre: e.target.value }))
										}
										placeholder="Genre"
									/>
								</div>
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
						<p className="filename mono">{job.outputFilename || job.downloadFilename}</p>
						<div className="complete-actions">
							<a
								href={`${API_BASE}/api/job/${job.jobId}/file`}
								download
								className="btn-primary"
							>
								Download MP3
							</a>
							<button type="button" onClick={handleReset} className="btn-secondary">
								Start New Download
							</button>
						</div>
					</div>
				)}
			</div>

			<footer className="footer">
				<button
					type="button"
					className="btn-secondary btn-cleanup"
					onClick={handleCleanupSoundcloud}
					disabled={isCleaningUp}
				>
					{isCleaningUp ? 'Cleaning...' : 'Cleanup SoundCloud'}
				</button>
				<p>
					Built for personal use &middot;{' '}
					<a
						href="https://github.com/D3SOX/hypeddit-soundcloud-downloader"
						target="_blank"
						rel="noopener noreferrer"
					>
						GitHub
					</a>
				</p>
			</footer>
		</div>
	);
}
