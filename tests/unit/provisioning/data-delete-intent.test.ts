import { describe, it, expect } from 'vite-plus/test';
import {
  ECR_AUTO_DELETE_IMAGES_TAG,
  S3_AUTO_DELETE_OBJECTS_TAG,
  hasCdkAutoDeleteTag,
  isTruthyCfnBoolean,
} from '../../../src/provisioning/data-delete-intent.js';

describe('hasCdkAutoDeleteTag', () => {
  it('matches the canonical CDK tag shape (string "true" and boolean true)', () => {
    expect(
      hasCdkAutoDeleteTag(
        { Tags: [{ Key: S3_AUTO_DELETE_OBJECTS_TAG, Value: 'true' }] },
        S3_AUTO_DELETE_OBJECTS_TAG
      )
    ).toBe(true);
    expect(
      hasCdkAutoDeleteTag(
        { Tags: [{ Key: ECR_AUTO_DELETE_IMAGES_TAG, Value: true }] },
        ECR_AUTO_DELETE_IMAGES_TAG
      )
    ).toBe(true);
  });

  it('rejects falsy or foreign tag values', () => {
    expect(
      hasCdkAutoDeleteTag(
        { Tags: [{ Key: S3_AUTO_DELETE_OBJECTS_TAG, Value: 'false' }] },
        S3_AUTO_DELETE_OBJECTS_TAG
      )
    ).toBe(false);
    expect(
      hasCdkAutoDeleteTag({ Tags: [{ Key: 'unrelated', Value: 'true' }] }, S3_AUTO_DELETE_OBJECTS_TAG)
    ).toBe(false);
  });

  it('tolerates malformed Tags shapes without throwing', () => {
    expect(hasCdkAutoDeleteTag(undefined, S3_AUTO_DELETE_OBJECTS_TAG)).toBe(false);
    expect(hasCdkAutoDeleteTag({}, S3_AUTO_DELETE_OBJECTS_TAG)).toBe(false);
    expect(hasCdkAutoDeleteTag({ Tags: 'not-an-array' }, S3_AUTO_DELETE_OBJECTS_TAG)).toBe(false);
    expect(hasCdkAutoDeleteTag({ Tags: { Key: 'x' } }, S3_AUTO_DELETE_OBJECTS_TAG)).toBe(false);
    expect(
      hasCdkAutoDeleteTag({ Tags: [null, 42, 'str', {}] }, S3_AUTO_DELETE_OBJECTS_TAG)
    ).toBe(false);
  });
});

describe('isTruthyCfnBoolean', () => {
  it('accepts true and the CFn string form only', () => {
    expect(isTruthyCfnBoolean(true)).toBe(true);
    expect(isTruthyCfnBoolean('true')).toBe(true);
    expect(isTruthyCfnBoolean(false)).toBe(false);
    expect(isTruthyCfnBoolean('false')).toBe(false);
    expect(isTruthyCfnBoolean('TRUE')).toBe(false);
    expect(isTruthyCfnBoolean(1)).toBe(false);
    expect(isTruthyCfnBoolean(undefined)).toBe(false);
  });
});
