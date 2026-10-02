import type { RmqContext } from '@nestjs/microservices';

import type { ConverterRegistry } from '../converters/converter-registry';
import { ConversionOperationsController } from './conversion-operations.controller';
import type { ConversionOperationsService } from './conversion-operations.service';
import type {
  ConversionHistoryMessageDto,
  ConversionOperationMessageDto,
  ConvertFileMessageDto,
} from './dto/conversion-messages.dto';

describe('ConversionOperationsController', () => {
  const operations = {
    convert: jest.fn().mockResolvedValue('converted'),
    history: jest.fn().mockResolvedValue('page'),
    operation: jest.fn().mockResolvedValue('record'),
    savedResult: jest.fn().mockResolvedValue('file'),
  };
  const registry = {
    formats: jest.fn().mockReturnValue([{ source: 'csv', target: ['json'] }]),
  };
  const controller = new ConversionOperationsController(
    operations as unknown as ConversionOperationsService,
    registry as unknown as ConverterRegistry,
  );

  let ack: jest.Mock;
  let context: RmqContext;

  beforeEach(() => {
    ack = jest.fn();
    const message = {};

    context = {
      getMessage: () => message,
      getChannelRef: () => ({ ack }),
    } as unknown as RmqContext;
  });

  it('converts, and acks', async () => {
    const dto = { operationId: 'op' } as ConvertFileMessageDto;

    await expect(controller.convert(dto, context)).resolves.toBe('converted');
    expect(operations.convert).toHaveBeenCalledWith(dto);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('acks a failed conversion too', async () => {
    operations.convert.mockRejectedValueOnce(new Error('refused'));

    await expect(
      controller.convert({} as ConvertFileMessageDto, context),
    ).rejects.toThrow('refused');
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('lists the formats from the registry', async () => {
    await expect(controller.formats(context)).resolves.toEqual([
      { source: 'csv', target: ['json'] },
    ]);
    expect(ack).toHaveBeenCalled();
  });

  it('serves the history, an operation and a saved result', async () => {
    const page = { userId: 'u' } as ConversionHistoryMessageDto;
    const one = {
      userId: 'u',
      operationId: 'op',
    } as ConversionOperationMessageDto;

    await expect(controller.history(page, context)).resolves.toBe('page');
    await expect(controller.operation(one, context)).resolves.toBe('record');
    await expect(controller.result(one, context)).resolves.toBe('file');
    expect(operations.history).toHaveBeenCalledWith(page);
    expect(operations.operation).toHaveBeenCalledWith(one);
    expect(operations.savedResult).toHaveBeenCalledWith(one);
  });
});
