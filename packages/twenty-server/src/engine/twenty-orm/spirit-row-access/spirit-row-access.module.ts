import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RelatedPersonIdsModule } from 'src/engine/core-modules/related-person-ids/related-person-ids.module';
import { SecretEncryptionModule } from 'src/engine/core-modules/secret-encryption/secret-encryption.module';
import { WorkspaceEntity } from 'src/engine/core-modules/workspace/workspace.entity';
import { SpiritLiveEventService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-live-event.service';
import { SpiritRowAccessStateService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-state.service';
import { SpiritRowAccessSwitchService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-row-access-switch.service';
import { SpiritTimelineAccessService } from 'src/engine/twenty-orm/spirit-row-access/services/spirit-timeline-access.service';
import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';

@Global()
@Module({
  imports: [
    SecretEncryptionModule,
    WorkspaceCacheModule,
    TypeOrmModule.forFeature([WorkspaceEntity]),
    RelatedPersonIdsModule,
  ],
  providers: [
    SpiritRowAccessStateService,
    SpiritRowAccessSwitchService,
    SpiritLiveEventService,
    SpiritTimelineAccessService,
  ],
  exports: [
    SpiritRowAccessStateService,
    SpiritLiveEventService,
    SpiritTimelineAccessService,
  ],
})
export class SpiritRowAccessModule {}
