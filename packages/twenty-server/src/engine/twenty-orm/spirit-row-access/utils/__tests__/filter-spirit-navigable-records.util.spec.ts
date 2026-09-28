import { type ObjectRecord } from 'twenty-shared/types';

import { type ToolExecutionContext } from 'src/engine/core-modules/tool/types/tool-execution-context.type';
import {
  PermissionsException,
  PermissionsExceptionCode,
} from 'src/engine/metadata-modules/permissions/permissions.exception';
import { filterSpiritNavigableRecords } from 'src/engine/twenty-orm/spirit-row-access/utils/filter-spirit-navigable-records.util';
import { SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME } from 'src/engine/twenty-orm/spirit-row-access/utils/is-spirit-row-access-enforced.util';
import { type WorkspaceOrmManager } from 'src/engine/twenty-orm/workspace-orm.manager';

const RECORDS = [
  { id: 'company-a', name: 'A' },
  { id: 'company-b', name: 'B' },
  { id: 'company-c', name: 'C' },
] as ObjectRecord[];

const MEMBER_CONTEXT: ToolExecutionContext = {
  workspaceId: 'workspace-id',
  rolePermissionConfig: { intersectionOf: ['role-member'] },
};

const buildWorkspaceOrmManager = (find: () => Promise<{ id: string }[]>) => {
  const findMock = jest.fn(find);
  const getRepository = jest.fn(() => ({ find: findMock }));
  const executeInWorkspaceContext = jest.fn(
    async (fn: () => Promise<unknown>) => fn(),
  );

  return {
    workspaceOrmManager: {
      getRepository,
      executeInWorkspaceContext,
    } as unknown as WorkspaceOrmManager,
    getRepository,
    findMock,
  };
};

const filter = (
  workspaceOrmManager: WorkspaceOrmManager,
  context: ToolExecutionContext = MEMBER_CONTEXT,
) =>
  filterSpiritNavigableRecords({
    workspaceOrmManager,
    context,
    objectNameSingular: 'company',
    records: RECORDS,
  });

describe('filterSpiritNavigableRecords (design §5.11)', () => {
  afterEach(() => {
    delete process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME];
  });

  it('off: returns the same array and reads nothing', async () => {
    const { workspaceOrmManager, getRepository } = buildWorkspaceOrmManager(
      async () => [],
    );

    expect(await filter(workspaceOrmManager)).toBe(RECORDS);
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('on, with no role config: matches nothing', async () => {
    process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME] = 'true';

    const { workspaceOrmManager, getRepository } = buildWorkspaceOrmManager(
      async () => [{ id: 'company-a' }],
    );

    expect(
      await filter(workspaceOrmManager, { workspaceId: 'workspace-id' }),
    ).toEqual([]);
    expect(getRepository).not.toHaveBeenCalled();
  });

  it("on: keeps only the records the caller's own id-only read returns", async () => {
    process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME] = 'true';

    const { workspaceOrmManager, getRepository, findMock } =
      buildWorkspaceOrmManager(async () => [{ id: 'company-a' }]);

    expect(await filter(workspaceOrmManager)).toEqual([RECORDS[0]]);
    expect(getRepository).toHaveBeenCalledWith('company', {
      intersectionOf: ['role-member'],
    });
    expect(findMock).toHaveBeenCalledWith({ select: ['id'] });
  });

  it('on: a permission error matches nothing', async () => {
    process.env[SPIRIT_ROW_ACCESS_ENFORCED_ENV_NAME] = 'true';

    const { workspaceOrmManager } = buildWorkspaceOrmManager(async () => {
      throw new PermissionsException(
        'denied',
        PermissionsExceptionCode.PERMISSION_DENIED,
      );
    });

    expect(await filter(workspaceOrmManager)).toEqual([]);
  });
});
