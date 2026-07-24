/**
 * Currency Formatting Helpers
 */
export const formatCurrency = (amount, symbol = '₹', locale = 'en-IN') => {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: symbol === '₹' ? 'INR' : 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch (err) {
    return `${symbol}${Number(amount || 0).toFixed(2)}`;
  }
};
