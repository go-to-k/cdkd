/**
 * go-to-k/cdkd#7061: the marker arms of the drift readers that no behavioural
 * test reached, each pinned in the direction a wrong answer would take. The
 * rollback and drift readers now ask `secret-redaction/recorded-secrecy.ts`;
 * these cases fail if one of those questions is answered the other way.
 */
import { describe, expect, it } from 'vite-plus/test';
import type { PropertyDrift } from '../../../src/analyzer/drift-calculator.js';
import {
  acceptRefusalReason,
  partitionNoEchoParameterChanges,
  partitionUncertifiedBaselineChanges,
  redactDriftChanges,
} from '../../../src/cli/commands/drift/redaction.js';
import { overlayLiveAtUncertifiedPaths } from '../../../src/cli/commands/drift/revert-live-values.js';
import { keepRecordedAttributesOverMask } from '../../../src/cli/commands/drift/revert-payload.js';
import { resolveStateSecretExpressions } from '../../../src/cli/commands/drift/secret-resolution.js';
import type { ResourceState } from '../../../src/types/state.js';

const LIVE_SECRET = 'live-plaintext-held-by-aws';

describe('drift readers: marker arms (go-to-k/cdkd#7061)', () => {
  it('redactDriftChanges masks the live value of a change whose state side IS the mask, with no other evidence', () => {
    // No resolved secret, no secret path, no mask path: the state side's mask is
    // the only thing that says the position is secret. Read the other way, the
    // live plaintext is reported and `--accept` may write it.
    const changes: PropertyDrift[] = [{ path: 'Data', stateValue: '***', awsValue: LIVE_SECRET }];
    const out = redactDriftChanges(changes, new Map(), new Set(), new Set());
    expect(JSON.stringify(out.changes)).not.toContain(LIVE_SECRET);
    expect(out.maskedPaths.has('Data')).toBe(true);
  });

  it('partitionNoEchoParameterChanges splits off only a change whose state side holds the mask', () => {
    const record = {
      resourceType: 'Custom::Thing',
      physicalId: 'p',
      properties: { Param: 'same-value' },
      noEchoLeaves: [['Param']],
    } as unknown as ResourceState;
    const changes: PropertyDrift[] = [
      { path: 'Param', stateValue: 'same-value', awsValue: 'same-value' },
    ];
    const out = partitionNoEchoParameterChanges(changes, record, { Param: 'same-value' });
    expect(out.noEchoParameterPaths).toEqual([]);
    expect(out.kept).toEqual(changes);
  });

  it('partitionUncertifiedBaselineChanges splits off only a change whose state side holds the mask', () => {
    const properties = { Password: '{{resolve:secretsmanager:db:SecretString:pw}}' };
    const changes: PropertyDrift[] = [
      { path: 'Password', stateValue: 'same-value', awsValue: 'same-value' },
    ];
    const out = partitionUncertifiedBaselineChanges(changes, properties, { Password: 'same-value' });
    expect(out.uncertifiedPaths).toEqual([]);
    expect(out.kept).toEqual(changes);
  });

  it('acceptRefusalReason names the masked BASELINE only when the state side is the mask', () => {
    const reason = acceptRefusalReason(
      { path: 'Password', stateValue: 'resolved-old', awsValue: 'rotated-new' },
      new Set(['Password'])
    );
    expect(reason).toContain('dynamic reference');
    expect(reason).not.toContain('redaction mask');
  });

  it('overlayLiveAtUncertifiedPaths registers the live value at the mask only, not its plain siblings', () => {
    const baseline = { Config: { Token: '***', Name: 'ordinary-sibling-name' } };
    const aws = { Config: { Token: LIVE_SECRET, Name: 'ordinary-sibling-name' } };
    const secrets = new Map<string, string>();
    overlayLiveAtUncertifiedPaths(
      { Config: { Token: '***', Name: 'ordinary-sibling-name' } },
      ['Config'],
      aws,
      baseline,
      secrets,
      new Set(['Config'])
    );
    expect([...secrets.keys()]).toContain(LIVE_SECRET);
    expect([...secrets.keys()]).not.toContain('ordinary-sibling-name');
  });

  it('keepRecordedAttributesOverMask never puts a recorded plaintext back over a value the redaction embedded a mask in', () => {
    // `arn:***` holds no WHOLE mask leaf, so the key is not one this pass may
    // restore from the record: the redacted value stands.
    const out = keepRecordedAttributesOverMask(
      { Arn: 'arn:aws:x:***' },
      { Arn: 'arn:aws:x:secret-tail' },
      { Arn: 'arn:aws:x:secret-tail' },
      undefined
    );
    expect(out['Arn']).toBe('arn:aws:x:***');
  });

  it('resolveStateSecretExpressions returns a bag with no reference as-is, touching no resolver', async () => {
    const props = { Name: 'plain', Nested: { List: ['a', 'b'] }, Count: 3 };
    // No resolver is usable here: reaching one throws.
    const resolvers = new Proxy(
      {},
      {
        get() {
          throw new Error('a resolver was reached');
        },
      }
    ) as Parameters<typeof resolveStateSecretExpressions>[1];
    await expect(resolveStateSecretExpressions(
        props,
        resolvers,
        new Map(),
        {} as Parameters<typeof resolveStateSecretExpressions>[3]
      )).resolves.toBe(props);
  });
});
