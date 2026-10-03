import { Body, Controller, Delete, Get, Module, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { actorOf, AllowPendingPassword, AuthUser, CurrentUser, ROLES, Role, Roles } from '../auth/auth.types';
import { AppError } from '../common/errors';
import { UsersService } from './users.service';

export class CreateUserDto {
  @IsEmail() email: string;
  @IsString() @MinLength(1) @MaxLength(120) displayName: string;
  @IsIn(ROLES) role: Role;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) siteIds?: string[];
}

export class UpdateUserDto {
  @IsOptional() @IsIn(ROLES) role?: Role;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) siteIds?: string[];
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) displayName?: string;
}

export class ChangePasswordDto {
  @IsString() currentPassword: string;
  @IsString() @MinLength(10) @MaxLength(128) newPassword: string;
}

@ApiTags('users')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles('ADMIN', 'HR')
  list(@CurrentUser() user: AuthUser) {
    return this.users.list(user.tenantId);
  }

  @Post()
  @Roles('ADMIN', 'HR')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUserDto) {
    // Roles and access are an admin capability; HR only grants app access to staff.
    if (user.role === 'HR' && !['EMPLOYEE', 'MANAGER'].includes(dto.role)) {
      throw new AppError(403, 'FORBIDDEN', 'HR can only create EMPLOYEE and MANAGER logins');
    }
    return this.users.createLogin({ ...dto, tenantId: user.tenantId }, actorOf(user));
  }

  @Get(':id')
  @Roles('ADMIN', 'HR')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.get(user.tenantId, id);
  }

  @Patch(':id')
  @Roles('ADMIN')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    return this.users.update(user.tenantId, id, dto, actorOf(user));
  }

  @Delete(':id')
  @Roles('ADMIN')
  deactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.setActive(user.tenantId, id, false, actorOf(user));
  }

  @Post(':id/reactivate')
  @Roles('ADMIN')
  reactivate(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.setActive(user.tenantId, id, true, actorOf(user));
  }

  @Post(':id/reset-password')
  @Roles('ADMIN', 'HR')
  resetPassword(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.users.resetPassword(user.tenantId, id, actorOf(user));
  }
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly users: UsersService) {}

  @Post('password')
  @AllowPendingPassword()
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto) {
    return this.users.changeOwnPassword(user, dto.currentPassword, dto.newPassword);
  }
}

@Module({
  controllers: [UsersController, AuthController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
