import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';

/** Throw with a stable machine-readable code the clients can switch on. */
export class AppError extends HttpException {
  constructor(status: number, code: string, message: string, details?: unknown) {
    super({ code, message, details }, status);
  }
}

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  422: 'VALIDATION_FAILED',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/** Postgres/Prisma errors that are the caller's fault, not ours. */
function fromDatabase(err: any): { status: number; code: string; message: string } | null {
  const pg = err?.meta?.driverAdapterError?.cause ?? err?.cause ?? err;
  const sqlState = pg?.originalCode ?? pg?.code;
  if (err?.code === 'P2002' || sqlState === '23505') return { status: 409, code: 'DUPLICATE', message: 'A record with these values already exists' };
  if (err?.code === 'P2025') return { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
  if (sqlState === '23P01') return { status: 409, code: 'OVERLAP', message: 'Overlaps an existing request or schedule for this employee' };
  if (sqlState === '23514') return { status: 400, code: 'CONSTRAINT_FAILED', message: 'Value rejected by a database constraint' };
  if (err?.code === 'P2003' || sqlState === '23503') return { status: 400, code: 'INVALID_REFERENCE', message: 'Referenced record does not exist' };
  return null;
}

/** Every error leaves as `{ statusCode, code, message, details? }` (§14). */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exceptions');

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== 'http') return;
    const reply = host.switchToHttp().getResponse();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Internal server error';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      code = STATUS_CODES[status] ?? 'ERROR';
      message = exception.message;
      const body = exception.getResponse();
      if (body && typeof body === 'object') {
        const b = body as Record<string, any>;
        if (typeof b.code === 'string') code = b.code;
        if (typeof b.message === 'string') message = b.message;
        if (Array.isArray(b.message)) {
          // class-validator: one message per failed constraint.
          code = 'VALIDATION_FAILED';
          message = 'Validation failed';
          details = b.message;
        }
        if (b.details !== undefined) details = b.details;
      }
    } else {
      const db = fromDatabase(exception);
      if (db) {
        ({ status, code, message } = db);
        this.logger.warn(`Database error ${code}: ${(exception as any)?.message}`, (exception as any)?.stack);
      } else {
        this.logger.error((exception as Error)?.message, (exception as Error)?.stack);
      }
    }

    reply.status(status).send({ statusCode: status, code, message, ...(details !== undefined && { details }) });
  }
}
