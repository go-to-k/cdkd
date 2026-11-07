/**
 * The whole property bags of the resource whose property a conditional
 * predicate judges, for a rule whose answer depends on a SIBLING property
 * (issue #5446: an `AWS::EC2::Instance` `SecurityGroupIds` change replaces the
 * instance only when it has no `SubnetId`). Absent where the caller judges a
 * value outside a diff; a predicate then answers for the common case.
 */
export interface ReplacementSiblings {
  readonly oldProperties: Readonly<Record<string, unknown>>;
  readonly newProperties: Readonly<Record<string, unknown>>;
}

export type ConditionalReplacement = (
  oldValue: unknown,
  newValue: unknown,
  siblings?: ReplacementSiblings
) => boolean;

/**
 * Resource replacement rule
 */
export interface ReplacementRule {
  /** Properties that always require replacement when changed */
  replacementProperties: Set<string>;
  /** Properties that never require replacement */
  updateableProperties?: Set<string>;
  /** Custom logic for conditional replacement */
  conditionalReplacements?: Map<string, ConditionalReplacement>;
}
