import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

/**
 * Generate A4 PDF from HTML using Puppeteer
 * @param {string} htmlContent - Full compiled HTML string
 * @param {string} outputPath - Local filesystem path where PDF should be saved
 */
export const generatePDF = async (htmlContent, outputPath) => {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Launch Puppeteer headless browser
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    
    // Set viewport for high resolution print render
    await page.setViewport({ width: 1200, height: 1600, deviceScaleFactor: 2 });
    
    // Inject and compile the HTML content
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    // Render A4 PDF with 10mm margins
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: {
        top: '10mm',
        bottom: '10mm',
        left: '10mm',
        right: '10mm'
      },
      printBackground: true,
      preferCSSPageSize: true
    });
  } catch (err) {
    console.error('PDF Generation Service Error:', err);
    throw err;
  } finally {
    await browser.close();
  }
};
