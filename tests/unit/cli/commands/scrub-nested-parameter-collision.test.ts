/**
 * `cdkd scrub` of a nested child withdraws a literal-spelled parameter's #4644
 * spelling exactly where the deploy does (issue
 * [#4731](https://github.com/go-to-k/cdkd/issues/4731)): when one child
 * resource reads it beside a same-plaintext sibling. Otherwise scrub would
 * rewrite the child's records with the literal's tokens while the next deploy
 * diffs against the survivor.
 *
 * Drives the REAL resolver through `scrubStack`'s nested-child entry and reads
 * the withdrawal off the very bag scrub was handed. The control (the two reads
 * in DIFFERENT resources) keeps the spelling, so the case reads the call.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import {
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactInheritedParameterValue,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../../src/deployment/secret-redaction.js';

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:scrub4731::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:scrub4731:AWSCURRENT:}}';
const SHARED = 'sh4red-scrub-4731';
const SPELLING = `postgres://plainuser:${EXPR_A}@host`;
const CONN = `postgres://plainuser:${SHARED}@host`;

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function parentRow(): RecordedSecretValues {
  const parent: RecordedSecretValues = new Map();
  for (const expression of [EXPR_A, EXPR_B]) {
    parent.set(SHARED, expression);
    recordResolvedPair(parent, expression, SHARED);
  }
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: { ConnA: CONN, SecretB: SHARED } },
    { Parameters: { ConnA: SPELLING, SecretB: EXPR_B } }
  );
  return parent;
}

describe('cdkd scrub of a nested child withdraws a colliding literal spelling (#4731)', () => {
  for (const mixed of [true, false]) {
    it(`${mixed ? 'withdraws' : 'keeps'} it when ${mixed ? 'one resource reads both parameters' : 'the reads are in different resources'}`, async () => {
      const parent = parentRow();
      expect(redactInheritedParameterValue(parent, 'ConnA', CONN)).toBe(SPELLING);
      const selA = { 'Fn::Select': [0, [{ Ref: 'ConnA' }]] };
      const selB = { 'Fn::Select': [0, [{ Ref: 'SecretB' }]] };
      const template = {
        Parameters: { ConnA: { Type: 'String' }, SecretB: { Type: 'String' } },
        Resources: mixed
          ? { R: { Type: 'AWS::SSM::Parameter', Properties: { Value: selA, Description: selB } } }
          : {
              R: { Type: 'AWS::SSM::Parameter', Properties: { Value: selA } },
              S: { Type: 'AWS::SSM::Parameter', Properties: { Value: selB } },
            },
        Outputs: {},
      } as unknown as CloudFormationTemplate;
      const state: StackState = {
        version: 9,
        region: 'us-east-1',
        stackName: 'MyStack~Child',
        resources: {},
        outputs: {},
        lastModified: 0,
      } as StackState;
      await scrubStack(
        { stackName: 'MyStack~Child', template } as never,
        'us-east-1',
        {
          getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
          saveState: vi.fn().mockResolvedValue('etag-2'),
          purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
          listStacks: vi.fn().mockResolvedValue([]),
        } as never,
        {
          acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
          releaseLock: vi.fn().mockResolvedValue(undefined),
        } as never,
        {
          dryRun: true,
          logger,
          nestedChild: {
            logicalId: 'Child',
            stackName: 'MyStack~Child',
            input: { parameters: { ConnA: CONN, SecretB: SHARED }, inheritedSecrets: parent },
          },
        } as never
      );
      expect(redactInheritedParameterValue(parent, 'ConnA', CONN)).toBe(
        mixed ? redactSecretsForState(CONN, parent) : SPELLING
      );
      expect(redactSecretsForState(CONN, parent)).not.toBe(SPELLING);
    });
  }
});
