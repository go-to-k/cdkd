/**
 * The producer-region evidence a parent hands its nested children, and the
 * region-less secret test a replay on INCOMPLETE evidence refuses by
 * (go-to-k/cdkd#4174).
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  getCurrentProducerRegions,
  inheritProducerRegions,
  withProducerRegions,
} from '../../../src/deployment/producer-regions-scope.js';
import {
  classifyReplaySecretRegion,
  regionLessSecretName,
} from '../../../src/deployment/secret-region-classification.js';

describe('inheritProducerRegions', () => {
  it("unions the child's own regions first with the parent's, deduplicated case-insensitively", () => {
    expect(
      inheritProducerRegions(['eu-west-1', 'EU-WEST-1'], {
        regions: ['Eu-West-1', 'us-west-2', 'us-west-2'],
        complete: true,
      })
    ).toEqual({ regions: ['eu-west-1', 'us-west-2'], complete: true });
  });

  it('is incomplete when the parent evidence is absent or incomplete', () => {
    expect(inheritProducerRegions(['eu-west-1'], undefined)).toEqual({
      regions: ['eu-west-1'],
      complete: false,
    });
    expect(inheritProducerRegions([], { regions: ['us-west-2'], complete: false })).toEqual({
      regions: ['us-west-2'],
      complete: false,
    });
  });

  it('keeps the FIRST spelling of a region, mixed case included', () => {
    expect(
      inheritProducerRegions(['US-West-2'], { regions: ['us-west-2', 'eu-west-1'], complete: true })
    ).toEqual({ regions: ['US-West-2', 'eu-west-1'], complete: true });
  });

  it('skips an empty region string', () => {
    expect(inheritProducerRegions(['', 'eu-west-1'], { regions: [''], complete: true })).toEqual({
      regions: ['eu-west-1'],
      complete: true,
    });
  });
});

describe('withProducerRegions', () => {
  it('binds the getter for the async chain and nests by shadowing', async () => {
    const outer = () => ({ regions: ['a'], complete: true });
    const inner = () => ({ regions: ['b'], complete: false });
    expect(getCurrentProducerRegions()).toBeUndefined();
    await withProducerRegions(outer, async () => {
      await Promise.resolve();
      expect(getCurrentProducerRegions()).toBe(outer);
      await withProducerRegions(inner, async () => {
        expect(getCurrentProducerRegions()).toBe(inner);
      });
      expect(getCurrentProducerRegions()).toBe(outer);
    });
    expect(getCurrentProducerRegions()).toBeUndefined();
  });
});

describe('regionLessSecretName', () => {
  const ARN = 'arn:aws:secretsmanager:eu-west-1:111122223333:secret:prod/db-AbCdEf';
  const cases: Array<[string, string | undefined]> = [
    ['{{resolve:secretsmanager:prod/db:SecretString:password}}', 'prod/db'],
    ['{{resolve:secretsmanager:prod/db}}', 'prod/db'],
    ['{{resolve:ssm:/app/pw}}', '/app/pw'],
    ['{{resolve:ssm-secure:/app/pw:3}}', '/app/pw:3'],
    [`{{resolve:secretsmanager:${ARN}:SecretString:password}}`, undefined],
    ['{{resolve:ssm:arn:aws:ssm:us-west-2:111122223333:parameter/db/pw}}', undefined],
    ['{{resolve:ssm}}', undefined],
    ['{{resolve:ssm-secure}}', undefined],
    ['{{resolve:unknownservice:x}}', undefined],
    ['plain', undefined],
  ];

  it.each(cases)('%s -> %s', (expression, expected) => {
    expect(regionLessSecretName(expression)).toBe(expected);
  });

  it('names exactly the references the classifier calls ambiguous once a foreign region is on record', () => {
    for (const [expression] of cases) {
      const verdict = classifyReplaySecretRegion(expression, 'us-east-1', ['ap-south-1']);
      expect(verdict.kind === 'ambiguous').toBe(regionLessSecretName(expression) !== undefined);
    }
  });
});
