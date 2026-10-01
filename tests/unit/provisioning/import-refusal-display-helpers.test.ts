import { describe, it, expect } from 'vite-plus/test';
import {
  isPlainImportJson,
  isPlainImportValue,
  isQuotableImportValue,
  quotedRemedyLogicalId,
  remedyLogicalId,
} from '../../../src/provisioning/import-helpers.js';

/**
 * The boundary conditions of the import-refusal display helpers
 * (go-to-k/cdkd#4226) that no payload family reaches: every payload carries a
 * `$`, `;`, backtick or `'`, which the character rule refuses first, so the
 * whitespace and length arms need cases of their own.
 */
describe('import refusal display helpers', () => {
  it('isPlainImportValue refuses a value that spells displayIdent\'s own cut marker', () => {
    // 2048 plain characters and then a self-consistent cut marker: the marker
    // is 35 characters long and says 35 were withheld, so `displayIdent`
    // renders the value unchanged and only the whitespace test refuses it.
    const marker = ' [cut: 35 more characters withheld]';
    expect(marker).toHaveLength(35);
    const spoof = `${'a'.repeat(2048)}${marker}`;
    expect(isPlainImportValue(spoof)).toBe(false);
    expect(isPlainImportValue('arn:aws:sqs:us-east-1:123456789012:q')).toBe(true);
    expect(isPlainImportValue('')).toBe(false);
  });

  it('isPlainImportJson refuses a plain JSON longer than the ARN ceiling', () => {
    expect(isPlainImportJson('a'.repeat(2046))).toBe(true); // 2048 with its quotes
    expect(isPlainImportJson('a'.repeat(2047))).toBe(false);
    expect(isPlainImportJson({ Ref: 'MyBucket' })).toBe(true);
    expect(isPlainImportJson({ Ref: 'x$(touch OWNED)' })).toBe(false);
    expect(isPlainImportJson(undefined)).toBe(false);
  });

  it('isQuotableImportValue admits the separator and empty segments, nothing else new', () => {
    expect(isQuotableImportValue('mydb|')).toBe(true);
    expect(isQuotableImportValue('|t')).toBe(true);
    expect(isQuotableImportValue('')).toBe(true);
    expect(isQuotableImportValue("db|x';touch OWNED;#")).toBe(false);
    expect(isQuotableImportValue('a b|c')).toBe(false);
  });

  it('holes a logical id that is not pasteable, quoted or bare by where it sits', () => {
    expect(remedyLogicalId('MyTable')).toBe('MyTable');
    expect(remedyLogicalId("x'y")).toBe("'<logicalId>'");
    expect(quotedRemedyLogicalId('MyTable')).toBe('MyTable');
    expect(quotedRemedyLogicalId("x'y")).toBe('<logicalId>');
  });
});
