import { STANDARD_OBJECTS } from 'twenty-shared/metadata';

import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';

const AUDITED_STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS = new Set<string>([
  STANDARD_OBJECTS.company.universalIdentifier,
  STANDARD_OBJECTS.opportunity.universalIdentifier,
  STANDARD_OBJECTS.task.universalIdentifier,
]);

export const isSpiritRuleObjectAllowed = ({
  flatObjectMetadata,
  workspaceCustomApplicationId,
  ownApplicationIds,
}: {
  flatObjectMetadata: Pick<
    FlatObjectMetadata,
    'universalIdentifier' | 'isSystem' | 'applicationId'
  >;
  workspaceCustomApplicationId: string | undefined;
  ownApplicationIds: string[];
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

  if (ownApplicationIds.includes(flatObjectMetadata.applicationId)) {
    return true;
  }

  return (
    workspaceCustomApplicationId !== undefined &&
    flatObjectMetadata.applicationId === workspaceCustomApplicationId
  );
};
