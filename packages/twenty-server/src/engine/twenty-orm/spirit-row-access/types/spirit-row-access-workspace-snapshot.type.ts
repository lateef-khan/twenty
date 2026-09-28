import { type FlatEntityMaps } from 'src/engine/metadata-modules/flat-entity/types/flat-entity-maps.type';
import { type OrmFlatFieldMetadata } from 'src/engine/metadata-modules/flat-field-metadata/types/orm-flat-field-metadata.type';
import { type FlatObjectMetadata } from 'src/engine/metadata-modules/flat-object-metadata/types/flat-object-metadata.type';
import { type SpiritRowAccessState } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-state.type';

// The state plus the metadata it was validated against, for code that runs
// outside a repository (the live-update publisher).
export type SpiritRowAccessWorkspaceSnapshot = {
  state: SpiritRowAccessState;
  flatObjectMetadataMaps: FlatEntityMaps<FlatObjectMetadata>;
  flatFieldMetadataMaps: FlatEntityMaps<OrmFlatFieldMetadata>;
  objectIdByNameSingular: Record<string, string>;
};
