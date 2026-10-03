import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { SupabaseService } from './supabase.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, SupabaseService],
  exports: [PrismaService, RedisService, SupabaseService],
})
export class CommonModule {}
