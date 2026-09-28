import { randomUUID } from 'crypto';

import gql from 'graphql-tag';
import { createManyOperationFactory } from 'test/integration/graphql/utils/create-many-operation-factory.util';
import { destroyManyOperationFactory } from 'test/integration/graphql/utils/destroy-many-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { findManyObjectMetadata } from 'test/integration/metadata/suites/object-metadata/utils/find-many-object-metadata.util';
import { createOneRole } from 'test/integration/metadata/suites/role/utils/create-one-role.util';
import { deleteOneRole } from 'test/integration/metadata/suites/role/utils/delete-one-role.util';
import { findOneRoleByLabel } from 'test/integration/metadata/suites/role/utils/find-one-role-by-label.util';
import { updateWorkspaceMemberRole } from 'test/integration/metadata/suites/role/utils/update-workspace-member-role.util';
import { isDefined } from 'twenty-shared/utils';

import { WORKSPACE_MEMBER_DATA_SEED_IDS } from 'src/engine/workspace-manager/dev-seeder/data/constants/workspace-member-data-seeds.constant';

// alice = Jony (Member), bob = Tim, admin = Jane, manager = Phil moved to a
// role labelled "Manager", which the test config treats as see-all.
export const ALICE_MEMBER_ID = WORKSPACE_MEMBER_DATA_SEED_IDS.JONY;
export const BOB_MEMBER_ID = WORKSPACE_MEMBER_DATA_SEED_IDS.TIM;
export const MANAGER_MEMBER_ID = WORKSPACE_MEMBER_DATA_SEED_IDS.PHIL;

export const ALICE_TOKEN = APPLE_JONY_MEMBER_ACCESS_TOKEN;
export const ADMIN_TOKEN = APPLE_JANE_ADMIN_ACCESS_TOKEN;
export const MANAGER_TOKEN = APPLE_PHIL_GUEST_ACCESS_TOKEN;

export type SpiritOwnerRecords = {
  prefix: string;
  companyAId: string;
  companyBId: string;
  companyCId: string;
  companyAName: string;
  companyBName: string;
  companyCName: string;
  personOfAId: string;
  personOfBId: string;
};

export const buildSpiritOwnerPrefix = () =>
  `SpiritOwner${randomUUID().slice(0, 8)}`;

export const companyNameFilter = (prefix: string) => ({
  name: { like: `${prefix}%` },
});

export const createSpiritOwnerRecords = async (
  prefix: string,
): Promise<SpiritOwnerRecords> => {
  const records: SpiritOwnerRecords = {
    prefix,
    companyAId: randomUUID(),
    companyBId: randomUUID(),
    companyCId: randomUUID(),
    companyAName: `${prefix} A alice`,
    companyBName: `${prefix} B bob`,
    companyCName: `${prefix} C nobody`,
    personOfAId: randomUUID(),
    personOfBId: randomUUID(),
  };

  const companiesResponse = await makeGraphqlAPIRequest(
    createManyOperationFactory({
      objectMetadataSingularName: 'company',
      objectMetadataPluralName: 'companies',
      gqlFields: 'id accountOwnerId',
      data: [
        {
          id: records.companyAId,
          name: records.companyAName,
          accountOwnerId: ALICE_MEMBER_ID,
        },
        {
          id: records.companyBId,
          name: records.companyBName,
          accountOwnerId: BOB_MEMBER_ID,
        },
        {
          id: records.companyCId,
          name: records.companyCName,
          accountOwnerId: null,
        },
      ],
    }),
    ADMIN_TOKEN,
  );

  expect(companiesResponse.body.errors).toBeUndefined();

  const peopleResponse = await makeGraphqlAPIRequest(
    createManyOperationFactory({
      objectMetadataSingularName: 'person',
      objectMetadataPluralName: 'people',
      gqlFields: 'id',
      data: [
        {
          id: records.personOfAId,
          jobTitle: `${prefix} person of A`,
          companyId: records.companyAId,
        },
        {
          id: records.personOfBId,
          jobTitle: `${prefix} person of B`,
          companyId: records.companyBId,
        },
      ],
    }),
    ADMIN_TOKEN,
  );

  expect(peopleResponse.body.errors).toBeUndefined();

  return records;
};

export const destroyCompaniesByPrefix = async (prefix: string) => {
  await makeGraphqlAPIRequest(
    destroyManyOperationFactory({
      objectMetadataSingularName: 'person',
      objectMetadataPluralName: 'people',
      gqlFields: 'id',
      filter: { jobTitle: { like: `${prefix}%` } },
    }),
    ADMIN_TOKEN,
  );

  await makeGraphqlAPIRequest(
    destroyManyOperationFactory({
      objectMetadataSingularName: 'company',
      objectMetadataPluralName: 'companies',
      gqlFields: 'id',
      filter: companyNameFilter(prefix),
    }),
    ADMIN_TOKEN,
  );
};

export type ManagerRoleSetup = {
  managerRoleId: string;
  originalManagerMemberRoleId: string;
};

export const setupManagerRole = async (): Promise<ManagerRoleSetup> => {
  const guestRole = await findOneRoleByLabel({ label: 'Guest' });

  const { data } = await createOneRole({
    expectToFail: false,
    input: {
      label: 'Manager',
      description: 'Spirit owner row access test: see-all role',
      icon: 'IconSettings',
      canUpdateAllSettings: false,
      canAccessAllTools: true,
      canReadAllObjectRecords: true,
      canUpdateAllObjectRecords: true,
      canSoftDeleteAllObjectRecords: true,
      canDestroyAllObjectRecords: false,
      canBeAssignedToUsers: true,
      canBeAssignedToAgents: false,
      canBeAssignedToApiKeys: false,
    },
  });

  const managerRoleId = data?.createOneRole?.id;

  if (!isDefined(managerRoleId)) {
    throw new Error('Manager role was not created');
  }

  await updateWorkspaceMemberRole({
    input: { roleId: managerRoleId, workspaceMemberId: MANAGER_MEMBER_ID },
    expectToFail: false,
  });

  return { managerRoleId, originalManagerMemberRoleId: guestRole.id };
};

export const cleanupManagerRole = async (
  setup: Partial<ManagerRoleSetup> = {},
) => {
  if (isDefined(setup.originalManagerMemberRoleId)) {
    await updateWorkspaceMemberRole({
      input: {
        roleId: setup.originalManagerMemberRoleId,
        workspaceMemberId: MANAGER_MEMBER_ID,
      },
      expectToFail: false,
    });
  }

  if (isDefined(setup.managerRoleId)) {
    await deleteOneRole({
      expectToFail: false,
      input: { idToDelete: setup.managerRoleId },
    });
  }
};

export const findCompanyAndOwnerFieldIds = async () => {
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

  const company = objects?.find((object) => object.nameSingular === 'company');
  const accountOwner = company?.fieldsList?.find(
    (field) => field.name === 'accountOwner',
  );

  if (!isDefined(company) || !isDefined(accountOwner)) {
    throw new Error('company.accountOwner metadata not found');
  }

  return {
    companyObjectMetadataId: company.id,
    accountOwnerFieldMetadataId: accountOwner.id,
  };
};

export const findCompanyOwnersAsAdmin = async (
  companyIds: string[],
): Promise<Record<string, string | null>> => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritOwnerCompanies($filter: CompanyFilterInput) {
          companies(filter: $filter, first: 100) {
            edges {
              node {
                id
                accountOwnerId
              }
            }
          }
        }
      `,
      variables: { filter: { id: { in: companyIds } } },
    },
    ADMIN_TOKEN,
  );

  expect(response.body.errors).toBeUndefined();

  return Object.fromEntries(
    response.body.data.companies.edges.map(
      (edge: { node: { id: string; accountOwnerId: string | null } }) => [
        edge.node.id,
        edge.node.accountOwnerId,
      ],
    ),
  );
};

export const listCompanyIds = async ({
  token,
  prefix,
}: {
  token: string;
  prefix: string;
}): Promise<{ ids: string[]; errors: unknown }> => {
  const response = await makeGraphqlAPIRequest(
    {
      query: gql`
        query SpiritOwnerCompanyIds($filter: CompanyFilterInput) {
          companies(filter: $filter, first: 100) {
            edges {
              node {
                id
              }
            }
          }
        }
      `,
      variables: { filter: companyNameFilter(prefix) },
    },
    token,
  );

  return {
    ids: (response.body.data?.companies?.edges ?? []).map(
      (edge: { node: { id: string } }) => edge.node.id,
    ),
    errors: response.body.errors,
  };
};
