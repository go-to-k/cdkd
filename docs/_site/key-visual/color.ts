// Hex token values as color channels, for the key visual's canvas. Pure, so
// it is usable outside a browser.

export type Rgb = readonly [number, number, number];

/** `#rgb` or `#rrggbb` as sRGB channels in [0, 1]. */
export function parseHex(value: string): Rgb {
  const hex = value.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new Error(`[key-visual] not a hex color: ${value}`);
  }
  return [
    Number.parseInt(full.slice(0, 2), 16) / 255,
    Number.parseInt(full.slice(2, 4), 16) / 255,
    Number.parseInt(full.slice(4, 6), 16) / 255,
  ];
}
