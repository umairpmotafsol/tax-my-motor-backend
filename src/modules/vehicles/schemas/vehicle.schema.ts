import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VehicleDocument = HydratedDocument<Vehicle>;

/**
 * The vehicle register the registration lookup reads.
 *
 * In production this is a cache in front of the DVLA lookup; here it is
 * the source. Either way the lookup answers from one place, so a plate
 * resolves to the same car in the customer app, the supplier app and
 * the portal.
 */
@Schema({ timestamps: true, collection: 'vehicles' })
export class Vehicle {
  /** Stored without spacing — "AB12CDE" — so lookups cannot miss on format. */
  @Prop({ required: true, unique: true, uppercase: true, trim: true, index: true })
  reg!: string;

  @Prop({ required: true })
  make!: string;

  @Prop({ default: '' })
  variant!: string;

  @Prop({ default: '' })
  colour!: string;

  @Prop({ default: '' })
  vin!: string;

  /** "Petrol", "Diesel", "Hybrid" — the DVLA taxation class. */
  @Prop({ default: 'Petrol' })
  fuelType!: string;

  /** When the register was last refreshed from the DVLA. */
  @Prop({ type: Date, default: () => new Date() })
  lastCheckedAt!: Date;
}

export const VehicleSchema = SchemaFactory.createForClass(Vehicle);
