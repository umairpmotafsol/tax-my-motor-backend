import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Error as MongooseError } from 'mongoose';

/**
 * One error shape for every failure, matching what the apps' Axios
 * interceptor already reads: a `message` it can show, alongside the
 * status code.
 *
 * Unexpected errors are logged in full here and reported to the client
 * as a generic message, so an internal detail never leaves the process.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message: string | string[] = 'Something went wrong on our side. Please try again.';
    let error: string | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const shaped = body as { message?: string | string[]; error?: string };
        message = shaped.message ?? exception.message;
        error = shaped.error;
      }
    } else if (exception instanceof MongooseError.ValidationError) {
      status = HttpStatus.BAD_REQUEST;
      message = Object.values(exception.errors).map(e => e.message);
      error = 'Bad Request';
    } else if (exception instanceof MongooseError.CastError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'That identifier is not valid.';
      error = 'Bad Request';
    } else if (isDuplicateKeyError(exception)) {
      status = HttpStatus.CONFLICT;
      message = 'That record already exists.';
      error = 'Conflict';
    }

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        request.method + ' ' + request.url + ' failed',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      error,
      message,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

function isDuplicateKeyError(exception: unknown): boolean {
  return (
    typeof exception === 'object' &&
    exception !== null &&
    (exception as { code?: number }).code === 11000
  );
}
