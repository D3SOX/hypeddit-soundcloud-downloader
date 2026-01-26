import { join } from 'node:path';
import { confirm } from '@inquirer/prompts';
import Soundcloud, { type SoundcloudTrack } from 'soundcloud.ts';
import { extractHypedditUrl, getDefaultMetadata } from './flowUtils';
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
		const hypedditUrl = extractHypedditUrl(track);
		if (hypedditUrl) {
			if (track.purchase_url?.startsWith('https://hypeddit.com/')) {
				console.log(
					'Found Hypeddit URL from SoundCloud track purchase URL:',
					hypedditUrl,
				);
			} else {
				console.log(
					'Found Hypeddit URL from SoundCloud track description:',
					hypedditUrl,
				);
			}
		}
		return hypedditUrl;
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
		return getDefaultMetadata(track);
	}

	async cleanup(prompt = true): Promise<
		| {
				unfollowed: number;
				unliked: number;
				deletedComments: number;
				deletedReposts: number;
		  }
		| undefined
	> {
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

		const unfollowed = await this.unfollowAllUsers(me.id);
		const unliked = await this.unlikeAllTracks(me.id);
		const deletedComments = await this.deleteAllComments(me.id);
		const deletedReposts = await this.deleteAllReposts();

		return {
			unfollowed,
			unliked,
			deletedComments,
			deletedReposts,
		};
	}

	private async unfollowAllUsers(meId: string): Promise<number> {
		const { collection: following } = await this.soundcloud.api.getV2(
			`users/${meId}/followings`,
		);
		if (!following || !following.length) {
			console.log('No users to unfollow');
			return 0;
		}
		console.log(`Found ${following.length} users to unfollow`);

		let count = 0;
		for (const user of following) {
			try {
				await this.soundcloud.api.deleteV2(`me/followings/${user.id}`);
				console.log(`✓ Unfollowed ${user.username} (${user.id})`);
				count++;
			} catch (error) {
				console.error(
					`✗ Failed to unfollow ${user.username} (${user.id}):`,
					error,
				);
			}
		}
		return count;
	}

	private async unlikeAllTracks(meId: string): Promise<number> {
		const { collection: likes } = await this.soundcloud.api.getV2(
			`users/${meId}/likes`,
		);
		if (!likes || !likes.length) {
			console.log('No tracks to unlike');
			return 0;
		}
		console.log(`Found ${likes.length} tracks to unlike`);

		let count = 0;
		for (const like of likes) {
			try {
				await this.soundcloud.api.deleteV2(
					`users/${meId}/track_likes/${like.track.id}`,
				);
				console.log(`✓ Unliked ${like.track.title} (${like.track.id})`);
				count++;
			} catch (error) {
				console.error(
					`✗ Failed to unlike ${like.track.title} (${like.track.id}):`,
					error,
				);
			}
		}
		return count;
	}

	private async deleteAllComments(meId: string): Promise<number> {
		const { collection: comments } = await this.soundcloud.api.getV2(
			`users/${meId}/comments`,
		);
		if (!comments || !comments.length) {
			console.log('No comments to delete');
			return 0;
		}
		console.log(`Found ${comments.length} comments to delete`);

		let count = 0;
		for (const comment of comments) {
			try {
				await this.soundcloud.api.deleteV2(`comments/${comment.id}`);
				console.log(`✓ Deleted comment ${comment.id}`);
				count++;
			} catch (error) {
				console.error(`✗ Failed to delete comment ${comment.id}:`, error);
			}
		}
		return count;
	}

	private async deleteAllReposts(): Promise<number> {
		const { collection: reposts } = await this.soundcloud.api.getV2(
			`me/track_reposts/ids`,
			{ limit: 200 },
		);
		if (!reposts || !reposts.length) {
			console.log('No reposts to delete');
			return 0;
		}
		console.log(`Found ${reposts.length} reposts to delete`);

		let count = 0;
		for (const repost of reposts) {
			try {
				await this.soundcloud.api.deleteV2(`me/track_reposts/${repost}`);
				console.log(`✓ Deleted repost ${repost}`);
				count++;
			} catch (error) {
				console.error(`✗ Failed to delete repost ${repost}:`, error);
			}
		}
		return count;
	}
}
