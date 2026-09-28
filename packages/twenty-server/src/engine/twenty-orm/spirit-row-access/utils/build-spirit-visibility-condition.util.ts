import { isNonEmptyString } from '@sniptt/guards';
import { STANDARD_OBJECTS } from 'twenty-shared/metadata';
import { isDefined } from 'twenty-shared/utils';

import { getFlatFieldsFromFlatObjectMetadata } from 'src/engine/api/graphql/workspace-schema-builder/utils/get-flat-fields-for-flat-object-metadata.util';
import { RelationType } from 'src/engine/metadata-modules/field-metadata/interfaces/relation-type.interface';
import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { findFlatEntityByIdInFlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/utils/find-flat-entity-by-id-in-flat-entity-maps.util';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { isMorphOrRelationFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/utils/is-morph-or-relation-flat-field-metadata.util';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { SPIRIT_OWNER_ALWAYS_FALSE_SQL } from 'src/engine/twenty-orm/spirit-row-access/constants/spirit-owner-condition.constant';
import { type SpiritRowAccessCaller } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-caller.type';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';
import { buildSpiritOwnerCondition } from 'src/engine/twenty-orm/spirit-row-access/utils/build-spirit-owner-condition.util';
import { resolveSpiritOwnerRuleTarget } from 'src/engine/twenty-orm/spirit-row-access/utils/resolve-spirit-owner-rule-target.util';
import { type SqlCondition } from 'src/engine/twenty-orm/types/row-access-policy.type';
import {
  escapeIdentifier,
  removeSqlDDLInjection,
} from 'src/engine/workspace-manager/workspace-migration/utils/remove-sql-injection.util';

export type SpiritVisibilityContext = {
  state: SpiritRowAccessState | undefined;
  caller: SpiritRowAccessCaller;
  flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
  objectIdByNameSingular: Record<string, string>;
  resolveTableExpression: (objectMetadataId: string) => string;
};

// Workflow run output can hold any record the run read (it runs as Admin),
// so while any rule is on only see-all callers read runs.
const SEE_ALL_ONLY_OBJECT_UNIVERSAL_IDENTIFIERS = new Set<string>([
  STANDARD_OBJECTS.workflowRun.universalIdentifier,
]);

// Nesting limit for the generated SQL. A gated parent reached deeper than
// this fails closed.
const MAX_PARENT_DEPTH = 5;

const LINKED_RECORD_ID_FIELD_NAME = 'linkedRecordId';
const LINKED_OBJECT_METADATA_ID_FIELD_NAME = 'linkedObjectMetadataId';

const ALWAYS_FALSE: SqlCondition = {
  sql: SPIRIT_OWNER_ALWAYS_FALSE_SQL,
  parameters: {},
};

type RelationSettings = {
  relationType?: RelationType;
  joinColumnName?: string;
  junctionTargetFieldId?: unknown;
};

type ParentLink = {
  joinColumnName: string;
  parentObjectMetadata: FlatObjectMetadata;
};

type Junction = {
  junctionObjectMetadata: FlatObjectMetadata;
  inverseJoinColumnName: string;
};

type GatingGraph = {
  gatedObjectIds: ReadonlySet<string>;
  linkableObjectIds: ReadonlySet<string>;
  parentLinksByObjectId: ReadonlyMap<string, ParentLink[]>;
  junctionsByObjectId: ReadonlyMap<string, Junction[]>;
  hasLinkedRecordByObjectId: ReadonlyMap<string, boolean>;
};

const hasAnyActiveRule = (state: SpiritRowAccessState | undefined) =>
  !isDefined(state?.config) ||
  state.config.rules.some((rule) => rule.isEnabled);

// A system object (other than workspaceMember) is a child: it follows its
// parents. A non-system object that reaches parents through a system
// junction (note -> noteTarget, task -> taskTarget) follows them too. System
// junction holders (messageThread, calendarEvent) do not: mail and meetings
// stay visible through the people on them, as the timeline shows them;
// only their target rows to a hidden record are hidden.
const isChildCandidate = (flatObjectMetadata: FlatObjectMetadata) =>
  flatObjectMetadata.isSystem === true &&
  flatObjectMetadata.universalIdentifier !==
    STANDARD_OBJECTS.workspaceMember.universalIdentifier;

const getActiveFields = (
  flatObjectMetadata: FlatObjectMetadata,
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>,
) =>
  getFlatFieldsFromFlatObjectMetadata(
    flatObjectMetadata,
    flatFieldMetadataMaps,
  ).filter((field) => field.isActive !== false);

const collectParentLinks = (
  flatObjectMetadata: FlatObjectMetadata,
  flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>,
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>,
): ParentLink[] =>
  getActiveFields(flatObjectMetadata, flatFieldMetadataMaps)
    .filter(isMorphOrRelationFlatFieldMetadata)
    .map((field) => {
      const settings = field.settings as RelationSettings | undefined;

      if (
        settings?.relationType !== RelationType.MANY_TO_ONE ||
        !isNonEmptyString(settings.joinColumnName) ||
        !isNonEmptyString(field.relationTargetObjectMetadataId)
      ) {
        return undefined;
      }

      const parentObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: field.relationTargetObjectMetadataId,
        flatEntityMaps: flatObjectMetadataMaps,
      });

      return isDefined(parentObjectMetadata)
        ? { joinColumnName: settings.joinColumnName, parentObjectMetadata }
        : undefined;
    })
    .filter(isDefined);

const collectSystemJunctions = (
  flatObjectMetadata: FlatObjectMetadata,
  flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>,
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>,
): Junction[] => {
  const junctions: Junction[] = [];
  const seenJunctionObjectIds = new Set<string>();

  getActiveFields(flatObjectMetadata, flatFieldMetadataMaps)
    .filter(isMorphOrRelationFlatFieldMetadata)
    .forEach((field) => {
      const settings = field.settings as RelationSettings | undefined;

      if (
        settings?.relationType !== RelationType.ONE_TO_MANY ||
        !isDefined(settings.junctionTargetFieldId) ||
        !isNonEmptyString(field.relationTargetObjectMetadataId) ||
        !isNonEmptyString(field.relationTargetFieldMetadataId) ||
        seenJunctionObjectIds.has(field.relationTargetObjectMetadataId)
      ) {
        return;
      }

      const junctionObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: field.relationTargetObjectMetadataId,
        flatEntityMaps: flatObjectMetadataMaps,
      });
      const inverseJoinColumnName = (
        findFlatEntityByIdInFlatEntityMaps({
          flatEntityId: field.relationTargetFieldMetadataId,
          flatEntityMaps: flatFieldMetadataMaps,
        })?.settings as RelationSettings | undefined
      )?.joinColumnName;

      if (
        !isDefined(junctionObjectMetadata) ||
        !isChildCandidate(junctionObjectMetadata) ||
        !isNonEmptyString(inverseJoinColumnName)
      ) {
        return;
      }

      seenJunctionObjectIds.add(junctionObjectMetadata.id);
      junctions.push({ junctionObjectMetadata, inverseJoinColumnName });
    });

  return junctions;
};

const gatingGraphCache = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, GatingGraph>>
>();

// Which objects follow the rule at all, computed once per (config, metadata)
// as a fixpoint over the relation graph, so a cycle or a long chain cannot
// make an ungated object (person) look gated.
const getGatingGraph = (context: SpiritVisibilityContext): GatingGraph => {
  const stateKey = context.state ?? gatingGraphCache;
  const byObjectMaps =
    gatingGraphCache.get(stateKey) ??
    new WeakMap<object, WeakMap<object, GatingGraph>>();
  const byFieldMaps =
    byObjectMaps.get(context.flatObjectMetadataMaps) ??
    new WeakMap<object, GatingGraph>();
  const cached = byFieldMaps.get(context.flatFieldMetadataMaps);

  if (isDefined(cached)) {
    return cached;
  }

  const objects = Object.values(
    context.flatObjectMetadataMaps.byUniversalIdentifier,
  ).filter(isDefined);

  const parentLinksByObjectId = new Map<string, ParentLink[]>();
  const junctionsByObjectId = new Map<string, Junction[]>();
  const hasLinkedRecordByObjectId = new Map<string, boolean>();
  const gatedObjectIds = new Set<string>();
  const isAnyRuleActive = hasAnyActiveRule(context.state);

  for (const object of objects) {
    parentLinksByObjectId.set(
      object.id,
      collectParentLinks(
        object,
        context.flatObjectMetadataMaps,
        context.flatFieldMetadataMaps,
      ),
    );
    junctionsByObjectId.set(
      object.id,
      collectSystemJunctions(
        object,
        context.flatObjectMetadataMaps,
        context.flatFieldMetadataMaps,
      ),
    );

    const fieldNames = new Set(
      getActiveFields(object, context.flatFieldMetadataMaps).map(
        (field) => field.name,
      ),
    );

    hasLinkedRecordByObjectId.set(
      object.id,
      isChildCandidate(object) &&
        fieldNames.has(LINKED_RECORD_ID_FIELD_NAME) &&
        fieldNames.has(LINKED_OBJECT_METADATA_ID_FIELD_NAME),
    );

    const ownerTarget = resolveSpiritOwnerRuleTarget({
      state: context.state,
      flatObjectMetadata: object,
      flatFieldMetadataMaps: context.flatFieldMetadataMaps,
      objectIdByNameSingular: context.objectIdByNameSingular,
    });

    if (
      isDefined(ownerTarget.rule) ||
      (isAnyRuleActive &&
        SEE_ALL_ONLY_OBJECT_UNIVERSAL_IDENTIFIERS.has(
          object.universalIdentifier,
        ))
    ) {
      gatedObjectIds.add(object.id);
    }
  }

  if (isAnyRuleActive) {
    let hasChanged = gatedObjectIds.size > 0;

    while (hasChanged) {
      hasChanged = false;

      for (const object of objects) {
        if (gatedObjectIds.has(object.id)) {
          continue;
        }

        const isGatedChild =
          isChildCandidate(object) &&
          ((parentLinksByObjectId.get(object.id) ?? []).some((link) =>
            gatedObjectIds.has(link.parentObjectMetadata.id),
          ) ||
            (hasLinkedRecordByObjectId.get(object.id) === true &&
              gatedObjectIds.size > 0));

        const isGatedJunctionHolder =
          object.isSystem !== true &&
          (junctionsByObjectId.get(object.id) ?? []).some(
            ({ junctionObjectMetadata }) =>
              (parentLinksByObjectId.get(junctionObjectMetadata.id) ?? []).some(
                (link) =>
                  link.parentObjectMetadata.id !== object.id &&
                  gatedObjectIds.has(link.parentObjectMetadata.id),
              ),
          );

        if (isGatedChild || isGatedJunctionHolder) {
          gatedObjectIds.add(object.id);
          hasChanged = true;
        }
      }
    }
  }

  // Records a "linked" activity can name: the sources of junction timeline
  // rules (note, task, calendarEvent, messageThread) and records hanging off
  // them other than their own junction rows (message, attachment), plus
  // rule objects. An activity never names another activity, so objects that
  // carry a linked record themselves are left out. Keeping the list short
  // keeps the SQL (and its JIT) small.
  const junctionHolderIds = new Set(
    objects
      .filter(
        (object) =>
          gatedObjectIds.has(object.id) &&
          (junctionsByObjectId.get(object.id) ?? []).length > 0,
      )
      .map((object) => object.id),
  );
  const linkableObjectIds = new Set<string>(
    objects
      .filter((object) => {
        if (
          !gatedObjectIds.has(object.id) ||
          hasLinkedRecordByObjectId.get(object.id) === true
        ) {
          return false;
        }

        if (junctionHolderIds.has(object.id) || !isChildCandidate(object)) {
          return true;
        }

        return (parentLinksByObjectId.get(object.id) ?? []).some(
          (link) =>
            junctionHolderIds.has(link.parentObjectMetadata.id) &&
            !(junctionsByObjectId.get(link.parentObjectMetadata.id) ?? []).some(
              (junction) => junction.junctionObjectMetadata.id === object.id,
            ),
        );
      })
      .map((object) => object.id),
  );

  const graph: GatingGraph = {
    gatedObjectIds,
    linkableObjectIds,
    parentLinksByObjectId,
    junctionsByObjectId,
    hasLinkedRecordByObjectId,
  };

  byFieldMaps.set(context.flatFieldMetadataMaps, graph);
  byObjectMaps.set(context.flatObjectMetadataMaps, byFieldMaps);
  gatingGraphCache.set(stateKey, byObjectMaps);

  return graph;
};

type BuildArgs = {
  context: SpiritVisibilityContext;
  graph: GatingGraph;
  flatObjectMetadata: FlatObjectMetadata;
  alias: string;
  depth: number;
  objectIdsOnPath: ReadonlySet<string>;
};

const mergeConditions = (
  conditions: SqlCondition[],
): SqlCondition | undefined =>
  conditions.length === 0
    ? undefined
    : {
        sql: conditions.map((condition) => `(${condition.sql})`).join(' AND '),
        parameters: Object.assign(
          {},
          ...conditions.map((condition) => condition.parameters),
        ),
      };

// "the record this column points at is visible", or undefined when the
// target object is not gated. A gated parent already on the path (a cycle in
// the relation graph) counts as never visible, so the row is visible only
// when that link is empty.
const buildParentExists = ({
  args,
  parentObjectMetadata,
  parentAlias,
  sourceColumnSql,
}: {
  args: BuildArgs;
  parentObjectMetadata: FlatObjectMetadata;
  parentAlias: string;
  sourceColumnSql: string;
}): SqlCondition | undefined => {
  const { context, graph, flatObjectMetadata, depth, objectIdsOnPath } = args;

  if (!graph.gatedObjectIds.has(parentObjectMetadata.id)) {
    return undefined;
  }

  if (objectIdsOnPath.has(parentObjectMetadata.id)) {
    return ALWAYS_FALSE;
  }

  const parentCondition = buildVisibility({
    context,
    graph,
    flatObjectMetadata: parentObjectMetadata,
    alias: parentAlias,
    depth: depth + 1,
    objectIdsOnPath: new Set([...objectIdsOnPath, flatObjectMetadata.id]),
  });

  if (!isDefined(parentCondition)) {
    return undefined;
  }

  const quotedParentAlias = escapeIdentifier(parentAlias);

  return {
    sql: `EXISTS (SELECT 1 FROM ${context.resolveTableExpression(
      parentObjectMetadata.id,
    )} ${quotedParentAlias} WHERE ${quotedParentAlias}."id" = ${sourceColumnSql} AND (${parentCondition.sql}))`,
    parameters: parentCondition.parameters,
  };
};

// A row is visible when EVERY non-null link to a gated parent points at a
// parent the caller can see.
const buildChildConditions = (args: BuildArgs): SqlCondition[] => {
  const { graph, flatObjectMetadata, alias, depth } = args;
  const quotedAlias = escapeIdentifier(alias);

  return (graph.parentLinksByObjectId.get(flatObjectMetadata.id) ?? [])
    .map((link, index) => {
      const columnSql = `${quotedAlias}.${escapeIdentifier(link.joinColumnName)}`;
      const parentExists = buildParentExists({
        args,
        parentObjectMetadata: link.parentObjectMetadata,
        parentAlias: `spirit_p${depth}_${index}`,
        sourceColumnSql: columnSql,
      });

      return isDefined(parentExists)
        ? {
            sql: `${columnSql} IS NULL OR ${parentExists.sql}`,
            parameters: parentExists.parameters,
          }
        : undefined;
    })
    .filter(isDefined);
};

// timelineActivity also points at a record through a plain (object id,
// record id) pair, not a relation: a "linked" activity on a visible company
// carries the title and body of the note it links. The linked record must
// be visible too.
const buildLinkedRecordConditions = (args: BuildArgs): SqlCondition[] => {
  const { context, graph, flatObjectMetadata, alias, depth } = args;

  if (graph.hasLinkedRecordByObjectId.get(flatObjectMetadata.id) !== true) {
    return [];
  }

  const quotedAlias = escapeIdentifier(alias);
  const linkedRecordColumnSql = `${quotedAlias}.${escapeIdentifier(LINKED_RECORD_ID_FIELD_NAME)}`;
  const linkedObjectColumnSql = `${quotedAlias}.${escapeIdentifier(LINKED_OBJECT_METADATA_ID_FIELD_NAME)}`;

  return [...graph.linkableObjectIds]
    .map((gatedObjectId, index) => {
      const gatedObjectMetadata = findFlatEntityByIdInFlatEntityMaps({
        flatEntityId: gatedObjectId,
        flatEntityMaps: context.flatObjectMetadataMaps,
      });

      if (!isDefined(gatedObjectMetadata)) {
        return undefined;
      }

      const linkedExists = buildParentExists({
        args,
        parentObjectMetadata: gatedObjectMetadata,
        parentAlias: `spirit_l${depth}_${index}`,
        sourceColumnSql: linkedRecordColumnSql,
      });

      if (!isDefined(linkedExists)) {
        return undefined;
      }

      const objectIdParameterName = `spiritLinkedObject_${removeSqlDDLInjection(alias)}_${index}`;

      // Same shape as a relation link (col IS NULL OR EXISTS …), which the
      // planner turns into a hashed subplan instead of a per-row one.
      return {
        sql: `${linkedObjectColumnSql} IS DISTINCT FROM :${objectIdParameterName} OR ${linkedRecordColumnSql} IS NULL OR ${linkedExists.sql}`,
        parameters: {
          ...linkedExists.parameters,
          [objectIdParameterName]: gatedObjectId,
        },
      };
    })
    .filter(isDefined);
};

const buildJunctionConditions = (args: BuildArgs): SqlCondition[] => {
  const { context, graph, flatObjectMetadata, alias, depth, objectIdsOnPath } =
    args;

  return (graph.junctionsByObjectId.get(flatObjectMetadata.id) ?? [])
    .map(({ junctionObjectMetadata, inverseJoinColumnName }, junctionIndex) => {
      const junctionAlias = `spirit_j${depth}_${junctionIndex}`;
      const quotedJunctionAlias = escapeIdentifier(junctionAlias);
      const junctionArgs: BuildArgs = {
        context,
        graph,
        flatObjectMetadata: junctionObjectMetadata,
        alias: junctionAlias,
        depth: depth + 1,
        objectIdsOnPath: new Set([...objectIdsOnPath, flatObjectMetadata.id]),
      };

      const hiddenLinks = (
        graph.parentLinksByObjectId.get(junctionObjectMetadata.id) ?? []
      )
        .filter(
          (link) => link.parentObjectMetadata.id !== flatObjectMetadata.id,
        )
        .map((link, linkIndex) => {
          const columnSql = `${quotedJunctionAlias}.${escapeIdentifier(link.joinColumnName)}`;
          const parentExists = buildParentExists({
            args: junctionArgs,
            parentObjectMetadata: link.parentObjectMetadata,
            parentAlias: `spirit_p${depth + 1}_${linkIndex}`,
            sourceColumnSql: columnSql,
          });

          return isDefined(parentExists)
            ? {
                sql: `(${columnSql} IS NOT NULL AND NOT ${parentExists.sql})`,
                parameters: parentExists.parameters,
              }
            : undefined;
        })
        .filter(isDefined);

      if (hiddenLinks.length === 0) {
        return undefined;
      }

      // Soft-deleted junction rows count too: a note whose target to a
      // hidden company was soft-deleted with that company stays hidden.
      return {
        sql: `NOT EXISTS (SELECT 1 FROM ${context.resolveTableExpression(
          junctionObjectMetadata.id,
        )} ${quotedJunctionAlias} WHERE ${quotedJunctionAlias}.${escapeIdentifier(
          inverseJoinColumnName,
        )} = ${escapeIdentifier(alias)}."id" AND (${hiddenLinks
          .map((link) => link.sql)
          .join(' OR ')}))`,
        parameters: Object.assign(
          {},
          ...hiddenLinks.map((link) => link.parameters),
        ),
      };
    })
    .filter(isDefined);
};

const buildVisibility = (args: BuildArgs): SqlCondition | undefined => {
  const { context, graph, flatObjectMetadata, alias, depth } = args;

  if (context.caller.kind === 'see-all') {
    return undefined;
  }

  const ownerTarget = resolveSpiritOwnerRuleTarget({
    state: context.state,
    flatObjectMetadata,
    flatFieldMetadataMaps: context.flatFieldMetadataMaps,
    objectIdByNameSingular: context.objectIdByNameSingular,
  });

  if (isDefined(ownerTarget.rule)) {
    return buildSpiritOwnerCondition({
      rule: ownerTarget.rule,
      caller: context.caller,
      alias,
      ownerFieldMetadata: ownerTarget.ownerFieldMetadata,
      workspaceMemberObjectMetadataId:
        ownerTarget.workspaceMemberObjectMetadataId,
    });
  }

  if (!graph.gatedObjectIds.has(flatObjectMetadata.id)) {
    return undefined;
  }

  if (
    SEE_ALL_ONLY_OBJECT_UNIVERSAL_IDENTIFIERS.has(
      flatObjectMetadata.universalIdentifier,
    ) ||
    depth >= MAX_PARENT_DEPTH
  ) {
    return ALWAYS_FALSE;
  }

  return mergeConditions([
    ...(isChildCandidate(flatObjectMetadata)
      ? [...buildChildConditions(args), ...buildLinkedRecordConditions(args)]
      : []),
    ...(flatObjectMetadata.isSystem !== true
      ? buildJunctionConditions(args)
      : []),
  ]);
};

// The full row rule for one alias: the owner rule on a rule object, and on
// child and junction-reached objects "every gated parent is visible".
export const buildSpiritVisibilityCondition = ({
  context,
  flatObjectMetadata,
  alias,
}: {
  context: SpiritVisibilityContext;
  flatObjectMetadata: FlatObjectMetadata;
  alias: string;
}): SqlCondition | undefined => {
  if (context.caller.kind === 'see-all') {
    return undefined;
  }

  return buildVisibility({
    context,
    graph: getGatingGraph(context),
    flatObjectMetadata,
    alias,
    depth: 0,
    objectIdsOnPath: new Set([flatObjectMetadata.id]),
  });
};

// Whether any row of the object can be hidden from a non-see-all caller.
export const isSpiritGatedObject = ({
  context,
  flatObjectMetadata,
}: {
  context: SpiritVisibilityContext;
  flatObjectMetadata: FlatObjectMetadata;
}): boolean =>
  getGatingGraph(context).gatedObjectIds.has(flatObjectMetadata.id);
