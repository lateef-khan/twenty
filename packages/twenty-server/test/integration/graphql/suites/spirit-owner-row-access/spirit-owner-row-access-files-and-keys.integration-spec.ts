import { randomUUID } from 'crypto';

import gql from 'graphql-tag';
import request from 'supertest';
import {
  ADMIN_TOKEN,
  ALICE_MEMBER_ID,
  ALICE_TOKEN,
  BOB_MEMBER_ID,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
  findCompanyOwnersAsAdmin,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  buildCompanyRuleConfig,
  cleanupSpiritRowAccessApp,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
  withRowAccessConfig,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { findOneOperationFactory } from 'test/integration/graphql/utils/find-one-operation-factory.util';
import { generateApiKeyToken } from 'test/integration/graphql/utils/generate-api-key-token.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { uploadFileWithDirectUpload } from 'test/integration/graphql/utils/upload-file-with-direct-upload.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { createOneRole } from 'test/integration/metadata/suites/role/utils/create-one-role.util';
import { deleteOneRole } from 'test/integration/metadata/suites/role/utils/delete-one-role.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { makeMetadataAPIRequest } from 'test/integration/metadata/suites/utils/make-metadata-api-request.util';
import { getAppProviderByClassName } from 'test/integration/utils/get-app-provider-by-class-name.util';
import { ToolCategory } from 'twenty-shared/ai';
import { EmailOperation } from 'twenty-shared/types';
import { isDefined } from 'twenty-shared/utils';

import { type ToolExecutorService } from 'src/engine/core-modules/tool-provider/services/tool-executor.service';
import { type ToolIndexEntry } from 'src/engine/core-modules/tool-provider/types/tool-index-entry.type';
import { type EmailComposerService } from 'src/engine/core-modules/tool/tools/email-tool/email-composer.service';
import { SEED_APPLE_WORKSPACE_ID } from 'src/engine/workspace-manager/dev-seeder/core/constants/seeder-workspaces.constant';
import { USER_WORKSPACE_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-user-workspaces.util';
import { USER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/core/utils/seed-users.util';

const FIND_ATTACHMENTS: ToolIndexEntry = {
  name: 'find_many_attachments',
  label: 'Find attachments',
  description: 'spirit row access test',
  category: ToolCategory.DATABASE_CRUD,
  executionRef: {
    kind: 'database_crud',
    objectNameSingular: 'attachment',
    operation: 'find_many',
  },
};

type ChatCaller = {
  userId: string;
  userWorkspaceId: string;
  roleId: string;
};

// The context the AI chat builds for a tool call: the user's ids and
// { unionOf: [the user's role] }
const chatContext = (caller: ChatCaller) => ({
  workspaceId: SEED_APPLE_WORKSPACE_ID,
  roleId: caller.roleId,
  rolePermissionConfig: { unionOf: [caller.roleId] },
  userId: caller.userId,
  userWorkspaceId: caller.userWorkspaceId,
});

const resultIds = (output: { result?: unknown }) =>
  (
    (output.result as { records?: { id: string }[] } | undefined)?.records ?? []
  ).map((record) => record.id);

type McpToolCallResult = {
  content?: { type: string; text: string }[];
  isError?: boolean;
};

const executeMcpTool = async (
  token: string,
  toolName: string,
  args: Record<string, unknown>,
) => {
  const id = `call-${randomUUID()}`;
  const response = await request(`http://localhost:${APP_PORT}`)
    .post('/mcp')
    .set('Authorization', `Bearer ${token}`)
    .set('Content-Type', 'application/json')
    .set('Accept', 'application/json')
    .send(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id,
        params: {
          name: 'execute_tool',
          arguments: { toolName, arguments: args },
        },
      }),
    );

  expect(response.status).toBe(200);
  expect(response.body.error).toBeUndefined();

  const result = response.body.result as McpToolCallResult;

  return JSON.parse(result.content?.[0]?.text ?? '{}') as {
    success: boolean;
    result?: { records?: { id: string; name?: string }[] };
    error?: string;
  };
};

const findAttachmentFileFieldId = async () => {
  const { objects } = await findManyObjectMetadata({
    expectToFail: false,
    input: { filter: {}, paging: { first: 1000 } },
    gqlFields: `
        id
        nameSingular
        fieldsList {
          id
          name
        }
      `,
  });

  const field = objects
    ?.find((object) => object.nameSingular === 'attachment')
    ?.fieldsList?.find((candidate) => candidate.name === 'file');

  if (!isDefined(field)) {
    throw new Error('attachment.file metadata not found');
  }

  return field.id;
};

const listAttachments = async (token: string, ids: string[]) => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritAttachments($filter: AttachmentFilterInput) {
          attachments(filter: $filter) {
            edges {
              node {
                id
                name
                targetCompanyId
                file {
                  fileId
                  label
                  url
                }
              }
            }
          }
        }
      `,
      variables: { filter: { id: { in: ids } } },
    },
    token,
  );

  return {
    nodes: (response.body.data?.attachments?.edges ?? []).map(
      (edge: {
        node: {
          id: string;
          file: { fileId: string; url: string }[] | null;
        };
      }) => edge.node,
    ),
    errors: response.body.errors,
  };
};

const download = (url: string) => {
  const { pathname, search: query } = new URL(url);

  return request(global.app.getHttpServer()).get(`${pathname}${query}`);
};

describe('spirit owner row access: files, AI email tool, MCP and API keys', () => {
  let records: SpiritOwnerRecords;
  let rowAccessApp: SpiritRowAccessAppSetup | undefined;
  let alice: ChatCaller;

  const attachmentOfA = randomUUID();
  const attachmentOfB = randomUUID();
  const fileContentOfA = `spirit file of A ${randomUUID()}`;
  const fileContentOfB = `spirit file of B ${randomUUID()}`;
  let fileIdOfA: string;
  let fileIdOfB: string;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());

    alice = {
      userId: USER_DATA_SEED_IDS.JONY,
      userWorkspaceId: USER_WORKSPACE_DATA_SEED_IDS.JONY,
      roleId: (await findOneRoleByLabel({ label: 'Member' })).id,
    };

    const fileFieldId = await findAttachmentFileFieldId();

    // Uploaded by the admin, the way the front attaches a file to a record
    fileIdOfA = (
      await uploadFileWithDirectUpload({
        filename: 'spirit-a.txt',
        content: Buffer.from(fileContentOfA),
        fileFolder: 'FilesField',
        fieldMetadataId: fileFieldId,
      })
    ).id;
    fileIdOfB = (
      await uploadFileWithDirectUpload({
        filename: 'spirit-b.txt',
        content: Buffer.from(fileContentOfB),
        fileFolder: 'FilesField',
        fieldMetadataId: fileFieldId,
      })
    ).id;

    const attachments = await makeGraphqlAPIRequest(
      createManyOperationFactory({
        objectMetadataSingularName: 'attachment',
        objectMetadataPluralName: 'attachments',
        gqlFields: 'id',
        data: [
          {
            id: attachmentOfA,
            name: `${records.prefix} file of A`,
            targetCompanyId: records.companyAId,
            file: [{ fileId: fileIdOfA, label: 'spirit-a.txt' }],
          },
          {
            id: attachmentOfB,
            name: `${records.prefix} file of B`,
            targetCompanyId: records.companyBId,
            file: [{ fileId: fileIdOfB, label: 'spirit-b.txt' }],
          },
        ],
      }),
      ADMIN_TOKEN,
    );

    expect(attachments.body.errors).toBeUndefined();
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await makeGraphqlAPIRequest(
      destroyManyOperationFactory({
        objectMetadataSingularName: 'attachment',
        objectMetadataPluralName: 'attachments',
        gqlFields: 'id',
        filter: { id: { in: [attachmentOfA, attachmentOfB] } },
      }),
      ADMIN_TOKEN,
    );
    await destroyCompaniesByPrefix(records.prefix);
  });

  describe('6. file downloads', () => {
    it('alice lists the attachment of A with a working file link, and not the attachment of B', async () => {
      const { nodes, errors } = await listAttachments(ALICE_TOKEN, [
        attachmentOfA,
        attachmentOfB,
      ]);

      expect(errors).toBeUndefined();
      expect(nodes.map((node: { id: string }) => node.id)).toEqual([
        attachmentOfA,
      ]);

      const url = nodes[0].file?.[0]?.url as string;
      const response = await download(url);

      expect(response.status).toBe(200);
      expect(response.text).toBe(fileContentOfA);
    });

    it('no other read gives alice the file id or a file link of B', async () => {
      const companyB = await makeGraphqlAPIRequest(
        findOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields:
            'id attachments { edges { node { id file { fileId url } } } }',
          filter: { id: { eq: records.companyBId } },
        }),
        ALICE_TOKEN,
      );
      const personOfB = await makeGraphqlAPIRequest(
        findOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields:
            'id company { id attachments { edges { node { id file { fileId url } } } } }',
          filter: { id: { eq: records.personOfBId } },
        }),
        ALICE_TOKEN,
      );
      const activities = await makeGraphqlAPIRequest(
        {
          query: gql`
            query SpiritAttachmentActivities(
              $filter: TimelineActivityFilterInput
            ) {
              timelineActivities(filter: $filter, first: 100) {
                edges {
                  node {
                    id
                    properties
                    linkedRecordId
                  }
                }
              }
            }
          `,
          variables: {
            filter: {
              or: [
                { linkedRecordId: { eq: attachmentOfB } },
                { targetCompanyId: { eq: records.companyBId } },
              ],
            },
          },
        },
        ALICE_TOKEN,
      );
      const searched = await search({
        searchInput: `${records.prefix} file`,
        includedObjectNameSingulars: ['attachment'],
        limit: 50,
        accessToken: ALICE_TOKEN,
      });

      expect(personOfB.body.errors).toBeUndefined();
      expect(activities.body.errors).toBeUndefined();
      expect(searched.errors).toBeUndefined();
      // The search also returns seeded attachments that match "file" alone
      expect(
        searched.data.search.edges.map((edge) => edge.node.recordId),
      ).toContain(attachmentOfA);

      for (const body of [
        companyB.body,
        personOfB.body,
        activities.body,
        searched.data,
      ]) {
        expect(JSON.stringify(body)).not.toContain(fileIdOfB);
        expect(JSON.stringify(body)).not.toContain(attachmentOfB);
      }
    });

    it('control: the admin link to the file of B downloads, also without any session (D34: a leaked link works for a day)', async () => {
      const { nodes } = await listAttachments(ADMIN_TOKEN, [attachmentOfB]);
      const url = nodes[0].file?.[0]?.url as string;
      const response = await download(url);

      expect(nodes[0].file?.[0]?.fileId).toBe(fileIdOfB);
      expect(response.status).toBe(200);
      expect(response.text).toBe(fileContentOfB);
    });

    it('control: alice made see-all lists the attachment of B and downloads it', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const { nodes } = await listAttachments(ALICE_TOKEN, [attachmentOfB]);

        expect(nodes.map((node: { id: string }) => node.id)).toEqual([
          attachmentOfB,
        ]);

        const response = await download(nodes[0].file?.[0]?.url as string);

        expect(response.text).toBe(fileContentOfB);
      });
    });
  });

  describe('4. AI tools', () => {
    const dispatchAs = (
      caller: ChatCaller,
      descriptor: ToolIndexEntry,
      args: Record<string, unknown>,
    ) =>
      getAppProviderByClassName<ToolExecutorService>(
        'ToolExecutorService',
      ).dispatch(descriptor, args, chatContext(caller));

    const composeAs = (caller: ChatCaller, fileId: string) =>
      getAppProviderByClassName<EmailComposerService>(
        'EmailComposerService',
      ).composeEmail({
        parameters: {
          recipients: { to: 'someone@example.com' },
          subject: 'spirit row access test',
          body: 'spirit row access test',
          files: [{ id: fileId, name: 'attached.txt' }],
        },
        context: chatContext(caller),
        operation: EmailOperation.SEND,
      });

    it('find_many_attachments (chat tool) gives alice A and never B or its file id', async () => {
      const found = await dispatchAs(alice, FIND_ATTACHMENTS, {
        select: ['id', 'name', 'file'],
        name: { like: `${records.prefix}%` },
      });

      expect(found.success).toBe(true);
      expect(resultIds(found)).toEqual([attachmentOfA]);
      expect(JSON.stringify(found)).not.toContain(fileIdOfB);
    });

    it('control: alice made see-all finds the attachment of B and its file id through the tool', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const found = await dispatchAs(alice, FIND_ATTACHMENTS, {
          select: ['id', 'name', 'file'],
          name: { like: `${records.prefix}%` },
        });

        expect(resultIds(found).sort()).toEqual(
          [attachmentOfA, attachmentOfB].sort(),
        );
        expect(JSON.stringify(found)).toContain(fileIdOfB);
      });
    });

    // D34: accepted. The email tool reads the file by id from the core file
    // table with no row check, so a leaked id is enough.
    it('D34: the email tool (send_email / draft_email / sendEmail compose) attaches the file of B when alice has its id', async () => {
      const composedB = await composeAs(alice, fileIdOfB);
      const composedA = await composeAs(alice, fileIdOfA);

      expect(composedA.success).toBe(true);
      expect(composedB.success).toBe(true);

      if (!composedA.success || !composedB.success) {
        return;
      }

      expect(composedA.data.attachments[0].content.toString()).toBe(
        fileContentOfA,
      );
      expect(composedB.data.attachments[0].content.toString()).toBe(
        fileContentOfB,
      );
    });

    it('PT-17 over MCP (the AI tool path end to end over HTTP): alice lists A only', async () => {
      const asAlice = await executeMcpTool(ALICE_TOKEN, 'find_many_companies', {
        name: { like: `${records.prefix}%` },
        select: ['id', 'name'],
      });
      const asAdmin = await executeMcpTool(ADMIN_TOKEN, 'find_many_companies', {
        name: { like: `${records.prefix}%` },
        select: ['id', 'name'],
      });

      expect(asAlice.success).toBe(true);
      expect(
        (asAlice.result?.records ?? []).map((record) => record.id),
      ).toEqual([records.companyAId]);
      expect(JSON.stringify(asAlice)).not.toContain(records.companyBName);
      expect(
        (asAdmin.result?.records ?? []).map((record) => record.id).sort(),
      ).toEqual(
        [records.companyAId, records.companyBId, records.companyCId].sort(),
      );
    });

    it('PT-17 over MCP, unfiltered "list all companies": every company alice gets is hers', async () => {
      const asAlice = await executeMcpTool(ALICE_TOKEN, 'find_many_companies', {
        select: ['id', 'accountOwnerId'],
        limit: 100,
      });

      const aliceRecords = (asAlice.result?.records ?? []) as {
        id: string;
        accountOwnerId?: string | null;
      }[];

      expect(asAlice.success).toBe(true);
      expect(aliceRecords.length).toBeGreaterThan(0);

      const owners = await findCompanyOwnersAsAdmin(
        aliceRecords.map((record) => record.id),
      );

      expect(
        Object.values(owners).every((owner) => owner === ALICE_MEMBER_ID),
      ).toBe(true);
    });
  });

  describe('5. API key with a non-see-all role', () => {
    let apiKeyRoleId: string | undefined;
    let apiKeyId: string | undefined;
    let apiKeyToken: string;
    let adminApiKeyId: string | undefined;
    let adminApiKeyToken: string;
    const createdCompanyId = randomUUID();

    const createApiKey = (roleId: string, name: string) =>
      makeMetadataAPIRequest({
        query: gql`
          mutation SpiritCreateApiKey($input: CreateApiKeyInput!) {
            createApiKey(input: $input) {
              id
            }
          }
        `,
        variables: {
          input: { name, expiresAt: '2099-01-01T00:00:00Z', roleId },
        },
      });

    const tokenFor = async (id: string) => {
      const response = await generateApiKeyToken({
        apiKeyId: id,
        accessToken: ADMIN_TOKEN,
      });

      expect(response.body.errors).toBeUndefined();

      return response.body.data.generateApiKeyToken.token as string;
    };

    beforeAll(async () => {
      const { data } = await createOneRole({
        expectToFail: false,
        input: {
          label: 'Spirit API role',
          description: 'Spirit owner row access test: non-see-all API role',
          icon: 'IconKey',
          canUpdateAllSettings: false,
          canAccessAllTools: false,
          canReadAllObjectRecords: true,
          canUpdateAllObjectRecords: true,
          canSoftDeleteAllObjectRecords: true,
          canDestroyAllObjectRecords: false,
          canBeAssignedToUsers: false,
          canBeAssignedToAgents: false,
          canBeAssignedToApiKeys: true,
        },
      });

      apiKeyRoleId = data?.createOneRole?.id;

      if (!isDefined(apiKeyRoleId)) {
        throw new Error('API key role was not created');
      }

      const created = await createApiKey(apiKeyRoleId, 'Spirit API key');

      expect(created.body.errors).toBeUndefined();
      apiKeyId = created.body.data.createApiKey.id;
      apiKeyToken = await tokenFor(apiKeyId as string);

      const adminCreated = await createApiKey(
        (await findOneRoleByLabel({ label: 'Admin' })).id,
        'Spirit admin key',
      );

      expect(adminCreated.body.errors).toBeUndefined();
      adminApiKeyId = adminCreated.body.data.createApiKey.id;
      adminApiKeyToken = await tokenFor(adminApiKeyId as string);
    });

    afterAll(async () => {
      await makeGraphqlAPIRequest(
        destroyManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: 'id',
          filter: { id: { eq: createdCompanyId } },
        }),
        ADMIN_TOKEN,
      );

      for (const id of [apiKeyId, adminApiKeyId].filter(isDefined)) {
        await testDataSource
          .query('DELETE FROM core."apiKey" WHERE id = $1', [id])
          .catch(() => {});
      }

      if (isDefined(apiKeyRoleId)) {
        await deleteOneRole({
          expectToFail: false,
          input: { idToDelete: apiKeyRoleId },
        });
      }
    });

    it('the seeded Member role cannot be given to an API key', async () => {
      const memberRole = await findOneRoleByLabel({ label: 'Member' });
      const response = await createApiKey(memberRole.id, 'Spirit member key');

      expect(response.body.data?.createApiKey ?? null).toBeNull();
      expect(response.body.errors).toBeDefined();
    });

    it('D14: createOne through the key stores owner NULL even when it names bob, and the key cannot read the row back', async () => {
      const created = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id name accountOwnerId',
          data: {
            id: createdCompanyId,
            name: `${records.prefix} K made by key`,
            accountOwnerId: BOB_MEMBER_ID,
          },
        }),
        apiKeyToken,
      );

      const owners = await findCompanyOwnersAsAdmin([createdCompanyId]);

      expect(owners).toEqual({ [createdCompanyId]: null });

      const readBack = await makeGraphqlAPIRequest(
        findOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id name',
          filter: { id: { eq: createdCompanyId } },
        }),
        apiKeyToken,
      );
      const list = await makeGraphqlAPIRequest(
        {
          query: gql`
            query SpiritKeyCompanies($filter: CompanyFilterInput) {
              companies(filter: $filter) {
                totalCount
                edges {
                  node {
                    id
                  }
                }
              }
            }
          `,
          variables: { filter: { name: { like: `${records.prefix}%` } } },
        },
        apiKeyToken,
      );

      expect(readBack.body.data?.company ?? null).toBeNull();
      expect(list.body.errors).toBeUndefined();
      expect(list.body.data.companies.totalCount).toBe(0);
      // The row is committed, but the create call returns no row to the key
      // (it errors)
      expect(created.body.data?.createCompany ?? null).toBeNull();
    });

    it('control: an Admin API key reads the new row and A, B, C', async () => {
      const list = await makeGraphqlAPIRequest(
        {
          query: gql`
            query SpiritAdminKeyCompanies($filter: CompanyFilterInput) {
              companies(filter: $filter) {
                edges {
                  node {
                    id
                  }
                }
              }
            }
          `,
          variables: { filter: { name: { like: `${records.prefix}%` } } },
        },
        adminApiKeyToken,
      );

      expect(list.body.errors).toBeUndefined();
      expect(
        list.body.data.companies.edges
          .map((edge: { node: { id: string } }) => edge.node.id)
          .sort(),
      ).toEqual(
        [
          records.companyAId,
          records.companyBId,
          records.companyCId,
          createdCompanyId,
        ].sort(),
      );
    });

    it('control: with the key role made see-all, the key reads its row back', async () => {
      if (!isDefined(rowAccessApp) || !isDefined(apiKeyRoleId)) {
        throw new Error('setup missing');
      }

      await withRowAccessConfig(
        rowAccessApp,
        await buildCompanyRuleConfig({ seeAllRoleIds: [apiKeyRoleId] }),
        async () => {
          const readBack = await makeGraphqlAPIRequest(
            findOneOperationFactory({
              objectMetadataSingularName: 'company',
              gqlFields: 'id',
              filter: { id: { eq: createdCompanyId } },
            }),
            apiKeyToken,
          );

          expect(readBack.body.errors).toBeUndefined();
          expect(readBack.body.data.company.id).toBe(createdCompanyId);
        },
      );
    });
  });
});
