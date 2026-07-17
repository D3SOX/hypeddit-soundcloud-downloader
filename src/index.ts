import { confirm, input } from '@inquirer/prompts';
import { AudioProcessor } from './audioProcessor';
import { loadConfig, saveConfig } from './config';
import { HypedditDownloader } from './hypeddit';
import { HypedditHttpDownloader } from './hypedditHttp';
import { SoundcloudClient } from './soundcloud';
import { getFfmpegBin, getFfprobeBin, validateSoundcloudUrl } from './utils';

try {
	const ffmpegBin = await getFfmpegBin();
	const ffprobeBin = await getFfprobeBin();

	const SC_COMMENT = process.env.SC_COMMENT;
	if (!SC_COMMENT) {
		throw new Error('SC_COMMENT is required. Please set it in your .env file.');
	}
	const HYPEDDIT_NAME = process.env.HYPEDDIT_NAME;
	const HYPEDDIT_EMAIL = process.env.HYPEDDIT_EMAIL;
	if (!HYPEDDIT_NAME || !HYPEDDIT_EMAIL) {
		throw new Error(
			'HYPEDDIT_NAME and HYPEDDIT_EMAIL are required. Please set them in your .env file.',
		);
	}

	const config = await loadConfig();

	const soundcloudArg = process.argv[2];
	const soundcloudArgValidation = soundcloudArg
		? validateSoundcloudUrl(soundcloudArg)
		: true;

	if (soundcloudArg && soundcloudArgValidation !== true) {
		console.log(soundcloudArgValidation);
	}
	const soundcloudUrl =
		soundcloudArg && soundcloudArgValidation === true
			? soundcloudArg
			: await input({
					message: 'Enter the URL of the SoundCloud track',
					validate: validateSoundcloudUrl,
				});

	const soundcloudClient = new SoundcloudClient();
	const track = await soundcloudClient.getTrack(soundcloudUrl);

	// try to find Hypeddit URL from soundcloud track
	let hypedditUrl: string | null = await soundcloudClient.getHypedditURL(track);

	// if no Hypeddit URL was found, prompt the user for it
	if (!hypedditUrl) {
		hypedditUrl = await input({
			message: 'Enter the URL of the Hypeddit post',
			validate: (value) => {
				if (!value?.startsWith('https://hypeddit.com/')) {
					return 'A valid Hypeddit URL is required';
				}
				return true;
			},
		});
	}

	const headless = config
		? config.headless
		: await confirm({
				message:
					'Do you want to run the browser in headless mode? (You will not see the browser window but the process will run in the background). If something does not work it is recommended to turn it off.',
				default: true,
			});

	const initializeLogins = config
		? config.initializeLogins
		: await confirm({
				message:
					"Do you want to initialize logins? This is required for the first run. You can skip it for subsequent runs. If you don't use the tool for a while it might be required again.",
				default: false,
			});

	const hypedditConfig = {
		name: HYPEDDIT_NAME,
		email: HYPEDDIT_EMAIL,
		comment: SC_COMMENT,
		headless,
	};

	// Fast path: gates that are purely client-side (email + social follow/like/
	// repost buttons) can be satisfied with plain HTTP, skipping the browser.
	const httpDownloader = new HypedditHttpDownloader(hypedditConfig);
	let downloadFilename = await httpDownloader.tryDownload(hypedditUrl);

	// Fall back to the browser for gates that need real verification (Spotify, ...).
	if (!downloadFilename) {
		const hypedditDownloader = new HypedditDownloader(hypedditConfig);
		await hypedditDownloader.initialize();

		if (initializeLogins) {
			await hypedditDownloader.prepareLogins();
			if (config) {
				await saveConfig({ ...config, initializeLogins: false });
				console.log('✓ Updated config.json: initializeLogins set to false');
			}
		}

		downloadFilename = await hypedditDownloader.downloadAudio(hypedditUrl);
		await hypedditDownloader.close();
	}

	if (config) {
		if (config.cleanupSoundCloudAccount) {
			await soundcloudClient.cleanup(false);
		}
	} else {
		await soundcloudClient.cleanup();
	}

	if (downloadFilename) {
		const artworkUrl = soundcloudClient.getArtworkUrl(track);
		const artwork = await soundcloudClient.fetchArtwork(artworkUrl);

		const audioProcessor = new AudioProcessor(ffmpegBin, ffprobeBin);
		const metadata = await audioProcessor.promptForMetadata(
			track,
			downloadFilename,
		);

		const losslessHandling = config
			? config.deleteLosslessAfterConversion
				? 'always'
				: 'never'
			: 'prompt';

		await audioProcessor.processAudio(
			downloadFilename,
			metadata,
			artwork,
			losslessHandling,
		);
	}
} catch (error) {
	if (error instanceof Error && error.name === 'ExitPromptError') {
		console.log('\nAborted by user.');
		process.exit(0);
	}
	throw error;
}
