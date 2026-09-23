/**
 * A Direct Debit order arrives with the customer's mandate details and
 * somebody at the supplier has to check them before the first
 * collection. When a field is wrong the order goes back to the customer
 * with that field named, and returns when they have fixed it — as many
 * times as it takes.
 */
export enum BankField {
  AccountHolder = 'accountHolder',
  AccountNumber = 'accountNumber',
  SortCode = 'sortCode',
  DateOfBirth = 'dateOfBirth',
}

export const BANK_FIELDS: BankField[] = [
  BankField.AccountHolder,
  BankField.AccountNumber,
  BankField.SortCode,
  BankField.DateOfBirth,
];

export const BANK_FIELD_LABEL: Record<BankField, string> = {
  [BankField.AccountHolder]: 'Account holder name',
  [BankField.AccountNumber]: 'Account number',
  [BankField.SortCode]: 'Sort code',
  [BankField.DateOfBirth]: 'Date of birth',
};

export enum BankReviewStatus {
  /** With the supplier, waiting to be looked at. */
  Submitted = 'submitted',
  /** Back with the customer, with the bad fields named. */
  ChangesRequested = 'changes_requested',
  /** Signed off; the mandate can be set up. */
  Approved = 'approved',
}

export enum BankReviewActor {
  Supplier = 'supplier',
  Customer = 'customer',
}
