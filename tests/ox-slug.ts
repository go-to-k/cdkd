/**
 * The published site's heading slugger, and the fence-stripper its callers
 * need — shared so there is ONE implementation.
 *
 * Ox Content (`vite.docs.config.ts`) renders `docs/**`, and its
 * heading-permalink ids are NOT GitHub's: every non-alphanumeric RUN collapses
 * to a single hyphen, and leading hyphens are dropped, so
 * `## \`--pin-cc-api\` (deploy)` is `#pin-cc-api-deploy` where GitHub would
 * keep both dashes. The rules here are derived from ids read off the BUILT
 * site, and `docs-site-links.test.ts` pins them against those ids so a plugin
 * upgrade that changes the algorithm fails there rather than silently 404ing
 * every anchor.
 *
 * It lives here rather than beside one of its callers because a second copy is
 * the failure mode: two hand-written sluggers agree until one is corrected,
 * and the one that is not corrected then generates links the other blesses.
 */

/**
 * Drop fenced code blocks, so a `#` inside a shell snippet is never read as a
 * heading and a `](#anchor)` inside an example is never read as a link.
 */
export const stripFences = (src: string): string => {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of src.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]!.startsWith(fence[0]!) && m[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (m) {
      fence = m[1]!;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
};

/**
 * The id Ox Content gives a heading — e.g. "Teardown (`cdkd bootstrap
 * --destroy`, issue #1010)" → "teardown-cdkd-bootstrap-destroy-issue-1010",
 * "`--no-wait`" → "no-wait", "pre-v0.94.0" → "pre-v0-94-0".
 */
export const oxSlug = (heading: string): string =>
  heading
    // Inline markdown links contribute their TEXT to the site's id, not their
    // URL: "Bounded growth (issue [#885](https://...))" renders as
    // id="bounded-growth-issue-885" (read off the built site).
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
