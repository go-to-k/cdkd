// Colors for the key visual, read from the brand tokens as the element it
// draws on resolves them: the hero's field restates the logo colors for its
// own ground, so reading from the canvas, not the root, keeps the scene in
// step with the CSS.

import { parseHex, type Rgb } from './color.js';

export interface KeyVisualPalette {
  /** The logo's cloud and route. */
  cloud: Rgb;
  route: Rgb;
}

export function readPalette(element: Element): KeyVisualPalette {
  const style = getComputedStyle(element);
  const read = (name: string): Rgb => parseHex(style.getPropertyValue(`--cdkd-${name}`));
  return {
    cloud: read('color-logo-cloud'),
    route: read('color-logo-route'),
  };
}
