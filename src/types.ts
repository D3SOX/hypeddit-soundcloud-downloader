export interface LocalCookieData {
	name: string;
	value: string;
	domain: string;
	path?: string;
	expirationDate?: number;
	httpOnly?: boolean;
	secure?: boolean;
	sameSite?: string;
}

export interface HypedditConfig {
	name: string;
	email: string;
	comment: string;
	headless: boolean;
}

export interface Metadata {
	title?: string;
	artist?: string;
	album?: string;
	genre?: string;
}

// Job system types for Web UI
export type JobStage =
	| 'pending'
	| 'fetching_track'
	| 'waiting_hypeddit'
	| 'initializing_browser'
	| 'preparing_logins'
	| 'handling_gates'
	| 'downloading'
	| 'processing_audio'
	| 'ready'
	| 'error';

export interface JobProgress {
	stage: JobStage;
	message: string;
	currentGate?: string;
}

export interface Job {
	id: string;
	soundcloudUrl: string;
	hypedditUrl: string | null;
	track: {
		title: string;
		artworkUrl: string;
		purchaseUrl?: string;
		description?: string;
		user: {
			username: string;
			fullName?: string;
		};
		publisherMetadata?: {
			artist?: string;
			albumTitle?: string;
		};
		genre?: string;
	} | null;
	defaultMetadata: Metadata | null;
	progress: JobProgress;
	downloadFilename: string | null;
	outputFilename: string | null;
	artworkBuffer: ArrayBuffer | null;
	artworkFileName: string | null;
	error: string | null;
	createdAt: Date;
	updatedAt: Date;
}
