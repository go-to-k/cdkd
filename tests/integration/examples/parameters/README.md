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

## Deploy

```bash
# Install packages
npm install

# Deploy with cdkq
node ../../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --state-bucket <your-state-bucket> \
  --region us-east-1 \
  --verbose
```

## Verified Features

- [x] Parameters section is correctly parsed
- [x] `{ Ref: 'BucketPrefix' }` is resolved to the parameter value
- [x] Default values are correctly applied
- [x] Bucket name is created in the format `<prefix>-bucket`
- [x] Versioning settings are applied according to the parameter
