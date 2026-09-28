import { Logger } from '@nestjs/common';

import { type RedisClientService } from 'src/engine/core-modules/redis-client/redis-client.service';
import { type SecretEncryptionService } from 'src/engine/core-modules/secret-encryption/secret-encryption.service';
import { SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import {
  SpiritRowAccessSwitchService,
  getSpiritRowAccessSwitchKey,
} from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-switch.service';
import {
  isSpiritRowAccessEnforced,
  setSpiritRowAccessEnforcedByLivePeer,
} from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { type WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';

// Design D40: a process with the switch on holds a claim in
// one Redis hash (TTL 30 s, refreshed every 10 s); a process with the switch
// off polls the hash every 5 s and enforces the rule while any claim is live.
// The numbers below come from the design, not from the code under test.
const CLAIM_TTL_MS = 30_000;
const REFRESH_MS = 10_000;
const POLL_MS = 5_000;
const T0 = new Date('2026-09-27T12:00:00.000Z').getTime();

// Review m1: Twenty prefixes its cache keys with "integration-tests:" under
// NODE_ENV=test (CacheStorageService.getKey); the guard key follows it.
const DEV_KEY = 'engine:spirit-row-access:switch-on-processes';
const TEST_KEY = `integration-tests:${DEV_KEY}`;

const buildFakeRedis = () => {
  const hashes = new Map<string, Map<string, string>>();
  let isDown = false;

  const failIfDown = () => {
    if (isDown) {
      throw new Error('connect ECONNREFUSED 127.0.0.1:6379');
    }
  };

  const hashOf = (key: string) => {
    const hash = hashes.get(key) ?? new Map<string, string>();

    hashes.set(key, hash);

    return hash;
  };

  const client = {
    hset: jest.fn(async (key: string, field: string, value: string) => {
      failIfDown();
      hashOf(key).set(field, value);

      return 1;
    }),
    hgetall: jest.fn(async (key: string) => {
      failIfDown();

      return Object.fromEntries(hashOf(key));
    }),
    hdel: jest.fn(async (key: string, ...fields: string[]) => {
      failIfDown();
      fields.forEach((field) => hashOf(key).delete(field));

      return fields.length;
    }),
  };

  return {
    client,
    claims: (key = TEST_KEY) => Object.fromEntries(hashOf(key)),
    addClaim: (field: string, expiresAt: number) =>
      hashOf(TEST_KEY).set(field, String(expiresAt)),
    setDown: (value: boolean) => {
      isDown = value;
    },
    redisClientService: {
      getClient: () => client,
    } as unknown as RedisClientService,
  };
};

describe('SpiritRowAccessSwitchService (D40 mismatch guard)', () => {
  const originalEnforced = process.env.SPIRIT_ROW_ACCESS_ENFORCED;
  const originalNodeEnv = process.env.NODE_ENV;

  let redis: ReturnType<typeof buildFakeRedis>;
  let service: SpiritRowAccessSwitchService | undefined;
  let errorLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;

  const startProcess = async (switchValue: 'true' | undefined) => {
    if (switchValue === undefined) {
      delete process.env.SPIRIT_ROW_ACCESS_ENFORCED;
    } else {
      process.env.SPIRIT_ROW_ACCESS_ENFORCED = switchValue;
    }

    service = new SpiritRowAccessSwitchService(redis.redisClientService);
    await service.onModuleInit();

    return service;
  };

  beforeEach(() => {
    jest.useFakeTimers({ now: T0 });
    process.env.NODE_ENV = 'test';
    setSpiritRowAccessEnforcedByLivePeer(false);
    redis = buildFakeRedis();
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    warnLog = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(async () => {
    delete process.env.SPIRIT_ROW_ACCESS_ENFORCED;
    await service?.onModuleDestroy();
    service = undefined;
    setSpiritRowAccessEnforcedByLivePeer(false);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;

    if (originalEnforced === undefined) {
      delete process.env.SPIRIT_ROW_ACCESS_ENFORCED;
    } else {
      process.env.SPIRIT_ROW_ACCESS_ENFORCED = originalEnforced;
    }
  });

  describe('a process with the switch off', () => {
    it('enforces the rule at boot when another process holds a live claim, and logs one MISMATCH error', async () => {
      redis.addClaim('server:1:a', T0 + 20_000);

      await startProcess(undefined);

      expect(isSpiritRowAccessEnforced()).toBe(true);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(errorLog.mock.calls[0][0]).toContain('MISMATCH');

      // Still live on the next poll: still enforced, no second error
      await jest.advanceTimersByTimeAsync(POLL_MS);

      expect(isSpiritRowAccessEnforced()).toBe(true);
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it('does not enforce when every claim has expired', async () => {
      redis.addClaim('server:1:a', T0 - 1);
      redis.addClaim('worker:2:b', T0);

      await startProcess(undefined);

      expect(isSpiritRowAccessEnforced()).toBe(false);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('stops enforcing on the first poll after the last claim expires, and logs one WARN', async () => {
      // A killed on-server: its claim is never refreshed
      redis.addClaim('server:1:a', T0 + CLAIM_TTL_MS);

      await startProcess(undefined);

      expect(isSpiritRowAccessEnforced()).toBe(true);

      await jest.advanceTimersByTimeAsync(CLAIM_TTL_MS - POLL_MS);

      expect(isSpiritRowAccessEnforced()).toBe(true);
      expect(warnLog).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(POLL_MS);

      expect(isSpiritRowAccessEnforced()).toBe(false);
      expect(warnLog).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(POLL_MS);

      expect(warnLog).toHaveBeenCalledTimes(1);
    });

    it('starts enforcing within one poll when an on process starts after it', async () => {
      await startProcess(undefined);

      expect(isSpiritRowAccessEnforced()).toBe(false);

      redis.addClaim('server:1:a', T0 + CLAIM_TTL_MS);
      await jest.advanceTimersByTimeAsync(POLL_MS);

      expect(isSpiritRowAccessEnforced()).toBe(true);
    });

    it('keeps its previous value while Redis cannot be read', async () => {
      redis.addClaim('server:1:a', T0 + CLAIM_TTL_MS * 10);

      await startProcess(undefined);

      expect(isSpiritRowAccessEnforced()).toBe(true);

      redis.setDown(true);
      await jest.advanceTimersByTimeAsync(POLL_MS * 3);

      expect(isSpiritRowAccessEnforced()).toBe(true);
      expect(warnLog).toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it('never writes a claim', async () => {
      await startProcess(undefined);
      await jest.advanceTimersByTimeAsync(REFRESH_MS * 3);

      expect(redis.client.hset).not.toHaveBeenCalled();
    });
  });

  describe('a process with the switch on', () => {
    it('writes its claim at boot with expiry = now + 30 000 ms', async () => {
      await startProcess('true');

      expect(isSpiritRowAccessEnforced()).toBe(true);
      expect(redis.client.hset).toHaveBeenCalledTimes(1);
      expect(Object.values(redis.claims())).toEqual([
        String(T0 + CLAIM_TTL_MS),
      ]);
    });

    it('refreshes its claim every 10 s and drops expired fields of other processes', async () => {
      redis.addClaim('killed-server:1:a', T0 + 5_000);
      redis.addClaim('live-worker:2:b', T0 + 25_000);

      await startProcess('true');

      expect(Object.keys(redis.claims()).sort()).toEqual(
        expect.arrayContaining(['killed-server:1:a', 'live-worker:2:b']),
      );

      await jest.advanceTimersByTimeAsync(REFRESH_MS);

      const claims = redis.claims();
      const ownFields = Object.keys(claims).filter(
        (field) => field !== 'live-worker:2:b',
      );

      expect(claims['killed-server:1:a']).toBeUndefined();
      expect(claims['live-worker:2:b']).toBe(String(T0 + 25_000));
      expect(ownFields).toHaveLength(1);
      expect(claims[ownFields[0]]).toBe(String(T0 + REFRESH_MS + CLAIM_TTL_MS));
      expect(redis.client.hset).toHaveBeenCalledTimes(2);
    });

    it('removes its own field on a clean shutdown, and only its own', async () => {
      redis.addClaim('live-worker:2:b', T0 + 25_000);

      const onProcess = await startProcess('true');

      expect(Object.keys(redis.claims())).toHaveLength(2);

      await onProcess.onModuleDestroy();
      service = undefined;

      expect(Object.keys(redis.claims())).toEqual(['live-worker:2:b']);
    });

    it('makes an off process that boots next enforce the rule (server on, worker off)', async () => {
      await startProcess('true');

      // A second process in another pid: same Redis, switch off
      delete process.env.SPIRIT_ROW_ACCESS_ENFORCED;
      setSpiritRowAccessEnforcedByLivePeer(false);

      const offProcess = new SpiritRowAccessSwitchService(
        redis.redisClientService,
      );

      await offProcess.onModuleInit();

      expect(isSpiritRowAccessEnforced()).toBe(true);

      await offProcess.onModuleDestroy();
    });
  });

  describe('the switch off everywhere', () => {
    it('keeps the rule off: no claim, no enforcement, and the loader reads nothing (upstream)', async () => {
      const getOrRecompute = jest.fn();
      const stateService = new SpiritRowAccessStateService(
        { getOrRecompute } as unknown as WorkspaceCacheService,
        {
          decryptVersionedOrThrow: jest.fn(),
        } as unknown as SecretEncryptionService,
        { findOne: jest.fn() },
      );

      await startProcess(undefined);
      await jest.advanceTimersByTimeAsync(CLAIM_TTL_MS * 2);

      expect(isSpiritRowAccessEnforced()).toBe(false);
      expect(redis.claims()).toEqual({});
      expect(await stateService.loadSnapshot('workspace-1')).toBeUndefined();
      expect(getOrRecompute).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('the same loader reads the config while a live on process is seen (mismatch)', async () => {
      const getOrRecompute = jest.fn(async () => {
        throw new Error('read attempted');
      });
      const stateService = new SpiritRowAccessStateService(
        { getOrRecompute } as unknown as WorkspaceCacheService,
        {
          decryptVersionedOrThrow: jest.fn(),
        } as unknown as SecretEncryptionService,
        { findOne: jest.fn(async () => null) },
      );

      redis.addClaim('server:1:a', T0 + CLAIM_TTL_MS);
      await startProcess(undefined);

      await expect(stateService.loadSnapshot('workspace-1')).rejects.toThrow(
        'read attempted',
      );
    });
  });

  describe('the Redis key (review m1)', () => {
    it('is namespaced for jest under NODE_ENV=test', async () => {
      expect(getSpiritRowAccessSwitchKey()).toBe(TEST_KEY);

      await startProcess('true');

      expect(Object.keys(redis.claims(TEST_KEY))).toHaveLength(1);
      expect(redis.claims(DEV_KEY)).toEqual({});
    });

    it('has no test prefix in a dev or production process', () => {
      process.env.NODE_ENV = 'development';

      try {
        expect(getSpiritRowAccessSwitchKey()).toBe(DEV_KEY);
      } finally {
        process.env.NODE_ENV = 'test';
      }
    });

    it('a jest claim is not seen by a dev process on the same Redis database', async () => {
      await startProcess('true');

      process.env.NODE_ENV = 'development';
      delete process.env.SPIRIT_ROW_ACCESS_ENFORCED;
      setSpiritRowAccessEnforcedByLivePeer(false);

      const devProcess = new SpiritRowAccessSwitchService(
        redis.redisClientService,
      );

      try {
        await devProcess.onModuleInit();

        expect(isSpiritRowAccessEnforced()).toBe(false);
      } finally {
        await devProcess.onModuleDestroy();
        process.env.NODE_ENV = 'test';
      }
    });
  });
});
