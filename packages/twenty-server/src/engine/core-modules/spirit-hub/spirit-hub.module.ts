import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { SpiritHubNoteService } from 'src/engine/core-modules/spirit-hub/spirit-hub-note.service';
import { SpiritHubController } from 'src/engine/core-modules/spirit-hub/spirit-hub.controller';
import { UserWorkspaceModule } from 'src/engine/core-modules/user-workspace/user-workspace.module';
import { UserEntity } from 'src/engine/core-modules/user/user.entity';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';

@Module({
  imports: [
    AuthModule,
    UserWorkspaceModule,
    TypeOrmModule.forFeature([UserEntity, WorkspaceEntity]),
  ],
  controllers: [SpiritHubController],
  providers: [SpiritHubNoteService],
})
export class SpiritHubModule {}
