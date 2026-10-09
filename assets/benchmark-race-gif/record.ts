// Records the home page's benchmark race (docs/_site/components/cdkd-benchmark.vue)
// as two GIFs for the README: ../benchmark-race-light.gif and
// ../benchmark-race-dark.gif. Usage is in README.md beside this file.
//
// The race is driven by requestAnimationFrame and performance.now(), so the
// page runs on Playwright's fake clock and every frame is taken after
// advancing it a fixed step: the GIF's timing is the component's own, not
// whatever the machine managed while screenshotting.
import { spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright';

const HERE = import.meta.dirname;
const SITE = resolve(HERE, '../../dist/site');
const OUT_DIR = resolve(HERE, '..');
const FPS = 20;
/** The component's PLAY_MS plus a little, so the last row lands. */
const RACE_MS = 4400;
/** How long the start (all zeros) and the finished race hold, seconds. */
const HOLD_START_S = 0.6;
const HOLD_END_S = 3;
/** Wide enough for the desktop layout of the figure, which the README shows. */
const VIEWPORT = { width: 1000, height: 900 };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

if (!existsSync(join(SITE, 'index.html'))) {
  throw new Error(`no site build at ${SITE}; run \`vp run docs:build\` first`);
}
if (spawnSync('ffmpeg', ['-version']).status !== 0) {
  throw new Error('ffmpeg is not on PATH (macOS: brew install ffmpeg)');
}

// The built site, served as GitHub Pages would: a directory answers with its index.html.
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(SITE, path));
  if (!file.startsWith(SITE)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('server did not bind');
const origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch();
try {
  for (const scheme of ['light', 'dark'] as const) {
    const frames = mkdtempSync(join(tmpdir(), `cdkd-race-${scheme}-`));
    try {
      const page = await browser.newPage({
        viewport: VIEWPORT,
        // 2x, so the README stays sharp on high-density screens; GitHub scales
        // the image down to the column width.
        deviceScaleFactor: 2,
        colorScheme: scheme,
        reducedMotion: 'no-preference',
      });
      await page.clock.install();
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const figure = page.locator('figure.cdkd-benchmark');
      await figure.waitFor();
      // Hydration resets the race to zero and arms its IntersectionObserver.
      // An installed clock still flows in real time, so stop it before the
      // race can start: from here on, time moves only by runFor().
      await page.waitForFunction(
        () => document.querySelector('.cdkd-benchmark .clock-value')?.textContent?.trim() === '0',
      );
      await page.clock.pauseAt(new Date(Date.now() + 60_000));
      // The link under the chart cannot be followed in a GIF.
      await page.addStyleTag({ content: '.cdkd-benchmark a { visibility: hidden; }' });
      // Scrolling the figure into view starts the race. The observer callback
      // runs on a real task; the race's first animation frame, which records
      // its start time, waits for the paused clock.
      await figure.scrollIntoViewIfNeeded();
      await new Promise((done) => setTimeout(done, 500));
      await page.clock.runFor(1);
      const shot = (index: number): Promise<Buffer> =>
        figure.screenshot({ path: join(frames, `${String(index).padStart(4, '0')}.png`) });
      await shot(0);

      const step = 1000 / FPS;
      const count = Math.ceil(RACE_MS / step);
      for (let index = 1; index <= count; index += 1) {
        await shot(index);
        await page.clock.runFor(step);
      }
      await page.close();

      const out = join(OUT_DIR, `benchmark-race-${scheme}.gif`);
      // Hold the first and last frames, then build one palette for the whole
      // clip so the brand colors stay exact and flat areas do not dither.
      const filter =
        `[0:v]tpad=start_mode=clone:start_duration=${HOLD_START_S}` +
        `:stop_mode=clone:stop_duration=${HOLD_END_S},split[a][b];` +
        '[a]palettegen=stats_mode=full:reserve_transparent=0[p];' +
        '[b][p]paletteuse=dither=none';
      const ffmpeg = spawnSync(
        'ffmpeg',
        [
          '-y',
          '-loglevel',
          'error',
          '-framerate',
          String(FPS),
          '-i',
          join(frames, '%04d.png'),
          '-filter_complex',
          filter,
          '-loop',
          '0',
          out,
        ],
        { stdio: 'inherit' },
      );
      if (ffmpeg.status !== 0) throw new Error(`ffmpeg failed for ${scheme}`);
      console.log(`${out} (${Math.round(statSync(out).size / 1024)} KB)`);
    } finally {
      rmSync(frames, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
  server.close();
}
