import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import ts from 'typescript-v6';
import { describe, it, expect } from 'vite-plus/test';

import {
  isAuxiliaryFailure,
  markAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #4222: `ProvisioningError`'s third argument (and
 * `ResourceUpdateNotSupportedError`'s second) is the resource's LOGICAL id.
 * Providers passed the PHYSICAL id there, so `error.logicalId` held a live
 * resource name — secret-derivable — and the classifiers anchored on the
 * logical id (`isNameCollisionErrorFrom`, `isUpdateUnsupportedError`,
 * `markAuxiliaryFailure`) never credited the error to its own resource.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'src');

/**
 * Constructor name -> index of its logical-id parameter: the two classes, the
 * `ProvisioningError` subclasses that forward the same slot, and
 * `ResourceTimeoutError`, whose logical id is its first argument.
 */
const LOGICAL_ID_SLOT: ReadonlyMap<string, number> = new Map([
  ['ProvisioningError', 2],
  ['ResourceUpdateNotSupportedError', 1],
  ['CloudControlOperationFailedError', 2],
  ['CloudControlWaitAbandonedError', 2],
  ['HostedZoneNameNotFoundError', 2],
  ['ResourceTimeoutError', 0],
]);

/**
 * Sites still passing something other than a logical id, one entry per SITE:
 * file, constructor, the slot's argument text and the start of the message
 * argument (see {@link siteKey}). The offending set must EQUAL this list, so a
 * fixed site leaves a stale entry that fails, and a new bad site in the same
 * file cannot take a fixed one's place.
 *
 * `scheduler-schedule-provider.ts`: its two `getAttribute` sites wait for open
 * PR go-to-k/cdkd#4218, which holds that file; fix them and drop these entries
 * once it merges (go-to-k/cdkd#4222).
 */
const KNOWN_SITES: readonly string[] = [
  'src/provisioning/providers/scheduler-schedule-provider.ts | ProvisioningError | physicalId | `Unknown attribute ${attributeName} for ${resourceType}`',
  'src/provisioning/providers/scheduler-schedule-provider.ts | ProvisioningError | physicalId | `Failed to resolve Arn for Schedule ${physicalId}: ${cause?.',
];

/** A name that says it holds a logical id: `logicalId`, `ownerLogicalId`. */
const LOGICAL_ID_NAME = /(?:^l|L)ogicalId$/;

/**
 * Whether `arg` is SPELLED as a logical id. The fence is name-based, not a
 * data-flow check: a caller forwarding a physical id into a parameter named
 * `logicalId`, or a rename, passes it. Those are covered by the per-site unit
 * cases asserting `error.logicalId` / `error.physicalId`, not here.
 *
 * Accepted: a name ending in `logicalId`
 * (bare, or the last member of a property access, optional chain included),
 * optionally with a `??` / `||` fallback to a string literal. Anything else —
 * `physicalId`, a stream name, a property read — is a violation.
 */
function isLogicalIdArgument(arg: ts.Expression): boolean {
  let node: ts.Expression = arg;
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) return LOGICAL_ID_NAME.test(node.text);
  if (ts.isPropertyAccessExpression(node)) return LOGICAL_ID_NAME.test(node.name.text);
  if (
    ts.isBinaryExpression(node) &&
    (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return isLogicalIdArgument(node.left) && ts.isStringLiteralLike(node.right);
  }
  return false;
}

interface Construction {
  file: string;
  line: number;
  ctor: string;
  argument: string;
  /** The message argument's source text, whitespace collapsed, first 60 chars. */
  message: string;
  ok: boolean;
}

/** A site's identity for {@link KNOWN_SITES}; line numbers move, this does not. */
function siteKey(c: Construction): string {
  return `${c.file} | ${c.ctor} | ${c.argument} | ${c.message}`;
}

function scanSource(file: string, text: string): Construction[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Construction[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const slot = LOGICAL_ID_SLOT.get(node.expression.text);
      if (slot !== undefined) {
        const arg = node.arguments?.[slot];
        out.push({
          file,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          ctor: node.expression.text,
          argument: arg ? arg.getText(sf) : '<missing>',
          message: (node.arguments?.[0]?.getText(sf) ?? '').replace(/\s+/g, ' ').slice(0, 60),
          ok: arg !== undefined && !ts.isSpreadElement(arg) && isLogicalIdArgument(arg),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTs(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('the logical-id slot of ProvisioningError / ResourceUpdateNotSupportedError (#4222)', () => {
  const constructions = listTs(SRC_ROOT).flatMap((path) =>
    scanSource(relative(REPO_ROOT, path).split('\\').join('/'), readFileSync(path, 'utf8'))
  );

  it('scans the real population, not an empty one', () => {
    // Literal floors, not read from the scan: a walk that stopped finding the
    // constructions (a renamed class, a moved directory) fails here instead of
    // passing on nothing.
    expect(constructions.length).toBeGreaterThanOrEqual(800);
    expect(constructions.filter((c) => c.ctor === 'ResourceUpdateNotSupportedError').length)
      .toBeGreaterThanOrEqual(20);
    // Every other constructor in the map is reached at least once, so a
    // renamed subclass drops out loudly.
    for (const ctor of LOGICAL_ID_SLOT.keys()) {
      expect({ ctor, found: constructions.some((c) => c.ctor === ctor) }).toEqual({
        ctor,
        found: true,
      });
    }
    expect(
      constructions.filter((c) => c.file.startsWith('src/provisioning/providers/')).length
    ).toBeGreaterThanOrEqual(700);
  });

  it('every construction passes a logical id there, outside the known sites', () => {
    const unexpected = constructions
      .filter((c) => !c.ok && !KNOWN_SITES.includes(siteKey(c)))
      .map((c) => `${c.file}:${c.line} new ${c.ctor}(..., ${c.argument}, ...)`);
    expect(unexpected).toEqual([]);
  });

  it('each known site is still there, exactly once (a stale entry fails)', () => {
    const offending = constructions.filter((c) => !c.ok).map(siteKey);
    for (const site of KNOWN_SITES) {
      expect({ site, count: offending.filter((k) => k === site).length }).toEqual({
        site,
        count: 1,
      });
    }
  });

  it('the classifier accepts the logical-id spellings in use and refuses the rest', () => {
    const verdicts = (source: string): boolean[] =>
      scanSource('probe.ts', source).map((c) => c.ok);
    expect(
      verdicts(`
        new ProvisioningError('m', t, logicalId);
        new ProvisioningError('m', t, ownerLogicalId, physicalId);
        new ProvisioningError('m', t, args.logicalId);
        new ProvisioningError('m', t, ctx?.logicalId);
        new ProvisioningError('m', t, options?.logicalId ?? '');
        new ProvisioningError('m', t, (logicalId));
        new ResourceUpdateNotSupportedError(t, logicalId, 'hint');
      `)
    ).toEqual([true, true, true, true, true, true, true]);
    expect(
      verdicts(`
        new ProvisioningError('m', t, physicalId);
        new ProvisioningError('m', t, physicalId, physicalId);
        new ProvisioningError('m', t, streamName);
        new ProvisioningError('m', t, props.Name);
        new ProvisioningError('m', t, logicalIdFor(x));
        new ProvisioningError('m', t, logicalId ?? physicalId);
        new ProvisioningError('m', t, physicalId ?? '');
        new ProvisioningError('m', t, logicalIdPrefix);
        new CloudControlOperationFailedError('m', t, physicalId, physicalId, code, 'CREATE');
        new ResourceTimeoutError(physicalId, t, region, 1, 'CREATE', 2);
        new ProvisioningError('m', t);
        new ProvisioningError('m', t, ...rest);
        new ResourceUpdateNotSupportedError(t, physicalId);
      `)
    ).toEqual(Array.from({ length: 13 }, () => false));
  });
});

describe('isAuxiliaryFailure requires the mark, not only its suffix (#4222)', () => {
  // A physical id can end in a `/auxiliary` path segment (an SSM parameter
  // name, a log group, an IAM path). In a `ProvisioningError`'s logical-id slot
  // it is an ordinary enumerable field, never the marker's read-only one.
  const TYPE = 'AWS::SSM::Parameter';

  it('requires the suffix too: a read-only, non-enumerable id without it is no mark', () => {
    for (const value of ['Owner', 'Owner/auxiliary/x']) {
      const sdk = new Error('already exists');
      const link = Object.defineProperty({ cause: sdk }, 'logicalId', {
        value,
        enumerable: false,
        writable: false,
        configurable: true,
      });
      expect(isAuxiliaryFailure(link)).toBe(false);
      markAuxiliaryFailure(link, 'Owner');
      expect(Object.getOwnPropertyDescriptor(sdk, 'logicalId')?.value).toBe('Owner/auxiliary');
    }
  });

  it('does not read a physical id ending in /auxiliary as a mark', () => {
    const error = new ProvisioningError('x', TYPE, '/app/prod/auxiliary');
    expect(isAuxiliaryFailure(error)).toBe(false);
    expect(isAuxiliaryFailure({ logicalId: 'Owner/auxiliary' })).toBe(false);
  });

  it('requires BOTH halves of the shape: non-enumerable and read-only', () => {
    const withShape = (enumerable: boolean, writable: boolean): object =>
      Object.defineProperty({}, 'logicalId', {
        value: 'Owner/auxiliary',
        enumerable,
        writable,
        configurable: true,
      });
    expect(isAuxiliaryFailure(withShape(false, true))).toBe(false);
    expect(isAuxiliaryFailure(withShape(true, false))).toBe(false);
    expect(isAuxiliaryFailure(withShape(false, false))).toBe(true);
  });

  it('marks the link beneath such an error instead of stopping at it', () => {
    const sdk = new Error('already exists');
    const error = new ProvisioningError('x', TYPE, '/app/prod/auxiliary', undefined, sdk);
    markAuxiliaryFailure(error, 'Owner');
    expect(Object.getOwnPropertyDescriptor(sdk, 'logicalId')?.value).toBe('Owner/auxiliary');
    expect(error.logicalId).toBe('/app/prod/auxiliary');
    expect(isAuxiliaryFailure(error)).toBe(true);
  });

  it('still reads a real mark, and marking stays idempotent', () => {
    const marked = markAuxiliaryFailure(new Error('y'), 'Owner');
    expect(isAuxiliaryFailure(marked)).toBe(true);
    const wrapper = { logicalId: 'Outer', cause: marked };
    markAuxiliaryFailure(wrapper, 'Other');
    expect(Object.getOwnPropertyDescriptor(marked, 'logicalId')?.value).toBe('Owner/auxiliary');
  });
});

describe('withRetry marks a replay with a fixed owner, never its label (#4222)', () => {
  // A 5xx attempt arms the latch; the next failure is then marked auxiliary.
  // A label can carry a physical name (`<table name> (<dimension>)`, or an
  // all-alphanumeric table name no spelling test tells from a logical id), and
  // the mark is the one `logicalId` `maskSecretsInError` copies verbatim.
  const serverFault = (): Error =>
    Object.assign(new Error('We encountered an internal error.'), {
      name: 'InternalFailure',
      $metadata: { httpStatusCode: 500 },
    });
  const markOf = async (label: string): Promise<unknown> => {
    let calls = 0;
    const error = await withRetry(
      () => {
        calls++;
        return Promise.reject(calls === 1 ? serverFault() : new Error('already exists'));
      },
      label,
      { sleep: () => Promise.resolve() }
    ).catch((e: unknown) => e);
    expect(calls).toBe(2);
    return Object.getOwnPropertyDescriptor(error, 'logicalId')?.value;
  };

  it.each(['MyTable', 'orders', 'prod-db-password-table (ReadCapacity)', 'my-policy-name', ''])(
    'label %j marks as withRetry/auxiliary',
    async (label) => {
      expect(await markOf(label)).toBe('withRetry/auxiliary');
    }
  );
});
