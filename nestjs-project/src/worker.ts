import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // On SIGTERM the BullMQ worker finishes the active job before closing.
  app.enableShutdownHooks();
}
void bootstrap();
