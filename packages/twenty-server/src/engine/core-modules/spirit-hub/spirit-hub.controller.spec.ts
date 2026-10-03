import {
  BadRequestException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';

import { QueryFailedError } from 'typeorm';

import { SpiritHubController } from 'src/engine/core-modules/spirit-hub/spirit-hub.controller';
import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';

// The controller gets every service as a fake below; mocking the modules keeps
// jest from loading their whole dependency graph.
jest.mock('src/engine/core-modules/auth/services/auth.service', () => ({
  AuthService: class {},
}));
jest.mock('src/engine/core-modules/auth/services/sign-in-up.service', () => ({
  SignInUpService: class {},
}));
jest.mock(
  'src/engine/core-modules/user-workspace/user-workspace.service',
  () => ({ UserWorkspaceService: class {} }),
);
jest.mock('src/engine/core-modules/user/services/user.service', () => ({
  UserService: class {},
}));

const SECRET = 'spirit-hub-test-secret';
const WORKSPACE = { id: '57c5b52a-81e1-48a1-b7da-abf5b68402e8' };
const ADMIN = {
  id: '7b1f4f0e-3c55-4c8e-9f55-2b0a2b0c9d11',
  email: 'admin@spiritfitness.test',
  passwordHash: '$2b$10$existing-admin-hash',
};
const NEW_USER = {
  email: 'probe@spiritfitness.test',
  firstName: 'Probe',
  lastName: 'Person',
};

const buildController = () => {
  const userRepository = { findOneBy: jest.fn(), findOne: jest.fn() };
  const workspaceRepository = {
    find: jest.fn().mockResolvedValue([WORKSPACE]),
  };
  const signInUpService = { signInUpOnExistingWorkspace: jest.fn() };
  const userWorkspaceService = {
    addUserToWorkspaceIfUserNotInWorkspace: jest
      .fn()
      .mockResolvedValue(undefined),
    getUserCount: jest.fn().mockResolvedValue(2),
  };

  const userService = {
    deleteUserWorkspaceAndPotentiallyDeleteUser: jest
      .fn()
      .mockResolvedValue(undefined),
  };

  const controller = new SpiritHubController(
    {} as never,
    {} as never,
    {} as never,
    signInUpService as never,
    userWorkspaceService as never,
    userRepository as never,
    workspaceRepository as never,
    userService as never,
  );

  return {
    controller,
    userRepository,
    signInUpService,
    userWorkspaceService,
    userService,
  };
};

const uniqueViolation = () =>
  new QueryFailedError('INSERT INTO "core"."user"', [], {
    code: '23505',
  } as unknown as Error);

describe('SpiritHubController.createUser', () => {
  const originalSecret = process.env.SPIRIT_HUB_SECRET;

  beforeEach(() => {
    process.env.SPIRIT_HUB_SECRET = SECRET;
  });

  afterAll(() => {
    process.env.SPIRIT_HUB_SECRET = originalSecret;
  });

  it('makes a new user with no password and a verified email', async () => {
    const { controller, userRepository, signInUpService } = buildController();

    userRepository.findOneBy.mockResolvedValue(null);
    signInUpService.signInUpOnExistingWorkspace.mockResolvedValue({
      id: 'b3b3aae7-1714-4fd6-9002-093eab25e3bd',
    });

    await expect(
      controller.createUser(`Bearer ${SECRET}`, NEW_USER),
    ).resolves.toEqual({ id: 'b3b3aae7-1714-4fd6-9002-093eab25e3bd' });
    expect(signInUpService.signInUpOnExistingWorkspace).toHaveBeenCalledWith({
      workspace: WORKSPACE,
      userData: {
        type: 'newUserWithPicture',
        newUserWithPicture: { ...NEW_USER, isEmailVerified: true },
      },
    });
  });

  it('adopts a user Twenty already has and leaves it as it is', async () => {
    const {
      controller,
      userRepository,
      signInUpService,
      userWorkspaceService,
    } = buildController();

    userRepository.findOneBy.mockResolvedValue({ ...ADMIN });

    await expect(
      controller.createUser(`Bearer ${SECRET}`, {
        email: 'Admin@SpiritFitness.test',
        firstName: 'Owner',
        lastName: 'Name',
      }),
    ).resolves.toEqual({ id: ADMIN.id });
    expect(signInUpService.signInUpOnExistingWorkspace).not.toHaveBeenCalled();
    expect(
      userWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace,
    ).toHaveBeenCalledWith(ADMIN, WORKSPACE);
  });

  it('adopts the winner when a second create for the same email loses the race', async () => {
    const {
      controller,
      userRepository,
      signInUpService,
      userWorkspaceService,
    } = buildController();
    const winner = { id: '0e48331b-0f6c-4ee9-b0fb-c693bfe5fee4', ...NEW_USER };

    userRepository.findOneBy
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(winner);
    signInUpService.signInUpOnExistingWorkspace.mockRejectedValue(
      uniqueViolation(),
    );

    await expect(
      controller.createUser(`Bearer ${SECRET}`, NEW_USER),
    ).resolves.toEqual({ id: winner.id });
    expect(
      userWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace,
    ).toHaveBeenCalledWith(winner, WORKSPACE);
  });

  it('still answers with the id when the winner joins the workspace first', async () => {
    const { controller, userRepository, userWorkspaceService } =
      buildController();

    userRepository.findOneBy.mockResolvedValue({ ...ADMIN });
    userWorkspaceService.addUserToWorkspaceIfUserNotInWorkspace.mockRejectedValue(
      uniqueViolation(),
    );

    await expect(
      controller.createUser(`Bearer ${SECRET}`, {
        email: ADMIN.email,
        firstName: 'A',
        lastName: 'B',
      }),
    ).resolves.toEqual({ id: ADMIN.id });
  });

  it('refuses a wrong secret', async () => {
    const { controller, userRepository } = buildController();

    await expect(
      controller.createUser('Bearer wrong', NEW_USER),
    ).rejects.toThrow(UnauthorizedException);
    expect(userRepository.findOneBy).not.toHaveBeenCalled();
  });
});

describe('SpiritHubController.deleteUser', () => {
  const originalSecret = process.env.SPIRIT_HUB_SECRET;

  beforeEach(() => {
    process.env.SPIRIT_HUB_SECRET = SECRET;
  });

  afterAll(() => {
    process.env.SPIRIT_HUB_SECRET = originalSecret;
  });

  it('refuses a wrong bearer', async () => {
    const { controller } = buildController();

    await expect(
      controller.deleteUser('Bearer nope', ADMIN.id),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('answers 400 for an id that is not a UUID, without asking the database', async () => {
    const { controller, userRepository } = buildController();

    await expect(
      controller.deleteUser(`Bearer ${SECRET}`, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(userRepository.findOne).not.toHaveBeenCalled();
  });

  it('removes the member from the only workspace', async () => {
    const { controller, userRepository, userService } = buildController();

    userRepository.findOne.mockResolvedValue({
      id: ADMIN.id,
      userWorkspaces: [{ workspaceId: WORKSPACE.id }],
    });

    await controller.deleteUser(`Bearer ${SECRET}`, ADMIN.id);

    expect(
      userService.deleteUserWorkspaceAndPotentiallyDeleteUser,
    ).toHaveBeenCalledWith({ userId: ADMIN.id, workspaceId: WORKSPACE.id });
  });

  it('does nothing for a user who is gone or outside the workspace', async () => {
    const { controller, userRepository, userService } = buildController();

    userRepository.findOne.mockResolvedValue(null);
    await controller.deleteUser(`Bearer ${SECRET}`, ADMIN.id);
    userRepository.findOne.mockResolvedValue({
      id: ADMIN.id,
      userWorkspaces: [],
    });
    await controller.deleteUser(`Bearer ${SECRET}`, ADMIN.id);

    expect(
      userService.deleteUserWorkspaceAndPotentiallyDeleteUser,
    ).not.toHaveBeenCalled();
  });

  it('answers 409 for the last admin', async () => {
    const { controller, userRepository, userService } = buildController();

    userRepository.findOne.mockResolvedValue({
      id: ADMIN.id,
      userWorkspaces: [{ workspaceId: WORKSPACE.id }],
    });
    userService.deleteUserWorkspaceAndPotentiallyDeleteUser.mockRejectedValue(
      new PermissionsException(
        'last admin',
        PermissionsExceptionCode.CANNOT_DELETE_LAST_ADMIN_USER,
      ),
    );

    await expect(
      controller.deleteUser(`Bearer ${SECRET}`, ADMIN.id),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers 409 and removes nothing for the only member, which would delete the workspace', async () => {
    const { controller, userRepository, userService, userWorkspaceService } =
      buildController();

    userRepository.findOne.mockResolvedValue({
      id: ADMIN.id,
      userWorkspaces: [{ workspaceId: WORKSPACE.id }],
    });
    userWorkspaceService.getUserCount.mockResolvedValue(1);

    await expect(
      controller.deleteUser(`Bearer ${SECRET}`, ADMIN.id),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(userWorkspaceService.getUserCount).toHaveBeenCalledWith(
      WORKSPACE.id,
    );
    expect(
      userService.deleteUserWorkspaceAndPotentiallyDeleteUser,
    ).not.toHaveBeenCalled();
  });
});
