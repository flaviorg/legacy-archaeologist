// A modern rewrite of fixtures/legacy-billing/billing.js: ESM, TypeScript, const, arrow functions, a Map for the
// discount codes, a closure for the invoice counter and no global write. Every quirk the characterization tests pin
// is kept on purpose, with the SPEC.md rule it belongs to; changing one of them is a business decision, not a cleanup.
// The calls to Math.random and new Date() happen in the same order as in billing.js, because the recorded values come
// from the seeded random stream and the frozen clock.

export type Customer = { name: string; code: string | null; state: string };
export type InvoiceLine = { qty: number; unitPrice: number };
export type Invoice = { number: string; customer: string; subtotal: number; discount: number; tax: number; total: number; ref: string };

// Sales tax applied to every invoice; Oregon has none (calculateInvoice BR-01).
const TAX_RATE = 0.0725;
const DAY_MS = 86400000;

// roundMoney BR-01 (SB-01): Math.floor(n * 100 + 0.5) rounds an exact negative half cent toward zero, so -0.125
// becomes -0.12, not the -0.13 of half-away-from-zero rounding. Float artifacts (1.005 → 1) are kept as well.
export const roundMoney = (n: number): number => Math.floor(n * 100 + 0.5) / 100;

const DISCOUNTS = new Map<string, number>([
  ["VIP", 0.1],
  ["STAFF", 0.25],
]);

// billing.js looked codes up on a plain object, so a code naming an Object.prototype member ("toString", "valueOf")
// found that member and the result became NaN; kept for codes the Map does not hold.
const rateFor = (key: string): unknown => (DISCOUNTS.has(key) ? DISCOUNTS.get(key) : ({} as Record<string, unknown>)[key]);

export const applyDiscount = (subtotal: number, code: string | null): number => {
  // applyDiscount BR-04: a null (or undefined) code throws a TypeError from .toString().
  const rate = rateFor((code as string).toString());
  // applyDiscount BR-03: an unknown code leaves the subtotal unchanged, with no error.
  if (rate === undefined) {
    return subtotal;
  }
  if (code === "VIP") {
    // applyDiscount BR-01 (SB-02): VIP applies only strictly above 100; exactly 100.00 gets no discount.
    if (subtotal > 100) {
      return subtotal - subtotal * (rate as number);
    }
    return subtotal;
  }
  // applyDiscount BR-02: STAFF always gets its rate, whatever the subtotal.
  return subtotal - subtotal * (rate as number);
};

export const prorate = (amountCents: number, startDate: Date, endDate?: Date): number => {
  // prorate BR-02: without an end date the charge runs until today (new Date(), frozen in the tests).
  const end = endDate || new Date();
  let startDay = startDate.getDate();
  // prorate BR-01: a start on the 31st is billed as if it started on the 30th.
  if (startDay === 31) {
    startDay = 30;
  }
  const daysInMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
  const remaining = daysInMonth - startDay + 1;
  let days = Math.floor((end.getTime() - startDate.getTime()) / DAY_MS) + 1;
  if (days > remaining) {
    days = remaining;
  }
  if (days < 0) {
    days = 0;
  }
  return Math.round(amountCents * days / daysInMonth);
};

export const lateFee = (dueDate: Date, paidDate: Date, amount: number): number => {
  const days = (paidDate.getTime() - dueDate.getTime()) / DAY_MS;
  // lateFee BR-01: 1.5% per started week. lateFee BR-03 (SB-03): paying early gives negative weeks, so the fee is a
  // credit once the payment is at least 7 days early (and -0 for 1 to 6 days early).
  let weeks = Math.ceil(days / 7);
  // lateFee BR-02: at most three weeks.
  if (weeks > 3) {
    weeks = 3;
  }
  return weeks * 0.015 * amount;
};

// nextInvoiceNumber BR-01: the counter starts at 1000 and lives as long as the module instance.
const makeCounter = (start: number): (() => number) => {
  let seq = start;
  return () => {
    seq = seq + 1;
    return seq;
  };
};
const nextSeq = makeCounter(1000);

export const nextInvoiceNumber = (prefix?: string): string => {
  // nextInvoiceNumber BR-02: a given prefix replaces INV; an empty prefix falls back to INV.
  const p = prefix || "INV";
  const seq = nextSeq();
  const year = new Date().getFullYear();
  return p + "-" + year + "-" + seq;
};

export const calculateInvoice = (customer: Customer, lines: InvoiceLine[], cb: (err: Error | null, invoice?: Invoice) => void): void => {
  if (!lines || lines.length === 0) {
    // One argument, as in billing.js: the callback receives the error alone.
    cb(new Error("no lines"));
    return;
  }
  let subtotal = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as InvoiceLine;
    subtotal = subtotal + line.qty * line.unitPrice;
  }
  // calculateInvoice BR-02: the discount rules of applyDiscount, VIP exactly at 100.00 included.
  const discounted = applyDiscount(subtotal, customer.code);
  const taxRate = customer.state === "OR" ? 0 : TAX_RATE;
  const tax = roundMoney(discounted * taxRate);
  // Same keys in the same order as billing.js; the reference comes from Math.random (seeded in the tests).
  const invoice: Invoice = {
    number: nextInvoiceNumber(),
    customer: customer.name,
    subtotal: roundMoney(subtotal),
    discount: roundMoney(subtotal - discounted),
    tax: tax,
    total: roundMoney(discounted + tax),
    ref: "R" + Math.floor(Math.random() * 1000000),
  };
  // billing.js also wrote global.LAST_INVOICE here; the tests never asserted it, and this rewrite drops it.
  cb(null, invoice);
};

export const formatMoney = (cents: number): string => {
  // formatMoney BR-02: -0 prints "0.00" (the sign is lost), while -0.4 prints "-0.00".
  const text = (cents / 100).toFixed(2);
  // formatMoney BR-01: a comma every three digits.
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};
