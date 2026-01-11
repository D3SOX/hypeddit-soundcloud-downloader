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
