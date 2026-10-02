import {
  Controller,
  UseFilters,
  UseInterceptors,
  ValidationPipe,
} from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';

import {
  CONVERSION_RPC_PATTERNS,
  type ConversionFormatEntry,
  type ConversionHistoryPage,
  type ConversionOperationRecord,
  type ConversionResultFile,
  type ConvertFileResponse,
} from '@contracts/messages/conversion.messages';
import { RpcAppExceptionFilter } from '@core/errors/rpc-app-exception.filter';
import { RmqAckInterceptor, settleRpc } from '@core/messaging/rmq-ack';
import { ConverterRegistry } from '../converters/converter-registry';
import { ConversionOperationsService } from './conversion-operations.service';
import {
  ConversionHistoryMessageDto,
  ConversionOperationMessageDto,
  ConvertFileMessageDto,
} from './dto/conversion-messages.dto';

/** Mirrors the gateway's global pipe — this boundary is validated separately. */
const messageValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});

/**
 * `conversion.rpc`: what the gateway asks of this service and waits for.
 *
 * The ack interceptor is on this controller rather than global, because the
 * same service also consumes the family work queues, whose handlers settle
 * their messages themselves (ack, retry, dead letter).
 */
@Controller()
@UseFilters(RpcAppExceptionFilter)
@UseInterceptors(RmqAckInterceptor)
export class ConversionOperationsController {
  constructor(
    private readonly operations: ConversionOperationsService,
    private readonly registry: ConverterRegistry,
  ) {}

  @MessagePattern(CONVERSION_RPC_PATTERNS.CONVERT)
  async convert(
    @Payload(messageValidationPipe) dto: ConvertFileMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ConvertFileResponse> {
    return settleRpc(context, () => this.operations.convert(dto));
  }

  @MessagePattern(CONVERSION_RPC_PATTERNS.FORMATS)
  async formats(@Ctx() context: RmqContext): Promise<ConversionFormatEntry[]> {
    return settleRpc(context, () => Promise.resolve(this.registry.formats()));
  }

  @MessagePattern(CONVERSION_RPC_PATTERNS.HISTORY_LIST)
  async history(
    @Payload(messageValidationPipe) dto: ConversionHistoryMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ConversionHistoryPage> {
    return settleRpc(context, () => this.operations.history(dto));
  }

  @MessagePattern(CONVERSION_RPC_PATTERNS.HISTORY_GET)
  async operation(
    @Payload(messageValidationPipe) dto: ConversionOperationMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ConversionOperationRecord> {
    return settleRpc(context, () => this.operations.operation(dto));
  }

  @MessagePattern(CONVERSION_RPC_PATTERNS.HISTORY_RESULT)
  async result(
    @Payload(messageValidationPipe) dto: ConversionOperationMessageDto,
    @Ctx() context: RmqContext,
  ): Promise<ConversionResultFile> {
    return settleRpc(context, () => this.operations.savedResult(dto));
  }
}
