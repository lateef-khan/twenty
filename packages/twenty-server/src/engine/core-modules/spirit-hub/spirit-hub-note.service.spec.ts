import { UnauthorizedException } from '@nestjs/common';

import * as jwt from 'jsonwebtoken';

import { SpiritHubNoteService } from 'src/engine/core-modules/spirit-hub/spirit-hub-note.service';

const SECRET = 'spirit-hub-test-secret';
const USER_ID = '3b7c1d52-0d7e-4f0a-9d8e-2f1f6a0c9e11';

// The claims Spirit's HubNote.ForCrm writes: sub, aud "crm", exp 60 seconds ahead, a random jti.
const signNote = (
  claims: Record<string, unknown>,
  secret: string = SECRET,
): string =>
  jwt.sign(
    {
      sub: USER_ID,
      aud: 'crm',
      exp: Math.floor(Date.now() / 1000) + 60,
      jti: '9f86d081884c7d659a2feaa0c55ad015',
      ...claims,
    },
    secret,
    { algorithm: 'HS256', noTimestamp: true },
  );

const buildRedisFake = () => {
  const keys = new Set<string>();

  return {
    set: jest.fn(
      async (
        key: string,
        _value: string,
        _expiryMode: 'EX',
        _seconds: number,
        _condition: 'NX',
      ) => {
        if (keys.has(key)) {
          return null;
        }

        keys.add(key);

        return 'OK';
      },
    ),
  };
};

describe('SpiritHubNoteService', () => {
  const originalSecret = process.env.SPIRIT_HUB_SECRET;
  let redis: ReturnType<typeof buildRedisFake>;
  let service: SpiritHubNoteService;

  beforeEach(() => {
    process.env.SPIRIT_HUB_SECRET = SECRET;
    redis = buildRedisFake();
    service = new SpiritHubNoteService({
      getClient: () => redis,
    } as never);
  });

  afterAll(() => {
    process.env.SPIRIT_HUB_SECRET = originalSecret;
  });

  it('accepts a fresh note and returns its user id', async () => {
    await expect(service.readUserId(signNote({}))).resolves.toBe(USER_ID);
  });

  it('refuses an expired note', async () => {
    const note = signNote({ exp: Math.floor(Date.now() / 1000) - 1 });

    await expect(service.readUserId(note)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a note for another audience', async () => {
    const note = signNote({ aud: 'desk' });

    await expect(service.readUserId(note)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a note signed with another secret', async () => {
    const note = signNote({}, 'another-secret');

    await expect(service.readUserId(note)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses the same note twice', async () => {
    const note = signNote({});

    await expect(service.readUserId(note)).resolves.toBe(USER_ID);
    await expect(service.readUserId(note)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('refuses a note with no jti', async () => {
    const note = signNote({ jti: undefined });

    await expect(service.readUserId(note)).rejects.toThrow(
      UnauthorizedException,
    );
  });
});
