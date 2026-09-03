// Open Graph image template for cdkd.dev (1200x630), rendered headlessly by
// Ox Content's chromium renderer during `vp run docs:build`.
// Contract: default-export a function `(props) => string` returning a full
// HTML document sized to the OG canvas.

// Brand tokens ("Bypass" concept: indigo layers, amber direct-line arrow) —
// the single place to retune when the brand palette changes.
const BRAND = {
  background: '#101322',
  backgroundEdge: '#1c2142',
  text: '#f4f6fb',
  muted: '#9aa1b0',
  accent: '#fbbf24',
  primary: '#818cf8',
  primaryDim: '#3d4470',
};

interface OgTemplateProps {
  title?: string;
  description?: string;
  siteName?: string;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

// Horizontal orientation ("|→||"): vertical bars with the direct-line arrow
// running left-to-right — the stacked-bars variant read as a hamburger menu in
// the header's top-left slot.
const logoSvg = `
<svg width="72" height="72" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="60" height="60" rx="14" fill="#171b30" stroke="#2c3254" stroke-width="2"/>
  <rect x="11" y="13" width="8" height="38" rx="3" fill="${BRAND.primary}"/>
  <rect x="28" y="13" width="8" height="10" rx="3" fill="${BRAND.primaryDim}"/>
  <rect x="28" y="41" width="8" height="10" rx="3" fill="${BRAND.primaryDim}"/>
  <rect x="45" y="13" width="8" height="38" rx="3" fill="${BRAND.primary}"/>
  <path d="M20 32 L34 32" stroke="${BRAND.accent}" stroke-width="5.5" stroke-linecap="round"/>
  <path d="M31.5 25.5 L40.5 32 L31.5 38.5" fill="none" stroke="${BRAND.accent}" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

export default function ogTemplate(props: OgTemplateProps): string {
  const rawSiteName = props.siteName ?? 'cdkd';
  const siteName = escapeHtml(rawSiteName);
  const rawTitle = props.title ?? 'cdkd';
  // Compare unescaped values — the escaped siteName would never match a raw
  // title containing & < >.
  const isHome = rawTitle === rawSiteName || rawTitle === 'cdkd';
  const displayTitle = isHome ? 'Deploy CDK apps directly. Skip CloudFormation.' : rawTitle;
  // Measure BEFORE escaping — entities like &amp; would inflate the length
  // and spuriously shrink the font.
  const titleIsLong = displayTitle.length > 60;
  const title = escapeHtml(displayTitle);
  const description = escapeHtml(props.description ?? '');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 1200px; height: 630px; }
  body {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    padding: 72px 84px;
    background: linear-gradient(135deg, ${BRAND.background} 0%, ${BRAND.backgroundEdge} 100%);
    color: ${BRAND.text};
    font-family: 'Helvetica Neue', Arial, sans-serif;
  }
  .brand { display: flex; align-items: center; gap: 20px; }
  .brand-name { font-size: 40px; font-weight: 800; letter-spacing: -0.02em; }
  .title {
    font-size: ${titleIsLong ? 52 : 64}px;
    font-weight: 800;
    line-height: 1.12;
    letter-spacing: -0.02em;
    max-width: 1000px;
  }
  .description {
    margin-top: 24px;
    font-size: 28px;
    line-height: 1.4;
    color: ${BRAND.muted};
    max-width: 980px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .footer { display: flex; justify-content: space-between; align-items: baseline; }
  .domain { font-size: 28px; font-weight: 700; color: ${BRAND.accent}; letter-spacing: 0.02em; }
  .site { font-size: 24px; color: ${BRAND.muted}; }
</style>
</head>
<body>
  <div class="brand">${logoSvg}<span class="brand-name">${siteName}</span></div>
  <div>
    <div class="title">${title}</div>
    ${description && !isHome ? `<div class="description">${description}</div>` : ''}
  </div>
  <div class="footer">
    <span class="domain">cdkd.dev</span>
    <span class="site">Deploy AWS CDK apps without CloudFormation</span>
  </div>
</body>
</html>`;
}
