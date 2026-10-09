<script setup lang="ts">
// A shell command set the way the brand's CLI specimen sets it: Night
// surface, an orange prompt, one copy action for the whole block.
import { computed, onBeforeUnmount, ref } from 'vue';

const { lines, label = 'Shell command' } = defineProps<{
  lines: string[];
  /** Names the block for assistive technology. */
  label?: string;
}>();

const copied = ref(false);
const text = computed(() => lines.join('\n'));
const rows = computed(() => lines.map((line, index) => ({ id: `${index}:${line}`, line })));
let reset: ReturnType<typeof setTimeout> | undefined;

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

onBeforeUnmount(() => clearTimeout(reset));
</script>

<template>
  <div class="cdkd-command" role="group" :aria-label="label">
    <div class="lines">
      <code v-for="row in rows" :key="row.id" class="line">
        <span aria-hidden="true" class="prompt">$</span>{{ row.line }}
      </code>
    </div>
    <button class="copy" type="button" :aria-label="copied ? 'Copied' : 'Copy command'" @click="copy">
      <span
        class="icon iconify-icon"
        :class="copied ? 'icon-[lucide--check]' : 'icon-[lucide--copy]'"
        aria-hidden="true"
      />
    </button>
    <span class="status" role="status">{{ copied ? 'Copied to clipboard' : '' }}</span>
  </div>
</template>

<style scoped>
.cdkd-command {
  display: flex;
  align-items: flex-start;
  gap: var(--cdkd-space-2);
  margin-block-start: var(--cdkd-space-6);
  padding-block: var(--cdkd-space-1);
  padding-inline: var(--cdkd-space-4) var(--cdkd-space-1);
  border: 1px solid var(--cdkd-code-frame);
  border-radius: var(--cdkd-radius-md);
  background: var(--cdkd-color-code-bg);
  color: var(--cdkd-color-code-text);

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
