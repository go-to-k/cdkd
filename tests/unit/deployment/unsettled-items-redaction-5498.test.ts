/**
 * go-to-k/cdkd#5498: an attempted item name (`ResourceState.unsettledItems`)
 * can be secret-derived — an IndexName or tag key built from a dynamic
 * reference or a `NoEcho` parameter. It is rewritten on persist (the deploy's
 * `scrubResourceRecord` pass and the `NoEcho` persist arm) and by `cdkd scrub`
 * (the same `scrubResourceRecord`), and a rewritten name never matches a live
 * item, so the item is kept, never deleted.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { applyNoEchoPersist, NoEchoRunState } from '../../../src/deployment/deploy-engine/noecho.js';
import { projectIndexesOnto } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { isUsableAttemptedName, unsettledItemsOf } from '../../../src/state/unsettled-properties.js';
import type { ResourceState } from '../../../src/types/state.js';

const EXPR = '{{resolve:secretsmanager:idx:SecretString:name::}}';
const PLAIN = 'tenant-4f9a2c7e1b';
const GSI = 'GlobalSecondaryIndexes';

const record = (names: string[]): ResourceState =>
  ({
    physicalId: 't',
    resourceType: 'AWS::DynamoDB::Table',
    properties: { TableName: 't' },
    unsettledProperties: [GSI, 'Tags'],
    unsettledItems: { [GSI]: names, Tags: [`${PLAIN}-owner`, 'team'] },
  }) as ResourceState;

const secrets = (): RecordedSecretValues => new Map([[PLAIN, EXPR]]);

describe('secret-derived attempted names (go-to-k/cdkd#5498)', () => {
  it('scrubResourceRecord rewrites a whole and an embedded secret-derived name, under every path', () => {
    const out = scrubResourceRecord(record([PLAIN, `gsi-${PLAIN}`, 'plain-gsi']), secrets());
    const json = JSON.stringify(out.unsettledItems);
    expect(json).not.toContain(PLAIN);
    expect(out.unsettledItems?.[GSI]).toContain('plain-gsi');
    expect(out.unsettledItems?.['Tags']).toContain('team');
    // Every rewritten entry is unusable as a deletion name.
    for (const name of [...out.unsettledItems![GSI]!, ...out.unsettledItems!['Tags']!]) {
      if (name !== 'plain-gsi' && name !== 'team') expect(isUsableAttemptedName(name)).toBe(false);
    }
  });

  it('a rewritten name never projects a live index of the secret\'s value onto the previous side', () => {
    const out = scrubResourceRecord(record([PLAIN]), secrets());
    const attempted = unsettledItemsOf(out).get(GSI)!;
    const live = [{ IndexName: PLAIN }, { IndexName: 'other' }];
    expect(projectIndexesOnto(live, [], [], attempted) ?? []).toEqual([]);
    // The unredacted name would have been projected: the rewrite is what stops it.
    expect(projectIndexesOnto(live, [], [], new Set([PLAIN]))).toEqual([{ IndexName: PLAIN }]);
  });

  it('scrubbing again (cdkd scrub over a persisted record) is a no-op and stays leak-free', () => {
    const once = scrubResourceRecord(record([PLAIN]), secrets());
    const twice = scrubResourceRecord(once, secrets());
    expect(twice.unsettledItems).toEqual(once.unsettledItems);
    expect(JSON.stringify(twice)).not.toContain(PLAIN);
  });

  it('a record without the field gains none', () => {
    const plain = { physicalId: 't', resourceType: 'T', properties: {} } as ResourceState;
    expect(scrubResourceRecord(plain, secrets())).not.toHaveProperty('unsettledItems');
  });

  it('the NoEcho persist arm masks a name a NoEcho parameter served, by value', () => {
    const run = new NoEchoRunState();
    run.noEchoPositionedValues.set('T', new Set([JSON.stringify('nx1')]));
    const rec = record(['nx1', 'kept']);
    const out = applyNoEchoPersist(
      run,
      { perResourceSecrets: () => new Map() } as never,
      'T',
      rec,
      rec,
      undefined,
      { T: rec }
    );
    expect(out.unsettledItems?.[GSI]).toEqual(['***', 'kept']);
    expect(JSON.stringify(out.unsettledItems)).not.toContain('nx1');
    // A record of another resource is not masked by this resource's values.
    const other = applyNoEchoPersist(
      run,
      { perResourceSecrets: () => new Map() } as never,
      'U',
      rec,
      rec,
      undefined,
      { U: rec }
    );
    expect(other.unsettledItems?.[GSI]).toEqual(['nx1', 'kept']);
  });
});
