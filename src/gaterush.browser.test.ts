import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Browser, Page } from 'puppeteer';
import { launchAppBrowser } from './browserLaunch';
import { GaterushDownloader } from './gaterush';
import Selectors from './selectors';

// Replays the redesigned gate's DOM and delayed step replacement without
// submitting personal data or performing social actions against live services.
const fixture = (steps: string[], rejectEmail = false) => `
<div id="cookieModal" hidden>
  <input id="cookieAdToggle" type="checkbox" checked>
  <button id="cookieRejectAll">Reject all</button>
</div>
<div id="stepStage"></div>
<button id="download" disabled>Locked</button>
<script>
  const steps = ${JSON.stringify(steps)};
  let index = 0;
  const stage = document.querySelector('#stepStage');
  const modal = document.querySelector('#cookieModal');
  modal.hidden = localStorage.getItem('rejected') === 'true';
  document.querySelector('#cookieRejectAll').onclick = () => {
    localStorage.setItem('rejected', 'true');
    location.reload();
  };
  function advance() {
    stage.firstElementChild.classList.add('leaving');
    index++;
    setTimeout(render, 280);
  }
  function render() {
    if (index === steps.length) {
      stage.innerHTML = '<div class="step">All set</div>';
      document.querySelector('#download').disabled = false;
      return;
    }
    const step = steps[index];
    const content = {
      email: '<input id="nameInput"><input id="emailInput"><button data-go>Save &amp; continue</button>',
      soundcloud: '<input id="commentInput"><button class="btn-soundcloud" data-go>Connect SoundCloud</button>',
      instagram: '<button class="list-btn svc-instagram">Follow</button><button class="list-btn svc-instagram">Follow</button>',
      'instagram-empty': '<button class="btn-instagram" data-go>Open Instagram</button>'
    }[step];
    stage.innerHTML = '<div class="step"><h2 class="step-title">' + step + '</h2><div data-body>' + content + '</div></div>';
    if (step === 'instagram-empty') {
      stage.querySelector('button').onclick = () => {
        window.open('about:blank#instagram');
        setTimeout(advance, 800);
      };
    } else if (step === 'instagram') {
      for (const button of stage.querySelectorAll('button')) {
        button.onclick = () => {
          if (button.classList.contains('done')) throw new Error('Repeated Instagram follow');
          button.classList.add('done');
          button.innerHTML = '<svg></svg>';
          window.open('about:blank#instagram');
          if (!stage.querySelector('button:not(.done)')) setTimeout(advance, 50);
        };
      }
    } else {
      stage.querySelector('button').onclick = () => {
        if (!modal.hidden) throw new Error('Cookie banner still open');
        if (step === 'email') {
          if (document.querySelector('#nameInput').value !== 'Test Listener' ||
              document.querySelector('#emailInput').value !== 'listener@example.com') return;
          if (${rejectEmail}) return;
        } else if (document.querySelector('#commentInput').value !== 'Test comment') return;
        stage.querySelector('button').disabled = true;
        setTimeout(advance, 50);
      };
    }
  }
  document.querySelector('#download').onclick = () => document.body.dataset.downloaded = 'true';
  setTimeout(render, 50);
</script>`;

describe('GateRush redesigned gate', () => {
	let browser: Browser;
	beforeAll(async () => {
		browser = await launchAppBrowser({ headless: true, humanize: false });
	}, 30_000);
	afterAll(async () => {
		await browser?.close();
	});

	async function runGate(
		steps: string[],
		rejectEmail = false,
		missEmailClick = false,
	) {
		const context = await browser.createBrowserContext();
		const page = await context.newPage();
		const click = page.click.bind(page);
		if (missEmailClick) {
			spyOn(page, 'click').mockImplementation(async (selector, options) => {
				if (selector === Selectors.GATERUSH_EMAIL_SUBMIT) {
					await page.$eval('#stepStage', (el) => (el as HTMLElement).click());
					return;
				}
				await click(selector, options);
			});
		}
		await page.setRequestInterception(true);
		page.on('request', (request) => {
			void request.respond({
				status: 200,
				contentType: 'text/html',
				body: fixture(steps, rejectEmail),
			});
		});
		const downloader = new GaterushDownloader({
			browserMode: 'headless',
			name: 'Test Listener',
			email: 'listener@example.com',
			comment: 'Test comment',
		});
		let downloaded = false;
		Object.assign(downloader, {
			browser: {
				newPage: async () => page,
				pages: () => context.pages(),
			},
			handleDownload: async (gate: Page) => {
				expect(
					await gate.$eval('#cookieModal', (el) => el.hasAttribute('hidden')),
				).toBeTrue();
				await gate.click('#download');
				downloaded = await gate.evaluate(
					() => document.body.dataset.downloaded === 'true',
				);
			},
		});
		try {
			await downloader.downloadAudio('https://gaterush.me/fixture');
			expect(downloaded).toBeTrue();
		} finally {
			await context.close();
		}
	}

	test('rejects cookies, waits for reload, and completes successive steps', async () => {
		await runGate(['email', 'soundcloud', 'instagram']);
	}, 15_000);

	test('handles the order chosen by the gate and optional steps', async () => {
		await runGate(['instagram', 'soundcloud', 'email']);
		await runGate(['instagram-empty']);
		await runGate([]);
	}, 15_000);

	test('reports email validation failure without advancing', async () => {
		await expect(runGate(['email'], true)).rejects.toThrow(
			'GateRush email step did not complete',
		);
	}, 15_000);

	test('submits email when the humanized pointer would miss the button', async () => {
		await runGate(['email'], false, true);
	}, 15_000);
});
