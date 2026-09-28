export type SpiritRowAccessRule = {
  objectMetadataId: string;
  ownerFieldMetadataId: string;
  isEnabled: boolean;
};

export type SpiritRowAccessConfig = {
  version: 1;
  rules: SpiritRowAccessRule[];
  seeAllRoleIds: string[];
};
