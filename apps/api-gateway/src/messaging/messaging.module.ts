import { Global, Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';

import { ConfigService } from '@core/config/config.service';
import { EXCHANGES, QUEUES } from '@contracts/messaging/topology';
import { GatewayConfig } from '../config/gateway.config';

export const IDENTITY_CLIENT = 'IDENTITY_CLIENT';
export const CONVERSION_COMMANDS_CLIENT = 'CONVERSION_COMMANDS_CLIENT';

/**
 * The gateway's two outbound channels, deliberately kept distinct:
 *
 * - identity is **request/response** over a plain queue — the caller waits;
 * - conversion work is a **command** published to a direct exchange and routed
 *   by format family, so the ffmpeg workers and the sharp workers are separate
 *   deployments consuming separate queues.
 */
@Global()
@Module({
  imports: [
    ClientsModule.registerAsync([
      {
        name: IDENTITY_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<GatewayConfig>) => ({
          transport: Transport.RMQ as const,
          options: {
            urls: [config.get('RABBITMQ_URL')],
            queue: QUEUES.IDENTITY_RPC,
            queueOptions: { durable: true },
            persistent: true,
          },
        }),
      },
      {
        name: CONVERSION_COMMANDS_CLIENT,
        inject: [ConfigService],
        useFactory: (config: ConfigService<GatewayConfig>) => ({
          transport: Transport.RMQ as const,
          options: {
            urls: [config.get('RABBITMQ_URL')],
            exchange: EXCHANGES.CONVERSION_COMMANDS,
            exchangeType: 'direct',
            // Routes by the emitted pattern (`convert.<family>`) instead of by
            // queue name.
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
