import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { FieldMetadataType } from 'twenty-shared/types';

import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type SpiritRowAccessCaller } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-caller.type';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import {
  buildSpiritVisibilityCondition,
  isSpiritGatedObject,
  type SpiritVisibilityContext,
} from 'src/engine/twenty-orm/spirit-row-access/utils/build-spirit-visibility-condition.util';

// A small copy of the standard relation graph: the objects and links that
// design §5.9 names. Child links are MORPH_RELATION where the real ones are.
type ObjectSpec = {
  name: string;
  isSystem: boolean;
  universalIdentifier?: string;
};

type LinkSpec = {
  from: string;
  name: string;
  to: string;
  type?: FieldMetadataType.RELATION | FieldMetadataType.MORPH_RELATION;
};

const OBJECTS: ObjectSpec[] = [
  { name: 'workspaceMember', isSystem: true },
  { name: 'company', isSystem: false },
  { name: 'person', isSystem: false },
  { name: 'opportunity', isSystem: false },
  { name: 'note', isSystem: false },
  { name: 'noteTarget', isSystem: true },
  { name: 'task', isSystem: false },
  { name: 'taskTarget', isSystem: true },
  { name: 'attachment', isSystem: true },
  { name: 'timelineActivity', isSystem: true },
  { name: 'messageThread', isSystem: true },
  { name: 'messageThreadTarget', isSystem: true },
  { name: 'calendarEvent', isSystem: true },
  { name: 'calendarEventTarget', isSystem: true },
  { name: 'workflowRun', isSystem: true },
];

const MORPH = FieldMetadataType.MORPH_RELATION;

const MANY_TO_ONE_LINKS: LinkSpec[] = [
  { from: 'company', name: 'accountOwner', to: 'workspaceMember' },
  { from: 'person', name: 'company', to: 'company' },
  { from: 'opportunity', name: 'owner', to: 'workspaceMember' },
  { from: 'opportunity', name: 'company', to: 'company' },
  { from: 'task', name: 'assignee', to: 'workspaceMember' },
  { from: 'noteTarget', name: 'note', to: 'note' },
  { from: 'noteTarget', name: 'targetCompany', to: 'company', type: MORPH },
  { from: 'noteTarget', name: 'targetPerson', to: 'person', type: MORPH },
  {
    from: 'noteTarget',
    name: 'targetOpportunity',
    to: 'opportunity',
    type: MORPH,
  },
  { from: 'taskTarget', name: 'task', to: 'task' },
  { from: 'taskTarget', name: 'targetCompany', to: 'company', type: MORPH },
  { from: 'taskTarget', name: 'targetPerson', to: 'person', type: MORPH },
  {
    from: 'taskTarget',
    name: 'targetOpportunity',
    to: 'opportunity',
    type: MORPH,
  },
  { from: 'attachment', name: 'targetCompany', to: 'company', type: MORPH },
  { from: 'attachment', name: 'targetPerson', to: 'person', type: MORPH },
  { from: 'attachment', name: 'targetNote', to: 'note', type: MORPH },
  { from: 'attachment', name: 'targetTask', to: 'task', type: MORPH },
  { from: 'timelineActivity', name: 'workspaceMember', to: 'workspaceMember' },
  {
    from: 'timelineActivity',
    name: 'targetCompany',
    to: 'company',
    type: MORPH,
  },
  { from: 'timelineActivity', name: 'targetPerson', to: 'person', type: MORPH },
  {
    from: 'timelineActivity',
    name: 'targetOpportunity',
    to: 'opportunity',
    type: MORPH,
  },
  { from: 'timelineActivity', name: 'targetNote', to: 'note', type: MORPH },
  { from: 'timelineActivity', name: 'targetTask', to: 'task', type: MORPH },
  { from: 'messageThreadTarget', name: 'messageThread', to: 'messageThread' },
  {
    from: 'messageThreadTarget',
    name: 'targetCompany',
    to: 'company',
    type: MORPH,
  },
  {
    from: 'messageThreadTarget',
    name: 'targetPerson',
    to: 'person',
    type: MORPH,
  },
  { from: 'calendarEventTarget', name: 'calendarEvent', to: 'calendarEvent' },
  {
    from: 'calendarEventTarget',
    name: 'targetCompany',
    to: 'company',
    type: MORPH,
  },
  {
    from: 'calendarEventTarget',
    name: 'targetPerson',
    to: 'person',
    type: MORPH,
  },
];

// The junction holders: note -> noteTarget, task -> taskTarget,
// messageThread -> messageThreadTarget, calendarEvent -> calendarEventTarget.
const JUNCTIONS: { holder: string; junction: string; backLink: string }[] = [
  { holder: 'note', junction: 'noteTarget', backLink: 'note' },
  { holder: 'task', junction: 'taskTarget', backLink: 'task' },
  {
    holder: 'messageThread',
    junction: 'messageThreadTarget',
    backLink: 'messageThread',
  },
  {
    holder: 'calendarEvent',
    junction: 'calendarEventTarget',
    backLink: 'calendarEvent',
  },
];

const objectId = (name: string) => `object-${name}`;
const fieldId = (objectName: string, fieldName: string) =>
  `field-${objectName}-${fieldName}`;
const ownerFieldId = {
  company: fieldId('company', 'accountOwner'),
  opportunity: fieldId('opportunity', 'owner'),
  task: fieldId('task', 'assignee'),
};

type GraphInput = {
  objects: ObjectSpec[];
  links: LinkSpec[];
  junctions: typeof JUNCTIONS;
  linkedRecordObjects: string[];
};

const buildMaps = (entities: { id: string; universalIdentifier: string }[]) =>
  ({
    byUniversalIdentifier: Object.fromEntries(
      entities.map((entity) => [entity.universalIdentifier, entity]),
    ),
    universalIdentifierById: Object.fromEntries(
      entities.map((entity) => [entity.id, entity.universalIdentifier]),
    ),
    universalIdentifiersByApplicationId: {},
  }) as unknown as FlatEntityMaps<never>;

const buildMetadata = ({
  objects,
  links,
  junctions,
  linkedRecordObjects,
}: GraphInput) => {
  const fields: Record<string, unknown>[] = [];

  for (const link of links) {
    fields.push({
      id: fieldId(link.from, link.name),
      universalIdentifier: `uid-${fieldId(link.from, link.name)}`,
      objectMetadataId: objectId(link.from),
      name: link.name,
      type: link.type ?? FieldMetadataType.RELATION,
      isActive: true,
      relationTargetObjectMetadataId: objectId(link.to),
      relationTargetFieldMetadataId: undefined,
      settings: {
        relationType: RelationType.MANY_TO_ONE,
        joinColumnName: `${link.name}Id`,
      },
    });
  }

  for (const { holder, junction, backLink } of junctions) {
    fields.push({
      id: fieldId(holder, `${junction}s`),
      universalIdentifier: `uid-${fieldId(holder, `${junction}s`)}`,
      objectMetadataId: objectId(holder),
      name: `${junction}s`,
      type: FieldMetadataType.RELATION,
      isActive: true,
      relationTargetObjectMetadataId: objectId(junction),
      relationTargetFieldMetadataId: fieldId(junction, backLink),
      settings: {
        relationType: RelationType.ONE_TO_MANY,
        junctionTargetFieldId: fieldId(junction, 'targetCompany'),
      },
    });
  }

  for (const name of linkedRecordObjects) {
    for (const column of ['linkedRecordId', 'linkedObjectMetadataId']) {
      fields.push({
        id: fieldId(name, column),
        universalIdentifier: `uid-${fieldId(name, column)}`,
        objectMetadataId: objectId(name),
        name: column,
        type: FieldMetadataType.UUID,
        isActive: true,
      });
    }
  }

  const flatObjectMetadataMaps = buildMaps(
    objects.map((object) => ({
      id: objectId(object.name),
      universalIdentifier:
        object.universalIdentifier ??
        STANDARD_OBJECTS[object.name as keyof typeof STANDARD_OBJECTS]
          ?.universalIdentifier ??
        `uid-${object.name}`,
      nameSingular: object.name,
      isSystem: object.isSystem,
      isActive: true,
      fieldIds: fields
        .filter((field) => field.objectMetadataId === objectId(object.name))
        .map((field) => field.id as string),
    })),
  ) as unknown as FlatEntityMaps<FlatObjectMetadata>;

  const flatFieldMetadataMaps = buildMaps(
    fields as { id: string; universalIdentifier: string }[],
  ) as unknown as FlatEntityMaps<OrmFlatFieldMetadata>;

  return {
    flatObjectMetadataMaps,
    flatFieldMetadataMaps,
    objectIdByNameSingular: Object.fromEntries(
      objects.map((object) => [object.name, objectId(object.name)]),
    ),
  };
};

const STANDARD_GRAPH = buildMetadata({
  objects: OBJECTS,
  links: MANY_TO_ONE_LINKS,
  junctions: JUNCTIONS,
  linkedRecordObjects: ['timelineActivity'],
});

const ALICE: SpiritRowAccessCaller = {
  kind: 'owner',
  workspaceMemberId: 'alice-member-id',
};

const buildState = (
  ruleObjects: (keyof typeof ownerFieldId)[],
): SpiritRowAccessState => ({
  config: {
    version: 1,
    rules: ruleObjects.map((name) => ({
      objectMetadataId: objectId(name),
      ownerFieldMetadataId: ownerFieldId[name],
      isEnabled: true,
    })),
    seeAllRoleIds: [],
  },
  configStatus: 'ok',
  configProblems: [],
  adminRoleId: 'role-admin',
});

const COMPANY_RULE_STATE = buildState(['company']);
const SPIRIT_RULES_STATE = buildState(['company', 'opportunity', 'task']);
const NO_RULE_STATE = buildState([]);
const FAIL_CLOSED_STATE: SpiritRowAccessState = {
  config: null,
  configStatus: 'application-missing',
  configProblems: ['application-missing'],
  adminRoleId: 'role-admin',
};

const buildContext = (
  state: SpiritRowAccessState,
  caller: SpiritRowAccessCaller = ALICE,
  graph = STANDARD_GRAPH,
): SpiritVisibilityContext => ({
  state,
  caller,
  ...graph,
  resolveTableExpression: (id) => `"workspace"."${id}"`,
});

const findObject = (name: string, graph = STANDARD_GRAPH) =>
  Object.values(graph.flatObjectMetadataMaps.byUniversalIdentifier).find(
    (object) => object?.nameSingular === name,
  ) as FlatObjectMetadata;

const gatedSet = (context: SpiritVisibilityContext) =>
  OBJECTS.map((object) => object.name)
    .filter((name) =>
      isSpiritGatedObject({ context, flatObjectMetadata: findObject(name) }),
    )
    .sort();

const conditionFor = (
  name: string,
  context: SpiritVisibilityContext,
  graph = STANDARD_GRAPH,
) =>
  buildSpiritVisibilityCondition({
    context,
    flatObjectMetadata: findObject(name, graph),
    alias: name,
  });

describe('buildSpiritVisibilityCondition: the gated set (design §5.9)', () => {
  it('with the Company rule on: company, workflowRun, note, task, their targets, attachment, timelineActivity, and the mail and meeting target rows', () => {
    expect(gatedSet(buildContext(COMPANY_RULE_STATE))).toEqual(
      [
        'company',
        'workflowRun',
        'note',
        'task',
        'noteTarget',
        'taskTarget',
        'attachment',
        'timelineActivity',
        'messageThreadTarget',
        'calendarEventTarget',
      ].sort(),
    );
  });

  it('with the Company rule on, person, opportunity, messageThread and calendarEvent stay open', () => {
    const context = buildContext(COMPANY_RULE_STATE);

    for (const name of [
      'person',
      'opportunity',
      'messageThread',
      'calendarEvent',
      'workspaceMember',
    ]) {
      expect(conditionFor(name, context)).toBeUndefined();
    }
  });

  it('with the Spirit rules (Company, Opportunity, Task) opportunity joins the set; person and the mail and meetings stay open', () => {
    expect(gatedSet(buildContext(SPIRIT_RULES_STATE))).toEqual(
      [
        'company',
        'opportunity',
        'workflowRun',
        'note',
        'task',
        'noteTarget',
        'taskTarget',
        'attachment',
        'timelineActivity',
        'messageThreadTarget',
        'calendarEventTarget',
      ].sort(),
    );
  });

  it('with no enabled rule nothing is gated and nothing is filtered (D6)', () => {
    const context = buildContext(NO_RULE_STATE);

    expect(gatedSet(context)).toEqual([]);

    for (const { name } of OBJECTS) {
      expect(conditionFor(name, context)).toBeUndefined();
    }
  });

  it('with no usable config every object with an owner-shaped relation is closed, and its children follow (fail closed, §5.2)', () => {
    const context = buildContext(FAIL_CLOSED_STATE);

    expect(gatedSet(context)).toEqual(
      [
        'company',
        'opportunity',
        'task',
        'timelineActivity',
        'workflowRun',
        'note',
        'noteTarget',
        'taskTarget',
        'attachment',
        'messageThreadTarget',
        'calendarEventTarget',
      ].sort(),
    );

    for (const name of ['company', 'opportunity', 'task', 'timelineActivity']) {
      expect(conditionFor(name, context)).toEqual({
        sql: '1=0',
        parameters: {},
      });
    }
  });
});

describe('buildSpiritVisibilityCondition: conditions', () => {
  const context = buildContext(COMPANY_RULE_STATE);

  it('a rule object gets the owner condition of §5.4 and nothing else', () => {
    expect(conditionFor('company', context)).toEqual({
      sql: '"company"."accountOwnerId" = :spiritOwner_company',
      parameters: { spiritOwner_company: 'alice-member-id' },
    });
  });

  it('a see-all caller gets no condition on any object', () => {
    const seeAll = buildContext(COMPANY_RULE_STATE, { kind: 'see-all' });

    for (const { name } of OBJECTS) {
      expect(conditionFor(name, seeAll)).toBeUndefined();
    }
  });

  it('a caller with no member gets always-false on a rule object (D10)', () => {
    expect(
      conditionFor(
        'company',
        buildContext(COMPANY_RULE_STATE, {
          kind: 'owner',
          workspaceMemberId: null,
        }),
      ),
    ).toEqual({ sql: '1=0', parameters: {} });
  });

  it('workflowRun is see-all only while a rule is on (D17)', () => {
    expect(conditionFor('workflowRun', context)).toEqual({
      sql: '1=0',
      parameters: {},
    });
    expect(
      conditionFor('workflowRun', buildContext(NO_RULE_STATE)),
    ).toBeUndefined();
  });

  it('a child row needs its gated parent visible when the link is set, and ignores open parents', () => {
    const condition = conditionFor('noteTarget', context);

    expect(condition?.sql).toContain(
      '"noteTarget"."targetCompanyId" IS NULL OR EXISTS (SELECT 1 FROM "workspace"."object-company"',
    );
    expect(condition?.sql).not.toContain('targetPersonId');
    expect(condition?.sql).not.toContain('targetOpportunityId');
    expect(Object.values(condition?.parameters ?? {})).toContain(
      'alice-member-id',
    );
  });

  it('a note is hidden when any of its target rows points at a hidden record (every parent, D15)', () => {
    const condition = conditionFor('note', context);

    expect(condition?.sql).toMatch(
      /^\(NOT EXISTS \(SELECT 1 FROM "workspace"\."object-noteTarget" "spirit_j0_0" WHERE "spirit_j0_0"\."noteId" = "note"\."id"/,
    );
    expect(condition?.sql).toContain(
      '"spirit_j0_0"."targetCompanyId" IS NOT NULL AND NOT EXISTS',
    );
    expect(condition?.sql).not.toContain('targetPersonId');
  });

  it('with the Opportunity rule on too, a note target must pass both its company and its opportunity', () => {
    const condition = conditionFor(
      'noteTarget',
      buildContext(SPIRIT_RULES_STATE),
    );

    expect(condition?.sql).toContain('"noteTarget"."targetCompanyId" IS NULL');
    expect(condition?.sql).toContain(
      '"noteTarget"."targetOpportunityId" IS NULL',
    );
    expect(condition?.sql).toContain(') AND (');
  });

  it('a task under the Task rule is judged by its assignee alone, not its targets (§5.9)', () => {
    expect(conditionFor('task', buildContext(SPIRIT_RULES_STATE))).toEqual({
      sql: '"task"."assigneeId" = :spiritOwner_task',
      parameters: { spiritOwner_task: 'alice-member-id' },
    });
  });

  it('a timeline activity checks its linked record for note and task, never for another activity', () => {
    const condition = conditionFor('timelineActivity', context);
    const linkedObjectIds = Object.entries(condition?.parameters ?? {})
      .filter(([name]) => name.startsWith('spiritLinkedObject_'))
      .map(([, value]) => value);

    expect(linkedObjectIds).toEqual(
      expect.arrayContaining([objectId('note'), objectId('task')]),
    );
    expect(linkedObjectIds).not.toContain(objectId('timelineActivity'));
    expect(linkedObjectIds).not.toContain(objectId('person'));

    for (const linkedObjectId of linkedObjectIds) {
      expect(gatedSet(context)).toContain(
        (linkedObjectId as string).replace('object-', ''),
      );
    }
  });

  it('a mail thread target row to a hidden company is hidden; the thread itself is not (D16)', () => {
    expect(conditionFor('messageThreadTarget', context)?.sql).toContain(
      '"messageThreadTarget"."targetCompanyId" IS NULL OR EXISTS',
    );
    expect(conditionFor('messageThread', context)).toBeUndefined();
  });
});

describe('buildSpiritVisibilityCondition: limits fail closed', () => {
  it('a cycle of system children counts the repeated parent as never visible', () => {
    const graph = buildMetadata({
      objects: [
        { name: 'workspaceMember', isSystem: true },
        { name: 'company', isSystem: false },
        { name: 'loopA', isSystem: true },
        { name: 'loopB', isSystem: true },
      ],
      links: [
        { from: 'company', name: 'accountOwner', to: 'workspaceMember' },
        { from: 'loopA', name: 'company', to: 'company' },
        { from: 'loopA', name: 'loopB', to: 'loopB' },
        { from: 'loopB', name: 'loopA', to: 'loopA' },
      ],
      junctions: [],
      linkedRecordObjects: [],
    });
    const context = buildContext(COMPANY_RULE_STATE, ALICE, graph);

    // loopB -> loopA -> loopB: the second loopB is on the path, so a row of
    // loopB is visible only when that link is empty.
    const condition = conditionFor('loopB', context, graph);

    expect(condition?.sql).toContain('."loopBId" IS NULL OR 1=0');
    expect(condition?.sql).toContain('."companyId" IS NULL OR EXISTS');
  });

  it('a chain deeper than 5 gated parents is always false past the limit', () => {
    const chain = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
    const graph = buildMetadata({
      objects: [
        { name: 'workspaceMember', isSystem: true },
        { name: 'company', isSystem: false },
        ...chain.map((name) => ({ name, isSystem: true })),
      ],
      links: [
        { from: 'company', name: 'accountOwner', to: 'workspaceMember' },
        { from: 'c1', name: 'company', to: 'company' },
        ...chain
          .slice(1)
          .map((name, index) => ({ from: name, name: 'up', to: chain[index] })),
      ],
      junctions: [],
      linkedRecordObjects: [],
    });
    const context = buildContext(COMPANY_RULE_STATE, ALICE, graph);

    expect(conditionFor('c5', context, graph)?.sql).not.toContain('1=0');
    expect(conditionFor('c6', context, graph)?.sql).toContain('1=0');
  });
});
