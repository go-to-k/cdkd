<script setup lang="ts">
// The home page key visual. Client-only: it draws into a canvas over the
// hero's static symbol (the poster), placing the scene exactly on the
// poster's box, so the CSS alone decides where the symbol sits. Without
// WebGL the poster simply stays.
import { onBeforeUnmount, onMounted, ref } from 'vue';

defineOptions({ clientOnly: true });

const canvas = ref<HTMLCanvasElement | null>(null);
const ready = ref(false);
let teardown: (() => void) | undefined;
let unmounted = false;

function frame(): HTMLElement | null {
  return canvas.value?.closest<HTMLElement>('.hero-image') ?? null;
}

/** The poster image the current theme shows. */
function poster(): HTMLElement | null {
  const images = frame()?.querySelectorAll<HTMLElement>(':scope > img') ?? [];
  return [...images].find((image) => image.getBoundingClientRect().width > 0) ?? null;
}

function supportsWebGL(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    // A probe only: hand the context back rather than hold one of the
    // browser's few until it is collected.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

function setState(state: 'scene' | 'poster'): void {
  frame()?.classList.toggle('has-scene', state === 'scene');
  frame()?.classList.toggle('has-poster', state === 'poster');
}

onMounted(async () => {
  if (!canvas.value || !supportsWebGL()) {
    setState('poster');
    return;
  }
  const { mountKeyVisual } = await import('../key-visual/scene.js');
  if (unmounted || !canvas.value) return;
  teardown = mountKeyVisual(canvas.value, {
    poster,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    pointer: window.matchMedia('(hover: hover) and (pointer: fine)').matches,
    onReady: () => {
      ready.value = true;
      setState('scene');
    },
    onLost: () => {
      ready.value = false;
      setState('poster');
    },
  });
});

onBeforeUnmount(() => {
  unmounted = true;
  teardown?.();
  setState('poster');
});
</script>

<template>
  <div class="cdkd-key-visual" :class="{ ready }" aria-hidden="true">
    <canvas ref="canvas" class="canvas" />
  </div>
</template>

<style scoped>
.cdkd-key-visual {
  position: absolute;
  inset: 0;
  visibility: hidden;
  pointer-events: none;

  &.ready {
    visibility: visible;
  }

  & .canvas {
    display: block;
    inline-size: 100%;
    block-size: 100%;
  }
}
</style>
