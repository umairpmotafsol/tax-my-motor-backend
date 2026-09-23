import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CounterDocument = HydratedDocument<Counter>;

/**
 * Sequence numbers, one document per sequence.
 *
 * Order numbers are handed out with a single atomic `$inc` against this
 * collection rather than by counting existing orders — two customers
 * checking out at the same moment would otherwise be given the same
 * number, and ORD-1042 has to mean one order.
 */
@Schema({ collection: 'counters', versionKey: false })
export class Counter {
  @Prop({ required: true, unique: true })
  key!: string;

  @Prop({ required: true, default: 0 })
  value!: number;
}

export const CounterSchema = SchemaFactory.createForClass(Counter);
