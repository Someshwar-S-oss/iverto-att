import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { RlsInterceptor } from '../common/rls';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ScopeService } from './scope.service';

@Global()
@Module({
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_INTERCEPTOR, useClass: RlsInterceptor },
    JwtAuthGuard,
    ScopeService,
  ],
  exports: [ScopeService, JwtAuthGuard],
})
export class AuthModule {}
