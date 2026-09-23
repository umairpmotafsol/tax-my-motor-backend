import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { StreamableFile } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/**
 * Wraps every success in `{ success: true, data }`, which is the shape
 * the apps' Axios helpers already unwrap.
 *
 * A file response passes through untouched — wrapping a stream in JSON
 * would corrupt the download.
 */
export interface ApiResponse<T> {
  success: true;
  data: T;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponse<T> | T> {
    return next.handle().pipe(
      map(data =>
        data instanceof StreamableFile ? data : { success: true as const, data },
      ),
    );
  }
}
