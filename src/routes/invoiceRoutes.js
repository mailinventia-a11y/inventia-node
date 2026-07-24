import express from 'express';
import { handlePOSCheckout } from '../controllers/invoiceController.js';
import { checkRole } from '../../routes/auth.js';

const router = express.Router();

// POS Checkout Route to save sale, items, and generate A4 PDF invoice
router.post('/checkout', checkRole(['admin', 'manager', 'cashier']), handlePOSCheckout);

export default router;
