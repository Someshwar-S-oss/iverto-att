import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError } from '../common/errors';
import { PrismaService } from '../common/prisma.service';
import { AuthUser } from './auth.types';

/**
 * "Which employees may this user see?" — the one answer every list endpoint and
 * every report job uses (§13).
 *
 * ADMIN / HR: the whole tenant. MANAGER: direct reportees, members of the
 * departments they head, and themselves. EMPLOYEE: themselves. A non-empty
 * `site_ids` claim narrows all of the above to those sites.
 */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async employeeWhere(user: AuthUser): Promise<Prisma.EmployeeWhereInput> {
    const where: Prisma.EmployeeWhereInput = { tenantId: user.tenantId };
    if (user.siteIds.length) where.siteId = { in: user.siteIds };

    if (user.role === 'ADMIN' || user.role === 'HR') return where;

    const self = user.employeeId ?? '__none__';
    if (user.role === 'MANAGER') {
      const headed = await this.prisma.department.findMany({
        where: { tenantId: user.tenantId, headEmployeeId: self },
        select: { id: true },
      });
      where.OR = [
        { id: self },
        { managerId: self },
        ...(headed.length ? [{ departmentId: { in: headed.map((d) => d.id) } }] : []),
      ];
      return where;
    }
    where.id = self;
    return where;
  }

  /** 404 rather than 403 so ids outside the scope are indistinguishable from missing ones. */
  async assertEmployee(user: AuthUser, employeeId: string) {
    const employee = await this.prisma.employee.findFirst({
      where: { AND: [await this.employeeWhere(user), { id: employeeId }] },
    });
    if (!employee) throw new AppError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
    return employee;
  }

  /** Can this user decide requests of that employee (manager of / HR / admin)? */
  async assertApprover(user: AuthUser, employeeId: string) {
    if (user.employeeId === employeeId && user.role !== 'ADMIN') {
      throw new AppError(403, 'SELF_APPROVAL', 'You cannot decide your own request');
    }
    if (user.role === 'EMPLOYEE') throw new AppError(403, 'FORBIDDEN', 'Only managers, HR and admins decide requests');
    return this.assertEmployee(user, employeeId);
  }

  /** Self-service: the caller's own employee record. */
  async self(user: AuthUser) {
    if (!user.employeeId) throw new AppError(403, 'NO_EMPLOYEE', 'This login is not linked to an employee');
    const employee = await this.prisma.employee.findFirst({
      where: { id: user.employeeId, tenantId: user.tenantId },
      include: { site: true },
    });
    if (!employee) throw new AppError(403, 'NO_EMPLOYEE', 'This login is not linked to an employee');
    return employee;
  }
}
