import { Global, Module } from '@nestjs/common';
import { AzureBlobService } from './azure-blob.service';
import { PrismaService } from './prisma.service';
import { RedisService } from './redis.service';
import { SupabaseService } from './supabase.service';

@Global()
@Module({
  providers: [PrismaService, RedisService, SupabaseService, AzureBlobService],
  exports: [PrismaService, RedisService, SupabaseService, AzureBlobService],
})
export class CommonModule {}
