# benchmark race GIFs

Source for `assets/benchmark-race-light.gif` and `assets/benchmark-race-dark.gif`,
the deploy race shown under "Benchmark" in the project README.

## What gets recorded

The benchmark chart on the cdkd.dev home page
(`docs/_site/components/cdkd-benchmark.vue`, with its figures in
`docs/index.md`), once with the light theme and once with the dark one. The
page runs on Playwright's paused fake clock and every frame is taken after
advancing it 50 ms, so the GIF plays the race at the component's own speed
(the slowest run in 4.2 s), then holds the result for 3 s and loops.

## Reproducing

Re-record whenever the race's figures or the chart's design change; nothing
checks that the GIFs still match the site.

Prerequisites: `ffmpeg` on PATH (`brew install ffmpeg`) and Playwright's
Chromium (`./node_modules/.bin/playwright install chromium`).

```bash
vp run docs:build                     # the recorder serves dist/site
node assets/benchmark-race-gif/record.ts
```

It writes both GIFs next to this directory and prints their sizes.
