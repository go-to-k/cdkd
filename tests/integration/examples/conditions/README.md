# CloudFormation Conditions Example

This example demonstrates how to use CloudFormation Conditions with cdkd.

## Purpose

Implement key CloudFormation Conditions features and test how cdkd handles them:

- **CfnParameter**: Modify stack behavior based on user input
- **CfnCondition**: Define conditional expressions (Fn::Equals, Fn::And, etc.)
- **Fn::If**: Modify resource properties based on conditions
- **Conditional Resource Creation**: Control the creation of entire resources based on conditions

## Stack Configuration

This stack includes the following resources:

### Parameters
- `Environment`: Environment type (Development or Production)
- `EnableVersioning`: Whether to enable bucket versioning

### Conditions
- `IsProduction`: Whether the environment is Production
- `ShouldEnableVersioning`: Whether to enable versioning
- `ProductionWithVersioning`: Production and Versioning enabled

### Resources
1. **BasicBucket**: Basic S3 bucket that is always created
2. **ProductionBucket**: S3 bucket created only when `IsProduction` condition is true
   - Conditional bucket name
   - Conditional versioning configuration

### Outputs
- `BasicBucketName`: Name of the basic bucket
- `ProductionBucketName`: Name of the production bucket (conditional)
- `VersioningStatus`: Versioning status
- `EnvironmentType`: Environment type

## Features Tested in cdkd

This example tests the following cdkd features:

1. **Parameter Processing**
   - CfnParameter parsing and management
   - Parameter value change detection

2. **Condition Evaluation**
   - Evaluation of conditional expressions (Fn::Equals, Fn::And)
   - Building dependency graphs for conditions

3. **Conditional Resource Management**
   - Resource creation/deletion based on conditions
   - Resource state updates when conditions change

4. **Conditional Properties**
   - Conditional property configuration using Fn::If
   - JSON Patch generation based on conditions

## Deployment Instructions

### Prerequisites
```bash
cd tests/integration/examples/conditions
npm install
npm run build
```

### Deploy in Development Environment
```bash
cdkd deploy --parameters Environment=Development,EnableVersioning=false
```

### Deploy in Production Environment
```bash
cdkd deploy --parameters Environment=Production,EnableVersioning=true
```

### Update by Changing Parameters
```bash
# Change from Development to Production
cdkd deploy --parameters Environment=Production,EnableVersioning=false

# Enable versioning
cdkd deploy --parameters Environment=Production,EnableVersioning=true
```

## Current Limitations

**Important**: This example is created to demonstrate future feature enhancements for cdkd. **CloudFormation Conditions are not fully supported in the current cdkd implementation.**

Current limitations:
- ❌ CfnCondition evaluation engine not implemented
- ❌ Fn::If conditional property resolution not implemented
- ❌ Conditional resource creation/deletion logic not implemented
- ❌ Condition re-evaluation on parameter changes not implemented

This example is provided for the following purposes:
1. Demonstrate CloudFormation Conditions usage patterns
2. Reference specification for future implementation
3. Foundation for integration tests (after implementation)

## Planned cdkd Extensions

Features required for this example to work fully:

### 1. Condition Evaluation Engine
```typescript
// src/cloudformation/condition-evaluator.ts
class ConditionEvaluator {
  evaluateCondition(condition: CfnCondition, parameters: Map<string, any>): boolean
  evaluateFnIf(fnIf: FnIf, conditionResult: boolean): any
}
```

### 2. Parameter Management
```typescript
// src/state/parameter-store.ts
class ParameterStore {
  getCurrentValues(): Map<string, any>
  detectChanges(newValues: Map<string, any>): ParameterChange[]
}
```

### 3. Conditional Resource Management
```typescript
// src/deployment/conditional-resource-manager.ts
class ConditionalResourceManager {
  shouldCreateResource(resource: Resource, conditions: Condition[]): boolean
  handleConditionChange(resource: Resource, oldValue: boolean, newValue: boolean): Action
}
```

## Expected Behavior

After implementation is complete, this example should behave as follows:

1. **Initial Deployment (Development)**
   - BasicBucket is created
   - ProductionBucket is not created
   - Versioning is disabled

2. **Change to Production Environment**
   - BasicBucket remains unchanged
   - ProductionBucket is newly created
   - The correct resource set is determined by condition evaluation

3. **Enable Versioning**
   - Versioning configuration is added to both buckets
   - Properties are updated with JSON Patch

## Related Documentation

- [CloudFormation Conditions](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/conditions-section-structure.html)
- [CloudFormation Intrinsic Functions](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/intrinsic-function-reference.html)
- [AWS CDK Conditions](https://docs.aws.amazon.com/cdk/v2/guide/conditions.html)
