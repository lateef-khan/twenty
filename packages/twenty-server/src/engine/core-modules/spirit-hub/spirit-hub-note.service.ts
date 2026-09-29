import { Injectable, UnauthorizedException } from '@nestjs/common';

import * as jwt from 'jsonwebtoken';

import { RedisClientService } from 'src/engine/core-modules/redis-client/redis-client.service';

// Reads the one-time note Spirit's Hub signs (HubNote.ForCrm): HS256 with the
// shared SPIRIT_HUB_SECRET, audience "crm", a short exp and a jti.
@Injectable()
export class SpiritHubNoteService {
  constructor(private readonly redisClientService: RedisClientService) {}

  async readUserId(note: string): Promise<string> {
    const secret = process.env.SPIRIT_HUB_SECRET;

    if (!secret) {
      throw new UnauthorizedException();
    }

    let claims: jwt.JwtPayload;

    try {
      claims = jwt.verify(note, secret, {
        algorithms: ['HS256'],
        audience: 'crm',
      }) as jwt.JwtPayload;
    } catch {
      throw new UnauthorizedException();
    }

    if (!claims.sub || !claims.jti || !claims.exp) {
      throw new UnauthorizedException();
    }

    // The jti is kept until the note would expire anyway, so a note works once.
    const ttl = Math.max(1, claims.exp - Math.floor(Date.now() / 1000));
    const first = await this.redisClientService
      .getClient()
      .set(`spirit-hub:jti:${claims.jti}`, '1', 'EX', ttl, 'NX');

    if (first !== 'OK') {
      throw new UnauthorizedException();
    }

    return claims.sub;
  }
}
