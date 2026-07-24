/**
 * GST Calculation Utility
 */
export const calculateGST = (rate, quantity, discountPercent = 0, gstPercent = 18, isInterstate = false) => {
  const baseValue = Number(rate) * Number(quantity);
  const discountAmount = (baseValue * Number(discountPercent)) / 100;
  const taxableValue = baseValue - discountAmount;
  const totalGst = (taxableValue * Number(gstPercent)) / 100;
  
  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  
  if (isInterstate) {
    igst = totalGst;
  } else {
    cgst = totalGst / 2;
    sgst = totalGst / 2;
  }
  
  const lineTotal = taxableValue + totalGst;
  
  return {
    baseValue: Math.round(baseValue * 100) / 100,
    discountAmount: Math.round(discountAmount * 100) / 100,
    taxableValue: Math.round(taxableValue * 100) / 100,
    totalGst: Math.round(totalGst * 100) / 100,
    cgst: Math.round(cgst * 100) / 100,
    sgst: Math.round(sgst * 100) / 100,
    igst: Math.round(igst * 100) / 100,
    lineTotal: Math.round(lineTotal * 100) / 100
  };
};
