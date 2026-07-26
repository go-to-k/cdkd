import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactManifest, MetadataEntry } from '../types/assembly.js';
import { SynthesisError } from '../utils/error-handler.js';
import type { StackInfo } from './assembly-reader.js';

/**
 * Minimal logger surface `processStackMessages` needs — structurally
 * satisfied by both `getLogger()` and its `child()` loggers.
 */
interface MessageLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/**
 * Behavior knobs for {@link processStackMessages} (issue #1230) — mirrors
 * the CDK CLI's `validateMetadataFailAt()` three-state resolution:
 * default fails on errors only; `--ignore-errors` fails on nothing;
 * `--strict` fails on warnings too. When both flags are set, strict wins
 * (same precedence as the CDK CLI, which applies `ignoreErrors` first and
 * then lets `strict` overwrite it).
 */
export interface StackMessageOptions {
  /** `--strict`: also fail when any warning annotation exists. */
  strict?: boolean;

  /** `--ignore-errors`: display messages but never fail the run. */
  ignoreErrors?: boolean;
}

/**
 * Severity of a CDK annotation message (`Annotations.of(x).addError/addWarning/addInfo`).
 */
export type StackMessageLevel = 'error' | 'warning' | 'info';

/**
 * A single CDK annotation message attached to a construct path.
 */
export interface StackMessage {
  level: StackMessageLevel;

  /** Construct path the message was attached to (e.g. "/MyStack/MyBucket") */
  path: string;

  message: string;
}

/**
 * Cloud-assembly metadata entry types that carry annotation messages.
 * See `ArtifactMetadataEntryType` in aws-cdk-lib's cloud-assembly-schema.
 */
const MESSAGE_ENTRY_TYPES: Record<string, StackMessageLevel> = {
  'aws:cdk:error': 'error',
  'aws:cdk:warning': 'warning',
  'aws:cdk:info': 'info',
};

/**
 * Collect annotation messages (`aws:cdk:error` / `aws:cdk:warning` /
 * `aws:cdk:info`) for one stack artifact.
 *
 * Two on-disk layouts exist and BOTH must be read (issue #1228):
 * - Older aws-cdk-lib embeds entries inline in the artifact's `metadata`
 *   field in `manifest.json`.
 * - Current aws-cdk-lib writes them to a side file
 *   `<artifactId>.metadata.json` referenced by the artifact's
 *   `additionalMetadataFile` field (see `collectStackMetadata` in
 *   aws-cdk-lib `core/lib/stack-synthesizers/_shared.js`), keeping
 *   `manifest.json` itself slim.
 *
 * A referenced-but-unreadable side file throws: the assembly is torn, and
 * silently continuing could hide an error annotation that must block deploy.
 */
export function collectStackMessages(
  assemblyDir: string,
  artifact: ArtifactManifest
): StackMessage[] {
  const merged: Record<string, MetadataEntry[]> = { ...(artifact.metadata ?? {}) };

  if (artifact.additionalMetadataFile) {
    const metadataPath = join(assemblyDir, artifact.additionalMetadataFile);
    let sideFile: Record<string, MetadataEntry[]>;
    try {
      sideFile = JSON.parse(readFileSync(metadataPath, 'utf-8')) as Record<string, MetadataEntry[]>;
      if (sideFile === null || typeof sideFile !== 'object' || Array.isArray(sideFile)) {
        throw new Error('expected a JSON object mapping construct paths to metadata entry arrays');
      }
      for (const [path, entries] of Object.entries(sideFile)) {
        if (!Array.isArray(entries)) {
          throw new Error(`entry for path '${path}' is not an array`);
        }
        merged[path] = [...(merged[path] ?? []), ...entries];
      }
    } catch (error) {
      throw new SynthesisError(
        `Failed to read stack metadata file ${metadataPath}: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined
      );
    }
  }

  const messages: StackMessage[] = [];
  for (const [path, entries] of Object.entries(merged)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const type = entry?.type ?? '';
      const level = Object.hasOwn(MESSAGE_ENTRY_TYPES, type)
        ? MESSAGE_ENTRY_TYPES[type]
        : undefined;
      if (!level) continue;
      messages.push({
        level,
        path,
        message:
          typeof entry.data === 'string'
            ? entry.data
            : entry.data === undefined
              ? ''
              : JSON.stringify(entry.data),
      });
    }
  }
  return messages;
}

/**
 * Print annotation messages for the given stacks and fail per the CDK
 * CLI's rules (issues #1228 / #1230): every message is displayed at its
 * level (`[Error|Warning|Info at /path] message`); by default any error
 * annotation aborts with `Found errors`, `--strict` additionally aborts
 * on warnings with `Found warnings (--strict mode)`, and
 * `--ignore-errors` never aborts. Errors win over strict warnings when
 * both exist (CDK CLI parity).
 *
 * Call AFTER stack selection so an error in a non-selected stack does not
 * block the selected ones (same selection-awareness as the #1150 deferred
 * macro expansion).
 */
export function processStackMessages(
  stacks: StackInfo[],
  logger: MessageLogger,
  options: StackMessageOptions = {}
): void {
  let hasErrors = false;
  let hasWarnings = false;

  for (const stack of stacks) {
    for (const msg of stack.messages ?? []) {
      switch (msg.level) {
        case 'warning':
          hasWarnings = true;
          logger.warn(`[Warning at ${msg.path}] ${msg.message}`);
          break;
        case 'info':
          logger.info(`[Info at ${msg.path}] ${msg.message}`);
          break;
        case 'error':
          hasErrors = true;
          logger.error(`[Error at ${msg.path}] ${msg.message}`);
          break;
      }
    }
  }

  // CDK CLI failAt resolution: 'error' by default, 'none' under
  // --ignore-errors, 'warn' under --strict (strict overwrites ignore).
  const failAt: 'error' | 'none' | 'warn' = options.strict
    ? 'warn'
    : options.ignoreErrors
      ? 'none'
      : 'error';

  if (hasErrors && failAt !== 'none') {
    throw new SynthesisError('Found errors');
  }
  if (hasWarnings && failAt === 'warn') {
    throw new SynthesisError('Found warnings (--strict mode)');
  }
}
