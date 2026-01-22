import { join } from 'node:path';
import exampleConfig from '../config.example.json';

export type AppConfig = typeof exampleConfig;

const CONFIG_KEYS = Object.keys(exampleConfig) as Array<keyof AppConfig>;

const CONFIG_PATH = join(process.cwd(), 'config.json');

function isJSONObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadConfig(): Promise<AppConfig | null> {
	const file = Bun.file(CONFIG_PATH);
	const configExists = await file.exists();
	if (!configExists) {
		return null;
	}

	let raw: unknown;
	try {
		raw = JSON.parse(await file.text());
	} catch (error) {
		const message =
			error instanceof Error ? error.message : 'Unknown JSON parse error';
		throw new Error(`Failed to parse config.json: ${message}`);
	}

	if (!isJSONObject(raw)) {
		throw new Error('config.json must be a JSON object');
	}

	const entries = CONFIG_KEYS.map((key) => {
		if (!(key in raw)) {
			throw new Error(`config.json is missing required key: ${key}`);
		}
		const value = raw[key];
		const givenType = typeof value;
		const expectedType = typeof exampleConfig[key];
		if (givenType !== expectedType) {
			throw new Error(
				`config.json key ${key} must be a ${expectedType} (got ${givenType})`,
			);
		}
		return [key, value] as const;
	});

	return Object.fromEntries(entries) as AppConfig;
}

export async function saveConfig(config: AppConfig): Promise<void> {
	const serialized = `${JSON.stringify(config, null, 2)}\n`;
	await Bun.write(CONFIG_PATH, serialized);
}
