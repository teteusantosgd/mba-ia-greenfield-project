import { randomUUID } from 'crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import queueConfig from '../config/queue.config';
import { CoreModule } from './core.module';

const QUEUE_NAME = 'core-module-spec';

describe('CoreModule (integration)', () => {
  const prefix = `test-core-${randomUUID()}`;
  let module: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    process.env.QUEUE_PREFIX = prefix;
    module = await Test.createTestingModule({
      imports: [CoreModule, BullModule.registerQueue({ name: QUEUE_NAME })],
    }).compile();
    await module.init();
    queue = module.get<Queue>(getQueueToken(QUEUE_NAME));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
    delete process.env.QUEUE_PREFIX;
  });

  it('connects to Postgres', async () => {
    const dataSource = module.get(DataSource);
    expect(dataSource.isInitialized).toBe(true);
    await expect(dataSource.query('SELECT 1')).resolves.toBeDefined();
  });

  it('keeps jobs under the configured prefix', async () => {
    await queue.add('ping', {});

    const { host, port } = module.get<ConfigType<typeof queueConfig>>(
      queueConfig.KEY,
    );
    const otherPrefix = new Queue(QUEUE_NAME, {
      connection: { host, port },
      prefix: `${prefix}-other`,
    });

    try {
      expect(await queue.getWaitingCount()).toBe(1);
      expect(await otherPrefix.getWaitingCount()).toBe(0);
    } finally {
      await otherPrefix.close();
    }
  });
});
