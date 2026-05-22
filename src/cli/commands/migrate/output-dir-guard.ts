import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LocalMigrateError } from '../../../utils/error-handler.js';

/**
 * Refuse to run `cdkd migrate` when the upstream `cdk migrate` would
 * write its output into an existing non-empty directory. `cdk migrate`
 * itself silently overwrites in that case; cdkd surfaces the collision
 * up-front with the exact recovery command so the user is not left
 * with a half-overwritten CDK app.
 *
 * Behavior matrix (`outputPath = <user-supplied dir>`, `stackName =
 * <CFn stack name>`; cdk writes to `<outputPath>/<stackName>`):
 *  - target dir does not exist                      → OK
 *  - target dir exists but is empty                 → OK (treated as fresh)
 *  - target path is a file, not a directory         → typed error
 *  - target dir exists and contains entries         → typed error with
 *                                                    the canonical
 *                                                    `rm -rf` recovery
 *                                                    command in the
 *                                                    message
 *
 * The parent `outputPath` is NOT checked — `cdk migrate` creates
 * `<outputPath>` itself if missing, so a non-existent parent is fine.
 */
export function assertOutputDirAvailable(outputPath: string, stackName: string): void {
  const targetDir = resolve(outputPath, stackName);

  if (!existsSync(targetDir)) {
    return; // brand-new path — `cdk migrate` will mkdir
  }

  const stat = statSync(targetDir);
  if (!stat.isDirectory()) {
    throw new LocalMigrateError(
      `Output path '${targetDir}' exists but is not a directory. ` +
        `Remove it (or pass --output-dir <NEW_PATH>) and retry:\n` +
        `  rm -f ${targetDir} && cdkd migrate --from-cfn-stack ${stackName}`
    );
  }

  // `readdirSync` on an empty directory returns `[]`. We treat an empty
  // existing directory as "fresh" — `cdk migrate` re-uses it without
  // complaint, and forcing the user to `rm -rf` an empty dir would be
  // a paper cut.
  const entries = readdirSync(targetDir);
  if (entries.length === 0) {
    return;
  }

  // Non-empty: refuse with the canonical recovery command. Naming a
  // sample entry helps users debug whether the dir was populated by
  // a prior cdkd run or by something unrelated.
  const samplePath = join(targetDir, entries[0]!);
  throw new LocalMigrateError(
    `Output dir '${targetDir}' already exists and is non-empty (e.g. '${samplePath}'); ` +
      `remove it or pass --output-dir <NEW_PATH>:\n` +
      `  rm -rf ${targetDir} && cdkd migrate --from-cfn-stack ${stackName}`
  );
}
