import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const DEFAULT_TIMEOUT_MS = Number(process.env.INVOICE_PDF_TIMEOUT_MS || 30000);

export async function generatePDFBuffer(htmlContent, options = {}) {
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  let browser;
  const work = (async () => {
    try {
      browser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu'
        ]
      });
      const page = await browser.newPage();
      await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 2 });
      await page.setContent(htmlContent, { waitUntil: 'networkidle0', timeout: timeoutMs });
      await page.emulateMediaType('print');
      const bytes = await page.pdf({
        format: 'A4',
        margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: false,
        timeout: timeoutMs
      });
      return Buffer.from(bytes);
    } finally {
      await browser?.close().catch(() => {});
    }
  })();

  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Invoice PDF generation exceeded ${timeoutMs}ms.`);
          error.code = 'invoice_pdf_timeout';
          reject(error);
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function generatePDF(htmlContent, outputPath, options = {}) {
  const buffer = await generatePDFBuffer(htmlContent, options);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, buffer);
  return { outputPath, size_bytes: buffer.length };
}
