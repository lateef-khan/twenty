import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';

import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { basename } from 'path';

import { CacheStorageNamespace } from 'src/engine/core-modules/cache-storage/types/cache-storage-namespace.enum';
import { RedisClientService } from 'src/engine/core-modules/redis-client/redis-client.service';
import {
  SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME,
  isSpiritRowAccessEnforced,
  isSpiritRowAccessSwitchOn,
  setSpiritRowAccessEnforcedByLivePeer,
} from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';

// Redis hash: one field per live process with the switch on, valued with the
// time (ms) its claim expires. A crashed process drops out after the TTL; a
// clean shutdown removes its field at once. The key is workspace-independent.
// Like CacheStorageService keys, it gets the integration-tests prefix under
// NODE_ENV=test, so a jest run cannot turn the rule on in a dev server that
// shares the Redis database.
export const SPIRIT_ROW_ACCESS_SWITCH_ON_PROCESSES_KEY =
  'engine:spirit-row-access:switch-on-processes';

export const getSpiritRowAccessSwitchKey = (): string =>
  process.env.NODE_ENV === 'test'
    ? `${CacheStorageNamespace.IntegrationTests}:${SPIRIT_ROW_ACCESS_SWITCH_ON_PROCESSES_KEY}`
    : SPIRIT_ROW_ACCESS_SWITCH_ON_PROCESSES_KEY;
export const SPIRIT_ROW_ACCESS_SWITCH_CLAIM_TTL_MS = 30_000;
export const SPIRIT_ROW_ACCESS_SWITCH_REFRESH_MS = 10_000;
export const SPIRIT_ROW_ACCESS_SWITCH_POLL_MS = 5_000;

// The server and the worker must run with the same switch value (design
// §5.8). Each process logs its value at boot. A process with the switch on
// announces itself; a process with the switch off that sees a live one
// enforces the rule too and logs an error, so a mismatch fails closed.
@Injectable()
export class SpiritRowAccessSwitchService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SpiritRowAccessSwitchService.name);
  private readonly processField = `${hostname()}:${process.pid}:${randomUUID()}`;
  private readonly switchKey = getSpiritRowAccessSwitchKey();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly redisClientService: RedisClientService) {}

  async onModuleInit() {
    const isOn = isSpiritRowAccessSwitchOn();

    this.logger.log(
      `Row access enforcement is ${isOn ? 'ON' : 'OFF'} (${SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME}=${process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME] ?? '<unset>'}, entry ${basename(process.argv[1] ?? 'unknown')}, pid ${process.pid})`,
    );

    const tick = isOn
      ? () => this.announceSwitchOn()
      : () => this.followLivePeers();

    await tick();

    this.timer = setInterval(
      () => void tick(),
      isOn
        ? SPIRIT_ROW_ACCESS_SWITCH_REFRESH_MS
        : SPIRIT_ROW_ACCESS_SWITCH_POLL_MS,
    );
    this.timer.unref();
  }

  async onModuleDestroy() {
    clearInterval(this.timer);

    if (isSpiritRowAccessSwitchOn()) {
      await this.redisClientService
        .getClient()
        .hdel(this.switchKey, this.processField)
        .catch(() => undefined);
    }
  }

  private async announceSwitchOn() {
    try {
      const client = this.redisClientService.getClient();
      const now = Date.now();

      await client.hset(
        this.switchKey,
        this.processField,
        String(now + SPIRIT_ROW_ACCESS_SWITCH_CLAIM_TTL_MS),
      );

      // The server has no shutdown hook, so a stopped server leaves its
      // field behind; drop expired fields here.
      const expiredFields = Object.entries(await client.hgetall(this.switchKey))
        .filter(([, expiresAt]) => Number(expiresAt) <= now)
        .map(([field]) => field);

      if (expiredFields.length > 0) {
        await client.hdel(this.switchKey, ...expiredFields);
      }
    } catch (error) {
      this.logger.warn(`Cannot announce the row access switch: ${error}`);
    }
  }

  private async followLivePeers() {
    let claims: Record<string, string>;

    try {
      claims = await this.redisClientService
        .getClient()
        .hgetall(this.switchKey);
    } catch (error) {
      this.logger.warn(`Cannot read the row access switch peers: ${error}`);

      return;
    }

    const now = Date.now();
    const livePeers = Object.entries(claims).filter(
      ([, expiresAt]) => Number(expiresAt) > now,
    );
    const wasEnforced = isSpiritRowAccessEnforced();

    setSpiritRowAccessEnforcedByLivePeer(livePeers.length > 0);

    if (livePeers.length > 0 && !wasEnforced) {
      this.logger.error(
        `Row access switch MISMATCH: ${SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME} is off here, but ${livePeers.length} live process(es) run with it on (${livePeers.map(([field]) => field).join(', ')}). Enforcing the rule in this process too. Set the same value on the server and the worker, then restart both.`,
      );
    }

    if (livePeers.length === 0 && wasEnforced) {
      this.logger.warn(
        'Row access switch: no live process runs with it on any more; the rule is off in this process.',
      );
    }
  }
}
