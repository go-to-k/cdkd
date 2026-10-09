// The cdkd symbol as vector geometry: three cloud faces and one route.
//
// Redrawn from the approved raster (brand option 02) on a fixed construction:
// three circles for the cloud, a route band at 34 degrees, and one gap width
// (24 units) everywhere the faces and the route part. The same paths are the
// logo files (docs/_site/public/brand/logo-*.svg), the key visual and the OG card,
// so none of them can drift from the others. The favicon is its own drawing
// of the symbol, simplified for 16 to 32 px, where these gaps would close.
//
// Coordinates are SVG user units, y pointing down, origin at the top-left of
// the visible symbol.

export const MARK_WIDTH = 826;
export const MARK_HEIGHT = 725;

/** One closed outline per face, in drawing order. */
export const MARK_PATHS = {
  top: 'M244.3 238.6A215 215 0 0 1 600.5 54L704.2 145.8L412.7 342.4L353.6 290.9A228 228 0 0 0 244.3 238.6Z',
  left: 'M337.8 309A204 204 0 1 0 95.1 635.5A156 156 0 0 1 163.8 510.3L392.1 356.2L337.8 309Z',
  body: 'M143 725L648 725A162 162 0 0 0 722 418.9L722 300.2L165.6 675.5Q143 690.7 143 716.8Z',
  route:
    'M119 704L119 639.6A132 132 0 0 1 177.2 530.2L731.9 156L826 199L746 302L746 255.1L152.2 655.6Q119 678 119 704Z',
} as const;

/** The route's lane: its angle, and the centre line of its band. */
export const MARK_CONSTRUCTION = {
  /** Route direction, degrees above the horizontal. */
  routeAngle: 34,
  /** Route centre line: the points p with normal . p = offset. */
  routeAxis: { normal: [0.5592, 0.829] as const, offset: 583.6 },
} as const;
