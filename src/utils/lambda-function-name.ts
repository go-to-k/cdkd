/**
 * The function NAME a Lambda `FunctionName` value addresses, when that value
 * spells it as an UNQUALIFIED full ARN (`arn:<partition>:lambda:<region>:<account>:function:<name>`)
 * or partial ARN (`<account>:function:<name>`); any other string is returned
 * unchanged (issue #4118). A qualified ARN keeps its qualifier, so it is NOT
 * reduced. A LEAF.
 */
export function canonicalLambdaFunctionName(value: string): string {
  const full = /^arn:[^:]+:lambda:[^:]+:\d{12}:function:([^:]+)$/.exec(value);
  if (full) return full[1]!;
  const partial = /^\d{12}:function:([^:]+)$/.exec(value);
  if (partial) return partial[1]!;
  return value;
}
