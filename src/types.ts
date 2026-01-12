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
