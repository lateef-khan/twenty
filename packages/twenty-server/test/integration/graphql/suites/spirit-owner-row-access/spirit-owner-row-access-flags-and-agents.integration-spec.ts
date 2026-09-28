import { randomUUID } from 'crypto';

import gql from 'graphql-tag';
import {
  ALICE_MEMBER_ID,
  ALICE_TOKEN,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
  findCompanyAndOwnerFieldIds,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  cleanupSpiritRowAccessApp,
  readRowAccessAppTarball,
  setupSpiritRowAccessApp,
  updateRowAccessConfigVariable,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { uploadAppTarball } from 'test/integration/metadata/suites/application/utils/upload-app-tarball.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { ToolCategory } from 'twenty-shared/ai';

import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type ToolExecutorService } from 'src/engine/core-modules/tool-provider/services/tool-executor.service';
import { type ToolIndexEntry } from 'src/engine/core-modules/tool-provider/types/tool-index-entry.type';
import { type AgentActorContextService } from 'src/engine/metadata-modules/ai/ai-agent-execution/services/agent-actor-context.service';
import { buildAgentRolePermissionConfig } from 'src/engine/metadata-modules/ai/ai-agent-execution/utils/build-agent-role-permission-config.util';
import { SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER } from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-row-access-application.constant';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { USER_WORKSPACE_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-user-workspaces.util';
import { USER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-users.util';

jest.setTimeout(120000);

// §5.12 plus two flags round 2 found: MARKETPLACE_APPS uploads an app
// tarball (its role can be Admin), IMPERSONATE signs in as another user.
const RELEASE_GATE_FLAGS = [
  'WORKFLOWS',
  'API_KEYS_AND_WEBHOOKS',
  'APPLICATIONS',
  'ROLES',
  'SECURITY',
  'DATA_MODEL',
  'MARKETPLACE_APPS',
  'IMPERSONATE',
];

const expectForbidden = (response: {
  body: { errors?: { extensions?: { code?: string } }[] };
}) => {
  expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
};

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

const findCompanyIdsWithTool = async ({
  prefix,
  roleId,
  rolePermissionConfig,
  authContext,
  userId,
  userWorkspaceId,
}: {
  prefix: string;
  roleId: string;
  rolePermissionConfig: RolePermissionConfig;
  authContext?: WorkspaceAuthContext;
  userId?: string;
  userWorkspaceId?: string;
}): Promise<string[]> => {
  const output = await getAppProviderByClassName<ToolExecutorService>(
    'ToolExecutorService',
  ).dispatch(
    FIND_COMPANIES,
    { select: ['id'], name: { like: `${prefix}%` } },
    {
      workspaceId: SEED_APPLE_WORKSPACE_ID,
      roleId,
      rolePermissionConfig,
      authContext,
      userId,
      userWorkspaceId,
    },
  );

  const result = output.result as { records?: { id: string }[] } | undefined;

  expect(output.success).toBe(true);

  return (result?.records ?? []).map((record) => record.id).sort();
};

describe('spirit owner row access: permission flags (PT-25) and agents', () => {
  let records: SpiritOwnerRecords;
  let rowAccessApp: SpiritRowAccessAppSetup | undefined;
  let adminRoleId: string;
  let memberRoleId: string;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());
    adminRoleId = (await findOneRoleByLabel({ label: 'Admin' })).id;
    memberRoleId = (await findOneRoleByLabel({ label: 'Member' })).id;
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await destroyCompaniesByPrefix(records.prefix);
  });

  describe('PT-25: the seeded Member role holds none of the release-gate flags', () => {
    it('Member has canUpdateAllSettings false and no gate flag', async () => {
      const response = await makeMetadataAPIRequest({
        query: gql`
          query SpiritMemberFlags {
            getRoles {
              label
              canUpdateAllSettings
              canAccessAllTools
              permissionFlags {
                flag
              }
            }
          }
        `,
      });

      expect(response.body.errors).toBeUndefined();

      const member = response.body.data.getRoles.find(
        (role: { label: string }) => role.label === 'Member',
      );

      expect(member.canUpdateAllSettings).toBe(false);
      expect(
        member.permissionFlags
          .map((permissionFlag: { flag: string }) => permissionFlag.flag)
          .filter((flag: string) => RELEASE_GATE_FLAGS.includes(flag)),
      ).toEqual([]);
    });

    it('WORKFLOWS: alice cannot activate a workflow version', async () => {
      expectForbidden(
        await makeGraphqlAPIRequest(
          {
            query: gql`
              mutation SpiritActivate($workflowVersionId: UUID!) {
                activateWorkflowVersion(workflowVersionId: $workflowVersionId)
              }
            `,
            variables: { workflowVersionId: randomUUID() },
          },
          ALICE_TOKEN,
        ),
      );
    });

    it('API_KEYS_AND_WEBHOOKS: alice cannot create a webhook', async () => {
      expectForbidden(
        await makeMetadataAPIRequest(
          {
            query: gql`
              mutation SpiritCreateWebhook($input: CreateWebhookInput!) {
                createWebhook(input: $input) {
                  id
                }
              }
            `,
            variables: {
              input: {
                targetUrl: 'https://example.com/spirit-row-access',
                operations: ['company.updated'],
              },
            },
          },
          ALICE_TOKEN,
        ),
      );
    });

    it('APPLICATIONS: alice cannot install an app or edit the config (PT-20)', async () => {
      expectForbidden(
        await makeMetadataAPIRequest(
          {
            query: gql`
              mutation SpiritInstall($universalIdentifier: String!) {
                installApplication(universalIdentifier: $universalIdentifier) {
                  id
                }
              }
            `,
            variables: {
              universalIdentifier:
                SPIRIT_ROW_ACCESS_APPLICATION_UNIVERSAL_IDENTIFIER,
            },
          },
          ALICE_TOKEN,
        ),
      );
      expectForbidden(
        await updateRowAccessConfigVariable({
          applicationId: rowAccessApp!.applicationId,
          value: '{}',
          token: ALICE_TOKEN,
        }),
      );
    });

    it('MARKETPLACE_APPS: alice cannot upload an app tarball', async () => {
      const { errors } = await uploadAppTarball({
        tarballBuffer: readRowAccessAppTarball(),
        expectToFail: true,
        token: ALICE_TOKEN,
      });

      expect(errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    });

    it('ROLES: alice cannot give herself the Admin role', async () => {
      expectForbidden(
        await makeMetadataAPIRequest(
          {
            query: gql`
              mutation SpiritSelfPromote(
                $workspaceMemberId: UUID!
                $roleId: UUID!
              ) {
                updateWorkspaceMemberRole(
                  workspaceMemberId: $workspaceMemberId
                  roleId: $roleId
                ) {
                  id
                }
              }
            `,
            variables: {
              workspaceMemberId: ALICE_MEMBER_ID,
              roleId: adminRoleId,
            },
          },
          ALICE_TOKEN,
        ),
      );

      expect((await findOneRoleByLabel({ label: 'Member' })).id).toBe(
        memberRoleId,
      );
    });

    it('SECURITY: alice cannot turn on impersonation', async () => {
      expectForbidden(
        await makeMetadataAPIRequest(
          {
            query: gql`
              mutation SpiritSecurity {
                updateWorkspace(data: { allowImpersonation: true }) {
                  id
                }
              }
            `,
          },
          ALICE_TOKEN,
        ),
      );
    });

    it('DATA_MODEL: alice cannot change the owner field', async () => {
      const { accountOwnerFieldMetadataId } =
        await findCompanyAndOwnerFieldIds();

      expectForbidden(
        await makeMetadataAPIRequest(
          {
            query: gql`
              mutation SpiritDataModel($id: UUID!) {
                updateOneField(
                  input: { id: $id, update: { isActive: false } }
                ) {
                  id
                }
              }
            `,
            variables: { id: accountOwnerFieldMetadataId },
          },
          ALICE_TOKEN,
        ),
      );
    });
  });

  describe('AI agents: which role config the runner passes', () => {
    it('an agent run for alice (runAs) reads with her role only, even when the agent role is Admin: A only', async () => {
      const runAsContext =
        await getAppProviderByClassName<AgentActorContextService>(
          'AgentActorContextService',
        ).buildRunAsWorkspaceMemberContext({
          workspaceMemberId: ALICE_MEMBER_ID,
          workspaceId: SEED_APPLE_WORKSPACE_ID,
        });

      const rolePermissionConfig = buildAgentRolePermissionConfig({
        agentRoleId: adminRoleId,
        runAsRoleId: runAsContext.roleId,
      });

      expect(rolePermissionConfig).toEqual({ intersectionOf: [memberRoleId] });

      const ids = await findCompanyIdsWithTool({
        prefix: records.prefix,
        roleId: adminRoleId,
        rolePermissionConfig,
        authContext: runAsContext.authContext,
        userId: USER_DATA_SEED_IDS.JONY,
        userWorkspaceId: USER_WORKSPACE_DATA_SEED_IDS.JONY,
      });

      expect(ids).toEqual([records.companyAId]);
    });

    it('if a runner intersected agent (Admin) and user (Member) roles, alice still gets A only', async () => {
      const ids = await findCompanyIdsWithTool({
        prefix: records.prefix,
        roleId: adminRoleId,
        rolePermissionConfig: { intersectionOf: [adminRoleId, memberRoleId] },
        userId: USER_DATA_SEED_IDS.JONY,
        userWorkspaceId: USER_WORKSPACE_DATA_SEED_IDS.JONY,
      });

      expect(ids).toEqual([records.companyAId]);
    });

    it('an agent with no user and the Admin role reads A, B and C (D4); with the Member role it reads none (D10)', async () => {
      const applicationAuthContext = {
        type: 'application',
        workspace: { id: SEED_APPLE_WORKSPACE_ID },
        application: { id: randomUUID(), defaultRoleId: adminRoleId },
      } as unknown as WorkspaceAuthContext;

      const asAdminAgent = await findCompanyIdsWithTool({
        prefix: records.prefix,
        roleId: adminRoleId,
        rolePermissionConfig: buildAgentRolePermissionConfig({
          agentRoleId: adminRoleId,
        }),
        authContext: applicationAuthContext,
      });
      const asMemberAgent = await findCompanyIdsWithTool({
        prefix: records.prefix,
        roleId: memberRoleId,
        rolePermissionConfig: buildAgentRolePermissionConfig({
          agentRoleId: memberRoleId,
        }),
        authContext: applicationAuthContext,
      });

      expect(asAdminAgent).toEqual(
        [records.companyAId, records.companyBId, records.companyCId].sort(),
      );
      expect(asMemberAgent).toEqual([]);
    });
  });
});
