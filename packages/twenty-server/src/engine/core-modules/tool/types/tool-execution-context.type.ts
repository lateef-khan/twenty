import { type WorkspaceAuthContext } from 'src/engine/core-modules/auth/types/workspace-auth-context.type';
import { type CodeExecutionStreamEmitter } from 'src/engine/core-modules/tool-provider/interfaces/code-execution-stream-emitter.type';
import { type RolePermissionConfig } from 'src/engine/twenty-orm/types/role-permission-config';

export type ToolExecutionContext = {
  workspaceId: string;
  rolePermissionConfig?: RolePermissionConfig;
  authContext?: WorkspaceAuthContext;
  userId?: string;
  userWorkspaceId?: string;
  threadId?: string;
  onCodeExecutionUpdate?: CodeExecutionStreamEmitter;
};
