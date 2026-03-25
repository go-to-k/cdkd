import { describe, it, expect } from 'vitest';
import {
  mapAttributes,
  hasAttributeMapping,
  getAttributeAliasMap,
} from '../../../src/provisioning/attribute-mapper.js';

describe('attribute-mapper', () => {
  describe('mapAttributes', () => {
    it('should map DynamoDB TableArn to Arn', () => {
      const result = mapAttributes('AWS::DynamoDB::Table', {
        TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable',
        TableId: 'abc-123',
        TableName: 'MyTable',
      });

      expect(result['Arn']).toBe(
        'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable'
      );
      expect(result['TableId']).toBe('abc-123');
      // TableName is not in the alias map, so it should NOT appear
      expect(result['TableName']).toBeUndefined();
    });

    it('should map Lambda FunctionArn to Arn', () => {
      const result = mapAttributes('AWS::Lambda::Function', {
        FunctionArn: 'arn:aws:lambda:us-east-1:123456789012:function:MyFunc',
        FunctionName: 'MyFunc',
        Runtime: 'nodejs20.x',
      });

      expect(result['Arn']).toBe(
        'arn:aws:lambda:us-east-1:123456789012:function:MyFunc'
      );
      expect(result['FunctionName']).toBe('MyFunc');
      // Runtime is not in the alias map
      expect(result['Runtime']).toBeUndefined();
    });

    it('should map SQS QueueArn to Arn', () => {
      const result = mapAttributes('AWS::SQS::Queue', {
        QueueArn: 'arn:aws:sqs:us-east-1:123456789012:MyQueue',
        QueueUrl: 'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue',
      });

      expect(result['Arn']).toBe('arn:aws:sqs:us-east-1:123456789012:MyQueue');
      expect(result['QueueUrl']).toBe(
        'https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue'
      );
    });

    it('should map SNS TopicArn', () => {
      const result = mapAttributes('AWS::SNS::Topic', {
        TopicArn: 'arn:aws:sns:us-east-1:123456789012:MyTopic',
        TopicName: 'MyTopic',
      });

      expect(result['TopicArn']).toBe(
        'arn:aws:sns:us-east-1:123456789012:MyTopic'
      );
      // TopicName is not in the alias map
      expect(result['TopicName']).toBeUndefined();
    });

    it('should map S3 Bucket attributes', () => {
      const result = mapAttributes('AWS::S3::Bucket', {
        Arn: 'arn:aws:s3:::my-bucket',
        DomainName: 'my-bucket.s3.amazonaws.com',
        RegionalDomainName: 'my-bucket.s3.us-east-1.amazonaws.com',
        BucketName: 'my-bucket',
      });

      expect(result['Arn']).toBe('arn:aws:s3:::my-bucket');
      expect(result['DomainName']).toBe('my-bucket.s3.amazonaws.com');
      expect(result['RegionalDomainName']).toBe(
        'my-bucket.s3.us-east-1.amazonaws.com'
      );
      // BucketName is not in the alias map
      expect(result['BucketName']).toBeUndefined();
    });

    it('should skip undefined values in CC API properties', () => {
      const result = mapAttributes('AWS::DynamoDB::Table', {
        TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable',
        TableId: undefined,
        StreamArn: undefined,
      });

      expect(result['Arn']).toBe(
        'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable'
      );
      expect(result).not.toHaveProperty('TableId');
      expect(result).not.toHaveProperty('StreamArn');
    });

    it('should skip properties not present in CC API response', () => {
      const result = mapAttributes('AWS::DynamoDB::Table', {
        TableArn: 'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable',
        // TableId and StreamArn are not in the input at all
      });

      expect(result['Arn']).toBe(
        'arn:aws:dynamodb:us-east-1:123456789012:table/MyTable'
      );
      expect(result).not.toHaveProperty('TableId');
      expect(result).not.toHaveProperty('StreamArn');
    });

    it('should pass through all properties for unknown resource types', () => {
      const props = {
        SomeArn: 'arn:aws:something:us-east-1:123456789012:resource/id',
        SomeName: 'my-resource',
        NestedProp: { Key: 'Value' },
      };

      const result = mapAttributes('AWS::Some::UnknownResource', props);

      expect(result['SomeArn']).toBe(props.SomeArn);
      expect(result['SomeName']).toBe(props.SomeName);
      expect(result['NestedProp']).toEqual(props.NestedProp);
    });

    it('should return empty object when CC API properties are empty', () => {
      const result = mapAttributes('AWS::DynamoDB::Table', {});
      expect(result).toEqual({});
    });

    it('should return empty object for unknown resource type with empty properties', () => {
      const result = mapAttributes('AWS::Unknown::Thing', {});
      expect(result).toEqual({});
    });

    it('should map StepFunctions StateMachineName to Name', () => {
      const result = mapAttributes('AWS::StepFunctions::StateMachine', {
        Arn: 'arn:aws:states:us-east-1:123456789012:stateMachine:MySM',
        StateMachineName: 'MySM',
      });

      expect(result['Arn']).toBe(
        'arn:aws:states:us-east-1:123456789012:stateMachine:MySM'
      );
      expect(result['Name']).toBe('MySM');
    });

    it('should map EC2 SecurityGroup attributes', () => {
      const result = mapAttributes('AWS::EC2::SecurityGroup', {
        GroupId: 'sg-12345678',
        VpcId: 'vpc-abcdef',
        GroupDescription: 'My SG',
      });

      expect(result['GroupId']).toBe('sg-12345678');
      expect(result['VpcId']).toBe('vpc-abcdef');
      // GroupDescription is not in alias map
      expect(result['GroupDescription']).toBeUndefined();
    });
  });

  describe('hasAttributeMapping', () => {
    it('should return true for resource types with mappings', () => {
      expect(hasAttributeMapping('AWS::DynamoDB::Table')).toBe(true);
      expect(hasAttributeMapping('AWS::Lambda::Function')).toBe(true);
      expect(hasAttributeMapping('AWS::S3::Bucket')).toBe(true);
      expect(hasAttributeMapping('AWS::SQS::Queue')).toBe(true);
      expect(hasAttributeMapping('AWS::SNS::Topic')).toBe(true);
    });

    it('should return false for resource types without mappings', () => {
      expect(hasAttributeMapping('AWS::Unknown::Resource')).toBe(false);
      expect(hasAttributeMapping('AWS::Some::Thing')).toBe(false);
    });
  });

  describe('getAttributeAliasMap', () => {
    it('should return the alias map for a known resource type', () => {
      const map = getAttributeAliasMap('AWS::DynamoDB::Table');
      expect(map).toBeDefined();
      expect(map!['TableArn']).toBe('Arn');
      expect(map!['TableId']).toBe('TableId');
    });

    it('should return undefined for an unknown resource type', () => {
      const map = getAttributeAliasMap('AWS::Unknown::Resource');
      expect(map).toBeUndefined();
    });
  });
});
