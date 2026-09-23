/**
 * Every ObjectId reference in the app, checked to be an ObjectId path.
 *
 * `@Prop({ type: Types.ObjectId })` compiles without complaint and
 * produces a Mixed path, because Types.ObjectId is the BSON value class
 * rather than a schema type. Mixed is never cast, so a query written
 * with a plain id string — which is all a controller ever has — matches
 * nothing, and `ref` is dropped so populate() returns the raw id. It
 * fails as an empty list, never as an error, which is why it cost a
 * customer's order book, a supplier's order book and token refresh all
 * at once before anyone noticed.
 *
 * The fix is `MongooseSchema.Types.ObjectId`. This test is here so the
 * two spellings can never again be told apart only by a live database.
 */
import { Schema } from 'mongoose';

import { SessionSchema } from '../modules/auth/schemas/session.schema';
import { NotificationSchema } from '../modules/notifications/schemas/notification.schema';
import { OrderSchema } from '../modules/orders/schemas/order.schema';
import { UserSchema } from '../modules/users/schemas/user.schema';

const REFERENCES: [string, Schema, string[]][] = [
  ['Order', OrderSchema, ['customer', 'supplier', 'reassignedFrom', 'invoice.uploadedBy']],
  ['User', UserSchema, ['supplier', 'referredBy']],
  ['Session', SessionSchema, ['user']],
  ['Notification', NotificationSchema, ['order', 'recipient']],
];

describe.each(REFERENCES)('%s schema', (_name, schema, paths) => {
  it.each(paths)('casts %s to an ObjectId', path => {
    const type = schema.path(path);
    expect(type).toBeDefined();
    expect(type.instance).toBe('ObjectId');
  });

  it.each(paths)('keeps the ref on %s, so populate() resolves', path => {
    expect(schema.path(path).options.ref).toBeTruthy();
  });
});
