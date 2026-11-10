// go-to-k/cdkd#5639: `DBSystemId` on AWS::RDS::DBCluster is unhandled by
// design and stays SDK-unwired, so a template declaring it keeps its Cloud
// Control route: the CloudFormation schema documents it as "Reserved for
// future use." (create-only; DescribeType, us-east-1, 2026-11-07), so there is
// no behaviour to wire. (`WithExpressConfiguration`, its sibling here until
// go-to-k/cdkd#5984, is wired: rds-dbcluster-express-writer-5984.test.ts.)
import { describe, it, expect } from 'vite-plus/test';

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

const CLUSTER = 'AWS::RDS::DBCluster';

describe('RDSProvider DBCluster unhandled-by-design rows (go-to-k/cdkd#5639)', () => {
  const provider = new RDSProvider({ region: 'us-east-1' });

  it.each([
    ['DBSystemId', /reserved for future use/],
  ])('%s is unhandled by design, naming its measured premise', (key, reason) => {
    expect(provider.handledProperties.get(CLUSTER)?.has(key)).toBe(false);
    expect(provider.unhandledByDesign.get(CLUSTER)?.get(key)).toMatch(reason);
  });

  it.each([
    ['DBSystemId', /reserved for future use/],
  ])(
    '%s stays SDK-unwired with that reason, so a declaring template keeps its Cloud Control route',
    (key, reason) => {
      expect(PROPERTY_COVERAGE_BY_TYPE.get(CLUSTER)?.sdkUnwired.get(key)).toMatch(reason);
      expect(PROPERTY_COVERAGE_BY_TYPE.get(CLUSTER)?.handled.has(key)).toBe(false);
    }
  );
});
