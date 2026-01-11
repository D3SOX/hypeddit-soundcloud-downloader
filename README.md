# Hypeddit SoundCloud Downloader

A simple tool that automates downloading audio from Hypeddit posts and enriches them with metadata from SoundCloud.

## Features

- 🎵 Automatically download audio from Hypeddit posts
- 🔄 Handles multiple gate types (see [How It Works](#how-it-works))
- 📝 Fetches metadata from the provided SoundCloud link
- 🎨 Manual metadata correction before finalizing
- 🎧 Converts Lossless (WAV/AIFF) files to MP3 (320kbps)
- 🏷️ Tags MP3 files with metadata and artwork from SoundCloud
- 🧹 Optional cleanup of the SoundCloud account (unfollow, unlike, delete comments/reposts)

## Prerequisites

- [**Bun**](https://bun.sh) - JavaScript runtime and package manager
- [**ffmpeg**](https://ffmpeg.org) - Must be installed and available in your `PATH`
- **SoundCloud account** - It is recommended to create a throwaway account for this because most Hypeddit downloads require reposts and likes which you might not want to do with your main account
- **Spotify account** (optional) - Required when a Hypeddit post has an unskippable Spotify gate

## Installation

1. Clone this repository:
```bash
git clone https://github.com/D3SOX/hypeddit-soundcloud-downloader
cd hypeddit-soundcloud-downloader
```

2. Install dependencies:
```bash
bun install
```

## Setup

### Environment Variables

Create a `.env` file in the project root by copying the `.env.example` file and filling in the values.

For `HYPEDDIT_NAME` currently everything works (I use just `asd`)

For `HYPEDDIT_EMAIL` you can enter any valid email address (For example grab one from [temp-mail.org](https://temp-mail.org))

#### Get SoundCloud API Credentials

1. Go to [soundcloud.com](https://soundcloud.com) and log in (skip if you are already logged in)
2. Open up the developer tools (Right click → Inspect or press F12) and go to the **Network** tab
3. Navigate to soundcloud.com (refresh the page if needed), and you should see a bunch of requests in the network tab
4. Find the request that has the name `session` (you can filter by typing `session` in the filter box) and click on it
5. Go to the **Payload** tab
6. You should see your client id in the **Query String Parameters** section, and your oauth token (`access_token`) in the **Request Payload** section
7. Copy these values to your `.env` file as `SC_CLIENT_ID` and `SC_OAUTH_TOKEN`

### Cookies

**For Firefox-based browsers:**
Install the [EditThisCookie2](https://addons.mozilla.org/en-US/firefox/addon/etc2/) extension

**For Chromium-based browsers (Chrome, Edge, Brave, Helium, etc.):**
Install the [EditThisCookie (fork)](https://chromewebstore.google.com/detail/editthiscookie-fork/ihfmcbadakjehneaijebhpogkegajgnk) extension

#### SoundCloud Cookies (Required)

**Steps:**
1. Go to [soundcloud.com](https://soundcloud.com) and log in
2. Open the extension and click on the export button
3. Save what was copied to the clipboard to a file called `soundcloud-cookies.json` in the project root

#### Spotify Cookies (Optional)

If you plan to download tracks that require Spotify gates, you'll also need Spotify cookies:

**Steps:**
1. Go to [accounts.spotify.com](https://accounts.spotify.com) and log in
2. Open the extension and click on the export button
3. Save what was copied to the clipboard to a file called `spotify-cookies.json` in the project root

## Usage

Run the tool and follow the prompts.
```bash
bun start
```

The final MP3 file will be saved in the `./downloads` directory with proper metadata and artwork embedded.

## How It Works

**Gate Handling**: The tool automatically detects and handles different Hypeddit gates:
   - Email gate: Enters your name and email
   - SoundCloud gate: Posts a comment and authorizes the app
   - Instagram gate: Handles Instagram follow requirements (This gets bypassed as it does not actually require a follow)
   - Spotify gate: Authorizes Spotify access
   - Download gate: Triggers the audio download

**File Processing**:
   - **Lossless (WAV/AIFF) files**: Converted to MP3 (320kbps) with metadata and artwork
   - **MP3 files**: Retagged with metadata and artwork (no re-encoding)
