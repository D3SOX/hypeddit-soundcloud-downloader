import { basename, join } from 'node:path';
import { execa } from 'execa';
import prompts from 'prompts';
import type { SoundcloudTrack } from 'soundcloud.ts';
import type { Metadata } from './types';
import { REPO_URL } from './utils';

export class AudioProcessor {
	private ffmpegBin: string;

	constructor(ffmpegBin: string) {
		this.ffmpegBin = ffmpegBin;
	}

	async promptForMetadata(track: SoundcloudTrack): Promise<Metadata> {
		const artist =
			track.publisher_metadata?.artist ||
			track.user.full_name ||
			track.user.username;
		const album = track.publisher_metadata?.album_title || '';

		console.log('Metadata', {
			title: track.title,
			artist,
			album,
			genre: track.genre,
		});

		console.log(
			'Now you can correct the metadata for the resulting MP3 file. All fields are optional and will be used if provided.',
		);

		const { correctedTitle } = await prompts({
			type: 'text',
			name: 'correctedTitle',
			message: 'Check and correct the title',
			initial: track.title,
		});
		const { correctedArtist } = await prompts({
			type: 'text',
			name: 'correctedArtist',
			message: 'Check and correct the artist',
			initial: artist,
		});
		const { correctedAlbum } = await prompts({
			type: 'text',
			name: 'correctedAlbum',
			message: 'Check and correct the album',
			initial: album,
		});
		const { correctedGenre } = await prompts({
			type: 'text',
			name: 'correctedGenre',
			message: 'Check and correct the genre',
			initial: track.genre,
		});

		return {
			title: correctedTitle?.trim(),
			artist: correctedArtist?.trim(),
			album: correctedAlbum?.trim(),
			genre: correctedGenre?.trim(),
		};
	}

	async processAudio(
		filename: string,
		metadata: Metadata,
		artwork: ArrayBuffer,
	): Promise<void> {
		const inputPath = join('./downloads', filename);

		// save artwork to temporary file
		const artworkPath = join('./downloads', `artwork_${Date.now()}.jpg`);
		await Bun.write(artworkPath, artwork);

		try {
			// if it is a WAV or AIFF, we convert it to MP3
			if (
				filename.toLowerCase().endsWith('.wav') ||
				filename.toLowerCase().endsWith('.aiff') ||
				filename.toLowerCase().endsWith('.aif') ||
				filename.toLowerCase().endsWith('.flac')
			) {
				await this.convertLosslessToMp3(
					inputPath,
					artworkPath,
					metadata,
					filename,
				);

				// ask if you want to remove the lossless file
				const { removeLosslessFile } = await prompts({
					type: 'confirm',
					name: 'removeLosslessFile',
					message: 'Do you want to remove the lossless file now?',
					initial: true,
				});
				if (removeLosslessFile) {
					await Bun.file(inputPath).unlink();
					console.log(`✓ Removed ${inputPath}`);
				}
			}
			// otherwise if it is an MP3, we retag it with the correct metadata
			else if (filename.toLowerCase().endsWith('.mp3')) {
				await this.retagMp3(inputPath, artworkPath, metadata);
			} else {
				console.warn(
					`Unsupported file type: ${filename}. Leaving as is... If you want support for this file type, please create an issue about this on ${REPO_URL}/issues`,
				);
			}
		} finally {
			// clean up temporary artwork file
			try {
				await Bun.file(artworkPath).unlink();
			} catch {
				// ignore cleanup errors
			}
		}
	}

	private async convertLosslessToMp3(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
		filename: string,
	): Promise<void> {
		const outputPath = join(
			'./downloads',
			filename
				.replace(/\.wav$/i, '.mp3')
				.replace(/\.aiff$/i, '.mp3')
				.replace(/\.aif$/i, '.mp3')
				.replace(/\.flac$/i, '.mp3'),
		);

		const args: string[] = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-c:a',
			'libmp3lame',
			'-b:a',
			'320k',
			'-id3v2_version',
			'3',
			'-map',
			'1:v',
			'-c:v',
			'copy',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		];

		if (metadata.title) {
			args.push('-metadata', `title=${metadata.title}`);
		}
		if (metadata.artist) {
			args.push('-metadata', `artist=${metadata.artist}`);
		}
		if (metadata.album) {
			args.push('-metadata', `album=${metadata.album}`);
		}
		if (metadata.genre) {
			args.push('-metadata', `genre=${metadata.genre}`);
		}

		args.push('-y', outputPath);

		console.log('Converting Lossless to MP3 (320kbps)...');
		await execa(this.ffmpegBin, args);
		console.log(`✓ Converted to ${outputPath}`);
	}

	private async retagMp3(
		inputPath: string,
		artworkPath: string,
		metadata: Metadata,
	): Promise<void> {
		const filename = basename(inputPath);
		const outputPath = join(
			'./downloads',
			filename.replace(/\.mp3$/i, '_retagged.mp3'),
		);

		const args: string[] = [
			'-i',
			inputPath,
			'-i',
			artworkPath,
			'-map',
			'0:a',
			'-c:a',
			'copy',
			'-id3v2_version',
			'3',
			'-map_metadata',
			'-1', // clear existing metadata
			'-map',
			'1:v',
			'-c:v',
			'copy',
			'-metadata:s:v',
			'title=Album cover',
			'-metadata:s:v',
			'comment=Cover (front)',
		];

		if (metadata.title) {
			args.push('-metadata', `title=${metadata.title}`);
		}
		if (metadata.artist) {
			args.push('-metadata', `artist=${metadata.artist}`);
		}
		if (metadata.album) {
			args.push('-metadata', `album=${metadata.album}`);
		}
		if (metadata.genre) {
			args.push('-metadata', `genre=${metadata.genre}`);
		}

		args.push('-y', outputPath);

		console.log('Retagging MP3...');
		await execa(this.ffmpegBin, args);

		// replace the original file with the retagged one
		await Bun.write(inputPath, Bun.file(outputPath));
		await Bun.file(outputPath).unlink();
		console.log(`✓ Retagged ${inputPath}`);
	}
}
