import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import type { Logger } from '../../../types/config.js';
import { CdkdError } from '../../../utils/error-handler.js';
import type { BootstrapMarker } from '../../../assets/asset-storage.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import {
  listAllStateKeys,
  parseStateKey,
  isPasteableIdent,
  STATE_KEY_MAX_CODE_POINTS,
  STATE_FILE_SUFFIX,
  DEFAULT_STATE_PREFIX,
} from '../state-file-keys.js';
import { displayIdent, displaySafe, safeMsg, UNRENDERABLE } from '../../../utils/display-safe.js';
import { pasteableCommand } from '../../../utils/pasteable-command.js';
import { accountArgs, withheldAccountClause } from '../../../state/malformed-resources-bag.js';
import { collectAssetReferences, type AssetReferences } from './asset-references.js';

/**
 * Scan every state file in the state bucket and collect the referenced
 * asset keys / image tags / digests for the marker's bucket + repo.
 *
 * Fail safe: a state file that fails to JSON-parse aborts the whole run —
 * a reference we could not read is a reference we would otherwise delete.
 * A state key that disappeared between the listing and the read (destroy
 * completed concurrently) is skipped: its references are legitimately gone.
 */
export async function scanReferencedAssets(
  stateBackend: Pick<S3StateBackend, 'listRawKeys' | 'getRawObject'>,
  marker: BootstrapMarker,
  logger: Logger,
  /**
   * The run's `--profile` and the state bucket this scan reads (go-to-k/cdkd#4648),
   * for the corrupt-record inspect command. The PREFIX comes from the key the
   * record was found at ({@link keyPrefixOf}): this command takes no
   * `--state-prefix` and lists the whole bucket.
   */
  account: { profile?: string | undefined; stateBucket: string }
): Promise<AssetReferences> {
  const refs: AssetReferences = {
    s3Keys: new Set(),
    imageTags: new Set(),
    imageDigests: new Set(),
  };
  const stateKeys = await listAllStateKeys(stateBackend);
  logger.info(`Scanning ${stateKeys.length} state file(s) for asset references...`);
  for (const key of stateKeys) {
    const body = await stateBackend.getRawObject(key);
    if (body === null) {
      logger.debug(
        `State file ${displayIdent(key, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })} disappeared during the scan — skipping`
      );
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      // Issue go-to-k/cdkd#3179 section C. This builds a command we TELL THE
      // OPERATOR TO RUN out of an S3 key nobody validated, so it gets two
      // things the previous version had neither of.
      //
      // The parts come from `parseStateKey` rather than from a regex over
      // `describeStateKey`'s rendered output. That re-parse read its own
      // display string, so it could not survive the display string being
      // sanitised — and it was already wrong: `\S` excludes `\r`, so a planted
      // carriage return took the no-match branch and put the ENTIRE rendered
      // string, control characters and all, where the stack name goes.
      //
      // And the command is offered ONLY when both parts are pasteable. A name
      // outside that set is not quoted into the command, because quoting does
      // not fix the case this is really about: every character of
      // `--state-bucket=attacker` survives `displaySafe`, so it renders EXACTLY
      // — and it is still an option when pasted, silently pointing the
      // inspection at another bucket. `isPasteableIdent` is what refuses it
      // (the leading `-`, and the `=`). When either part fails, the operator
      // gets the KEY — which is what they need to find the object anyway.
      const { stack, region } = parseStateKey(key, STATE_FILE_SUFFIX, DEFAULT_STATE_PREFIX);
      const pasteable =
        isPasteableIdent(stack) && (region === undefined || isPasteableIdent(region));
      // Built by the SHARED gate since go-to-k/cdkd#3436's fold-in, and printed
      // on a labelled line rather than inside the sentence's `'...'`. This site
      // is why the fence keys on a SHAPE: before the fold-in its own gate was
      // `isPasteableIdent` alone, it never called `pasteableCommand`, and it
      // carried no ` with: ` label — so NEITHER of go-to-k/cdkd#3436's two
      // derivation greps returned it, and it was found by reading.
      //
      // `isPasteableIdent` stays IN CONJUNCTION with the shared gate rather
      // than being replaced by it, because it is the STRICTER of the two: the
      // gate's exactness admits `=`, a space and a quote (each renders exactly
      // and each reshapes a pasted line or splits a flag value), and
      // `isPasteableIdent` refuses them. The gate refuses the leading `-`
      // too; dropping the stricter predicate here would be changing a
      // security predicate while moving a string.
      // The account flags (go-to-k/cdkd#4648): the run's `--profile`, the bucket
      // this scan read, and the prefix the record was FOUND under -- `cdkd gc`
      // takes no `--state-prefix` and scans every prefix, so the key is the
      // only source. A key the parse cannot reproduce gives no prefix, and the
      // command then names none (`accountArgs` omits an absent prefix).
      const recovery = {
        ...account,
        statePrefix: keyPrefixOf(key, stack, region),
      };
      const inspectHint = pasteable
        ? pasteableCommand('cdkd state show', [
            ...(region === undefined
              ? [{ value: stack, hole: 'stack' }]
              : [
                  { value: stack, hole: 'stack' },
                  { flag: '--stack-region', value: region, hole: 'region' },
                ]),
            ...accountArgs(recovery),
          ]).command
        : undefined;
      // Profile and bucket holes take the shared sentence ("the value you passed
      // this run"); a PREFIX hole cannot, since this command takes no
      // `--state-prefix`: its value is part of the KEY (go-to-k/cdkd#4648 review).
      const accountClause =
        inspectHint === undefined
          ? ''
          : [
              withheldAccountClause(
                { ...recovery, statePrefix: undefined },
                'the command below prints'
              ).trimEnd(),
              keyPrefixHoleSentence(recovery.statePrefix),
            ]
              .filter((part) => part !== '')
              .join(' ');
      // The KEY is an S3 key too, so it is sanitised on its own account — it is
      // named here whether or not a command could be offered.
      const inspect =
        inspectHint === undefined
          ? `its stack name is not safe to paste into a command, so inspect the ` +
            `object at that key directly`
          : `see the command below`;
      logger.debug(
        safeMsg`State file ${displayIdent(key, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })} failed to parse: ${displaySafe(describeAwsFailure(error).detail, { asciiOnly: true }) || UNRENDERABLE}`
      );
      throw new CdkdError(
        `State file ${displayIdent(key, { maxCodePoints: STATE_KEY_MAX_CODE_POINTS })} is not valid JSON — aborting: gc must know every ` +
          `referenced asset before deleting anything, and this file's references ` +
          `are unreadable. Repair or remove the corrupt state file ` +
          `(${inspect}), then re-run.` +
          (accountClause === '' ? '' : ` ${accountClause}`) +
          (inspectHint === undefined ? '' : `\nInspect it with: ${inspectHint}`),
        'GC_STATE_UNREADABLE'
        // NO `cause`, deliberately (issue #5247): V8's `SyntaxError` quotes a
        // window of this state body, which before `cdkd scrub` holds plaintext
        // values, and `formatError` prints a cause on its `Caused by:` line.
        // V8's text goes to `debug` only, below.
      );
    }
    collectAssetReferences(parsed, marker, refs);
  }
  logger.debug(
    `Referenced: ${refs.s3Keys.size} S3 key(s), ${refs.imageTags.size} image tag(s), ` +
      `${refs.imageDigests.size} image digest(s)`
  );
  return refs;
}

/**
 * The prefix a state `key` was found under, given the `stack` / `region` its
 * parse produced: what is left once `/{stack}[/{region}]/state.json` is taken
 * off the end (go-to-k/cdkd#4648). `undefined` when the key does not end that
 * way, so no prefix is claimed for a key the parse could not reproduce.
 */
function keyPrefixOf(key: string, stack: string, region: string | undefined): string | undefined {
  const tail = `/${stack}${region === undefined ? '' : `/${region}`}/${STATE_FILE_SUFFIX.replace(/^\//, '')}`;
  return key.endsWith(tail) ? key.slice(0, -tail.length) : undefined;
}

/**
 * The sentence for a key-derived prefix the shared gate printed as a hole, or
 * `''` when it named it (or there is none). Says where the value comes from:
 * the printed KEY, since `cdkd gc` has no `--state-prefix` to repeat.
 */
function keyPrefixHoleSentence(prefix: string | undefined): string {
  const withheld = pasteableCommand('cdkd', accountArgs({ statePrefix: prefix })).withheld;
  const reason = withheld.find((w) => w.hole === 'prefix')?.reason;
  if (reason === undefined) return '';
  const why =
    reason === 'option-shaped'
      ? `begins with a '-'`
      : reason === 'altered'
        ? 'does not render exactly'
        : reason === 'too-long'
          ? 'is too long to print'
          : prefix !== undefined && prefix.includes('/')
            ? `has a '/'-separated part that is not a plain identifier`
            : 'is not a plain identifier';
  return (
    `The state prefix of the key above ${why}, so the command below prints '<prefix>' in its ` +
    `place: replace it whole, quotes included, with that prefix shell-quoted -- the part of ` +
    `the key before '/<stack>/<region>/state.json' ('/<stack>/state.json' for a legacy key), ` +
    `since 'cdkd gc' takes no --state-prefix.`
  );
}
