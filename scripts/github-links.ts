/**
 * Repo-relative link builders for the generated coverage matrices.
 *
 * The matrices live at the top of `docs/`, which is the published site, and
 * only `docs/` is published — so a `../tests/integration/<fixture>/` link
 * resolves to nothing on cdkd.dev. About 2,600 of them did until issue #2510.
 *
 * These exist so the host is written once rather than at each of the eight
 * emitters, and so the tree-vs-blob choice is made by the function name
 * instead of being re-decided per site.
 */

const REPO = 'https://github.com/go-to-k/cdkd';

/** A link to a DIRECTORY in the repo, e.g. a `tests/integration/<name>/`. */
export const githubTree = (repoRelativePath: string): string =>
  `${REPO}/tree/main/${repoRelativePath}`;

/** A link to a FILE in the repo, e.g. `src/provisioning/register-providers.ts`. */
export const githubBlob = (repoRelativePath: string): string =>
  `${REPO}/blob/main/${repoRelativePath}`;
