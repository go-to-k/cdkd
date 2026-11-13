// go-to-k/cdkd#5639 / #5640: the maintainer ruled these AWS::RDS::DBCluster /
// DBInstance rows out of scope for the backfill campaign (2026-11-11), because
// verifying them needs dedicated infrastructure (a Directory Service or
// self-managed Active Directory domain, an Oracle HSM key store, an Oracle
// Enterprise Edition BYOL source, RDS Custom, RDS on Outposts). They are
// declared unhandled by design so the backfill sync stops filing them, and
// they stay SDK-unwired so a template declaring one keeps its Cloud Control
// route, as before.
import { describe, it, expect } from 'vite-plus/test';

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';
import { findActionableSdkUnwired } from '../../../src/provisioning/property-coverage.js';

const CLUSTER = 'AWS::RDS::DBCluster';
const INSTANCE = 'AWS::RDS::DBInstance';

const ROWS: ReadonlyArray<readonly [string, string, string]> = [
  [CLUSTER, 'Domain', '#5639'],
  [CLUSTER, 'DomainIAMRoleName', '#5639'],
  [INSTANCE, 'Domain', '#5640'],
  [INSTANCE, 'DomainAuthSecretArn', '#5640'],
  [INSTANCE, 'DomainDnsIps', '#5640'],
  [INSTANCE, 'DomainFqdn', '#5640'],
  [INSTANCE, 'DomainIAMRoleName', '#5640'],
  [INSTANCE, 'DomainOu', '#5640'],
  [INSTANCE, 'TdeCredentialArn', '#5640'],
  [INSTANCE, 'TdeCredentialPassword', '#5640'],
  [INSTANCE, 'ReplicaMode', '#5640'],
  [INSTANCE, 'CustomIAMInstanceProfile', '#5640'],
  [INSTANCE, 'DBSystemId', '#5640'],
  [INSTANCE, 'BackupTarget', '#5640'],
];

describe('RDSProvider out-of-scope rows (go-to-k/cdkd#5639, #5640)', () => {
  const provider = new RDSProvider({ region: 'us-east-1' });

  it.each(ROWS)('%s %s is unhandled by design, naming the decision (%s)', (type, key, issue) => {
    expect(provider.handledProperties.get(type)?.has(key)).toBe(false);
    const rationale = provider.unhandledByDesign.get(type)?.get(key);
    expect(rationale).toContain(`out of scope by maintainer decision (go-to-k/cdkd${issue})`);
    expect(rationale).toContain('keeps its Cloud Control route');
  });

  it.each(ROWS)(
    '%s %s stays SDK-unwired with that rationale, so a declaring template keeps its Cloud Control route',
    (type, key, issue) => {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(type);
      expect(coverage?.handled.has(key)).toBe(false);
      expect(coverage?.sdkUnwired.get(key)).toContain(`go-to-k/cdkd${issue}`);
      // THE routing predicate: the key still drives the resource to Cloud Control.
      expect(
        findActionableSdkUnwired(type, { [key]: 'x' }, new Set()).map((d) => d.property)
      ).toEqual([key]);
    }
  );
});
