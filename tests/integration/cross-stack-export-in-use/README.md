# cross-stack-export-in-use

A producer deploy that changes or removes an export a consumer still imports
via `Fn::ImportValue` is refused before any resource change, as CloudFormation
refuses it ([#6088](https://github.com/go-to-k/cdkd/issues/6088)). The same
change deployed together with its consumer (`deploy --all`) goes through,
including the "deadly embrace" case where the consumer drops its reference and
the producer drops the resource in one run.

Before that deploy, `cdkd diff` over the producer and its consumer previews the
consumer against the producer's new exports
([#6796](https://github.com/go-to-k/cdkd/issues/6796)): a consumer parameter
named after the imported queue name is listed by `--fail-on destructive` as
replaced.

Run: `/run-integ cross-stack-export-in-use`
