import { describe, it, expect } from 'vite-plus/test';
import {
  toSdkConfigurations,
  toSdkInstanceTypeConfigs,
  toSdkStepConfigs,
} from '../../../src/provisioning/emr-configuration.js';

describe('toSdkConfigurations (issue #1383)', () => {
  it('renames ConfigurationProperties to the SDK Properties member', () => {
    expect(
      toSdkConfigurations([
        {
          Classification: 'spark-defaults',
          ConfigurationProperties: { 'spark.executor.memory': '4g' },
        },
      ])
    ).toEqual([
      { Classification: 'spark-defaults', Properties: { 'spark.executor.memory': '4g' } },
    ]);
  });

  it('renames at EVERY nesting level of Configurations', () => {
    expect(
      toSdkConfigurations([
        {
          Classification: 'hadoop-env',
          ConfigurationProperties: { TOP: '1' },
          Configurations: [
            {
              Classification: 'export',
              ConfigurationProperties: { JAVA_HOME: '/usr/lib/jvm' },
              Configurations: [
                { Classification: 'deep', ConfigurationProperties: { DEEP: 'yes' } },
              ],
            },
          ],
        },
      ])
    ).toEqual([
      {
        Classification: 'hadoop-env',
        Properties: { TOP: '1' },
        Configurations: [
          {
            Classification: 'export',
            Properties: { JAVA_HOME: '/usr/lib/jvm' },
            Configurations: [{ Classification: 'deep', Properties: { DEEP: 'yes' } }],
          },
        ],
      },
    ]);
  });

  it('leaves a configuration without ConfigurationProperties untouched', () => {
    expect(toSdkConfigurations([{ Classification: 'core-site' }])).toEqual([
      { Classification: 'core-site' },
    ]);
  });

  it('passes undefined and non-array inputs through unchanged', () => {
    expect(toSdkConfigurations(undefined)).toBeUndefined();
    // An unresolved intrinsic must not become a confusing local crash — AWS
    // surfaces the real validation error instead.
    const intrinsic = { Ref: 'SomeParam' };
    expect(toSdkConfigurations(intrinsic)).toBe(intrinsic);
  });
});

describe('toSdkStepConfigs (issue #1383)', () => {
  it('renames HadoopJarStep.StepProperties to the SDK Properties member', () => {
    expect(
      toSdkStepConfigs([
        {
          Name: 'my-step',
          ActionOnFailure: 'CONTINUE',
          HadoopJarStep: {
            Jar: 's3://bucket/job.jar',
            MainClass: 'com.example.Main',
            Args: ['--input', 's3://in'],
            StepProperties: [{ Key: 'k', Value: 'v' }],
          },
        },
      ])
    ).toEqual([
      {
        Name: 'my-step',
        ActionOnFailure: 'CONTINUE',
        HadoopJarStep: {
          Jar: 's3://bucket/job.jar',
          MainClass: 'com.example.Main',
          Args: ['--input', 's3://in'],
          Properties: [{ Key: 'k', Value: 'v' }],
        },
      },
    ]);
  });

  it('leaves a step without StepProperties untouched', () => {
    const steps = [{ Name: 's', HadoopJarStep: { Jar: 's3://bucket/job.jar' } }];
    expect(toSdkStepConfigs(steps)).toEqual(steps);
  });

  it('passes undefined and non-array inputs through unchanged', () => {
    expect(toSdkStepConfigs(undefined)).toBeUndefined();
    const intrinsic = { Ref: 'SomeParam' };
    expect(toSdkStepConfigs(intrinsic)).toBe(intrinsic);
  });
});

describe('toSdkInstanceTypeConfigs (issue #1383)', () => {
  it('converts each element nested Configurations', () => {
    expect(
      toSdkInstanceTypeConfigs([
        {
          InstanceType: 'm5.xlarge',
          Configurations: [
            { Classification: 'yarn-site', ConfigurationProperties: { 'yarn.a': 'b' } },
          ],
        },
        { InstanceType: 'm5.2xlarge' },
      ])
    ).toEqual([
      {
        InstanceType: 'm5.xlarge',
        Configurations: [{ Classification: 'yarn-site', Properties: { 'yarn.a': 'b' } }],
      },
      { InstanceType: 'm5.2xlarge' },
    ]);
  });

  it('passes undefined and non-array inputs through unchanged', () => {
    expect(toSdkInstanceTypeConfigs(undefined)).toBeUndefined();
    const intrinsic = { Ref: 'SomeParam' };
    expect(toSdkInstanceTypeConfigs(intrinsic)).toBe(intrinsic);
  });
});
