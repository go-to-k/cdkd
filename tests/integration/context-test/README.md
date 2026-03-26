# Context Test Example

Tests context value passing via two mechanisms:

1. **cdk.json context** - `env` and `featureFlag` defined in `cdk.json` under `context`
2. **CLI `--context` / `-c` option** - Override context values at deploy time

## Default behavior (cdk.json context)

```bash
cdkd deploy ContextTestStack
```

- `env` = `"from-cdk-json"`
- `featureFlag` = `"false"` (FeatureParam SSM parameter is NOT created)

## CLI context override

```bash
cdkd deploy ContextTestStack -c env=staging -c featureFlag=true
```

- `env` = `"staging"` (overrides cdk.json value)
- `featureFlag` = `"true"` (FeatureParam SSM parameter IS created)

## Resources

- S3 Bucket (always created)
- SSM Parameter `/cdkd-test/context/ContextTestStack/env` (always created, value from context)
- SSM Parameter `/cdkd-test/context/ContextTestStack/feature` (conditionally created when `featureFlag=true`)
