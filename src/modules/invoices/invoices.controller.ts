import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { createReadStream, existsSync } from 'fs';
import { join, resolve } from 'path';

import { AuthUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/enums/role.enum';
import { toSupplierOrder } from '../orders/orders.serializer';
import { OrdersService } from '../orders/orders.service';
import { InvoicesService } from './invoices.service';

/** Photographs only. A PDF would be a different flow with a different viewer. */
const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp'];

@ApiTags('invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly config: ConfigService,
  ) {}

  /**
   * The supplier photographs the invoice and uploads it. This is the
   * one action that stops the window.
   */
  @Roles(Role.Supplier)
  @Post(':orderId')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload the photographed invoice for an order' })
  async upload(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    if (!file) {
      throw new BadRequestException('Please attach the invoice photo.');
    }
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      throw new BadRequestException('The invoice has to be a photo.');
    }

    /* Scoped first: a supplier may only upload against their own order. */
    const order = await this.orders.findScoped(orderId, user);
    const stored = await this.invoices.store(order.orderNumber, file);

    const updated = await this.orders.attachInvoice(order, stored, user.userId);
    return toSupplierOrder(updated);
  }

  /**
   * The stored photo.
   *
   * Still the scoped route it always was: an order you may not read is
   * an invoice you may not read, and that check happens before anything
   * touches a store. What it does next depends on where the file went.
   * A Cloudinary invoice is a redirect to the hosted copy — the bytes
   * are not worth proxying, and the app is about to render that same URL
   * in an `<Image>` anyway. A local one is streamed, as before.
   */
  @Get(':orderId/file')
  @ApiOperation({ summary: 'Download the invoice photo for an order' })
  async file(
    @CurrentUser() user: AuthUser,
    @Param('orderId') orderId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const order = await this.orders.findScoped(orderId, user);
    if (!order.invoice) {
      throw new NotFoundException('No invoice has been uploaded for this order yet.');
    }

    if (order.invoice.url) {
      res.redirect(302, order.invoice.url);
      return undefined;
    }

    const root = resolve(this.config.get<string>('uploadDir') ?? './uploads');
    const path = join(root, order.invoice.storageKey);

    /*
     * The stored key is built by this service, but it is still checked
     * against the upload root before it is opened — a path that escapes
     * the directory must never reach the filesystem.
     */
    if (!resolve(path).startsWith(root) || !existsSync(path)) {
      throw new NotFoundException('That invoice file is no longer available.');
    }

    res.set({
      'Content-Type': order.invoice.mimeType,
      'Content-Disposition':
        'inline; filename="' + order.invoice.fileName.replace(/["\\]/g, '') + '"',
      'Cache-Control': 'private, max-age=300',
    });
    return new StreamableFile(createReadStream(path));
  }
}
