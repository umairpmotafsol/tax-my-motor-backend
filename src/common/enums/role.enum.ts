/**
 * Who is calling. One account model serves all three apps; the role is
 * what decides which order book they see and what they may do to it.
 */
export enum Role {
  Customer = 'customer',
  Supplier = 'supplier',
  Admin = 'admin',
}
