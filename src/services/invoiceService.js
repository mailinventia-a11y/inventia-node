import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { supabase } from '../../config/db.js';
import { calculateGST } from '../utils/gstCalculator.js';
import { formatCurrency } from '../helpers/currency.js';
import { numberToWords } from './numberToWords.js';
import { generatePDF } from './pdfService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Generate invoice number automatically
 */
export const generateNextInvoiceNumber = async () => {
  const currentYear = new Date().getFullYear();
  const yearStr = currentYear.toString();
  
  const { data, error } = await supabase
    .from('invoices')
    .select('invoiceNumber')
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data || !data.invoiceNumber) {
    return `INV-${yearStr}-000001`;
  }

  const parts = data.invoiceNumber.split('-');
  if (parts.length === 3) {
    const nextNum = parseInt(parts[2]) + 1;
    const padded = String(nextNum).padStart(6, '0');
    return `INV-${yearStr}-${padded}`;
  }

  return `INV-${yearStr}-000001`;
};

/**
 * Create GST Invoice and generate PDF
 */
export const createGSTInvoice = async (invoicePayload) => {
  const {
    customerId,
    saleId,
    items, // array of { productId, name, hsn, qty, rate, discountPercent, taxPercent, uom }
    paymentMethod = 'cash',
    paymentStatus = 'completed',
    challanNumber = 'N/A',
    transport = 'N/A',
    vehicle = 'N/A',
    ewayBill = 'N/A'
  } = invoicePayload;

  // 1. Fetch Company Settings
  const { data: dbSettings } = await supabase.from('app_settings').select('*');
  const settings = {};
  if (dbSettings) {
    dbSettings.forEach(s => {
      settings[s.setting_key] = s.setting_value;
    });
  }

  const companyName = settings['company_name'] || 'Inventia';
  const companyAddress = settings['company_address'] || '123 Business St, Sector 15';
  const companyEmail = settings['company_email'] || 'billing@inventia.com';
  const companyPhone = settings['company_phone'] || '+91 98765 43210';
  const companyGSTIN = settings['company_gstin'] || '07AAAAA1111A1Z1'; // Delhi Mock GSTIN
  const companyPAN = settings['company_pan'] || 'AAAAA1111A';
  const companyState = settings['company_state'] || 'Delhi';
  const companyStateCode = settings['company_state_code'] || '07';
  const currencySym = settings['currency_symbol'] || '₹';

  // 2. Fetch Customer Details
  let customerName = 'Walk-in Customer';
  let customerAddress = 'N/A';
  let customerPhone = 'N/A';
  let customerGSTIN = 'URP'; // Unregistered Person
  let customerState = companyState;
  let customerStateCode = companyStateCode;

  if (customerId) {
    const { data: customer } = await supabase
      .from('customers')
      .select('*')
      .eq('id', customerId)
      .single();
    
    if (customer) {
      customerName = customer.name;
      customerAddress = customer.address || 'N/A';
      customerPhone = customer.phone || 'N/A';
      customerGSTIN = customer.email?.includes('gst') ? customer.email : 'URP'; // Mock fallback or custom attribute
      // In a production system, these are read directly from columns. For this implementation:
      customerState = customer.address?.includes('State') ? customer.address.split('State')[1].trim() : companyState;
      customerStateCode = customerState === companyState ? companyStateCode : '27'; // Interstate code mock
    }
  }

  const isInterstate = customerStateCode !== companyStateCode;

  // 3. Generate Invoice Number & Calculations
  const invoiceNumber = await generateNextInvoiceNumber();
  
  let totalTaxableAmount = 0;
  let totalCGST = 0;
  let totalSGST = 0;
  let totalIGST = 0;
  let grandTotal = 0;
  
  const processedItems = items.map(item => {
    const gstCalc = calculateGST(
      item.rate, 
      item.qty, 
      item.discountPercent || 0, 
      item.taxPercent || 18, 
      isInterstate
    );

    totalTaxableAmount += gstCalc.taxableValue;
    totalCGST += gstCalc.cgst;
    totalSGST += gstCalc.sgst;
    totalIGST += gstCalc.igst;
    grandTotal += gstCalc.lineTotal;

    return {
      ...item,
      baseValue: gstCalc.baseValue,
      discountAmount: gstCalc.discountAmount,
      taxableValue: gstCalc.taxableValue,
      cgst: gstCalc.cgst,
      sgst: gstCalc.sgst,
      igst: gstCalc.igst,
      lineTotal: gstCalc.lineTotal
    };
  });

  const rawTotal = grandTotal;
  grandTotal = Math.round(grandTotal);
  const roundOff = Math.round((grandTotal - rawTotal) * 100) / 100;

  // 4. Save Invoice to Database
  const { data: invData, error: invErr } = await supabase
    .from('invoices')
    .insert([{
      invoiceNumber,
      customerId,
      saleId,
      subtotal: totalTaxableAmount,
      cgst: totalCGST,
      sgst: totalSGST,
      igst: totalIGST,
      discount: processedItems.reduce((acc, i) => acc + i.discountAmount, 0),
      grandTotal,
      paymentStatus,
      pdfPath: `/uploads/invoices/${invoiceNumber}.pdf`
    }])
    .select();

  if (invErr) throw invErr;
  const savedInvoice = invData[0];

  // 5. Save Items to Database
  const itemInserts = processedItems.map(item => ({
    invoiceId: savedInvoice.id,
    productId: item.productId,
    hsn: item.hsn || '9983',
    qty: item.qty,
    rate: item.rate,
    taxPercent: item.taxPercent || 18,
    taxAmount: item.cgst + item.sgst + item.igst,
    lineTotal: item.lineTotal
  }));

  const { error: itemsErr } = await supabase
    .from('invoice_items')
    .insert(itemInserts);

  if (itemsErr) throw itemsErr;

  // 6. Build PDF Invoice HTML Content
  const htmlTemplatePath = path.join(__dirname, '../templates/invoice.html');
  const cssTemplatePath = path.join(__dirname, '../templates/invoice.css');
  
  let html = fs.readFileSync(htmlTemplatePath, 'utf8');
  const css = fs.readFileSync(cssTemplatePath, 'utf8');

  // Build Table Rows
  let tableRowsHtml = '';
  processedItems.forEach((item, index) => {
    tableRowsHtml += `
      <tr>
        <td class="text-center">${index + 1}</td>
        <td class="text-left"><strong>${item.name}</strong></td>
        <td class="text-center">${item.hsn || '9983'}</td>
        <td class="text-right">${item.qty}</td>
        <td class="text-center">${item.uom || 'piece'}</td>
        <td class="text-right">${formatCurrency(item.rate, currencySym)}</td>
        <td class="text-right">${item.discountPercent || 0}%</td>
        <td class="text-right">${formatCurrency(item.taxableValue, currencySym)}</td>
        <td class="text-center">${item.taxPercent || 18}%</td>
        <td class="text-right">${formatCurrency(item.cgst, currencySym)}</td>
        <td class="text-right">${formatCurrency(item.sgst, currencySym)}</td>
        <td class="text-right">${formatCurrency(item.igst, currencySym)}</td>
        <td class="text-right"><strong>${formatCurrency(item.lineTotal, currencySym)}</strong></td>
      </tr>
    `;
  });

  // UPI Link generation
  const upiMerchantId = settings['upi_id'] || 'merchant@upi';
  const upiLink = `upi://pay?pa=${upiMerchantId}&pn=${encodeURIComponent(companyName)}&am=${grandTotal}&cu=INR&tn=Invoice_${invoiceNumber}`;
  const qrCodeHtml = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=${encodeURIComponent(upiLink)}" class="qr-code-img" alt="UPI QR Code">`;

  // Replacements mapping
  const replacements = {
    'CSS_CONTENT': css,
    'companyName': companyName,
    'companyAddress': companyAddress,
    'companyPhone': companyPhone,
    'companyEmail': companyEmail,
    'companyGSTIN': companyGSTIN,
    'companyPAN': companyPAN,
    'companyState': companyState,
    'companyStateCode': companyStateCode,
    'invoiceNumber': invoiceNumber,
    'invoiceDate': new Date().toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    'paymentMode': paymentMethod.toUpperCase(),
    'customerName': customerName,
    'customerAddress': customerAddress,
    'customerPhone': customerPhone,
    'customerGSTIN': customerGSTIN,
    'customerState': customerState,
    'customerStateCode': customerStateCode,
    'challanNumber': challanNumber,
    'transport': transport,
    'vehicle': vehicle,
    'ewayBill': ewayBill,
    'paymentStatus': paymentStatus.toUpperCase(),
    'TABLE_ROWS': tableRowsHtml,
    'amountInWords': numberToWords(grandTotal),
    'bankName': settings['bank_name'] || 'State Bank of India',
    'accountNumber': settings['bank_account_number'] || '12345678901',
    'ifsc': settings['bank_ifsc'] || 'SBIN0001234',
    'upi': upiMerchantId,
    'QR_CODE_HTML': qrCodeHtml,
    'termsAndConditions': settings['terms_conditions'] || '1. Goods once sold will not be taken back.\n2. Interest @ 18% p.a. will be charged if payment is not made within due date.',
    'taxableAmount': formatCurrency(totalTaxableAmount, currencySym),
    'totalCGST': formatCurrency(totalCGST, currencySym),
    'totalSGST': formatCurrency(totalSGST, currencySym),
    'totalIGST': formatCurrency(totalIGST, currencySym),
    'roundOff': formatCurrency(roundOff, currencySym),
    'grandTotal': formatCurrency(grandTotal, currencySym),
    'LOGO_HTML': '',
  };

  // Compile final html
  Object.keys(replacements).forEach(key => {
    html = html.replace(new RegExp(`{{${key}}}`, 'g'), replacements[key]);
  });

  // 7. Write PDF out
  const relativePdfPath = `/uploads/invoices/${invoiceNumber}.pdf`;
  const absolutePdfPath = path.join(process.cwd(), relativePdfPath);
  
  await generatePDF(html, absolutePdfPath);

  return {
    invoiceNumber,
    pdfUrl: relativePdfPath,
    grandTotal
  };
};
