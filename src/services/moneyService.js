import Decimal from 'decimal.js';
import { httpError } from '../platform/phase5Http.js';

Decimal.set({
  precision: 32,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -24,
  toExpPos: 24
});

export function decimal(value, field = 'amount') {
  try {
    const parsed = new Decimal(value ?? 0);
    if (!parsed.isFinite()) throw new Error('not finite');
    return parsed;
  } catch {
    throw httpError(422, 'invalid_decimal', `${field} must be a valid decimal value.`);
  }
}

export function positiveDecimal(value, field = 'amount') {
  const parsed = decimal(value, field);
  if (!parsed.greaterThan(0)) {
    throw httpError(422, 'positive_amount_required', `${field} must be greater than zero.`);
  }
  return parsed;
}

export function toMinor(value, field = 'amount') {
  return decimal(value, field).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
}

export function fromMinor(value) {
  return new Decimal(value || 0).dividedBy(100).toDecimalPlaces(2).toNumber();
}

export function minorToFixed(value) {
  return new Decimal(value || 0).dividedBy(100).toFixed(2);
}

export function quantityString(value, field = 'quantity') {
  const parsed = positiveDecimal(value, field);
  return parsed.toDecimalPlaces(6).toFixed().replace(/\.?0+$/, '');
}

export function calculateInvoiceAmounts(lines, invoiceDiscount, isInterstate) {
  if (!Array.isArray(lines) || !lines.length) {
    throw httpError(422, 'invoice_items_required', 'At least one invoice item is required.');
  }

  const prepared = lines.map((line, index) => {
    const quantity = positiveDecimal(line.quantity, `items[${index}].quantity`);
    const rate = decimal(line.unit_price, `items[${index}].unit_price`);
    const gstRate = decimal(line.gst_rate || 0, `items[${index}].gst_rate`);
    if (rate.isNegative()) throw httpError(422, 'negative_rate', 'Unit price cannot be negative.');
    if (gstRate.isNegative() || gstRate.greaterThan(100)) {
      throw httpError(422, 'invalid_gst_rate', 'GST rate must be between zero and one hundred.');
    }
    const grossMinor = quantity.times(rate).times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
    return {
      ...line,
      quantity: quantityString(quantity),
      rate_minor: toMinor(rate),
      gross_minor: grossMinor,
      gst_rate: gstRate.toFixed().replace(/\.?0+$/, '') || '0'
    };
  });

  const subtotalMinor = prepared.reduce((sum, line) => sum + line.gross_minor, 0);
  const discountMinor = toMinor(invoiceDiscount || 0, 'discount');
  if (discountMinor < 0) throw httpError(422, 'negative_discount', 'Discount cannot be negative.');
  if (discountMinor > subtotalMinor) {
    throw httpError(422, 'discount_exceeds_subtotal', 'Discount cannot exceed the pre-tax subtotal.');
  }
  const lineDiscounts = allocateMinor(discountMinor, prepared.map(line => line.gross_minor));

  let cgstTotalMinor = 0;
  let sgstTotalMinor = 0;
  let igstTotalMinor = 0;
  let taxableTotalMinor = 0;

  const calculatedLines = prepared.map((line, index) => {
    const taxableMinor = line.gross_minor - lineDiscounts[index];
    const taxMinor = new Decimal(taxableMinor)
      .times(line.gst_rate || 0)
      .dividedBy(100)
      .toDecimalPlaces(0, Decimal.ROUND_HALF_UP)
      .toNumber();
    const igstMinor = isInterstate ? taxMinor : 0;
    const cgstMinor = isInterstate ? 0 : Math.floor(taxMinor / 2);
    const sgstMinor = isInterstate ? 0 : taxMinor - cgstMinor;
    taxableTotalMinor += taxableMinor;
    cgstTotalMinor += cgstMinor;
    sgstTotalMinor += sgstMinor;
    igstTotalMinor += igstMinor;
    return {
      ...line,
      discount_minor: lineDiscounts[index],
      taxable_minor: taxableMinor,
      cgst_minor: cgstMinor,
      sgst_minor: sgstMinor,
      igst_minor: igstMinor,
      cess_minor: 0,
      line_total_minor: taxableMinor + taxMinor
    };
  });

  const grandTotalMinor = taxableTotalMinor + cgstTotalMinor + sgstTotalMinor + igstTotalMinor;
  return {
    lines: calculatedLines,
    subtotal_minor: subtotalMinor,
    discount_total_minor: discountMinor,
    taxable_total_minor: taxableTotalMinor,
    cgst_total_minor: cgstTotalMinor,
    sgst_total_minor: sgstTotalMinor,
    igst_total_minor: igstTotalMinor,
    cess_total_minor: 0,
    round_off_minor: 0,
    grand_total_minor: grandTotalMinor
  };
}

export function allocateMinor(totalMinor, weights) {
  const integerTotal = Number(totalMinor || 0);
  if (!Number.isInteger(integerTotal) || integerTotal < 0) {
    throw httpError(422, 'invalid_minor_amount', 'Minor-unit totals must be non-negative integers.');
  }
  if (!weights.length) return [];
  const totalWeight = weights.reduce((sum, weight) => sum.plus(weight || 0), new Decimal(0));
  if (totalWeight.isZero()) {
    const allocations = Array(weights.length).fill(0);
    allocations[0] = integerTotal;
    return allocations;
  }
  const exact = weights.map(weight => new Decimal(integerTotal).times(weight || 0).dividedBy(totalWeight));
  const allocations = exact.map(value => value.floor().toNumber());
  let remainder = integerTotal - allocations.reduce((sum, value) => sum + value, 0);
  const priority = exact
    .map((value, index) => ({ index, fraction: value.minus(value.floor()) }))
    .sort((left, right) => right.fraction.comparedTo(left.fraction) || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) allocations[priority[index % priority.length].index] += 1;
  return allocations;
}
