import {
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  cleanupSpiritRowAccessApp,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { ToolCategory } from 'twenty-shared/ai';

import { type ToolExecutorService } from 'src/engine/core-modules/tool-provider/services/tool-executor.service';
import { type ToolIndexEntry } from 'src/engine/core-modules/tool-provider/types/tool-index-entry.type';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { USER_WORKSPACE_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-user-workspaces.util';
import { USER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-users.util';

// No mock language model exists in the integration harness, so these tests
// call the tool executor the AI chat dispatches through, with the context the
// chat builds: the user's ids and { unionOf: [the user's role] }.
const FIND_COMPANIES: ToolIndexEntry = {
  name: 'find_companies',
  label: 'Find companies',
  description: 'spirit row access test',
  category: ToolCategory.DATABASE_CRUD,
  executionRef: {
    kind: 'database_crud',
    objectNameSingular: 'company',
    operation: 'find_many',
  },
};

const NAVIGATE_APP: ToolIndexEntry = {
  name: 'navigate_app',
  label: 'Navigate',
  description: 'spirit row access test',
  category: ToolCategory.ACTION,
  executionRef: { kind: 'static', toolId: 'navigate_app' },
};

type ChatCaller = {
  userId: string;
  userWorkspaceId: string;
  roleId: string;
};

const dispatchAs = (
  caller: ChatCaller,
  descriptor: ToolIndexEntry,
  args: Record<string, unknown>,
) =>
  getAppProviderByClassName<ToolExecutorService>(
    'ToolExecutorService',
  ).dispatch(descriptor, args, {
    workspaceId: SEED_APPLE_WORKSPACE_ID,
    roleId: caller.roleId,
    rolePermissionConfig: { unionOf: [caller.roleId] },
    userId: caller.userId,
    userWorkspaceId: caller.userWorkspaceId,
  });

describe('spirit owner row access: AI chat tools (§5.11)', () => {
  let records: SpiritOwnerRecords;
  let alice: ChatCaller;
  let admin: ChatCaller;

  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());

    const memberRole = await findOneRoleByLabel({ label: 'Member' });
    const adminRole = await findOneRoleByLabel({ label: 'Admin' });

    alice = {
      userId: USER_DATA_SEED_IDS.JONY,
      userWorkspaceId: USER_WORKSPACE_DATA_SEED_IDS.JONY,
      roleId: memberRole.id,
    };
    admin = {
      userId: USER_DATA_SEED_IDS.JANE,
      userWorkspaceId: USER_WORKSPACE_DATA_SEED_IDS.JANE,
      roleId: adminRole.id,
    };
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await destroyCompaniesByPrefix(records.prefix);
  });

  it('PT-17 (tool level): find_companies for alice returns A only', async () => {
    const asAlice = await dispatchAs(alice, FIND_COMPANIES, {
      select: ['id', 'name'],
      name: { like: `${records.prefix}%` },
    });
    const asAdmin = await dispatchAs(admin, FIND_COMPANIES, {
      select: ['id', 'name'],
      name: { like: `${records.prefix}%` },
    });

    const idsOf = (output: typeof asAlice) =>
      (
        (output.result as { records?: { id: string }[] } | undefined)
          ?.records ?? []
      ).map((record) => record.id);

    expect(asAlice.success).toBe(true);
    expect(idsOf(asAlice)).toEqual([records.companyAId]);
    expect(idsOf(asAdmin).sort()).toEqual(
      [records.companyAId, records.companyBId, records.companyCId].sort(),
    );
  });

  it('PT-17b: navigate_app never resolves "open B" to B for alice', async () => {
    const asAlice = await dispatchAs(alice, NAVIGATE_APP, {
      navigation: {
        type: 'navigateToRecord',
        objectNameSingular: 'company',
        recordName: records.companyBName,
      },
    });

    expect(JSON.stringify(asAlice)).not.toContain(records.companyBId);
    expect(JSON.stringify(asAlice)).not.toContain(records.companyBName);
  });

  it('PT-17b: navigate_app never resolves "open C" (no owner) for alice', async () => {
    const asAlice = await dispatchAs(alice, NAVIGATE_APP, {
      navigation: {
        type: 'navigateToRecord',
        objectNameSingular: 'company',
        recordName: records.companyCName,
      },
    });

    expect(JSON.stringify(asAlice)).not.toContain(records.companyCId);
  });

  it('PT-17b control: navigate_app resolves A for alice and B for admin', async () => {
    const aliceToA = await dispatchAs(alice, NAVIGATE_APP, {
      navigation: {
        type: 'navigateToRecord',
        objectNameSingular: 'company',
        recordName: records.companyAName,
      },
    });
    const adminToB = await dispatchAs(admin, NAVIGATE_APP, {
      navigation: {
        type: 'navigateToRecord',
        objectNameSingular: 'company',
        recordName: records.companyBName,
      },
    });

    expect(aliceToA.success).toBe(true);
    expect((aliceToA.result as { recordId?: string }).recordId).toBe(
      records.companyAId,
    );
    expect(adminToB.success).toBe(true);
    expect((adminToB.result as { recordId?: string }).recordId).toBe(
      records.companyBId,
    );
  });

  // D36: once the config makes alice see-all, the tools return B to her
  it('control: alice made see-all finds A, B and C, and navigate_app resolves B and C', async () => {
    await withAliceSeeAll(rowAccessApp, async () => {
      const found = await dispatchAs(alice, FIND_COMPANIES, {
        select: ['id', 'name'],
        name: { like: `${records.prefix}%` },
      });

      expect(
        (
          (found.result as { records?: { id: string }[] } | undefined)
            ?.records ?? []
        )
          .map((record) => record.id)
          .sort(),
      ).toEqual(
        [records.companyAId, records.companyBId, records.companyCId].sort(),
      );

      for (const [recordName, recordId] of [
        [records.companyBName, records.companyBId],
        [records.companyCName, records.companyCId],
      ]) {
        const navigation = await dispatchAs(alice, NAVIGATE_APP, {
          navigation: {
            type: 'navigateToRecord',
            objectNameSingular: 'company',
            recordName,
          },
        });

        expect(navigation.success).toBe(true);
        expect((navigation.result as { recordId?: string }).recordId).toBe(
          recordId,
        );
      }
    });
  });
});
