import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import Soundcloud, { type SoundcloudTrack } from 'soundcloud.ts';
import type { Metadata } from './types';

export class SoundcloudClient {
	private soundcloud: Soundcloud;

	constructor() {
		const clientId = process.env.SC_CLIENT_ID;
		const oauthToken = process.env.SC_OAUTH_TOKEN;

		if (!clientId || !oauthToken) {
			throw new Error(
				'SC_CLIENT_ID and SC_OAUTH_TOKEN are required. Please set them in your .env file.',
			);
		}

		this.soundcloud = new Soundcloud(clientId, oauthToken);
	}

	async getTrack(url: string) {
		return await this.soundcloud.tracks.get(url);
	}

	async getHypedditURL(track: SoundcloudTrack) {
		const { purchase_url, description } = track;
		if (purchase_url?.startsWith('https://hypeddit.com/')) {
			console.log(
				'Found Hypeddit URL from SoundCloud track purchase URL:',
				purchase_url,
			);
			return purchase_url;
		}

		if (description?.includes('https://hypeddit.com/')) {
			const matchedUrl = description.match(
				/https:\/\/hypeddit\.com\/[^\s]+/,
			)?.[0];
			if (matchedUrl) {
				console.log(
					'Found Hypeddit URL from SoundCloud track description:',
					matchedUrl,
				);
				return matchedUrl;
			}
		}
		return null;
	}

	async fetchArtwork(
		artworkUrl: string,
	): Promise<{ buffer: ArrayBuffer; fileName: string }> {
		const originalArtworkUrl = artworkUrl.replace('large', 'original');
		const fileName = originalArtworkUrl.split('/').pop() || 'artwork.jpg';
		if (await Bun.file(join('./downloads', fileName)).exists()) {
			console.log(`✓ Found artwork in downloads folder: ${fileName}`);
			return {
				buffer: await Bun.file(join('./downloads', fileName)).arrayBuffer(),
				fileName,
			};
		}
		const response = await fetch(originalArtworkUrl);
		if (!response.ok) {
			throw new Error(`Failed to fetch artwork: ${response.statusText}`);
		}
		const buffer = await response.arrayBuffer();
		return { buffer, fileName };
	}

	static getMetadata(track: SoundcloudTrack): Metadata {
		return {
			title: track.title,
			artist:
				track.publisher_metadata?.artist ||
				track.user.full_name ||
				track.user.username,
			album: track.publisher_metadata?.album_title || '',
			genre: track.genre,
		};
	}

	async cleanup(prompt = true) {
		if (prompt) {
			const cleanupSoundcloudConfirm = await confirm({
				message:
					'Do you want to cleanup your SoundCloud account (unfollow all users, unlike all tracks, delete all comments and reposts)?',
				default: true,
			});

			if (!cleanupSoundcloudConfirm) {
				return;
			}
		}

		const me = await this.soundcloud.api.getV2('me');
		if (!me) {
			throw new Error(
				'Failed to fetch your SoundCloud account. Please check your SoundCloud credentials.',
			);
		}

		await this.unfollowAllUsers(me.id);
		await this.unlikeAllTracks(me.id);
		await this.deleteAllComments(me.id);
		await this.deleteAllReposts();
	}

	private async unfollowAllUsers(meId: string) {
		const { collection: following } = await this.soundcloud.api.getV2(
			`users/${meId}/followings`,
		);
		if (!following || !following.length) {
			console.log('No users to unfollow');
			return;
		}
		console.log(`Found ${following.length} users to unfollow`);

		for (const user of following) {
			try {
				await this.soundcloud.api.deleteV2(`me/followings/${user.id}`);
				console.log(`✓ Unfollowed ${user.username} (${user.id})`);
			} catch (error) {
				console.error(
					`✗ Failed to unfollow ${user.username} (${user.id}):`,
					error,
				);
			}
		}
	}

	private async unlikeAllTracks(meId: string) {
		const { collection: likes } = await this.soundcloud.api.getV2(
			`users/${meId}/likes`,
		);
		if (!likes || !likes.length) {
			console.log('No tracks to unlike');
			return;
		}
		console.log(`Found ${likes.length} tracks to unlike`);

		for (const like of likes) {
			try {
				await this.soundcloud.api.deleteV2(
					`users/${meId}/track_likes/${like.track.id}`,
				);
				console.log(`✓ Unliked ${like.track.title} (${like.track.id})`);
			} catch (error) {
				console.error(
					`✗ Failed to unlike ${like.track.title} (${like.track.id}):`,
					error,
				);
			}
		}
	}

	private async deleteAllComments(meId: string) {
		const { collection: comments } = await this.soundcloud.api.getV2(
			`users/${meId}/comments`,
		);
		if (!comments || !comments.length) {
			console.log('No comments to delete');
			return;
		}
		console.log(`Found ${comments.length} comments to delete`);

		for (const comment of comments) {
			try {
				await this.soundcloud.api.deleteV2(`comments/${comment.id}`);
				console.log(`✓ Deleted comment ${comment.id}`);
			} catch (error) {
				console.error(`✗ Failed to delete comment ${comment.id}:`, error);
			}
		}
	}

	private async deleteAllReposts() {
		const { collection: reposts } = await this.soundcloud.api.getV2(
			`me/track_reposts/ids`,
			{ limit: 200 },
		);
		if (!reposts || !reposts.length) {
			console.log('No reposts to delete');
			return;
		}
		console.log(`Found ${reposts.length} reposts to delete`);

		for (const repost of reposts) {
			try {
				await this.soundcloud.api.deleteV2(`me/track_reposts/${repost}`);
				console.log(`✓ Deleted repost ${repost}`);
			} catch (error) {
				console.error(`✗ Failed to delete repost ${repost}:`, error);
			}
		}
	}
}
