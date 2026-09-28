import { randomUUID } from 'crypto';

import {
  ADMIN_TOKEN,
  ALICE_MEMBER_ID,
  ALICE_TOKEN,
  BOB_MEMBER_ID,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
  findCompanyAndOwnerFieldIds,
  findCompanyOwnersAsAdmin,
  listCompanyIds,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  cleanupSpiritRowAccessApp,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { createOneOperationFactory } from 'test/integration/graphql/utils/create-one-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { mergeManyOperationFactory } from 'test/integration/graphql/utils/merge-many-operation-factory.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { upsertFieldPermissions } from 'test/integration/graphql/utils/upsert-field-permissions.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';

const COMPANY_FIELDS = 'id name accountOwnerId';

describe('spirit owner row access: create override (PI-2) and column lock (PI-4)', () => {
  let records: SpiritOwnerRecords;

  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  beforeAll(async () => {
    rowAccessApp = await setupSpiritRowAccessApp();
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await destroyCompaniesByPrefix(records.prefix);
  });

  describe('without a column lock on accountOwner', () => {
    it('PT-8: alice creates D, sees it, and owns it', async () => {
      const companyDId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: COMPANY_FIELDS,
          data: { id: companyDId, name: `${records.prefix} D` },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.createCompany.accountOwnerId).toBe(
        ALICE_MEMBER_ID,
      );

      const { ids } = await listCompanyIds({
        token: ALICE_TOKEN,
        prefix: records.prefix,
      });

      expect(ids).toContain(companyDId);
    });

    it('PT-9: GraphQL createOne with owner = bob stores owner = alice', async () => {
      const companyEId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: COMPANY_FIELDS,
          data: {
            id: companyEId,
            name: `${records.prefix} E graphql`,
            accountOwnerId: BOB_MEMBER_ID,
          },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(await findCompanyOwnersAsAdmin([companyEId])).toEqual({
        [companyEId]: ALICE_MEMBER_ID,
      });
    });

    it('PT-9: GraphQL createOne with a nested connect to bob stores owner = alice', async () => {
      const companyId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: COMPANY_FIELDS,
          data: {
            id: companyId,
            name: `${records.prefix} E connect`,
            accountOwner: { connect: { where: { id: BOB_MEMBER_ID } } },
          },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(await findCompanyOwnersAsAdmin([companyId])).toEqual({
        [companyId]: ALICE_MEMBER_ID,
      });
    });

    it('PT-9: GraphQL createMany with owner = bob stores owner = alice on every row', async () => {
      const companyIds = [randomUUID(), randomUUID()];

      const response = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: COMPANY_FIELDS,
          data: companyIds.map((id, index) => ({
            id,
            name: `${records.prefix} E many ${index}`,
            accountOwnerId: BOB_MEMBER_ID,
          })),
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(await findCompanyOwnersAsAdmin(companyIds)).toEqual({
        [companyIds[0]]: ALICE_MEMBER_ID,
        [companyIds[1]]: ALICE_MEMBER_ID,
      });
    });

    it('PT-9: nested create of a company under a person stores owner = alice', async () => {
      const personId = randomUUID();
      const companyId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'person',
          gqlFields: 'id company { id accountOwnerId }',
          data: {
            id: personId,
            jobTitle: `${records.prefix} nested creator`,
            company: {
              create: {
                id: companyId,
                name: `${records.prefix} E nested`,
                accountOwnerId: BOB_MEMBER_ID,
              },
            },
          },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(await findCompanyOwnersAsAdmin([companyId])).toEqual({
        [companyId]: ALICE_MEMBER_ID,
      });
    });

    it('PT-9: REST create with owner = bob stores owner = alice', async () => {
      const companyId = randomUUID();

      const response = await makeRestAPIRequest({
        method: 'post',
        path: '/companies',
        bearer: ALICE_TOKEN,
        body: {
          id: companyId,
          name: `${records.prefix} E rest`,
          accountOwnerId: BOB_MEMBER_ID,
        },
      });

      expect(response.status).toBe(201);
      expect(await findCompanyOwnersAsAdmin([companyId])).toEqual({
        [companyId]: ALICE_MEMBER_ID,
      });
    });

    it('PT-9: import path (createMany upsert: true, insert arm) with owner = bob stores owner = alice', async () => {
      const companyId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: COMPANY_FIELDS,
          upsert: true,
          data: [
            {
              id: companyId,
              name: `${records.prefix} E import`,
              accountOwnerId: BOB_MEMBER_ID,
            },
          ],
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(await findCompanyOwnersAsAdmin([companyId])).toEqual({
        [companyId]: ALICE_MEMBER_ID,
      });
    });

    it('admin create with owner = bob keeps owner = bob (see-all is not overridden)', async () => {
      const companyId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: COMPANY_FIELDS,
          data: {
            id: companyId,
            name: `${records.prefix} admin made`,
            accountOwnerId: BOB_MEMBER_ID,
          },
        }),
        ADMIN_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.createCompany.accountOwnerId).toBe(
        BOB_MEMBER_ID,
      );
    });

    it('D12 without a lock: alice can give her own company away to bob through update', async () => {
      const companyId = randomUUID();

      await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          data: { id: companyId, name: `${records.prefix} give away` },
        }),
        ALICE_TOKEN,
      );

      const response = await makeGraphqlAPIRequest(
        updateOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: companyId,
          data: { accountOwnerId: BOB_MEMBER_ID },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(await findCompanyOwnersAsAdmin([companyId])).toEqual({
        [companyId]: BOB_MEMBER_ID,
      });
    });

    it('upsert claiming hidden B by id does not change B', async () => {
      const response = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: COMPANY_FIELDS,
          upsert: true,
          data: [
            { id: records.companyBId, name: `${records.prefix} B claimed` },
          ],
        }),
        ALICE_TOKEN,
      );

      // The primary key clash shows alice that some hidden row has this id
      expect(response.body.errors?.[0]?.extensions?.code).toBe(
        'BAD_USER_INPUT',
      );
      expect(JSON.stringify(response.body)).not.toContain(records.companyBName);
      expect(await findCompanyOwnersAsAdmin([records.companyBId])).toEqual({
        [records.companyBId]: BOB_MEMBER_ID,
      });
    });
  });

  // D36: the same writes reach bob's rows once the config makes alice
  // see-all, so the refusals come from the rule and not from the key or path.
  describe('control: alice made see-all through the config', () => {
    it('the upsert of B by id updates B', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        try {
          const response = await makeGraphqlAPIRequest(
            createManyOperationFactory({
              objectMetadataSingularName: 'company',
              objectMetadataPluralName: 'companies',
              gqlFields: COMPANY_FIELDS,
              upsert: true,
              data: [
                {
                  id: records.companyBId,
                  name: `${records.prefix} B claimed by see-all`,
                },
              ],
            }),
            ALICE_TOKEN,
          );

          expect(response.body.errors).toBeUndefined();
          expect(response.body.data.createCompanies[0].name).toBe(
            `${records.prefix} B claimed by see-all`,
          );
        } finally {
          await makeGraphqlAPIRequest(
            updateOneOperationFactory({
              objectMetadataSingularName: 'company',
              gqlFields: 'id',
              recordId: records.companyBId,
              data: { name: records.companyBName },
            }),
            ADMIN_TOKEN,
          );
        }
      });
    });

    it('merging two companies of bob works', async () => {
      const keepId = randomUUID();
      const dropId = randomUUID();

      const created = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: 'id',
          data: [
            {
              id: keepId,
              name: `${records.prefix} bob merge keep`,
              accountOwnerId: BOB_MEMBER_ID,
            },
            {
              id: dropId,
              name: `${records.prefix} bob merge drop`,
              accountOwnerId: BOB_MEMBER_ID,
            },
          ],
        }),
        ADMIN_TOKEN,
      );

      expect(created.body.errors).toBeUndefined();

      const response = await withAliceSeeAll(rowAccessApp, () =>
        makeGraphqlAPIRequest(
          mergeManyOperationFactory({
            objectMetadataPluralName: 'companies',
            gqlFields: 'id accountOwnerId',
            ids: [keepId, dropId],
            conflictPriorityIndex: 0,
          }),
          ALICE_TOKEN,
        ),
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.mergeCompanies.id).toBe(keepId);
      expect(response.body.data.mergeCompanies.accountOwnerId).toBe(
        BOB_MEMBER_ID,
      );
    });
  });

  describe('with a column lock on accountOwner for the Member role (PT-10, D3, D12)', () => {
    let memberRoleId: string;
    let companyObjectMetadataId: string;
    let accountOwnerFieldMetadataId: string;

    const lockAccountOwner = (canUpdateFieldValue: boolean | null) =>
      upsertFieldPermissions({
        roleId: memberRoleId,
        fieldPermissions: [
          {
            objectMetadataId: companyObjectMetadataId,
            fieldMetadataId: accountOwnerFieldMetadataId,
            canReadFieldValue: null,
            canUpdateFieldValue,
          },
        ],
      });

    beforeAll(async () => {
      memberRoleId = (await findOneRoleByLabel({ label: 'Member' })).id;
      ({ companyObjectMetadataId, accountOwnerFieldMetadataId } =
        await findCompanyAndOwnerFieldIds());

      const { errors } = await lockAccountOwner(false);

      expect(errors).toBeUndefined();
    });

    afterAll(async () => {
      await lockAccountOwner(null);
    });

    it('PT-10: alice cannot change A owner to bob', async () => {
      const response = await makeGraphqlAPIRequest(
        updateOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: records.companyAId,
          data: { accountOwnerId: BOB_MEMBER_ID },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
      expect(await findCompanyOwnersAsAdmin([records.companyAId])).toEqual({
        [records.companyAId]: ALICE_MEMBER_ID,
      });
    });

    it('PT-10: alice cannot re-send her own id as owner on update (lock fires on same value)', async () => {
      const response = await makeGraphqlAPIRequest(
        updateOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id',
          recordId: records.companyAId,
          data: { accountOwnerId: ALICE_MEMBER_ID },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    });

    it('PT-10: alice can still update other fields of A', async () => {
      const response = await makeGraphqlAPIRequest(
        updateOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: 'id employees',
          recordId: records.companyAId,
          data: { employees: 7 },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.updateCompany.employees).toBe(7);
    });

    it('PI-4: the insert exemption lets alice create with owner = bob under the lock, owner = alice', async () => {
      const companyId = randomUUID();

      const response = await makeGraphqlAPIRequest(
        createOneOperationFactory({
          objectMetadataSingularName: 'company',
          gqlFields: COMPANY_FIELDS,
          data: {
            id: companyId,
            name: `${records.prefix} locked create`,
            accountOwnerId: BOB_MEMBER_ID,
          },
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(await findCompanyOwnersAsAdmin([companyId])).toEqual({
        [companyId]: ALICE_MEMBER_ID,
      });
    });

    it('D12: import update arm (upsert of visible A) with the owner column fails for alice', async () => {
      const response = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: COMPANY_FIELDS,
          upsert: true,
          data: [
            {
              id: records.companyAId,
              name: records.companyAName,
              accountOwnerId: ALICE_MEMBER_ID,
            },
          ],
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    });

    it('D12: import update arm without the owner column works for alice', async () => {
      const response = await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: COMPANY_FIELDS,
          upsert: true,
          data: [{ id: records.companyAId, name: records.companyAName }],
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.createCompanies[0].accountOwnerId).toBe(
        ALICE_MEMBER_ID,
      );
    });

    it('D12: alice merging two of her own companies works under the lock', async () => {
      const keepId = randomUUID();
      const dropId = randomUUID();

      await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: 'id',
          data: [
            { id: keepId, name: `${records.prefix} merge keep` },
            { id: dropId, name: `${records.prefix} merge drop` },
          ],
        }),
        ALICE_TOKEN,
      );

      const response = await makeGraphqlAPIRequest(
        mergeManyOperationFactory({
          objectMetadataPluralName: 'companies',
          gqlFields: 'id accountOwnerId',
          ids: [keepId, dropId],
          conflictPriorityIndex: 0,
        }),
        ALICE_TOKEN,
      );

      // §5.6 predicted the lock would fire. It does not: every record alice
      // can see has her as owner, and the merge drops a join column that more
      // than one record fills (fieldIdByName has no "accountOwnerId" key)
      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.mergeCompanies.id).toBe(keepId);
      expect(response.body.data.mergeCompanies.accountOwnerId).toBe(
        ALICE_MEMBER_ID,
      );
    });

    it('D12: admin merging two companies still works under the Member lock', async () => {
      const keepId = randomUUID();
      const dropId = randomUUID();

      await makeGraphqlAPIRequest(
        createManyOperationFactory({
          objectMetadataSingularName: 'company',
          objectMetadataPluralName: 'companies',
          gqlFields: 'id',
          data: [
            {
              id: keepId,
              name: `${records.prefix} admin merge keep`,
              accountOwnerId: ALICE_MEMBER_ID,
            },
            {
              id: dropId,
              name: `${records.prefix} admin merge drop`,
              accountOwnerId: BOB_MEMBER_ID,
            },
          ],
        }),
        ADMIN_TOKEN,
      );

      const response = await makeGraphqlAPIRequest(
        mergeManyOperationFactory({
          objectMetadataPluralName: 'companies',
          gqlFields: 'id accountOwnerId',
          ids: [keepId, dropId],
          conflictPriorityIndex: 0,
        }),
        ADMIN_TOKEN,
      );

      expect(response.body.errors).toBeUndefined();
      expect(response.body.data.mergeCompanies.id).toBe(keepId);
      expect(response.body.data.mergeCompanies.accountOwnerId).toBe(
        ALICE_MEMBER_ID,
      );
    });

    it('alice merging her A with hidden B does not touch B', async () => {
      const response = await makeGraphqlAPIRequest(
        mergeManyOperationFactory({
          objectMetadataPluralName: 'companies',
          gqlFields: 'id name',
          ids: [records.companyAId, records.companyBId],
          conflictPriorityIndex: 0,
        }),
        ALICE_TOKEN,
      );

      expect(response.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(records.companyBName);
      expect(await findCompanyOwnersAsAdmin([records.companyBId])).toEqual({
        [records.companyBId]: BOB_MEMBER_ID,
      });
    });
  });
});
