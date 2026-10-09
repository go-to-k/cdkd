<script setup lang="ts">
// One benchmark, told as a race on a shared clock. Every run starts at zero
// on the same time axis and stops where it finished, so the eye reads "done
// sooner" -- a short run is a run that is over, not a smaller number. When
// the chart scrolls into view the clock runs (the slowest run in a few
// seconds) and each row marks itself done as the clock passes its time; the
// static page, and a reader who asks for reduced motion, get the finished
// race.
//
// Every figure comes from docs/_contents/benchmarks.md, with its conditions beside it.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

interface BenchmarkRow {
  label: string;
  /** Flag the run used, set in code type after the label. */
  flag?: string;
  seconds: number;
  /** The speedup as benchmarks.md states it, e.g. "15.0x". */
  ratio?: string;
}

const {
  title = '',
  rows,
  note = '',
  href = '',
  linkText = 'All benchmarks',
} = defineProps<{
  /** The stack measured. */
  title?: string;
  rows: BenchmarkRow[];
  /** What was timed and how, in one or two sentences. */
  note?: string;
  href?: string;
  linkText?: string;
}>();

/** Wall time the slowest run takes to play, ms. */
const PLAY_MS = 4200;

/** Site paths and https URLs only: the link comes from Markdown. */
function safeUrl(url: string): string {
  return /^(\/(?!\/)|https:\/\/)/.test(url) ? url : '';
}

const longest = computed(() => Math.max(...rows.map((row) => row.seconds)));
/** The axis runs to the next even minute past the slowest run, marked every two. */
const span = computed(() => Math.ceil(longest.value / 120) * 120);
const ticks = computed(() =>
  Array.from({ length: span.value / 120 + 1 }, (_, step) => ({
    minute: step * 2,
    style: { insetInlineStart: `${((step * 120) / span.value) * 100}%` },
  })),
);

// The clock: the finished race until the race is run.
const clock = ref(longest.value);

const lanes = computed(() =>
  rows.map((row, index) => ({
    ...row,
    id: `${row.label}${row.flag ?? ''}`,
    baseline: index === 0,
    done: clock.value >= row.seconds,
    style: { '--reach': `${(Math.min(clock.value, row.seconds) / span.value) * 100}%` },
  })),
);

const root = ref<HTMLElement | null>(null);
let observer: IntersectionObserver | undefined;
let frame = 0;

function race(): void {
  const start = performance.now();
  const tick = (time: number): void => {
    const progress = Math.min(1, (time - start) / PLAY_MS);
    clock.value = longest.value * progress;
    if (progress < 1) frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
}

onMounted(() => {
  const element = root.value;
  if (!element || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  clock.value = 0;
  observer = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting) return;
      observer?.disconnect();
      race();
    },
    { threshold: 0.5 },
  );
  observer.observe(element);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  cancelAnimationFrame(frame);
});
</script>

<template>
  <figure ref="root" class="cdkd-benchmark">
    <div class="head">
      <p v-if="title" class="title">{{ title }}</p>
      <p aria-hidden="true" class="clock">
        <span class="clock-value">{{ Math.round(clock) }}</span> s
      </p>
    </div>
    <ol class="rows">
      <li
        v-for="lane in lanes"
        :key="lane.id"
        class="row"
        :class="{ baseline: lane.baseline, done: lane.done }"
        :style="lane.style"
      >
        <span class="label">
          {{ lane.label }}<code v-if="lane.flag" class="flag">{{ lane.flag }}</code>
        </span>
        <span aria-hidden="true" class="track">
          <span class="run" />
          <span class="finish">
            <span v-if="!lane.baseline" class="finish-icon iconify-icon icon-[lucide--circle-check]" />
            <span class="finish-time">{{ lane.seconds }} s</span>
          </span>
        </span>
        <span class="verdict">
          <span class="cdkd-visually-hidden">Finished in {{ lane.seconds }} seconds.</span>
          <span v-if="lane.ratio" class="ratio">{{ lane.ratio }} faster</span>
        </span>
      </li>
    </ol>
    <div aria-hidden="true" class="axis">
      <span v-for="tick in ticks" :key="tick.minute" class="tick" :style="tick.style">
        {{ tick.minute === 0 ? '0' : `${tick.minute} min` }}
      </span>
    </div>
    <figcaption v-if="note || safeUrl(href)" class="note">
      {{ note }}<br v-if="note && safeUrl(href)" /><a v-if="safeUrl(href)" class="link" :href="safeUrl(href)">{{ linkText }}</a>
    </figcaption>
  </figure>
</template>

<style scoped>
.cdkd-benchmark {
  --label: 13rem;
  --verdict: 8rem;
  --gap: var(--cdkd-space-6);

  margin: var(--cdkd-space-10) 0 0;
  padding: var(--cdkd-space-8);
  border-radius: var(--cdkd-radius-xl);
  background: var(--cdkd-color-surface);

  & .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--cdkd-space-4);
    margin-block-end: var(--cdkd-space-6);
  }

  & .title {
    margin: 0;
    font-size: var(--cdkd-type-body-size);
    line-height: var(--cdkd-type-body-leading);
    font-weight: var(--cdkd-weight-semibold);
    color: var(--cdkd-color-text);
  }

  & .clock {
    margin: 0;
    font-family: var(--cdkd-font-mono);
    font-variant-numeric: var(--cdkd-numeric-data);
    font-size: var(--cdkd-type-small-size);
    color: var(--cdkd-color-text-muted);
  }

  & .clock-value {
    display: inline-block;
    min-inline-size: 3ch;
    text-align: end;
    color: var(--cdkd-color-text);
  }

  & .rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  & .row {
    display: grid;
    grid-template-columns: var(--label) minmax(0, 1fr) var(--verdict);
    align-items: center;
    column-gap: var(--gap);
    min-block-size: 3.5rem;
    margin: 0;
  }

  & .label {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--cdkd-space-2);
    font-size: var(--cdkd-type-label-size);
    line-height: var(--cdkd-type-label-leading);
    font-weight: var(--cdkd-weight-medium);
    color: var(--cdkd-color-text);
  }

  & .flag {
    font-family: var(--cdkd-font-mono);
    font-size: var(--cdkd-type-code-size);
    font-weight: var(--cdkd-weight-regular);
    color: var(--cdkd-color-text-secondary);
    background: none;
    border: 0;
    padding: 0;
  }

  /* The track is the whole time axis; the run fills it up to the clock or
     to its own finish, whichever comes first. */
  & .track {
    position: relative;
    display: block;
    block-size: 10px;
    border-radius: 999px;
    background: var(--cdkd-color-surface-alt);
  }

  & .run {
    position: absolute;
    inset-block: 0;
    inset-inline-start: 0;
    inline-size: var(--reach);
    border-radius: inherit;
    background: var(--cdkd-color-accent);
  }

  & .baseline .run {
    background: var(--cdkd-color-border);
  }

  /* The finish: a mark and the time just past the end of the run, shown
     once the run is over. */
  & .finish {
    position: absolute;
    inset-block-start: 50%;
    inset-inline-start: var(--reach);
    display: inline-flex;
    align-items: center;
    gap: var(--cdkd-space-1);
    padding-inline-start: var(--cdkd-space-2);
    translate: 0 -50%;
    font-family: var(--cdkd-font-mono);
    font-variant-numeric: var(--cdkd-numeric-data);
    font-size: var(--cdkd-type-small-size);
    white-space: nowrap;
    color: var(--cdkd-color-text);
    opacity: 0;
    transition: opacity var(--cdkd-motion-fast) var(--cdkd-motion-ease);
  }

  & .done .finish {
    opacity: 1;
  }

  & .finish-icon {
    inline-size: var(--cdkd-size-icon-sm);
    block-size: var(--cdkd-size-icon-sm);
    background-color: var(--cdkd-color-success);
  }

  /* The slowest run ends at the far edge, so its time sits above the end. */
  & .baseline .finish {
    inset-inline-start: auto;
    inset-inline-end: 0;
    translate: 0 calc(-50% - 1.25rem);
    padding: 0;
  }

  & .verdict {
    text-align: end;
  }

  & .ratio {
    font-family: var(--cdkd-font-mono);
    font-variant-numeric: var(--cdkd-numeric-data);
    font-size: var(--cdkd-type-label-size);
    font-weight: var(--cdkd-weight-medium);
    white-space: nowrap;
    color: var(--cdkd-color-link);
    opacity: 0;
    transition: opacity var(--cdkd-motion-fast) var(--cdkd-motion-ease);
  }

  & .done .ratio {
    opacity: 1;
  }

  & .axis {
    position: relative;
    block-size: 1.5rem;
    margin-block-start: var(--cdkd-space-2);
    margin-inline: calc(var(--label) + var(--gap)) calc(var(--verdict) + var(--gap));
  }

  & .tick {
    position: absolute;
    inset-block-start: 0;
    translate: -50% 0;
    font-family: var(--cdkd-font-mono);
    font-variant-numeric: var(--cdkd-numeric-data);
    font-size: var(--cdkd-type-caption-size);
    white-space: nowrap;
    color: var(--cdkd-color-text-muted);

    &:first-child {
      translate: 0 0;
    }

    &:last-child {
      translate: -100% 0;
    }
  }

  & .note {
    max-inline-size: var(--cdkd-layout-measure);
    margin-block-start: var(--cdkd-space-6);
    font-size: var(--cdkd-type-small-size);
    line-height: var(--cdkd-type-small-leading);
    color: var(--cdkd-color-text-muted);
  }

  & .link {
    display: inline-block;
    margin-block-start: var(--cdkd-space-2);
    color: var(--cdkd-color-link);
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 0.2em;
    white-space: nowrap;

    &:hover {
      color: var(--cdkd-color-link-hover);
    }
  }

  /* Forced colors drop backgrounds, which are what the runs are drawn
     with: in system colors instead, the race still reads. */
  @media (forced-colors: active) {
    & .track {
      border: 1px solid CanvasText;
    }

    & .run {
      forced-color-adjust: none;
      background: Highlight;
    }

    & .baseline .run {
      background: GrayText;
    }
  }

  @media (max-width: 48rem) {
    padding: var(--cdkd-space-5);

    & .row {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas:
        'label verdict'
        'track track';
      row-gap: var(--cdkd-space-3);
      min-block-size: 4.5rem;
      align-content: center;
    }

    & .label {
      grid-area: label;
    }

    & .verdict {
      grid-area: verdict;
    }

    & .track {
      grid-area: track;
    }

    & .finish-time {
      font-size: var(--cdkd-type-caption-size);
    }

    & .axis {
      margin-inline: 0;
    }

    & .tick:not(:first-child, :last-child) {
      visibility: hidden;
    }
  }
}
</style>
