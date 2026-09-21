import { Global, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { ConfigService } from '@core/config/config.service';
import { EXCHANGES } from '@contracts/messaging/topology';
import { IdentityConfig } from '../config/identity.config';

export const DOMAIN_EVENTS_CLIENT = 'DOMAIN_EVENTS_CLIENT';

/**
 * Identity's only outbound channel: facts published to the `domain.events`
 * topic exchange. It never calls another service — a registration completes
 * whether or not notification-service is running, which is precisely what the
 * event split buys.
 */
@Global()
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: DOMAIN_EVENTS_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<IdentityConfig>) => ({
          transport: Transport.RMQ as const,
          options: {
            urls: [config.get('RABBITMQ_URL')],
            exchange: EXCHANGES.DOMAIN_EVENTS,
            exchangeType: 'topic',
            // Routes on the emitted pattern (the event name) rather than on a
            // queue name, so subscribers bind whatever they care about.
            wildcards: true,
            persistent: true,
          },
        }),
      },
    ]),
  ],
  exports: [ClientsModule],
})
export class MessagingModule {}
