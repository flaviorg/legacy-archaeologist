/*
 * billing.js
 *
 * Invoice helpers for the billing service. Used by the nightly invoice job,
 * the customer portal and the monthly reports. Handle with care.
 */

// running counter for invoice numbers
var _seq = 1000;

// sales tax applied to every invoice (Oregon has no sales tax)
var TAX_RATE = 0.0725;

/**
 * Rounds an amount of money to cents.
 * @param {number} n amount in dollars
 * @returns {number}
 */
function roundMoney(n) {
  return Math.floor(n * 100 + 0.5) / 100;
}

/*
 * Discount codes and their rates.
 * VIP customers get their discount on larger orders only.
 */
var DISCOUNTS = { VIP: 0.1, STAFF: 0.25 };

/**
 * Applies the discount for a customer code to a subtotal.
 * @param {number} subtotal
 * @param {string} code
 * @returns {number}
 */
function applyDiscount(subtotal, code) {
  var rate = DISCOUNTS[code.toString()];
  if (rate === undefined) {
    return subtotal;
  }
  if (code === "VIP") {
    if (subtotal > 100) {
      return subtotal - subtotal * rate;
    }
    return subtotal;
  }
  return subtotal - subtotal * rate;
}

/**
 * Prorates a monthly charge from startDate until endDate (or today),
 * never past the end of the month.
 * @param {number} amountCents monthly charge in cents
 * @param {Date} startDate
 * @param {Date} [endDate]
 * @returns {number} cents
 */
function prorate(amountCents, startDate, endDate) {
  var end = endDate || new Date();
  var startDay = startDate.getDate();
  if (startDay === 31) {
    startDay = 30;
  }
  var daysInMonth = new Date(startDate.getFullYear(), startDate.getMonth() + 1, 0).getDate();
  var remaining = daysInMonth - startDay + 1;
  var days = Math.floor((end.getTime() - startDate.getTime()) / 86400000) + 1;
  if (days > remaining) {
    days = remaining;
  }
  if (days < 0) {
    days = 0;
  }
  return Math.round(amountCents * days / daysInMonth);
}

/**
 * Late fee: 1.5% of the amount per started week, at most 3 weeks.
 * @param {Date} dueDate
 * @param {Date} paidDate
 * @param {number} amount
 * @returns {number}
 */
function lateFee(dueDate, paidDate, amount) {
  var days = (paidDate.getTime() - dueDate.getTime()) / 86400000;
  var weeks = Math.ceil(days / 7);
  if (weeks > 3) {
    weeks = 3;
  }
  return weeks * 0.015 * amount;
}

/**
 * Next invoice number, for example INV-2023-1001.
 * @param {string} [prefix]
 * @returns {string}
 */
function nextInvoiceNumber(prefix) {
  var p = prefix || "INV";
  _seq = _seq + 1;
  var year = new Date().getFullYear();
  return p + "-" + year + "-" + _seq;
}

/**
 * Builds an invoice for a customer and passes it to cb(err, invoice).
 * @param {{ name: string, code: string, state: string }} customer
 * @param {{ qty: number, unitPrice: number }[]} lines
 * @param {function} cb
 */
function calculateInvoice(customer, lines, cb) {
  if (!lines || lines.length === 0) {
    cb(new Error("no lines"));
    return;
  }
  var subtotal = 0;
  for (var i = 0; i < lines.length; i++) {
    subtotal = subtotal + lines[i].qty * lines[i].unitPrice;
  }
  var discounted = applyDiscount(subtotal, customer.code);
  var taxRate = customer.state === "OR" ? 0 : TAX_RATE;
  var tax = roundMoney(discounted * taxRate);
  var invoice = {
    number: nextInvoiceNumber(),
    customer: customer.name,
    subtotal: roundMoney(subtotal),
    discount: roundMoney(subtotal - discounted),
    tax: tax,
    total: roundMoney(discounted + tax),
    ref: "R" + Math.floor(Math.random() * 1000000)
  };
  global.LAST_INVOICE = invoice;
  cb(null, invoice);
}

/**
 * Formats cents as dollars with thousands separators, for example 1,234.50.
 * @param {number} cents
 * @returns {string}
 */
function formatMoney(cents) {
  var text = (cents / 100).toFixed(2);
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

module.exports = {
  roundMoney: roundMoney,
  applyDiscount: applyDiscount,
  prorate: prorate,
  lateFee: lateFee,
  nextInvoiceNumber: nextInvoiceNumber,
  calculateInvoice: calculateInvoice,
  formatMoney: formatMoney
};
