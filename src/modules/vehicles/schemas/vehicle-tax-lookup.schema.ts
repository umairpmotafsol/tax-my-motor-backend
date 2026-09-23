import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type VehicleTaxLookupDocument = HydratedDocument<VehicleTaxLookup>;

/**
 * One paid answer from Vehicle Data Global, kept so it is never paid
 * for twice.
 *
 * Deliberately not on a Mongo TTL index: an expired row is still the
 * best answer available when the budget is spent or the provider is
 * down, so staleness is decided when it is read, and the row itself
 * lives until the next successful refresh replaces it.
 */
@Schema({ timestamps: true, collection: 'vehicle_tax_lookups' })
export class VehicleTaxLookup {
  /** Stored without spacing — "AB12CDE" — to match the vehicle register. */
  @Prop({ required: true, unique: true, uppercase: true, trim: true, index: true })
  reg!: string;

  /**
   * The provider's response as it arrived. Kept server-side only — it
   * carries fields the apps have no business showing and the billing
   * block besides — but kept, so a mapping fix or a support question
   * never costs another lookup.
   */
  @Prop({ type: Object, default: null })
  raw!: Record<string, unknown> | null;

  /**
   * The identity package's response, when one is configured. Separate
   * from `raw` because it is a separate billed call and may be absent
   * on a row whose tax half succeeded.
   */
  @Prop({ type: Object, default: null })
  detailsRaw!: Record<string, unknown> | null;

  /** The mapped, customer-safe view — what the API actually serves. */
  @Prop({ type: Object, required: true })
  details!: Record<string, unknown>;

  /**
   * The mapped identity — make, model, colour, VIN, fuel type — as the
   * registration screen and the V62 need it. Stored alongside the tax
   * view so entering a plate and pricing it cost one call between them,
   * not one each.
   */
  @Prop({ type: Object, default: null })
  vehicle!: Record<string, unknown> | null;

  /**
   * Which build of the mapper produced `details`.
   *
   * A mapping fix has to reach rows cached before it — the VED table a
   * car is priced from was being read wrongly, and every row already
   * stored carried that wrong figure until its TTL ran out. Stamping
   * the version here lets a stale mapping be spotted on read and
   * rebuilt from `raw`, so the fix lands on the next request instead of
   * a day later, and without buying the plate again.
   *
   * Defaults to 0, which is older than any released mapper, so rows
   * written before this field existed are re-mapped once.
   */
  @Prop({ type: Number, default: 0, index: true })
  mappingVersion!: number;

  /** Where this row came from: a real call, or the documented sample in development. */
  @Prop({ required: true, enum: ['live', 'sample'], default: 'live' })
  source!: 'live' | 'sample';

  /** When the provider was actually called — what freshness is measured against. */
  @Prop({ type: Date, required: true, default: () => new Date() })
  fetchedAt!: Date;
}

export const VehicleTaxLookupSchema = SchemaFactory.createForClass(VehicleTaxLookup);
