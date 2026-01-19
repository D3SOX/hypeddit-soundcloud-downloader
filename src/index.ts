import { confirm, input } from '@inquirer/prompts';
import { AudioProcessor } from './audioProcessor';
import { HypedditDownloader } from './hypeddit';
import { SoundcloudClient } from './soundcloud';
import { getFfmpegBin, getFfprobeBin } from './utils';

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

	const soundcloudUrl = await input({
		message: 'Enter the URL of the SoundCloud track',
		validate: (value) => {
			if (!value || !value.startsWith('https://soundcloud.com/')) {
				return 'A valid SoundCloud URL is required';
			}
			return true;
		},
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
				if (!value || !value.startsWith('https://hypeddit.com/')) {
					return 'A valid Hypeddit URL is required';
				}
				return true;
			},
		});
	}

	const headless = await confirm({
		message:
			'Do you want to run the browser in headless mode? (You will not see the browser window but the process will run in the background). If something does not work it is recommended to turn it off.',
		default: true,
	});

	const initializeLogins = await confirm({
		message:
			"Do you want to initialize logins? This is required for the first run. You can skip it for subsequent runs. If you don't use the tool for a while it might be required again.",
		default: false,
	});

	const hypedditDownloader = new HypedditDownloader({
		name: HYPEDDIT_NAME,
		email: HYPEDDIT_EMAIL,
		comment: SC_COMMENT,
		headless,
	});
	await hypedditDownloader.initialize();

	if (initializeLogins) {
		await hypedditDownloader.prepareLogins();
	}

	const downloadFilename = await hypedditDownloader.downloadAudio(hypedditUrl);
	await hypedditDownloader.close();

	await soundcloudClient.cleanup();

	if (downloadFilename) {
		const artwork = await soundcloudClient.fetchArtwork(track.artwork_url);

		const audioProcessor = new AudioProcessor(ffmpegBin, ffprobeBin);
		const metadata = await audioProcessor.promptForMetadata(
			track,
			downloadFilename,
		);

		await audioProcessor.processAudio(downloadFilename, metadata, artwork);
	}
} catch (error) {
	if (error instanceof Error && error.name === 'ExitPromptError') {
		console.log('\nAborted by user.');
		process.exit(0);
	}
	throw error;
}
