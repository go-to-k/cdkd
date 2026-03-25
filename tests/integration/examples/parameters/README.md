# Parameters Example

An example using CloudFormation Parameters.

## Configuration

This stack includes the following:

- **Parameters**:
  - `BucketPrefix`: Prefix for S3 bucket name (default: "cdkq-test")
  - `EnableVersioning`: Flag to enable versioning (default: "false")

- **Resources**:
  - **S3 Bucket**: Uses the prefix and versioning settings specified in parameters

## Features Tested in cdkq

1. **Parameters Section**: Processing the Parameters section in CloudFormation templates
2. **Ref (Parameters)**: Referencing parameter values with `{ Ref: 'BucketPrefix' }`
3. **Parameter Default Values**: Using default values
4. **Parameter Validation**: Validation such as minLength, maxLength, allowedValues

## Required Implementation

To make this example work with cdkq, the following implementation is required:

1. **Parameters Section Parsing**: Recognize Parameters in the template
2. **Ref Extension**: Support references to Parameters, not just resources
3. **Default Value Resolution**: Use default values when parameter values are not specified
4. **Parameter Value Injection**: Retrieve parameter values from CLI options or configuration files

## Deploy (Not Implemented)

```bash
# Install packages
npm install

# Deploy with cdkq (after Parameters support is implemented)
node ../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --parameters BucketPrefix=my-test,EnableVersioning=true \
  --verbose
```

## Test Points

- [ ] Parameters section is correctly parsed
- [ ] `{ Ref: 'BucketPrefix' }` is resolved to the parameter value
- [ ] Default values are correctly applied
- [ ] Parameter values can be injected from CLI
- [ ] Bucket name is created in the format `<prefix>-bucket`
- [ ] Versioning settings are applied according to the parameter

## Current Limitations

**This example does not work with the current cdkq implementation.** The following features are not yet implemented:

- Support for CloudFormation Parameters section
- Ref resolution to Parameters
- Specifying parameter values via CLI

Test after implementation.
