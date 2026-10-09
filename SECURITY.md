# Security Policy

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab
2. Click **Report a vulnerability**
3. Fill in the details (affected version, reproduction steps, impact)

This opens a private channel with the maintainer. You can also reach the
maintainer through the contact links on their GitHub profile if you prefer.

## What to Expect

- An acknowledgment as soon as possible (typically within a few days)
- An assessment of the report and, if confirmed, a remediation plan shared
  with you before any public disclosure
- Credit in the published security advisory (and a CVE where applicable),
  unless you prefer to remain anonymous

## Supported Versions

cdkd is intended for dev/test workflows and is early in development. Only the
latest released version receives security fixes.

## Scope Notes

cdkd deploys AWS resources with the caller's AWS credentials and stores
deployment state in the caller's own S3 bucket. Reports about the handling
of sensitive data in state files, logs, or CLI output are in scope and
welcome.

In scope:

- A secret (a `NoEcho` parameter, a `{{resolve:...}}` dynamic reference, a
  value derived from one) reaching state, logs, CLI output, deployment events
  or an exports index in plaintext, except as listed below.
- Terminal control characters or escape sequences from a template, resource,
  state or AWS value reaching the terminal unstripped.
- A secret or credential placed on a child process's command line, left on
  disk, or handed to a process or container that does not need it.
- cdkd itself passing an untrusted value to a shell or a child process, or
  resolving a file path outside where it belongs.
- A local emulator's authorizer or signature check accepting a request AWS
  would reject.
- Deletion or modification of a resource cdkd does not own, or deleting one it
  does own without the snapshot or retention the template asks for.

Out of scope:

- **A value cdkd prints that would run if an operator copied the line into a
  shell.** The values in question — logical ids, stack names, physical ids,
  state keys, AWS error text — come from the operator's own CDK app (which
  already runs arbitrary code at synth), the operator's own state bucket
  (whose writers can already make cdkd change any resource), or a principal
  in the account who can already change the deployed resources directly. The
  attack also needs the operator to paste a crafted line. The AWS CDK CLI
  prints the same values as-is.
- **A value the template does not name through a `NoEcho` parameter or a
  `{{resolve:...}}` reference, recorded in state as AWS returned it.** This
  covers a secret an operator set out of band (for example over a placeholder
  literal) and one AWS returns in a field the template does not set. cdkd's
  drift baseline records what AWS holds, by design, so `state.json` is
  sensitive by construction; see
  [A value your template never references](docs/import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it).
  This does not cover a credential a provider records in `attributes` so that
  `Fn::GetAtt` can read it (an `AWS::IAM::AccessKey`'s `SecretAccessKey`, a
  Cognito user pool client's `ClientSecret`), nor a `NoEcho` parameter's value,
  nor a custom resource's `NoEcho` `Data`; reports of those remain welcome.
- **A physical name derived from a secret, recorded in state and in what
  carries it.** A `{{resolve:...}}` reference or a
  `NoEcho` parameter used in a name or other identifier property becomes the
  resource's identity. This covers that name in the resource's `physicalId`,
  and the name, or an identifier embedding it, wherever a resolved `Ref`,
  `Fn::GetAtt` or `Fn::Sub` carries it into another resource's record, a stack
  output or the exports index — and commands that print a stored record as it
  is, such as `cdkd state show`. CloudFormation uses the plaintext value in the
  primary identifier the same way and
  [advises against it](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/dynamic-references.html);
  see [Security and Best Practices](docs/state-management.md#security-and-best-practices).
  This does not cover the resource's own `properties`, `attributes` or
  `observedProperties`, a different secret read through the same resource, or
  the name unmasked in any other CLI output, logs or deployment events;
  reports of those remain welcome.
