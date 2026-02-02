import type { Job, JobProgress, JobStage } from './types';

type ProgressListener = (progress: JobProgress) => void;

/**
 * In-memory job store for single-user Web UI
 */
class JobStore {
	private jobs: Map<string, Job> = new Map();
	private listeners: Map<string, Set<ProgressListener>> = new Map();

	/**
	 * Creates a new job and returns its ID
	 */
	create(soundcloudUrl: string): Job {
		const id = crypto.randomUUID();
		const now = new Date();
		const job: Job = {
			id,
			soundcloudUrl,
			hypedditUrl: null,
			track: null,
			defaultMetadata: null,
			progress: {
				stage: 'pending',
				message: 'Job created',
			},
			downloadFilename: null,
			outputFilename: null,
			artworkBuffer: null,
			artworkFileName: null,
			error: null,
			createdAt: now,
			updatedAt: now,
		};
		this.jobs.set(id, job);
		return job;
	}

	/**
	 * Gets a job by ID
	 */
	get(id: string): Job | undefined {
		return this.jobs.get(id);
	}

	/**
	 * Updates a job and notifies listeners
	 */
	update(
		id: string,
		updates: Partial<Omit<Job, 'id' | 'createdAt'>>,
	): Job | undefined {
		const job = this.jobs.get(id);
		if (!job) return undefined;

		Object.assign(job, updates, { updatedAt: new Date() });

		// Notify progress listeners if progress was updated
		if (updates.progress) {
			this.notifyListeners(id, job.progress);
		}

		return job;
	}

	/**
	 * Updates job progress and notifies listeners
	 */
	updateProgress(
		id: string,
		stage: JobStage,
		message: string,
		extra?: Partial<JobProgress>,
	): void {
		const job = this.jobs.get(id);
		if (!job) return;

		job.progress = {
			stage,
			message,
			...extra,
		};
		job.updatedAt = new Date();

		this.notifyListeners(id, job.progress);
	}

	/**
	 * Sets job error state
	 */
	setError(id: string, error: string): void {
		const job = this.jobs.get(id);
		if (!job) return;

		job.error = error;
		job.progress = {
			stage: 'error',
			message: error,
		};
		job.updatedAt = new Date();

		this.notifyListeners(id, job.progress);
	}

	/**
	 * Subscribe to progress updates for a job
	 */
	subscribe(id: string, listener: ProgressListener): () => void {
		let listenerSet = this.listeners.get(id);
		if (!listenerSet) {
			listenerSet = new Set();
			this.listeners.set(id, listenerSet);
		}
		listenerSet.add(listener);

		// Return unsubscribe function
		return () => {
			this.listeners.get(id)?.delete(listener);
		};
	}

	/**
	 * Notify all listeners for a job
	 */
	private notifyListeners(id: string, progress: JobProgress): void {
		const jobListeners = this.listeners.get(id);
		if (jobListeners) {
			for (const listener of jobListeners) {
				try {
					listener(progress);
				} catch (e) {
					console.error('Error in progress listener:', e);
				}
			}
		}
	}

	/**
	 * Delete a job
	 */
	delete(id: string): boolean {
		this.listeners.delete(id);
		return this.jobs.delete(id);
	}

	/**
	 * Clean up old jobs (older than specified milliseconds)
	 */
	cleanup(maxAgeMs: number = 60 * 60 * 1000): number {
		const now = Date.now();
		let deleted = 0;
		for (const [id, job] of this.jobs) {
			if (now - job.createdAt.getTime() > maxAgeMs) {
				this.delete(id);
				deleted++;
			}
		}
		return deleted;
	}
}

// Export singleton instance
export const jobStore = new JobStore();
