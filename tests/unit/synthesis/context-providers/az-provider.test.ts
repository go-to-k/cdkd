import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock AWS SDK
const mockSend = vi.fn();
const mockDestroy = vi.fn();
vi.mock('@aws-sdk/client-ec2', () => ({
  EC2Client: vi.fn().mockImplementation(() => ({
    send: mockSend,
    destroy: mockDestroy,
  })),
  DescribeAvailabilityZonesCommand: vi.fn().mockImplementation((input) => ({
    ...input,
    _type: 'DescribeAvailabilityZonesCommand',
  })),
}));

// Mock logger
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { AZContextProvider } from '../../../../src/synthesis/context-providers/az-provider.js';

describe('AZContextProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return available AZ names sorted', async () => {
    mockSend.mockResolvedValue({
      AvailabilityZones: [
        { ZoneName: 'us-east-1c', State: 'available' },
        { ZoneName: 'us-east-1a', State: 'available' },
        { ZoneName: 'us-east-1b', State: 'available' },
      ],
    });

    const provider = new AZContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({});

    expect(result).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1c']);
    expect(mockDestroy).toHaveBeenCalled();
  });

  it('should filter out non-available zones', async () => {
    mockSend.mockResolvedValue({
      AvailabilityZones: [
        { ZoneName: 'us-east-1a', State: 'available' },
        { ZoneName: 'us-east-1b', State: 'impaired' },
        { ZoneName: 'us-east-1c', State: 'unavailable' },
        { ZoneName: 'us-east-1d', State: 'available' },
      ],
    });

    const provider = new AZContextProvider();
    const result = await provider.resolve({});

    expect(result).toEqual(['us-east-1a', 'us-east-1d']);
  });

  it('should use region from props', async () => {
    mockSend.mockResolvedValue({
      AvailabilityZones: [
        { ZoneName: 'ap-northeast-1a', State: 'available' },
      ],
    });

    const { EC2Client } = await import('@aws-sdk/client-ec2');

    const provider = new AZContextProvider({ region: 'us-east-1' });
    await provider.resolve({ region: 'ap-northeast-1' });

    // Props region should be used (passed to EC2Client constructor)
    expect(EC2Client).toHaveBeenCalledWith({ region: 'ap-northeast-1' });
  });

  it('should handle empty AvailabilityZones response', async () => {
    mockSend.mockResolvedValue({
      AvailabilityZones: [],
    });

    const provider = new AZContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({});

    expect(result).toEqual([]);
  });

  it('should handle undefined AvailabilityZones response', async () => {
    mockSend.mockResolvedValue({});

    const provider = new AZContextProvider({ region: 'us-east-1' });
    const result = await provider.resolve({});

    expect(result).toEqual([]);
  });
});
