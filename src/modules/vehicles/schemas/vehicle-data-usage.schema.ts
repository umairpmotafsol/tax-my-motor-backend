import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VehicleDataUsageDocument = HydratedDocument<VehicleDataUsage>;

/**
 * The day's spend on Vehicle Data Global, counted in the database
 * rather than in memory so a restart — or a second instance behind a
 * load balancer — cannot hand the app a fresh budget.
 */
@Schema({ timestamps: true, collection: 'vehicle_data_usage' })
export class VehicleDataUsage {
  /** UTC day, "2026-09-18". One row per day. */
  @Prop({ required: true, unique: true, index: true })
  day!: string;

  /** Upstream calls made — incremented before the call, never after. */
  @Prop({ type: Number, required: true, default: 0 })
  calls!: number;
}

export const VehicleDataUsageSchema = SchemaFactory.createForClass(VehicleDataUsage);
