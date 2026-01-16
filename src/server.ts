import { AudioProcessor } from './audioProcessor';
import { HypedditDownloader } from './hypeddit';
import { SoundcloudClient } from './soundcloud';
import { getFfmpegBin, getFfprobeBin } from './utils';

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

const soundcloudClient = new SoundcloudClient();

const hypedditDownloader = new HypedditDownloader({
	name: HYPEDDIT_NAME,
	email: HYPEDDIT_EMAIL,
	comment: SC_COMMENT,
	headless: true,
});

const server = Bun.serve({
	port: 3000,
	routes: {
		'/': (_req) => new Response('hypeddit-soundcloud-downloader is running!'),
		'/download': {
			POST: async (req, server) => {
				server.timeout(req, 1200);
				const formData = await req.formData();
				const url = formData.get('url');
				if (!url || typeof url !== 'string') {
					return new Response('Invalid URL', { status: 400 });
				}
				if (!url.startsWith('https://soundcloud.com/')) {
					return new Response('Invalid SoundCloud URL', { status: 400 });
				}
				const track = await soundcloudClient.getTrack(url);

				if (!track) {
					return new Response('Track not found', { status: 404 });
				}

				const hypedditUrl: string | null =
					await soundcloudClient.getHypedditURL(track);
				if (!hypedditUrl) {
					return new Response('Hypeddit URL not found', { status: 404 });
				}

				await hypedditDownloader.initialize();

				const downloadFilename =
					await hypedditDownloader.downloadAudio(hypedditUrl);
				await hypedditDownloader.close();

				if (!downloadFilename) {
					return new Response('Download failed', { status: 500 });
				}

				await soundcloudClient.cleanup(false);

				const audioProcessor = new AudioProcessor(ffmpegBin, ffprobeBin);
				const metadata = SoundcloudClient.getMetadata(track);
				const artwork = await soundcloudClient.fetchArtwork(track.artwork_url);

				const convertedFilePath = await audioProcessor.processAudio(
					downloadFilename,
					metadata,
					artwork,
					'always',
				);

				// serve downlaoded file
				return new Response(Bun.file(convertedFilePath), {
					headers: {
						'Content-Type': 'audio/mpeg',
					},
				});
			},
		},
	},
	error: async (err) => {
		console.error(err);
		await hypedditDownloader.close();
		return new Response('Internal Server Error', { status: 500 });
	},
});

console.log(`Server is running on ${server.url}`);
