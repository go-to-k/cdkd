/**
 * CloudFormation template structure
 */
export interface CloudFormationTemplate {
  AWSTemplateFormatVersion?: string;
  Description?: string;
  Parameters?: Record<string, TemplateParameter>;
  Resources: Record<string, TemplateResource>;
  Outputs?: Record<string, TemplateOutput>;
  Conditions?: Record<string, unknown>;
  Mappings?: Record<string, unknown>;
  /**
   * Top-level `Transform` declaration. CloudFormation macros (`Transform:
   * 'AWS::Serverless-2016-10-31'`, `Transform: ['AWS::LanguageExtensions',
   * 'CustomMacro']`, etc.). cdkd detects this at synthesis time and runs a
   * CFn round-trip via `src/synthesis/macro-expander.ts` to obtain the
   * post-expansion template before passing it to the analyzer / provisioner
   * pipeline — see `docs/design/463-cfn-macros.md`. The post-expansion
   * template has this field stripped (CFn does not surface it in the
   * Processed-stage GetTemplate response when every transform expanded).
   */
  Transform?: unknown;
  Rules?: Record<string, unknown>;
}

/**
 * CloudFormation template parameter
 */
export interface TemplateParameter {
  Type: string;
  Default?: unknown;
  Description?: string;
  AllowedValues?: unknown[];
  AllowedPattern?: string;
  ConstraintDescription?: string;
  /**
   * CFn's "this value is sensitive" declaration — masked in every place
   * CloudFormation echoes the value. cdkd honors it by redacting the value
   * in `--verbose` debug logs (issue #1329).
   * A boolean, or the string `"true"` (go-to-k/cdkd#4824): read it with
   * `isNoEchoDeclared`, never `=== true`.
   */
  NoEcho?: boolean | string;
}

/**
 * CloudFormation template resource
 */
export interface TemplateResource {
  Type: string;
  Properties?: Record<string, unknown>;
  DependsOn?: string | readonly string[];
  Condition?: string;
  Metadata?: Record<string, unknown>;
  CreationPolicy?: Record<string, unknown>;
  UpdatePolicy?: Record<string, unknown>;
  DeletionPolicy?: 'Delete' | 'Retain' | 'Snapshot';
  UpdateReplacePolicy?: 'Delete' | 'Retain' | 'Snapshot';
}

/**
 * CloudFormation template output
 */
export interface TemplateOutput {
  Value: unknown;
  Description?: string;
  /**
   * Name of a template `Conditions` entry gating this output. CFn only
   * creates the output when the condition evaluates true; the deploy
   * engine's `resolveOutputs` mirrors that by skipping condition-false
   * outputs (issue #1028).
   */
  Condition?: string;
  Export?: {
    Name: string;
  };
}
