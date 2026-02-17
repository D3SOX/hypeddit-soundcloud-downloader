// Login preparation
const SOUNDCLOUD_LIBRARY_LINK = 'a[href="/you/library"]';
const SOUNDCLOUD_CAPTCHA_CONTAINER = 'div[id*="ddChallengeContainer"]';
const SOUNDCLOUD_CAPTCHA_IFRAME = `iframe[src^="https://geo.captcha-delivery.com/captcha/"]`;
const SOUNDCLOUD_CAPTCHA_SLIDER = '.slider';
const SOUNDCLOUD_CAPTCHA_TRACK = '.sliderText';

const SPOTIFY_ACCOUNT_SETTINGS_LINK = '#account-settings-link';

// Hypeddit gate fetching
const DOWNLOAD_PROCESS_BUTTON = '#downloadProcess';
const ALL_STEPS_CONTAINER = '#all_steps';
const ALL_STEPS_CHILD_DIVS = `${ALL_STEPS_CONTAINER} > div`;

// Email gate
const EMAIL_NAME_INPUT = '#email_name';
const EMAIL_ADDRESS_INPUT = '#email_address';
const EMAIL_NEXT_BUTTON = '#email_to_downloads_next';

// SoundCloud gate
const SC_SKIPPER_BUTTON = '#skipper_sc';
const SC_COMMENT_TEXT_INPUT = '#sc_comment_text';
const SC_LOGIN_BUTTON = '#login_to_sc';
const SC_SUBMIT_APPROVAL_BUTTON = '#submit_approval';

// Instagram gate
const IG_SKIPPER_BUTTON = '#skipper_ig';
const IG_STATUS_BUTTON = '#instagram_status .hype-btn-instagram';
const IG_STATUS_UNDONE_BUTTON = '#instagram_status .hype-btn-instagram.undone';
const IG_NEXT_BUTTON = '#skipper_ig_next';

// Facebook gate
const FB_NEXT_BUTTON = '#fbCarouselSocialSection';

// Spotify gate
const SP_SKIPPER_BUTTON = '#skipper_sp';
const SP_OPT_IN_SECTION = '#optInSectionSpotify';
const SP_OPT_OUT_OPTION = 'a.optOutOption';
const SP_LOGIN_BUTTON = '#login_to_sp';
const SP_AUTH_ACCEPT_BUTTON = '[data-testid="auth-accept"]';

// Download gate
const DW_DOWNLOAD_BUTTON = '#gateDownloadButton';

export default {
	SOUNDCLOUD_LIBRARY_LINK,
	SOUNDCLOUD_CAPTCHA_CONTAINER,
	SOUNDCLOUD_CAPTCHA_IFRAME,
	SOUNDCLOUD_CAPTCHA_SLIDER,
	SOUNDCLOUD_CAPTCHA_TRACK,
	SPOTIFY_ACCOUNT_SETTINGS_LINK,
	DOWNLOAD_PROCESS_BUTTON,
	ALL_STEPS_CONTAINER,
	ALL_STEPS_CHILD_DIVS,
	EMAIL_NAME_INPUT,
	EMAIL_ADDRESS_INPUT,
	EMAIL_NEXT_BUTTON,
	SC_SKIPPER_BUTTON,
	SC_COMMENT_TEXT_INPUT,
	SC_LOGIN_BUTTON,
	SC_SUBMIT_APPROVAL_BUTTON,
	IG_SKIPPER_BUTTON,
	IG_STATUS_BUTTON,
	IG_STATUS_UNDONE_BUTTON,
	IG_NEXT_BUTTON,
	FB_NEXT_BUTTON,
	SP_SKIPPER_BUTTON,
	SP_OPT_IN_SECTION,
	SP_OPT_OUT_OPTION,
	SP_LOGIN_BUTTON,
	SP_AUTH_ACCEPT_BUTTON,
	DW_DOWNLOAD_BUTTON,
} as const;
