<script setup lang="ts">
// A shell command set the way the brand's CLI specimen sets it: Night
// surface, an orange prompt, one copy action for the whole block.
//
// With `tabs`, the block offers the same command per tool (one per package
// manager, say) as an ARIA tab list. A `group` shares the reader's choice
// with every other block of that group, including the docs' package-manager
// tabs, through the key Ox Content's tab runtime keeps it under.
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';

interface CommandTab {
  label: string;
  lines: string[];
}

const {
  lines = [],
  tabs = [],
  group,
  initial,
  label = 'Shell command',
} = defineProps<{
  /** The command, one entry per line, when there is only one. */
  lines?: string[];
  /** The same command per tool, in display order. */
  tabs?: CommandTab[];
  /** Shares the selected tab with every block of this group. */
  group?: string;
  /** The tab shown before the reader has chosen one. */
  initial?: string;
  /** Names the block for assistive technology. */
  label?: string;
}>();

const STORAGE_PREFIX = 'ox-tab-group:';
const id = useId();
const tabButtons = ref<HTMLButtonElement[]>([]);
const active = ref(
  Math.max(
    0,
    tabs.findIndex((tab) => tab.label === initial),
  ),
);
const copied = ref(false);

const shown = computed(() => (tabs.length > 0 ? (tabs[active.value]?.lines ?? []) : lines));
const text = computed(() => shown.value.join('\n'));
const rows = computed(() => shown.value.map((line, index) => ({ id: `${index}:${line}`, line })));
let reset: ReturnType<typeof setTimeout> | undefined;

function stored(): string | null {
  if (!group) return null;
  try {
    return localStorage.getItem(STORAGE_PREFIX + group);
  } catch {
    return null;
  }
}

function select(index: number, focus = false): void {
  const tab = tabs[index];
  if (!tab) return;
  active.value = index;
  if (focus) tabButtons.value[index]?.focus();
  if (!group) return;
  try {
    localStorage.setItem(STORAGE_PREFIX + group, tab.label);
  } catch {
    // Private mode or a full quota: the choice just is not remembered.
  }
}

function onKey(event: KeyboardEvent): void {
  const last = tabs.length - 1;
  const next =
    event.key === 'ArrowRight'
      ? active.value === last
        ? 0
        : active.value + 1
      : event.key === 'ArrowLeft'
        ? active.value === 0
          ? last
          : active.value - 1
        : event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? last
            : -1;
  if (next < 0) return;
  event.preventDefault();
  select(next, true);
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(text.value);
  } catch {
    return;
  }
  copied.value = true;
  clearTimeout(reset);
  reset = setTimeout(() => {
    copied.value = false;
  }, 2000);
}

onMounted(() => {
  const choice = stored();
  const index = choice === null ? -1 : tabs.findIndex((tab) => tab.label === choice);
  if (index >= 0) active.value = index;
});

onBeforeUnmount(() => clearTimeout(reset));
</script>

<template>
  <div class="cdkd-command" role="group" :aria-label="label">
    <div v-if="tabs.length > 0" class="tabs" role="tablist" :aria-label="label">
      <button
        v-for="(tab, index) in tabs"
        :id="`${id}-tab-${tab.label}`"
        :key="tab.label"
        ref="tabButtons"
        class="tab"
        role="tab"
        type="button"
        :aria-selected="index === active"
        :aria-controls="`${id}-panel`"
        :tabindex="index === active ? 0 : -1"
        @click="() => select(index)"
        @keydown="onKey"
      >
        {{ tab.label }}
      </button>
    </div>
    <div
      :id="`${id}-panel`"
      class="body"
      :role="tabs.length > 0 ? 'tabpanel' : undefined"
      :aria-labelledby="tabs.length > 0 ? `${id}-tab-${tabs[active]?.label}` : undefined"
    >
      <div class="lines">
        <code v-for="row in rows" :key="row.id" class="line">
          <span aria-hidden="true" class="prompt">$</span>{{ row.line }}
        </code>
      </div>
      <button
        class="copy"
        type="button"
        :aria-label="copied ? 'Copied' : 'Copy command'"
        @click="copy"
      >
        <span
          class="icon iconify-icon"
          :class="copied ? 'icon-[lucide--check]' : 'icon-[lucide--copy]'"
          aria-hidden="true"
        />
      </button>
    </div>
    <span class="status" role="status">{{ copied ? 'Copied to clipboard' : '' }}</span>
  </div>
</template>

<style scoped>
.cdkd-command {
  margin-block-start: var(--cdkd-space-6);
  border: 1px solid var(--cdkd-code-frame);
  border-radius: var(--cdkd-radius-md);
  background: var(--cdkd-color-code-bg);
  color: var(--cdkd-color-code-text);

  & .tabs {
    display: flex;
    gap: var(--cdkd-space-1);
    padding-inline: var(--cdkd-space-2);
    border-block-end: 1px solid color-mix(in srgb, var(--cdkd-color-code-text) 14%, transparent);
    overflow-x: auto;
    scrollbar-width: none;
  }

  & .tab {
    flex: none;
    min-block-size: 2.25rem;
    margin-block-end: -1px;
    padding: 0 var(--cdkd-space-3);
    border: 0;
    border-block-end: 2px solid transparent;
    background: none;
    font-family: var(--cdkd-font-mono);
    font-size: var(--cdkd-type-caption-size);
    color: var(--cdkd-color-code-muted);
    cursor: pointer;
    transition:
      color var(--cdkd-motion-fast) var(--cdkd-motion-ease),
      border-color var(--cdkd-motion-fast) var(--cdkd-motion-ease);

    &:hover {
      color: var(--cdkd-color-code-text);
    }

    &[aria-selected='true'] {
      color: var(--cdkd-color-code-text);
      border-block-end-color: var(--cdkd-color-accent);
    }

    &:focus-visible {
      outline: var(--cdkd-border-focus-width) solid var(--cdkd-color-code-accent);
      outline-offset: -4px;
      border-radius: var(--cdkd-radius-sm);
    }
  }

  & .body {
    display: flex;
    align-items: flex-start;
    gap: var(--cdkd-space-2);
    padding-block: var(--cdkd-space-1);
    padding-inline: var(--cdkd-space-4) var(--cdkd-space-1);
  }

  & .lines {
    flex: 1 1 auto;
    min-inline-size: 0;
    padding-block: var(--cdkd-space-3);
    overflow-x: auto;
  }

  & .line {
    display: block;
    white-space: pre;
    font-family: var(--cdkd-font-mono);
    font-feature-settings: var(--cdkd-font-features-code);
    font-size: var(--cdkd-type-code-size);
    line-height: var(--cdkd-type-code-leading);
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
  }

  & .prompt {
    margin-inline-end: 0.75ch;
    color: var(--cdkd-color-code-accent);
    user-select: none;
  }

  & .copy {
    flex: none;
    display: grid;
    place-items: center;
    inline-size: var(--cdkd-size-control-height);
    block-size: var(--cdkd-size-control-height);
    border: 0;
    border-radius: var(--cdkd-radius-sm);
    background: transparent;
    color: var(--cdkd-color-code-muted);
    cursor: pointer;
    transition:
      color var(--cdkd-motion-fast) var(--cdkd-motion-ease),
      background-color var(--cdkd-motion-fast) var(--cdkd-motion-ease);

    &:hover {
      color: var(--cdkd-color-code-text);
      background: color-mix(in srgb, var(--cdkd-color-code-text) 10%, transparent);
    }

    &:focus-visible {
      outline: var(--cdkd-border-focus-width) solid var(--cdkd-color-code-accent);
      outline-offset: 0;
    }
  }

  & .icon {
    display: block;
    inline-size: var(--cdkd-size-icon);
    block-size: var(--cdkd-size-icon);
    background-color: currentColor;
  }

  & .status {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
}
</style>
