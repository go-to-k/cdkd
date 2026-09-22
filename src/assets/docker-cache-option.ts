import type { DockerCacheOption } from '../types/assets.js';

/**
 * Render a `DockerCacheOption` as the `--cache-from` / `--cache-to` value
 * BuildKit receives.
 *
 * Its own LEAF module, imported by both `docker-build.ts` (which pushes it
 * into the argv) and `manifest-passthrough-warnings.ts` (which judges it).
 * Not because those two form a cycle — `docker-build.ts` imports the warnings
 * module and not the reverse — but because the helper belongs to NEITHER: it
 * is the shared definition of what BuildKit will be handed, and keeping it in
 * the builder would make the judge import the thing it judges.
 *
 * **It is the one spelling on purpose, and the reason is a defect**
 * ([#3497](https://github.com/go-to-k/cdkd/issues/3497)): the warning layer
 * used to walk `option.params` STRUCTURALLY while the argv is this
 * concatenation, and neither `,` nor `=` is quoted here. A manifest could
 * therefore inject CSV through a field the walk did not treat as a path —
 * `type: 'local,dest=/home/victim/.ssh'` with no params at all renders
 * `--cache-to type=local,dest=/home/victim/.ssh`, a host WRITE that produced
 * no warning because `params` was empty. Judging the rendered STRING closes
 * that by construction: whatever BuildKit parses is what cdkd parsed.
 */
export function cacheOptionToFlag(option: DockerCacheOption): string {
  let flag = `type=${option.type}`;
  if (option.params) {
    for (const [k, v] of Object.entries(option.params)) {
      flag += `,${k}=${v}`;
    }
  }
  return flag;
}
