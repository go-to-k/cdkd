import { describe, it, expect } from 'vite-plus/test';
import {
  SECRET_MASK,
  createUnionSecretMasker,
  maskRecordedSecretsInText,
  maskSecretsInText,
} from '../../../src/deployment/secret-redaction.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction/log-only.js';
import { safeMsg } from '../../../src/utils/display-safe.js';

// go-to-k/cdkd#2676: a log line is built with `safeMsg` at its call site and
// masked at the logger sink AFTER that, so a secret carrying a newline or a
// tab reaches the printing masker only in its flattened spelling. Each printing
// masker matches that spelling too; the persist-side detector does not.
describe('the printing maskers match a needle in its safeMsg-flattened spelling (#2676)', () => {
  const secret = '-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34\tGkx\n-----END KEY-----';
  const expr = '{{resolve:secretsmanager:pem:SecretString:key}}';
  const line = safeMsg`Failed to create Fn: Value '${secret}' at 'Key' failed`;

  it('the line really is flattened, so the raw needle no longer occurs in it', () => {
    expect(line).not.toContain('\n');
    expect(line).not.toContain(secret);
  });

  it('maskSecretsInText masks the flattened spelling (map needle)', () => {
    const masked = maskSecretsInText(line, new Map([[secret, expr]]));
    expect(masked).toBe(`Failed to create Fn: Value '${SECRET_MASK}' at 'Key' failed`);
  });

  it('maskSecretsInText masks the flattened spelling (log-only needle)', () => {
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, secret);
    expect(maskSecretsInText(line, bag)).toBe(
      `Failed to create Fn: Value '${SECRET_MASK}' at 'Key' failed`
    );
  });

  it('createUnionSecretMasker masks the flattened spelling, and still masks the raw one', () => {
    const mask = createUnionSecretMasker([new Map([[secret, expr]])]);
    expect(mask(line)).toBe(`Failed to create Fn: Value '${SECRET_MASK}' at 'Key' failed`);
    expect(mask(`raw: ${secret}`)).toBe(`raw: ${SECRET_MASK}`);
  });

  it('the persist-side detector does not match a spelling the value does not hold', () => {
    expect(maskRecordedSecretsInText(line, new Map([[secret, expr]]))).toBe(line);
  });

  it('a control-only secret adds no flattened needle that would mask runs of spaces', () => {
    const controlOnly = '\n\t\n\t\n';
    const text = safeMsg`indented     text ${'x'}`;
    expect(maskSecretsInText(text, new Map([[controlOnly, expr]]))).toBe(text);
    expect(createUnionSecretMasker([new Map([[controlOnly, expr]])])(text)).toBe(text);
  });

  it('a needle safeMsg leaves unchanged adds no second spelling', () => {
    const plain = 'plain-secret-value';
    expect(maskSecretsInText(`a ${plain} b`, new Map([[plain, expr]]))).toBe(`a ${SECRET_MASK} b`);
  });
});
