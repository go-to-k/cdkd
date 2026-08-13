import { describe, it, expect } from 'vite-plus/test';
import {
  compositeIdFormatMessage,
  COMPOSITE_ID_SEPARATOR,
  type CompositeIdFormat,
} from '../../../src/provisioning/composite-id.js';

/**
 * Issue #1657 — roughly half the composite-physicalId DECODE sites stated the
 * expected shape and half only echoed the value back. The format is documented
 * nowhere else, so on the silent half the message was the user's only possible
 * route to the answer and it did not carry it.
 */
describe('compositeIdFormatMessage (issue #1657)', () => {
  const TWO: CompositeIdFormat = {
    label: 'Glue Table',
    segments: ['databaseName', 'tableName'],
  };

  it('names the label, the expected shape and the received value', () => {
    const msg = compositeIdFormatMessage(TWO, 'MyTable', 'oops');
    expect(msg).toBe(
      'Invalid physicalId format for Glue Table MyTable: ' +
        'expected "<databaseName>|<tableName>", got "oops"'
    );
  });

  it('renders a LITERAL segment verbatim — telling the user to substitute a fixed token would be wrong', () => {
    const msg = compositeIdFormatMessage(
      { label: 'VPCGatewayAttachment', segments: [{ literal: 'IGW' }, 'vpcId'] },
      'MyAttachment',
      'bad'
    );
    expect(msg).toContain('expected "IGW|<vpcId>"');
    expect(msg).not.toContain('<IGW>');
  });

  it('joins with the module’s own separator constant, not a hardcoded pipe', () => {
    const msg = compositeIdFormatMessage(TWO, 'MyTable', 'oops');
    expect(msg).toContain(`<databaseName>${COMPOSITE_ID_SEPARATOR}<tableName>`);
  });

  it('carries a second accepted form when the type has one', () => {
    const msg = compositeIdFormatMessage(
      {
        label: 'S3 Tables Table',
        segments: ['tableBucketARN', 'namespace', 'name'],
        alsoAccepts: 'a table ARN',
      },
      'MyTbl',
      'junk'
    );
    expect(msg).toContain(
      'expected "<tableBucketARN>|<namespace>|<name>" or a table ARN, got "junk"'
    );
  });

  it('under `skipping` says the AWS resource survives and the destroy still reports success', () => {
    const msg = compositeIdFormatMessage(TWO, 'MyTable', 'oops', { skipping: true });
    expect(msg).toContain('expected "<databaseName>|<tableName>"');
    expect(msg).toContain('LEFT IN PLACE');
    expect(msg).toContain('successful');
  });

  it('the default (throw) variant carries NO skip clause', () => {
    expect(compositeIdFormatMessage(TWO, 'MyTable', 'oops')).not.toContain('LEFT IN PLACE');
    expect(compositeIdFormatMessage(TWO, 'MyTable', 'oops', { skipping: false })).not.toContain(
      'LEFT IN PLACE'
    );
  });

  it('quotes the received value so a blank / whitespace id is visible rather than vanishing', () => {
    expect(compositeIdFormatMessage(TWO, 'MyTable', '')).toContain('got ""');
    expect(compositeIdFormatMessage(TWO, 'MyTable', '  ')).toContain('got "  "');
  });

  it('handles a single-segment shape without emitting a dangling separator', () => {
    const msg = compositeIdFormatMessage({ label: 'Thing', segments: ['onlyId'] }, 'T', 'x');
    expect(msg).toContain('expected "<onlyId>"');
    expect(msg).not.toContain('|');
  });
});
