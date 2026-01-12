import type { CookieData } from 'puppeteer';
import type { LocalCookieData } from './types';
import packageJson from '../package.json' with { type: 'json' };

export const REPO_URL = packageJson.repository.url;

export async function timeout(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function loadCookies(filename: string): Promise<CookieData[]> {
	const cookiesData: LocalCookieData[] = JSON.parse(
		await Bun.file(filename).text(),
	);
	return cookiesData.map((cookie) => {
		const puppeteerCookie: CookieData = {
			name: cookie.name,
			value: cookie.value,
			domain: cookie.domain,
			path: cookie.path || '/',
		};

		if (cookie.expirationDate) {
			puppeteerCookie.expires = cookie.expirationDate;
		}
		if (cookie.httpOnly !== undefined) {
			puppeteerCookie.httpOnly = cookie.httpOnly;
		}
		if (cookie.secure !== undefined) {
			puppeteerCookie.secure = cookie.secure;
		}
		if (cookie.sameSite && cookie.sameSite !== 'unspecified') {
			puppeteerCookie.sameSite = cookie.sameSite as 'Strict' | 'Lax' | 'None';
		}

		return puppeteerCookie;
	});
}
