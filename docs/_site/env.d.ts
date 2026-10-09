// Ambient types for the docs site's client code.

declare module 'virtual:ox-content-vue/components' {
  import type { Component } from 'vue';

  /** Every SFC in docs/_site/components, keyed by its PascalCase file name. */
  export const components: Record<string, Component>;
  export default components;
}
