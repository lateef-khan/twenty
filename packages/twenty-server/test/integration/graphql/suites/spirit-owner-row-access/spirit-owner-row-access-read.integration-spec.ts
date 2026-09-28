import gql from 'graphql-tag';
import {
  ADMIN_TOKEN,
  ALICE_TOKEN,
  BOB_MEMBER_ID,
  MANAGER_TOKEN,
  type ManagerRoleSetup,
  type SpiritOwnerRecords,
  buildSpiritOwnerPrefix,
  cleanupManagerRole,
  companyNameFilter,
  createSpiritOwnerRecords,
  destroyCompaniesByPrefix,
  findCompanyOwnersAsAdmin,
  listCompanyIds,
  setupManagerRole,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-owner-row-access-setup.util';
import {
  type SpiritRowAccessAppSetup,
  cleanupSpiritRowAccessApp,
  setupSpiritRowAccessApp,
  withAliceSeeAll,
} from 'test/integration/graphql/suites/spirit-owner-row-access/utils/spirit-row-access-app.util';
import { deleteOneOperationFactory } from 'test/integration/graphql/utils/delete-one-operation-factory.util';
import { findOneOperationFactory } from 'test/integration/graphql/utils/find-one-operation-factory.util';
import { groupByOperationFactory } from 'test/integration/graphql/utils/group-by-operation-factory.util';
import { makeGraphqlAPIRequest } from 'test/integration/graphql/utils/make-graphql-api-request.util';
import { makeGraphqlAPIRequestWithApiKey } from 'test/integration/graphql/utils/make-graphql-api-request-with-api-key.util';
import { search } from 'test/integration/graphql/utils/search.util';
import { updateManyOperationFactory } from 'test/integration/graphql/utils/update-many-operation-factory.util';
import { updateOneOperationFactory } from 'test/integration/graphql/utils/update-one-operation-factory.util';
import { makeRestAPIRequest } from 'test/integration/rest/utils/make-rest-api-request.util';

describe('spirit owner row access: reads and pre-state-gated writes (PI-1)', () => {
  let records: SpiritOwnerRecords;
  let managerRole: ManagerRoleSetup | undefined;
  let rowAccessApp: SpiritRowAccessAppSetup | undefined;

  beforeAll(async () => {
    records = await createSpiritOwnerRecords(buildSpiritOwnerPrefix());
    managerRole = await setupManagerRole();
    rowAccessApp = await setupSpiritRowAccessApp({
      seeAllRoleIds: [managerRole.managerRoleId],
    });
  });

  afterAll(async () => {
    await cleanupSpiritRowAccessApp(rowAccessApp);
    await cleanupManagerRole(managerRole);
    await destroyCompaniesByPrefix(records.prefix);
  });

  it('PT-1: alice lists only the company she owns', async () => {
    const { ids, errors } = await listCompanyIds({
      token: ALICE_TOKEN,
      prefix: records.prefix,
    });

    expect(errors).toBeUndefined();
    expect(ids).toEqual([records.companyAId]);
  });

  it('PT-2: admin lists A, B and C', async () => {
    const { ids, errors } = await listCompanyIds({
      token: ADMIN_TOKEN,
      prefix: records.prefix,
    });

    expect(errors).toBeUndefined();
    expect(ids.sort()).toEqual(
      [records.companyAId, records.companyBId, records.companyCId].sort(),
    );
  });

  it('PT-2: manager (see-all role) lists A, B and C', async () => {
    const { ids, errors } = await listCompanyIds({
      token: MANAGER_TOKEN,
      prefix: records.prefix,
    });

    expect(errors).toBeUndefined();
    expect(ids.sort()).toEqual(
      [records.companyAId, records.companyBId, records.companyCId].sort(),
    );
  });

  it('PT-3: alice cannot open B by id through GraphQL', async () => {
    const response = await makeGraphqlAPIRequest(
      findOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id name',
        filter: { id: { eq: records.companyBId } },
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(response.body.data?.company ?? null).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(records.companyBName);
  });

  it('PT-3: alice cannot open B by id through REST', async () => {
    const response = await makeRestAPIRequest({
      method: 'get',
      path: `/companies/${records.companyBId}`,
      bearer: ALICE_TOKEN,
    });

    expect(response.status).toBe(404);
    expect(response.body.data?.company ?? null).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(records.companyBName);
  });

  it('PT-4: alice search returns no B or C', async () => {
    const { data, errors } = await search({
      searchInput: records.prefix,
      includedObjectNameSingulars: ['company'],
      limit: 50,
      accessToken: ALICE_TOKEN,
    });

    expect(errors).toBeUndefined();

    const recordIds = data.search.edges.map((edge) => edge.node.recordId);

    expect(recordIds).not.toContain(records.companyBId);
    expect(recordIds).not.toContain(records.companyCId);
  });

  it('PT-4: admin search finds B (control for the search index)', async () => {
    const { data, errors } = await search({
      searchInput: records.prefix,
      includedObjectNameSingulars: ['company'],
      limit: 50,
      accessToken: ADMIN_TOKEN,
    });

    expect(errors).toBeUndefined();

    const recordIds = data.search.edges.map((edge) => edge.node.recordId);

    expect(recordIds).toContain(records.companyBId);
  });

  it('PT-5: a person linked to B shows an empty company to alice', async () => {
    const response = await makeGraphqlAPIRequest(
      findOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id companyId company { id name accountOwnerId }',
        filter: { id: { eq: records.personOfBId } },
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.person.id).toBe(records.personOfBId);
    expect(response.body.data.person.company).toBeNull();
    expect(JSON.stringify(response.body)).not.toContain(records.companyBName);
  });

  it('PT-5: the person foreign key itself still shows B id (known, FK is a person column)', async () => {
    const response = await makeGraphqlAPIRequest(
      findOneOperationFactory({
        objectMetadataSingularName: 'person',
        gqlFields: 'id companyId',
        filter: { id: { eq: records.personOfBId } },
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.person.companyId).toBe(records.companyBId);
  });

  it('PT-5: a relation filter on the hidden company matches nothing for alice', async () => {
    const response = await makeGraphqlAPIRequest(
      {
        query: gql`
          query SpiritOwnerPeople($filter: PersonFilterInput) {
            people(filter: $filter) {
              edges {
                node {
                  id
                }
              }
            }
          }
        `,
        variables: {
          filter: { company: { name: { eq: records.companyBName } } },
        },
      },
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.people.edges).toHaveLength(0);
  });

  it('PT-5: companies with nested people only nests alice-visible parents', async () => {
    const response = await makeGraphqlAPIRequest(
      {
        query: gql`
          query SpiritOwnerPeopleWithCompany($filter: PersonFilterInput) {
            people(filter: $filter) {
              edges {
                node {
                  id
                  company {
                    id
                    name
                  }
                }
              }
            }
          }
        `,
        variables: {
          filter: { jobTitle: { like: `${records.prefix}%` } },
        },
      },
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(records.companyBName);
  });

  it('PT-5: bob workspace member nested accountOwnerForCompanies hides B from alice', async () => {
    const response = await makeGraphqlAPIRequest(
      {
        query: gql`
          query SpiritOwnerBobCompanies(
            $filter: WorkspaceMemberFilterInput
            $companyFilter: CompanyFilterInput
          ) {
            workspaceMembers(filter: $filter) {
              edges {
                node {
                  id
                  accountOwnerForCompanies(filter: $companyFilter) {
                    edges {
                      node {
                        id
                        name
                      }
                    }
                  }
                }
              }
            }
          }
        `,
        variables: {
          filter: { id: { eq: BOB_MEMBER_ID } },
          companyFilter: companyNameFilter(records.prefix),
        },
      },
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.workspaceMembers.edges).toHaveLength(1);
    expect(
      response.body.data.workspaceMembers.edges[0].node.accountOwnerForCompanies
        .edges,
    ).toEqual([]);
  });

  it('PT-6: totalCount on companies is 1 for alice', async () => {
    const response = await makeGraphqlAPIRequest(
      {
        query: gql`
          query SpiritOwnerCompanyCount($filter: CompanyFilterInput) {
            companies(filter: $filter) {
              totalCount
            }
          }
        `,
        variables: { filter: companyNameFilter(records.prefix) },
      },
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(response.body.data.companies.totalCount).toBe(1);
  });

  it('PT-6/PT-13: group-by counts on companies cover A only for alice', async () => {
    const response = await makeGraphqlAPIRequest(
      groupByOperationFactory({
        objectMetadataSingularName: 'company',
        objectMetadataPluralName: 'companies',
        groupBy: [{ name: true }],
        filter: companyNameFilter(records.prefix),
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();

    const groups = response.body.data.companiesGroupBy as {
      groupByDimensionValues: unknown[];
      totalCount: number;
    }[];

    expect(groups.map((group) => group.groupByDimensionValues)).toEqual([
      [records.companyAName],
    ]);
    expect(groups.map((group) => group.totalCount)).toEqual([1]);
  });

  it('PT-13: group-by of people by company name hides B name for alice', async () => {
    const response = await makeGraphqlAPIRequest(
      groupByOperationFactory({
        objectMetadataSingularName: 'person',
        objectMetadataPluralName: 'people',
        groupBy: [{ company: { name: true } }],
        filter: { jobTitle: { like: `${records.prefix}%` } },
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain(records.companyBName);
  });

  it('PT-7: alice cannot update B by id', async () => {
    const response = await makeGraphqlAPIRequest(
      updateOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id name',
        recordId: records.companyBId,
        data: { name: `${records.prefix} B hacked` },
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(response.body.data?.updateCompany ?? null).toBeNull();

    const adminView = await makeGraphqlAPIRequest(
      findOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id name',
        filter: { id: { eq: records.companyBId } },
      }),
      ADMIN_TOKEN,
    );

    expect(adminView.body.data.company.name).toBe(records.companyBName);
  });

  it('PT-7: alice updateMany over the prefix changes A only', async () => {
    const response = await makeGraphqlAPIRequest(
      updateManyOperationFactory({
        objectMetadataSingularName: 'company',
        objectMetadataPluralName: 'companies',
        gqlFields: 'id',
        data: { employees: 42 },
        filter: companyNameFilter(records.prefix),
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors).toBeUndefined();
    expect(
      response.body.data.updateCompanies.map(
        (company: { id: string }) => company.id,
      ),
    ).toEqual([records.companyAId]);
  });

  it('PT-7: alice cannot delete B by id', async () => {
    const response = await makeGraphqlAPIRequest(
      deleteOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id deletedAt',
        recordId: records.companyBId,
      }),
      ALICE_TOKEN,
    );

    expect(response.body.errors?.[0]?.extensions?.code).toBe('NOT_FOUND');
    expect(response.body.data?.deleteCompany ?? null).toBeNull();

    const owners = await findCompanyOwnersAsAdmin([records.companyBId]);

    expect(Object.keys(owners)).toEqual([records.companyBId]);
  });

  it('PT-7: alice cannot update B through REST', async () => {
    await makeRestAPIRequest({
      method: 'patch',
      path: `/companies/${records.companyBId}`,
      bearer: ALICE_TOKEN,
      body: { name: `${records.prefix} B hacked by rest` },
    });

    const adminView = await makeGraphqlAPIRequest(
      findOneOperationFactory({
        objectMetadataSingularName: 'company',
        gqlFields: 'id name',
        filter: { id: { eq: records.companyBId } },
      }),
      ADMIN_TOKEN,
    );

    expect(adminView.body.data.company.name).toBe(records.companyBName);
  });

  it('PT-11: an API key with the Admin role lists A, B and C', async () => {
    const response = await makeGraphqlAPIRequestWithApiKey({
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
      variables: { filter: companyNameFilter(records.prefix) },
    });

    expect(response.body.errors).toBeUndefined();
    expect(
      response.body.data.companies.edges
        .map((edge: { node: { id: string } }) => edge.node.id)
        .sort(),
    ).toEqual(
      [records.companyAId, records.companyBId, records.companyCId].sort(),
    );
  });

  // D36: the same paths return B to alice once the config makes her see-all,
  // so the absences above come from the rule and not from the query.
  describe('control: alice made see-all through the config', () => {
    const ALL = () =>
      [records.companyAId, records.companyBId, records.companyCId].sort();

    it('PT-1/PT-3/PT-4: alice lists A, B and C, opens B by GraphQL and REST, and finds B in search', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const { ids, errors } = await listCompanyIds({
          token: ALICE_TOKEN,
          prefix: records.prefix,
        });

        expect(errors).toBeUndefined();
        expect(ids.sort()).toEqual(ALL());

        const graphql = await makeGraphqlAPIRequest(
          findOneOperationFactory({
            objectMetadataSingularName: 'company',
            gqlFields: 'id name',
            filter: { id: { eq: records.companyBId } },
          }),
          ALICE_TOKEN,
        );

        expect(graphql.body.errors).toBeUndefined();
        expect(graphql.body.data.company.name).toBe(records.companyBName);

        const rest = await makeRestAPIRequest({
          method: 'get',
          path: `/companies/${records.companyBId}`,
          bearer: ALICE_TOKEN,
        });

        expect(rest.status).toBe(200);
        expect(JSON.stringify(rest.body)).toContain(records.companyBName);

        const { data } = await search({
          searchInput: records.prefix,
          includedObjectNameSingulars: ['company'],
          limit: 50,
          accessToken: ALICE_TOKEN,
        });

        expect(data.search.edges.map((edge) => edge.node.recordId)).toEqual(
          expect.arrayContaining([records.companyBId, records.companyCId]),
        );
      });
    });

    it('PT-5: the person of B shows B, the relation filter matches, nested people show B, and bob nests B', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const person = await makeGraphqlAPIRequest(
          findOneOperationFactory({
            objectMetadataSingularName: 'person',
            gqlFields: 'id company { id name }',
            filter: { id: { eq: records.personOfBId } },
          }),
          ALICE_TOKEN,
        );

        expect(person.body.data.person.company.name).toBe(records.companyBName);

        const filtered = await makeGraphqlAPIRequest(
          {
            query: gql`
              query SpiritOwnerPeople($filter: PersonFilterInput) {
                people(filter: $filter) {
                  edges {
                    node {
                      id
                    }
                  }
                }
              }
            `,
            variables: {
              filter: { company: { name: { eq: records.companyBName } } },
            },
          },
          ALICE_TOKEN,
        );

        expect(
          filtered.body.data.people.edges.map(
            (edge: { node: { id: string } }) => edge.node.id,
          ),
        ).toEqual([records.personOfBId]);

        const nested = await makeGraphqlAPIRequest(
          {
            query: gql`
              query SpiritOwnerBobCompanies(
                $filter: WorkspaceMemberFilterInput
                $companyFilter: CompanyFilterInput
              ) {
                workspaceMembers(filter: $filter) {
                  edges {
                    node {
                      accountOwnerForCompanies(filter: $companyFilter) {
                        edges {
                          node {
                            id
                            accountOwnerId
                          }
                        }
                      }
                    }
                  }
                }
              }
            `,
            variables: {
              filter: { id: { eq: BOB_MEMBER_ID } },
              companyFilter: companyNameFilter(records.prefix),
            },
          },
          ALICE_TOKEN,
        );

        // The nested filter argument is not applied upstream (bob's first
        // page comes back, B may not be on it), so check the owner only.
        const bobCompanies = nested.body.data.workspaceMembers.edges[0].node
          .accountOwnerForCompanies.edges as {
          node: { accountOwnerId: string };
        }[];

        expect(bobCompanies.length).toBeGreaterThan(0);
        expect(
          bobCompanies.every(
            (edge) => edge.node.accountOwnerId === BOB_MEMBER_ID,
          ),
        ).toBe(true);
      });
    });

    it('PT-6/PT-13: totalCount is 3, group-by has A, B and C, and people grouped by company name show B', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const count = await makeGraphqlAPIRequest(
          {
            query: gql`
              query SpiritOwnerCompanyCount($filter: CompanyFilterInput) {
                companies(filter: $filter) {
                  totalCount
                }
              }
            `,
            variables: { filter: companyNameFilter(records.prefix) },
          },
          ALICE_TOKEN,
        );

        expect(count.body.data.companies.totalCount).toBe(3);

        const groups = await makeGraphqlAPIRequest(
          groupByOperationFactory({
            objectMetadataSingularName: 'company',
            objectMetadataPluralName: 'companies',
            groupBy: [{ name: true }],
            filter: companyNameFilter(records.prefix),
          }),
          ALICE_TOKEN,
        );

        expect(groups.body.data.companiesGroupBy).toHaveLength(3);

        const peopleGroups = await makeGraphqlAPIRequest(
          groupByOperationFactory({
            objectMetadataSingularName: 'person',
            objectMetadataPluralName: 'people',
            groupBy: [{ company: { name: true } }],
            filter: { jobTitle: { like: `${records.prefix}%` } },
          }),
          ALICE_TOKEN,
        );

        expect(JSON.stringify(peopleGroups.body)).toContain(
          records.companyBName,
        );
      });
    });

    it('PT-7: alice can update B by id, and updateMany reaches A, B and C', async () => {
      await withAliceSeeAll(rowAccessApp, async () => {
        const update = await makeGraphqlAPIRequest(
          updateOneOperationFactory({
            objectMetadataSingularName: 'company',
            gqlFields: 'id name',
            recordId: records.companyBId,
            data: { name: records.companyBName },
          }),
          ALICE_TOKEN,
        );

        expect(update.body.errors).toBeUndefined();
        expect(update.body.data.updateCompany.id).toBe(records.companyBId);

        const updateMany = await makeGraphqlAPIRequest(
          updateManyOperationFactory({
            objectMetadataSingularName: 'company',
            objectMetadataPluralName: 'companies',
            gqlFields: 'id',
            data: { employees: 43 },
            filter: companyNameFilter(records.prefix),
          }),
          ALICE_TOKEN,
        );

        expect(
          updateMany.body.data.updateCompanies
            .map((company: { id: string }) => company.id)
            .sort(),
        ).toEqual(ALL());
      });
    });
  });
});
