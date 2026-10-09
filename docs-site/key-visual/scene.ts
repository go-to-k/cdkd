// The cdkd.dev key visual: the symbol, sliced along its route.
//
// The field is cut into thin bands that run with the route, at its own 34
// degrees, and each band can slide along it. The symbol is drawn once into a
// texture at the device's pixel size, exactly as the poster shows it, and a
// fragment shader reads every band from where it has slid to. The fills stay
// flat and the band edges stay hard: speed is shown as displacement, never
// as blur, tone or glow.
//
// On first view the bands start set back toward the route's tail in a
// composed scatter and are released from the route's own lane outward, so
// the symbol assembles at speed, middle first, and comes to rest as the logo
// itself. Afterwards a pointer -- or a finger swiping across the field --
// strikes the bands under it with its speed along the route; they slide and
// spring back. A tap or click on the field plays the assembly again. Nothing
// is drawn while every band is at rest, and with reduced motion the scene
// renders once, at rest.
import {
  CanvasTexture,
  Mesh,
  NearestFilter,
  OrthographicCamera,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
} from 'three';
import { MARK_CONSTRUCTION, MARK_HEIGHT, MARK_PATHS, MARK_WIDTH } from '../brand/mark.js';
import { createBands, scatter, step, strike, type Bands } from './bands.js';
import type { Rgb } from './color.js';
import { readPalette } from './palette.js';

export interface KeyVisualOptions {
  /** The static symbol the scene replaces; the scene draws over its box. */
  poster: () => HTMLElement | null;
  reducedMotion: boolean;
  /** Let a hovering pointer strike the bands as it moves; touch strikes on swipe. */
  pointer: boolean;
  /** First frame is on screen; the poster can go. */
  onReady?: () => void;
  /** The GPU dropped the context; the poster should come back. */
  onLost?: () => void;
}

/** Band width across the route, CSS px. */
const BAND = 12;
/** Bands the shader can address; matches the GLSL array size. */
const MAX_BANDS = 160;
/** How far back the opening scatters the bands, as a share of the symbol. */
const SCATTER = 0.9;
/** Pointer speed along the route, px per ms, to band speed. */
const STRIKE = 0.55;

const angle = (MARK_CONSTRUCTION.routeAngle * Math.PI) / 180;
/** In the canvas's own y-down pixels: toward the route's head, and across it. */
const along = new Vector2(Math.cos(angle), -Math.sin(angle));
const across = new Vector2(Math.sin(angle), Math.cos(angle));

const VERTEX = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// Each fragment finds its band, steps back along the route by that band's
// slide (snapped to whole device pixels, so nothing is resampled between
// pixels), and reads the symbol there. Outside the texture is empty field.
const FRAGMENT = /* glsl */ `
  #define MAX_BANDS ${MAX_BANDS}
  uniform sampler2D uSymbol;
  uniform vec2 uSize;
  uniform float uPixelRatio;
  uniform vec2 uAlong;
  uniform vec2 uAcross;
  uniform float uBand;
  uniform float uOrigin;
  uniform float uOffsets[MAX_BANDS];
  void main() {
    vec2 p = vec2(gl_FragCoord.x, uSize.y * uPixelRatio - gl_FragCoord.y) / uPixelRatio;
    int band = int(floor((dot(p, uAcross) - uOrigin) / uBand));
    float slide = band >= 0 && band < MAX_BANDS ? uOffsets[band] : 0.0;
    slide = floor(slide * uPixelRatio + 0.5) / uPixelRatio;
    vec2 q = floor((p - uAlong * slide) * uPixelRatio);
    ivec2 size = textureSize(uSymbol, 0);
    if (q.x < 0.0 || q.y < 0.0 || q.x >= float(size.x) || q.y >= float(size.y)) {
      gl_FragColor = vec4(0.0);
      return;
    }
    gl_FragColor = texelFetch(uSymbol, ivec2(q), 0);
    #include <colorspace_fragment>
  }
`;

const css = ([r, g, b]: Rgb): string =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;

/** Mounts the scene on `canvas`; returns the teardown. */
export function mountKeyVisual(canvas: HTMLCanvasElement, options: KeyVisualOptions): () => void {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    alpha: true,
    powerPreference: 'low-power',
  });
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const art = document.createElement('canvas');
  const texture = new CanvasTexture(art);
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = false;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;

  const offsets = new Float32Array(MAX_BANDS);
  const material = new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: false,
    uniforms: {
      uSymbol: { value: texture },
      uSize: { value: new Vector2() },
      uPixelRatio: { value: 1 },
      uAlong: { value: along },
      uAcross: { value: across },
      uBand: { value: BAND },
      uOrigin: { value: 0 },
      uOffsets: { value: offsets },
    },
  });
  const quad = new Mesh(new PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  // -- layout: the field, its bands, and the symbol drawn where the poster is
  let bands: Bands = createBands(0);
  /** Band index of the route's own lane, where the opening starts. */
  let routeBand = 0;
  let symbolWidth = 0;

  const paint = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const poster = options.poster();
    if (width === 0 || height === 0 || !poster) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio);
    renderer.setSize(width, height, false);
    material.uniforms['uSize']!.value.set(width, height);
    material.uniforms['uPixelRatio']!.value = ratio;

    // Bands are counted across the route from the field's first corner.
    const corners = [
      new Vector2(0, 0),
      new Vector2(width, 0),
      new Vector2(0, height),
      new Vector2(width, height),
    ].map((corner) => corner.dot(across));
    const origin = Math.min(...corners);
    const count = Math.min(MAX_BANDS, Math.ceil((Math.max(...corners) - origin) / BAND) + 1);
    material.uniforms['uOrigin']!.value = origin;
    if (bands.offset.length !== count) bands = createBands(count);

    // The symbol, at device pixels, exactly over the poster's box.
    const frame = canvas.getBoundingClientRect();
    const box = poster.getBoundingClientRect();
    symbolWidth = box.width;
    const artWidth = Math.round(width * ratio);
    const artHeight = Math.round(height * ratio);
    if (art.width !== artWidth || art.height !== artHeight) {
      art.width = artWidth;
      art.height = artHeight;
      // The GPU copy has a fixed size: a resized canvas needs a new one.
      texture.dispose();
    }
    const context = art.getContext('2d');
    if (!context) return;
    const palette = readPalette(canvas);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, art.width, art.height);
    const scale = (box.width / MARK_WIDTH) * ratio;
    context.setTransform(
      scale,
      0,
      0,
      (box.height / MARK_HEIGHT) * ratio,
      (box.left - frame.left) * ratio,
      (box.top - frame.top) * ratio
    );
    context.fillStyle = css(palette.cloud);
    for (const d of [MARK_PATHS.top, MARK_PATHS.left, MARK_PATHS.body]) context.fill(new Path2D(d));
    context.fillStyle = css(palette.route);
    context.fill(new Path2D(MARK_PATHS.route));
    texture.needsUpdate = true;

    // The route's lane: the band through the middle of its axis.
    const [nx, ny] = MARK_CONSTRUCTION.routeAxis.normal;
    const middle = new Vector2(
      box.left - frame.left + nx * MARK_CONSTRUCTION.routeAxis.offset * (box.width / MARK_WIDTH),
      box.top - frame.top + ny * MARK_CONSTRUCTION.routeAxis.offset * (box.height / MARK_HEIGHT)
    );
    routeBand = Math.floor((middle.dot(across) - origin) / BAND);
  };

  // -- motion ---------------------------------------------------------------
  let now = 0;
  let started = options.reducedMotion;
  let raf = 0;
  let last = 0;
  let ready = false;

  const draw = (): void => {
    offsets.set(bands.offset.subarray(0, Math.min(bands.offset.length, MAX_BANDS)));
    renderer.render(scene, camera);
    if (!ready) {
      ready = true;
      options.onReady?.();
    }
  };

  const tick = (time: number): void => {
    raf = 0;
    const dt = last ? Math.min(time - last, 48) : 16;
    last = time;
    now += dt;
    const moving = step(bands, now, dt);
    draw();
    if (moving) raf = requestAnimationFrame(tick);
    else last = 0;
  };
  const wake = (): void => {
    if (raf === 0 && !options.reducedMotion) raf = requestAnimationFrame(tick);
  };

  const begin = (): void => {
    started = true;
    now = 0;
    scatter(bands, routeBand, symbolWidth * SCATTER);
    draw();
    wake();
  };

  const visibility = new IntersectionObserver(
    ([entry]) => {
      if (!entry?.isIntersecting || started) return;
      visibility.disconnect();
      begin();
    },
    { threshold: 0.25 }
  );

  // -- input: strike the bands under a pointer or finger, replay on a tap ---
  /** The point in field pixels, or null outside the field. */
  const local = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const frame = canvas.getBoundingClientRect();
    const x = clientX - frame.left;
    const y = clientY - frame.top;
    return x >= 0 && y >= 0 && x <= frame.width && y <= frame.height ? { x, y } : null;
  };

  let previous: { x: number; y: number; t: number } | undefined;
  const track = (clientX: number, clientY: number, t: number): void => {
    if (!started) return;
    const point = local(clientX, clientY);
    if (point && previous && t > previous.t) {
      const speed =
        ((point.x - previous.x) * along.x + (point.y - previous.y) * along.y) / (t - previous.t);
      const origin = material.uniforms['uOrigin']!.value as number;
      strike(
        bands,
        Math.floor((point.x * across.x + point.y * across.y - origin) / BAND),
        speed * STRIKE
      );
      wake();
    }
    previous = point ? { ...point, t } : undefined;
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType !== 'touch') track(event.clientX, event.clientY, event.timeStamp);
  };
  // Touch scrolls the page, so a finger is read from touch events, which keep
  // arriving while the page moves; the strike never blocks the scroll.
  const onTouchMove = (event: TouchEvent): void => {
    const touch = event.touches[0];
    if (touch) track(touch.clientX, touch.clientY, event.timeStamp);
  };
  const onTouchEnd = (): void => {
    previous = undefined;
  };

  let press: { x: number; y: number; t: number } | undefined;
  const onPointerDown = (event: PointerEvent): void => {
    const point = local(event.clientX, event.clientY);
    press = point ? { ...point, t: event.timeStamp } : undefined;
  };
  const onPointerUp = (event: PointerEvent): void => {
    const point = local(event.clientX, event.clientY);
    if (!press || !point || !started) return;
    const still = Math.hypot(point.x - press.x, point.y - press.y) < 8;
    if (still && event.timeStamp - press.t < 400) begin();
    press = undefined;
  };

  const interactive = !options.reducedMotion;
  if (interactive) {
    if (options.pointer) window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
  }

  const resize = new ResizeObserver(() => {
    paint();
    if (raf === 0) draw();
  });

  const scheme = window.matchMedia('(prefers-color-scheme: dark)');
  const repaint = (): void => {
    paint();
    if (raf === 0) draw();
  };
  scheme.addEventListener('change', repaint);
  const themeAttribute = new MutationObserver(repaint);
  themeAttribute.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });

  const onLost = (event: Event): void => {
    event.preventDefault();
    cancelAnimationFrame(raf);
    raf = 0;
    options.onLost?.();
  };
  canvas.addEventListener('webglcontextlost', onLost);

  paint();
  if (!options.reducedMotion) {
    // The first frame is the opening's first frame, not the resting symbol.
    scatter(bands, routeBand, symbolWidth * SCATTER);
    visibility.observe(canvas);
  }
  draw();
  resize.observe(canvas);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('touchmove', onTouchMove);
    window.removeEventListener('touchend', onTouchEnd);
    window.removeEventListener('pointerdown', onPointerDown);
    window.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('webglcontextlost', onLost);
    visibility.disconnect();
    resize.disconnect();
    themeAttribute.disconnect();
    scheme.removeEventListener('change', repaint);
    quad.geometry.dispose();
    material.dispose();
    texture.dispose();
    renderer.dispose();
  };
}
