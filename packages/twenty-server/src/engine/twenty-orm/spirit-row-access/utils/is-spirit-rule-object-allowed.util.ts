import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';

// Standard objects whose reads and child objects were audited for an owner
// rule (design D32). Any other standard object, such as person, is refused
// until it is audited: the system reads that serve users (timeline, sync)
// are only known to be safe for these.
const AUDITED_STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS = new Set<string>([
  STANDARD_OBJECTS.company.universalIdentifier,
  STANDARD_OBJECTS.opportunity.universalIdentifier,
  STANDARD_OBJECTS.task.universalIdentifier,
]);

// A rule may sit on company, opportunity, task, or an object of the
// workspace's own custom application (design D41). Objects of other installed
// apps are refused: that app's logic functions read them under the app's
// role, and those reads were never audited. A system object (workspaceMember
// included) never holds a rule: it follows its parents through the child
// rule, and a direct rule would break sync. The settings page applies the
// same definition.
export const isSpiritRuleObjectAllowed = ({
  flatObjectMetadata,
  workspaceCustomApplicationId,
}: {
  flatObjectMetadata: Pick<
    FlatObjectMetadata,
    'universalIdentifier' | 'isSystem' | 'applicationId'
  >;
  workspaceCustomApplicationId: string | undefined;
}): boolean => {
  if (
    flatObjectMetadata.isSystem ||
    flatObjectMetadata.universalIdentifier ===
      STANDARD_OBJECTS.workspaceMember.universalIdentifier
  ) {
    return false;
  }

  if (
    AUDITED_STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.has(
      flatObjectMetadata.universalIdentifier,
    )
  ) {
    return true;
  }

  return (
    workspaceCustomApplicationId !== undefined &&
    flatObjectMetadata.applicationId === workspaceCustomApplicationId
  );
};
