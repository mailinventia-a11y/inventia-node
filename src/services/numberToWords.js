/**
 * Number to Words Converter (Indian Rupee Format)
 */
export const numberToWords = (amount) => {
  const fraction = Math.round((amount - Math.floor(amount)) * 100);
  let words = "";

  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const convertLessThanOneThousand = (number) => {
    let currentWords = "";
    if (number >= 100) {
      currentWords += ones[Math.floor(number / 100)] + " Hundred ";
      number %= 100;
    }
    if (number >= 20) {
      currentWords += tens[Math.floor(number / 10)] + " ";
      number %= 10;
    }
    if (number > 0) {
      currentWords += ones[number] + " ";
    }
    return currentWords.trim() + " ";
  };

  let num = Math.floor(amount);
  
  if (num === 0) {
    words = "Zero ";
  } else {
    if (num >= 10000000) {
      words += convertLessThanOneThousand(Math.floor(num / 10000000)) + "Crore ";
      num %= 10000000;
    }
    if (num >= 100000) {
      words += convertLessThanOneThousand(Math.floor(num / 100000)) + "Lakh ";
      num %= 100000;
    }
    if (num >= 1000) {
      words += convertLessThanOneThousand(Math.floor(num / 1000)) + "Thousand ";
      num %= 1000;
    }
    words += convertLessThanOneThousand(num);
  }

  words = words.trim() + " Rupees";

  if (fraction > 0) {
    const fractionWords = fraction < 20 ? ones[fraction] : tens[Math.floor(fraction / 10)] + " " + ones[fraction % 10];
    words += " and " + fractionWords.trim() + " Paise";
  }

  return words + " Only";
};
