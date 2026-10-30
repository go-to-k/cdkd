import { describe, it, expect } from 'vite-plus/test';
import { cfnRefValueFromPhysicalId } from '../../../src/deployment/intrinsic-resolver/ref-values.js';

/**
 * Issue #5540 — CloudFormation's `Ref` for an `AWS::AppSync::GraphQLSchema` is
 * `<apiId>GraphQLSchema` (measured on a live stack, 2026-10-30), while cdkd's
 * physical id is the bare API id.
 */
describe('Ref of an AWS::AppSync::GraphQLSchema (issue #5540)', () => {
  const API = '627snwwdmzgabjos5zwo76psmy';

  it("renders cdkd's bare API id as CloudFormation's <apiId>GraphQLSchema", () => {
    expect(cfnRefValueFromPhysicalId('AWS::AppSync::GraphQLSchema', API)).toBe(
      `${API}GraphQLSchema`
    );
  });

  it('passes a record already holding the suffix (migrated before #5364) through unchanged', () => {
    expect(cfnRefValueFromPhysicalId('AWS::AppSync::GraphQLSchema', `${API}GraphQLSchema`)).toBe(
      `${API}GraphQLSchema`
    );
  });

  it('leaves the GraphQLApi Ref alone', () => {
    expect(cfnRefValueFromPhysicalId('AWS::AppSync::GraphQLApi', API)).toBe(API);
  });
});
