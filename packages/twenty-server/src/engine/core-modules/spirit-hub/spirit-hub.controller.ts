import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  InternalServerErrorException,
  Post,
  Query,
  Res,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { createHash, timingSafeEqual } from 'crypto';

import { isNonEmptyString, isString } from '@sniptt/guards';
import { Response } from 'express';
import { ApiPath } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';
import { QueryFailedError, Repository } from 'typeorm';

import { POSTGRESQL_ERROR_CODES } from 'src/engine/api/graphql/workspace-query-runner/constants/postgres-error-codes.constants';
import { AuthRestApiExceptionFilter } from 'src/engine/core-modules/auth/filters/auth-rest-api-exception.filter';
import { AuthService } from 'src/engine/core-modules/auth/services/auth.service';
import { SignInUpService } from 'src/engine/core-modules/auth/services/sign-in-up.service';
import { LoginTokenService } from 'src/engine/core-modules/auth/token/services/login-token.service';
import { SpiritHubNoteService } from 'src/engine/core-modules/spirit-hub/spirit-hub-note.service';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { AuthProviderEnum } from 'src/engine/core-modules/workspace/types/workspace.type';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { PublicEndpointGuard } from 'src/engine/guards/public-endpoint.guard';

type SpiritHubNewUser = {
  email?: unknown;
  firstName?: unknown;
  lastName?: unknown;
};

// Hashing both sides first gives timingSafeEqual equal lengths, so a wrong
// secret's length does not show in the timing either.
const isSpiritHubBearer = (authorization: string | undefined): boolean => {
  const secret = process.env.SPIRIT_HUB_SECRET;

  if (!isNonEmptyString(secret) || !isString(authorization)) {
    return false;
  }

  const digest = (value: string) => createHash('sha256').update(value).digest();

  return timingSafeEqual(digest(authorization), digest(`Bearer ${secret}`));
};

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof QueryFailedError &&
  (error.driverError as { code?: string } | undefined)?.code ===
    POSTGRESQL_ERROR_CODES.UNIQUE_VIOLATION;

@Controller(`${ApiPath.Auth}/spirit`)
@UseFilters(AuthRestApiExceptionFilter)
export class SpiritHubController {
  constructor(
    private readonly spiritHubNoteService: SpiritHubNoteService,
    private readonly loginTokenService: LoginTokenService,
    private readonly authService: AuthService,
    private readonly signInUpService: SignInUpService,
    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,
    @InjectRepository(WorkspaceEntity)
    private readonly workspaceRepository: Repository<WorkspaceEntity>,
  ) {}

  @Get()
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  async signIn(@Query('note') note: string, @Res() res: Response) {
    if (!isNonEmptyString(note)) {
      throw new UnauthorizedException();
    }

    const userId = await this.spiritHubNoteService.readUserId(note);
    const user = await this.userRepository.findOneBy({ id: userId });

    if (!isDefined(user)) {
      throw new UnauthorizedException();
    }

    const workspace = await this.findOnlyWorkspace();
    const loginToken = await this.loginTokenService.generateLoginToken(
      user.email,
      workspace.id,
      AuthProviderEnum.Password,
    );

    return res.redirect(
      this.authService.computeRedirectURI({
        loginToken: loginToken.token,
        workspace,
      }),
    );
  }

  @Post('users')
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  async createUser(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: SpiritHubNewUser | undefined,
  ): Promise<{ id: string }> {
    if (!isSpiritHubBearer(authorization)) {
      throw new UnauthorizedException();
    }

    const email = body?.email;
    const firstName = body?.firstName ?? '';
    const lastName = body?.lastName ?? '';

    if (
      !isNonEmptyString(email) ||
      !isString(firstName) ||
      !isString(lastName)
    ) {
      throw new BadRequestException(
        'email, firstName and lastName must be strings',
      );
    }

    // The Hub never adopts an existing Twenty user: that account may hold a
    // password and a role someone else chose.
    if (await this.userRepository.existsBy({ email })) {
      throw new ConflictException('email already used in CRM');
    }

    const workspace = await this.findOnlyWorkspace();

    try {
      const user = await this.signInUpService.signInUpOnExistingWorkspace({
        workspace,
        userData: {
          type: 'newUserWithPicture',
          newUserWithPicture: {
            email,
            firstName,
            lastName,
            isEmailVerified: true,
          },
        },
      });

      return { id: user.id };
    } catch (error) {
      // Two creates for one email at once: the loser hits the unique index.
      if (isUniqueViolation(error)) {
        throw new ConflictException('email already used in CRM');
      }

      throw error;
    }
  }

  private async findOnlyWorkspace(): Promise<WorkspaceEntity> {
    const workspaces = await this.workspaceRepository.find();

    if (workspaces.length !== 1) {
      throw new InternalServerErrorException(
        'Spirit Hub expects exactly one workspace',
      );
    }

    return workspaces[0];
  }
}
