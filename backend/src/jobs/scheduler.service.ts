import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CONFIG, type Config } from '../config.js';
import { AccountLifecycleService } from '../platform/account-lifecycle.service.js';
import { NotificationsService } from '../platform/notifications.service.js';
import { StreakService } from '../study/streak.service.js';

const TICK_MS = 5 * 60 * 1000;

@Injectable()
export class SchedulerService implements OnModuleDestroy {
    private readonly logger = new Logger('Scheduler');
    private timer: NodeJS.Timeout | null = null;
    private busy = false;

    constructor(
        @Inject(CONFIG) private readonly config: Config,
        @Inject(StreakService) private readonly streaks: StreakService,
        @Inject(NotificationsService) private readonly notifications: NotificationsService,
        @Inject(AccountLifecycleService) private readonly lifecycle: AccountLifecycleService
    ) {}

    async tick(): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        try {
            const closed = await this.streaks.closeDays();
            if (closed > 0) this.logger.log(`Closed the Lagos day for ${closed} streaks`);
            const reminded = await this.notifications.sendReminders(this.config.appUrl);
            if (reminded > 0) this.logger.log(`Sent ${reminded} reminders`);
            const purged = await this.lifecycle.purgeDue();
            if (purged > 0)
                this.logger.log(`Erased ${purged} accounts after the deletion grace period`);
        } catch (error) {
            this.logger.error(`Scheduler tick failed: ${(error as Error).message}`);
        } finally {
            this.busy = false;
        }
    }

    start() {
        if (this.timer) return;
        this.timer = setInterval(() => void this.tick(), TICK_MS);
        void this.tick();
    }

    onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}
