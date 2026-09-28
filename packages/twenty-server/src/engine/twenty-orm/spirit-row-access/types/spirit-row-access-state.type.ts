import { type SpiritRowAccessConfig } from 'src/engine/twenty-orm/spirit-row-access/types/spirit-row-access-config.type';

export type SpiritRowAccessConfigStatus =
  | 'ok'
  | 'application-missing'
  | 'variable-missing'
  | 'unreadable'
  | 'invalid';

// Loaded once per workspace context while enforcement is on. A null config
// (any status other than ok) fails closed.
export type SpiritRowAccessState = {
  config: SpiritRowAccessConfig | null;
  configStatus: SpiritRowAccessConfigStatus;
  configProblems: string[];
  adminRoleId: string | null;
};
