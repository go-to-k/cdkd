<script setup lang="ts">
// The Open Graph card for every cdkd.dev page (1200 x 630), rendered at build
// time by Ox Content's Chromium renderer through Vue SSR (vuePlugin
// 'vizejs'). It is the hero, at card size: the page's title on Paper at the
// left, the symbol standing far larger than a Cloud Navy field at the right
// and cut by its edges. The home page's card carries the hero headline,
// derived from docs/index.md like the home <title>, so the two cannot drift.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computed } from 'vue';
import { MARK_HEIGHT, MARK_PATHS, MARK_WIDTH } from '../brand/mark.js';
import { themeColor, tokens } from '../brand/tokens.js';
import { heroTextOf } from '../plugins/home-title.js';

const {
  title = 'cdkd',
  description = '',
  siteName = 'cdkd',
} = defineProps<{
  title?: string;
  description?: string;
  siteName?: string;
}>();

// The renderer runs from the repository root.
const root = process.cwd();
const isHome = computed(() => title === siteName);
const heading = computed(() =>
  isHome.value ? (heroTextOf(readFileSync(join(root, 'docs/index.md'), 'utf8')) ?? title) : title,
);
const long = computed(() => heading.value.length > 48);

// Geist, inlined: the card renders from a string, with nothing to fetch.
const face = (weight: number): string => {
  const data = readFileSync(join(root, `docs/_site/public/fonts/geist-${weight}.woff2`)).toString(
    'base64',
  );
  return `@font-face{font-family:Geist;font-weight:${weight};src:url(data:font/woff2;base64,${data})}`;
};

// The card's styles travel in the rendered markup with the fonts: Ox Content
// bundles this file with rolldown alone, where an SFC <style> block has no
// CSS pipeline to go through. They are interpolated as text, so they hold no
// character HTML escapes (no quotes, no `&`, no `<` or `>`).
const styles =
  [400, 600].map(face).join('') +
  /* css */ `html,
body {
  margin: 0;
  inline-size: 1200px;
  block-size: 630px;
}

.card {
  display: grid;
  grid-template-columns: 700px 500px;
  inline-size: 1200px;
  block-size: 630px;
  font-family: Geist, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}

.copy {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 64px 56px 56px 72px;
}

.lockup {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* One em tall beside the wordmark: the cloud spans its letters. */
.lockup-mark {
  inline-size: 34px;
  block-size: 30px;
}

.lockup-name {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.03em;
}

.title {
  margin: 0;
  font-size: 64px;
  line-height: 1;
  font-weight: 600;
  letter-spacing: -0.045em;
  text-wrap: balance;
}

.title.long {
  font-size: 50px;
  line-height: 1.04;
}

.description {
  margin: 24px 0 0;
  font-size: 24px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.domain {
  margin: 0;
  font-size: 22px;
  font-weight: 400;
}

.field {
  position: relative;
  overflow: hidden;
}

.symbol {
  position: absolute;
  inset-block-start: 15%;
  inset-inline-end: 7%;
  inline-size: 150%;
  block-size: auto;
}`;

const palette = {
  paper: tokens.brand.paper,
  navy: tokens.brand.navy,
  cloud: tokens.brand.cloud,
  orange: tokens.brand.orange,
  secondary: themeColor('light', 'text-secondary'),
  muted: themeColor('light', 'text-muted'),
};
const cloudPath = [MARK_PATHS.top, MARK_PATHS.left, MARK_PATHS.body].join(' ');
const viewBox = `0 0 ${MARK_WIDTH} ${MARK_HEIGHT}`;
</script>

<template>
  <div class="card" :style="{ background: palette.paper, color: palette.navy }">
    <component is="style">{{ styles }}</component>
    <div class="copy">
      <div class="lockup">
        <svg class="lockup-mark" :viewBox aria-hidden="true">
          <path :fill="palette.navy" :d="cloudPath" />
          <path :fill="palette.orange" :d="MARK_PATHS.route" />
        </svg>
        <span class="lockup-name">cdkd</span>
      </div>
      <div class="text">
        <p class="title" :class="{ long }">{{ heading }}</p>
        <p v-if="description && !isHome" class="description" :style="{ color: palette.secondary }">
          {{ description }}
        </p>
      </div>
      <p class="domain" :style="{ color: palette.muted }">cdkd.dev</p>
    </div>
    <div class="field" :style="{ background: palette.navy }">
      <svg class="symbol" :viewBox aria-hidden="true">
        <path :fill="palette.cloud" :d="cloudPath" />
        <path :fill="palette.orange" :d="MARK_PATHS.route" />
      </svg>
    </div>
  </div>
</template>
