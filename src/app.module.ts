import { Module } from '@nestjs/common';
import { A2aController } from './a2a.controller';
import { HealthController } from './health.controller';

@Module({ controllers: [A2aController, HealthController] })
export class AppModule {}
