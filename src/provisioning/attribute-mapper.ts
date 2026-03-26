/**
 * Attribute Mapper for Cloud Control API
 *
 * Maps Cloud Control API ResourceModel property names to CloudFormation
 * Fn::GetAtt compatible attribute names.
 *
 * The CC API often returns properties with different names than what
 * CloudFormation uses for GetAtt. For example, DynamoDB's CC API returns
 * "TableArn" but CloudFormation's Fn::GetAtt expects "Arn".
 */

/**
 * Mapping from CC API property name → GetAtt attribute name
 */
type AttributeAliasMap = Record<string, string>;

/**
 * Registry of attribute alias mappings per resource type.
 *
 * Keys: CC API property names (as returned in ResourceModel JSON)
 * Values: CloudFormation GetAtt attribute names
 *
 * When a CC API property name already matches the GetAtt name, it should
 * still be listed here so it is explicitly copied into the attributes object.
 */
const ATTRIBUTE_ALIAS_REGISTRY: Record<string, AttributeAliasMap> = {
  'AWS::DynamoDB::Table': {
    TableArn: 'Arn',
    TableId: 'TableId',
    StreamArn: 'StreamArn',
  },

  'AWS::Lambda::Function': {
    FunctionArn: 'Arn',
    FunctionName: 'FunctionName',
  },

  'AWS::SQS::Queue': {
    QueueArn: 'Arn',
    QueueUrl: 'QueueUrl',
  },

  'AWS::SNS::Topic': {
    TopicArn: 'TopicArn',
  },

  'AWS::S3::Bucket': {
    Arn: 'Arn',
    DomainName: 'DomainName',
    RegionalDomainName: 'RegionalDomainName',
    WebsiteURL: 'WebsiteURL',
    DualStackDomainName: 'DualStackDomainName',
  },

  'AWS::Lambda::EventSourceMapping': {
    Id: 'Id',
  },

  'AWS::DynamoDB::GlobalTable': {
    Arn: 'Arn',
    StreamArn: 'StreamArn',
    TableId: 'TableId',
  },

  'AWS::Events::Rule': {
    Arn: 'Arn',
  },

  'AWS::StepFunctions::StateMachine': {
    Arn: 'Arn',
    StateMachineName: 'Name',
  },

  'AWS::Logs::LogGroup': {
    Arn: 'Arn',
  },

  'AWS::KMS::Key': {
    Arn: 'Arn',
    KeyId: 'KeyId',
  },

  'AWS::EC2::SecurityGroup': {
    GroupId: 'GroupId',
    VpcId: 'VpcId',
  },

  'AWS::EC2::VPC': {
    VpcId: 'VpcId',
    CidrBlock: 'CidrBlock',
    DefaultNetworkAcl: 'DefaultNetworkAcl',
    DefaultSecurityGroup: 'DefaultSecurityGroup',
  },

  'AWS::EC2::Subnet': {
    SubnetId: 'SubnetId',
    AvailabilityZone: 'AvailabilityZone',
  },

  'AWS::ECS::Cluster': {
    Arn: 'Arn',
  },

  'AWS::ECS::Service': {
    ServiceArn: 'ServiceArn',
    Name: 'Name',
  },

  'AWS::ApiGateway::RestApi': {
    RestApiId: 'RestApiId',
    RootResourceId: 'RootResourceId',
  },

  'AWS::ApiGateway::Deployment': {
    DeploymentId: 'DeploymentId',
  },

  'AWS::ApiGateway::Stage': {
    // Stage name is used as physical ID; no additional aliases needed
  },
};

/**
 * Map Cloud Control API ResourceModel properties to GetAtt-compatible attributes.
 *
 * For resource types that have a known alias mapping, this function extracts
 * the relevant properties from the CC API response and returns them with
 * CloudFormation-compatible attribute names.
 *
 * For unknown resource types, all CC API properties are passed through as-is
 * so that GetAtt can still work when the property name happens to match.
 *
 * @param resourceType  AWS resource type (e.g. "AWS::DynamoDB::Table")
 * @param ccApiProperties  Parsed ResourceModel from CC API response
 * @returns Mapped attributes object with GetAtt-compatible names
 */
export function mapAttributes(
  resourceType: string,
  ccApiProperties: Record<string, unknown>
): Record<string, unknown> {
  const aliasMap = ATTRIBUTE_ALIAS_REGISTRY[resourceType];

  if (!aliasMap) {
    // No explicit mapping – return all properties as-is so that callers
    // can still resolve GetAtt when the CC API property name matches.
    return { ...ccApiProperties };
  }

  const mapped: Record<string, unknown> = {};

  for (const [ccApiName, getAttName] of Object.entries(aliasMap)) {
    if (ccApiName in ccApiProperties && ccApiProperties[ccApiName] !== undefined) {
      mapped[getAttName] = ccApiProperties[ccApiName];
    }
  }

  return mapped;
}

/**
 * Check whether a resource type has an explicit attribute alias mapping.
 */
export function hasAttributeMapping(resourceType: string): boolean {
  return resourceType in ATTRIBUTE_ALIAS_REGISTRY;
}

/**
 * Get the alias map for a resource type (mainly for testing).
 */
export function getAttributeAliasMap(resourceType: string): AttributeAliasMap | undefined {
  return ATTRIBUTE_ALIAS_REGISTRY[resourceType];
}
