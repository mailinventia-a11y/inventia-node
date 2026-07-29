-- Database Setup Script for Supabase PostgreSQL
-- Run this in the Supabase SQL Editor

-- 1. Enable UUID Extension (optional but recommended)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Brands Table
CREATE TABLE IF NOT EXISTS brands (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(50) UNIQUE,
  logo_url TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. Categories & Subcategories (Self-Referencing Parent Table)
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  parent_id INT REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 4. Products Table (Specially configured for Interior Products)
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(100) UNIQUE NOT NULL,
  barcode VARCHAR(100) UNIQUE,
  name VARCHAR(255) NOT NULL,
  brand_id INT REFERENCES brands(id) ON DELETE SET NULL,
  category_id INT REFERENCES categories(id) ON DELETE SET NULL,
  description TEXT,
  
  -- Unit of Measure & Conversions (Sq. Ft., Box, Piece, Meter)
  uom VARCHAR(20) DEFAULT 'piece' CHECK (uom IN ('piece', 'box', 'sqft', 'meter', 'bundle')),
  coverage_per_box DECIMAL(10,2) DEFAULT NULL, -- For tiles / flooring
  
  cost_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  selling_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  
  -- Interior Specific Specifications
  material VARCHAR(100),    -- Wood, Steel, Ceramic, Fabric
  finish VARCHAR(100),      -- Matte, Glossy, Polished, Satin
  dimensions VARCHAR(100),  -- e.g., 600x600mm, 3x6 ft
  shade_lot_number VARCHAR(100), -- Crucial for color matching tiles/wallpapers
  
  min_stock_alert INT DEFAULT 5,
  image_url TEXT,
  status SMALLINT DEFAULT 1, -- 1=Active, 0=Inactive
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 5. Warehouses & Showrooms
CREATE TABLE IF NOT EXISTS warehouses (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(50) UNIQUE NOT NULL,
  type VARCHAR(20) DEFAULT 'warehouse' CHECK (type IN ('warehouse', 'showroom', 'transit')),
  address TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 6. Warehouse Stock Ledger
CREATE TABLE IF NOT EXISTS warehouse_stock (
  id SERIAL PRIMARY KEY,
  warehouse_id INT REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  quantity INT DEFAULT 0,
  bin_location VARCHAR(100), -- e.g. Rack A-12, Bin 3
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(warehouse_id, product_id)
);

-- Triggers to auto-initialize warehouse_stock records
CREATE OR REPLACE FUNCTION init_product_stock()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO warehouse_stock (warehouse_id, product_id, quantity)
  SELECT id, NEW.id, 0 FROM warehouses
  ON CONFLICT (warehouse_id, product_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_init_product_stock
AFTER INSERT ON products
FOR EACH ROW
EXECUTE FUNCTION init_product_stock();

CREATE OR REPLACE FUNCTION init_warehouse_stock()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO warehouse_stock (warehouse_id, product_id, quantity)
  SELECT NEW.id, id, 0 FROM products
  ON CONFLICT (warehouse_id, product_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trigger_init_warehouse_stock
AFTER INSERT ON warehouses
FOR EACH ROW
EXECUTE FUNCTION init_warehouse_stock();

-- 7. Customers & Credit Management
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(20) UNIQUE,
  email VARCHAR(100),
  address TEXT,
  credit_limit DECIMAL(10,2) DEFAULT 0.00,
  balance DECIMAL(10,2) DEFAULT 0.00, -- Amount they owe us (positive = debt)
  loyalty_points INT DEFAULT 0,
  tier VARCHAR(20) DEFAULT 'bronze' CHECK (tier IN ('bronze', 'silver', 'gold', 'platinum')),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 8. Users & Roles
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  role VARCHAR(20) DEFAULT 'cashier' CHECK (role IN ('admin', 'manager', 'warehouse_staff', 'cashier')),
  status SMALLINT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 9. Sales (Invoices)
CREATE TABLE IF NOT EXISTS sales (
  id SERIAL PRIMARY KEY,
  invoice_no VARCHAR(100) UNIQUE NOT NULL,
  customer_id INT REFERENCES customers(id) ON DELETE SET NULL,
  warehouse_id INT REFERENCES warehouses(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  discount DECIMAL(10,2) DEFAULT 0.00,
  tax_amount DECIMAL(10,2) DEFAULT 0.00,
  total DECIMAL(10,2) NOT NULL,
  payment_method VARCHAR(20) DEFAULT 'cash' CHECK (payment_method IN ('cash', 'card', 'upi', 'credit')),
  payment_status VARCHAR(20) DEFAULT 'completed' CHECK (payment_status IN ('pending', 'completed')),
  sale_date TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 10. Sale Items
CREATE TABLE IF NOT EXISTS sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INT REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  quantity INT NOT NULL,
  unit_price DECIMAL(10,2) NOT NULL,
  total_price DECIMAL(10,2) NOT NULL
);

-- 11. Inventory Log / Stock Audit Trail
CREATE TABLE IF NOT EXISTS inventory_logs (
  id SERIAL PRIMARY KEY,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  warehouse_id INT REFERENCES warehouses(id) ON DELETE CASCADE,
  change_qty INT NOT NULL, -- negative for sales/outgoing, positive for restock/incoming
  reason VARCHAR(50) CHECK (reason IN ('sale', 'restock', 'adjustment', 'transfer_out', 'transfer_in')),
  reference_id INT, -- e.g. sale_id or purchase_order_id
  notes TEXT,
  user_id INT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 12. Stock Transfers (Between Warehouses)
CREATE TABLE IF NOT EXISTS stock_transfers (
  id SERIAL PRIMARY KEY,
  from_warehouse_id INT REFERENCES warehouses(id) ON DELETE SET NULL,
  to_warehouse_id INT REFERENCES warehouses(id) ON DELETE SET NULL,
  product_id INT REFERENCES products(id) ON DELETE CASCADE,
  quantity INT NOT NULL,
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'in_transit', 'completed')),
  requested_by INT REFERENCES users(id),
  approved_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 13. App Settings Table
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key VARCHAR(100) PRIMARY KEY,
  setting_value TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Seed Data (Default App Settings)
INSERT INTO app_settings (setting_key, setting_value) VALUES
('company_name', 'Inventia'),
('company_address', '123 Business Street, City, State 12345'),
('company_email', 'info@inventia.com'),
('company_phone', '+1 234 567 890'),
('currency_code', 'INR'),
('currency_symbol', '₹'),
('tax_rate', '0.10')
ON CONFLICT (setting_key) DO NOTHING;

-- Seed Data (Default Admin User)
-- Password is 'admin123' (hashed using bcrypt/y2)
INSERT INTO users (username, password_hash, full_name, email, role) VALUES 
('admin', '$2y$10$jYDiutpajwvRPjavffXbVugffjwINhEua/lGu//OE7.iwBtW7Qwli', 'System Admin', 'admin@interiorpos.com', 'admin')
ON CONFLICT (username) DO NOTHING;

-- Seed Data (Default Warehouses)
INSERT INTO warehouses (id, name, code, type, address) VALUES
(1, 'Main Warehouse', 'WH-MAIN', 'warehouse', '404 Logistics Boulevard, Sector 5'),
(2, 'City Showroom', 'SR-CITY', 'showroom', '12 Luxury Retail Avenue, Downtown'),
(3, 'Transit Dock', 'TD-TRANSIT', 'transit', 'Harbor Gate 12, Shipping Terminal')
ON CONFLICT (id) DO NOTHING;

-- Seed Data (Default Brands)
INSERT INTO brands (id, name, code, logo_url) VALUES
(1, 'Royal Interiors', 'ROYAL-INT', ''),
(2, 'Aura Ceramics', 'AURA-CER', ''),
(3, 'Decora Wallpaper', 'DECORA-WP', '')
ON CONFLICT (id) DO NOTHING;

-- Seed Data (Default Categories)
INSERT INTO categories (id, name, parent_id, description) VALUES
(1, 'Tiles', NULL, 'Premium ceramic and porcelain tiles'),
(2, 'Wallpapers', NULL, 'Modern wall coverings and decals'),
(3, 'Lighting', NULL, 'Luxury fixtures and chandeliers')
ON CONFLICT (id) DO NOTHING;

-- Seed Data (Default Products)
INSERT INTO products (id, sku, barcode, name, brand_id, category_id, description, uom, cost_price, selling_price, material, finish, dimensions, shade_lot_number) VALUES
(1, 'TL-CAR-60-GL', '8901234567890', 'Carrara White Glossy Tile', 2, 1, 'Italian carrara marble look glossy finish tile', 'box', 45.00, 89.90, 'Ceramic', 'Glossy', '600x600mm', 'LOT-2026A'),
(2, 'WP-FLR-20-MT', '8901234567891', 'Floral Meadow Wallpaper', 3, 2, 'Vinyl wallpaper with matte floral patterns', 'bundle', 15.00, 35.50, 'Vinyl', 'Matte', '0.53x10m', 'LOT-99B'),
(3, 'LT-CHN-08-GL', '8901234567892', '8-Light Crystal Chandelier', 1, 3, 'Spectacular crystal glass chandelier', 'piece', 120.00, 299.00, 'Glass & Steel', 'Polished Chrome', 'D800mm', 'LOT-CH-1')
ON CONFLICT (id) DO NOTHING;

-- Seed Data (Default Warehouse Stock)
INSERT INTO warehouse_stock (warehouse_id, product_id, quantity, bin_location) VALUES
(1, 1, 150, 'Rack A-01'),
(2, 1, 30, 'Showroom Shelf 1'),
(3, 1, 0, 'Transit Bay 1'),
(1, 2, 80, 'Rack B-04'),
(2, 2, 15, 'Showroom Shelf 2'),
(3, 2, 0, 'Transit Bay 2'),
(1, 3, 25, 'Rack C-10'),
(2, 3, 5, 'Showroom Display'),
(3, 3, 0, 'Transit Bay 3')
ON CONFLICT (warehouse_id, product_id) DO NOTHING;

-- Seed Data (Default Customers)
INSERT INTO customers (id, name, phone, email, address, credit_limit, balance, loyalty_points, tier) VALUES
(1, 'John Doe', '+1 555-0199', 'john@example.com', '123 Pine St', 1000.00, 0.00, 120, 'silver'),
(2, 'Apex Builders', '+1 555-9011', 'billing@apex.com', '45 Industrial Ave', 50000.00, 14500.00, 2450, 'platinum')
ON CONFLICT (id) DO NOTHING;

-- Update PostgreSQL Sequence Counters
SELECT setval('brands_id_seq', COALESCE((SELECT MAX(id)+1 FROM brands), 1), false);
SELECT setval('categories_id_seq', COALESCE((SELECT MAX(id)+1 FROM categories), 1), false);
SELECT setval('products_id_seq', COALESCE((SELECT MAX(id)+1 FROM products), 1), false);
SELECT setval('warehouses_id_seq', COALESCE((SELECT MAX(id)+1 FROM warehouses), 1), false);
SELECT setval('customers_id_seq', COALESCE((SELECT MAX(id)+1 FROM customers), 1), false);

-- Disable Row Level Security (RLS) on all tables for ease of testing in Supabase
ALTER TABLE brands DISABLE ROW LEVEL SECURITY;
ALTER TABLE categories DISABLE ROW LEVEL SECURITY;
ALTER TABLE products DISABLE ROW LEVEL SECURITY;
ALTER TABLE warehouses DISABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_stock DISABLE ROW LEVEL SECURITY;
ALTER TABLE customers DISABLE ROW LEVEL SECURITY;
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE sales DISABLE ROW LEVEL SECURITY;
ALTER TABLE sale_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers DISABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings DISABLE ROW LEVEL SECURITY;

-- 15. GST Invoices Tables
CREATE TABLE IF NOT EXISTS invoices (
  id SERIAL PRIMARY KEY,
  invoiceNumber VARCHAR(100) UNIQUE NOT NULL,
  customerId INT REFERENCES customers(id) ON DELETE SET NULL,
  saleId INT REFERENCES sales(id) ON DELETE SET NULL,
  subtotal DECIMAL(10,2) NOT NULL,
  cgst DECIMAL(10,2) DEFAULT 0.00,
  sgst DECIMAL(10,2) DEFAULT 0.00,
  igst DECIMAL(10,2) DEFAULT 0.00,
  discount DECIMAL(10,2) DEFAULT 0.00,
  grandTotal DECIMAL(10,2) NOT NULL,
  paymentStatus VARCHAR(50) DEFAULT 'completed',
  pdfPath TEXT,
  createdAt TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_items (
  invoiceItemId SERIAL PRIMARY KEY,
  invoiceId INT REFERENCES invoices(id) ON DELETE CASCADE,
  productId INT REFERENCES products(id) ON DELETE CASCADE,
  hsn VARCHAR(50),
  qty INT NOT NULL,
  rate DECIMAL(10,2) NOT NULL,
  taxPercent DECIMAL(10,2) DEFAULT 18.00,
  taxAmount DECIMAL(10,2) DEFAULT 0.00,
  lineTotal DECIMAL(10,2) NOT NULL
);

ALTER TABLE invoices DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_items DISABLE ROW LEVEL SECURITY;

SELECT setval('invoices_id_seq', COALESCE((SELECT MAX(id)+1 FROM invoices), 1), false);
SELECT setval('invoice_items_invoiceItemId_seq', COALESCE((SELECT MAX(invoiceItemId)+1 FROM invoice_items), 1), false);

-- 14. Performance Indexes for Production High-Throughput POS Lookups
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_no);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_lookup ON warehouse_stock(warehouse_id, product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

-- Phase 1 purchasing and event-ledger modules
CREATE TABLE IF NOT EXISTS suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  gstin VARCHAR(50),
  address TEXT,
  payment_terms INT DEFAULT 0,
  status SMALLINT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id SERIAL PRIMARY KEY,
  order_no VARCHAR(100) UNIQUE NOT NULL,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  warehouse_id INT NOT NULL REFERENCES warehouses(id),
  status VARCHAR(30) DEFAULT 'draft',
  expected_date DATE,
  received_at TIMESTAMPTZ,
  notes TEXT,
  total DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id SERIAL PRIMARY KEY,
  purchase_order_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  quantity INT NOT NULL CHECK (quantity > 0),
  received_quantity INT DEFAULT 0,
  unit_cost DECIMAL(12,2) NOT NULL CHECK (unit_cost >= 0),
  line_total DECIMAL(12,2) NOT NULL
);

CREATE TABLE IF NOT EXISTS domain_events (
  id BIGSERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,
  entity_type VARCHAR(100) NOT NULL,
  entity_id VARCHAR(100) NOT NULL,
  actor_user_id INT REFERENCES users(id),
  payload JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE suppliers DISABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders DISABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_order_items DISABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX IF NOT EXISTS idx_purchase_items_order ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_domain_events_entity ON domain_events(entity_type, entity_id);

-- Phase 2 document and printing engine
CREATE TABLE IF NOT EXISTS document_files (
  id BIGSERIAL PRIMARY KEY,
  document_type VARCHAR(80) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  byte_size BIGINT NOT NULL DEFAULT 0,
  content_base64 TEXT NOT NULL,
  entity_type VARCHAR(80),
  entity_id VARCHAR(100),
  metadata JSONB,
  is_archived SMALLINT DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS barcode_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  barcode_type VARCHAR(30) DEFAULT 'code128',
  label_size VARCHAR(30) DEFAULT '40x20',
  config JSONB,
  is_default SMALLINT DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS barcode_history (
  id BIGSERIAL PRIMARY KEY,
  product_id INT REFERENCES products(id),
  barcode_value VARCHAR(255) NOT NULL,
  barcode_type VARCHAR(30) NOT NULL,
  document_file_id BIGINT REFERENCES document_files(id),
  generated_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS barcode_print_jobs (
  id BIGSERIAL PRIMARY KEY,
  barcode_history_id BIGINT REFERENCES barcode_history(id),
  copies INT DEFAULT 1,
  settings JSONB,
  status VARCHAR(30) DEFAULT 'queued',
  requested_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS barcode_downloads (
  id BIGSERIAL PRIMARY KEY,
  barcode_history_id BIGINT REFERENCES barcode_history(id),
  format VARCHAR(20) NOT NULL,
  downloaded_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  template_type VARCHAR(40) DEFAULT 'classic',
  config JSONB,
  is_default SMALLINT DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoice_documents (
  id BIGSERIAL PRIMARY KEY,
  invoice_id INT REFERENCES invoices(id),
  template_id INT REFERENCES invoice_templates(id),
  document_file_id BIGINT REFERENCES document_files(id),
  version INT DEFAULT 1,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS print_jobs (
  id BIGSERIAL PRIMARY KEY,
  document_file_id BIGINT NOT NULL REFERENCES document_files(id),
  document_type VARCHAR(80) NOT NULL,
  status VARCHAR(30) DEFAULT 'queued',
  settings JSONB,
  requested_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ocr_documents (
  id BIGSERIAL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  mime_type VARCHAR(120) NOT NULL,
  status VARCHAR(30) DEFAULT 'pending',
  source_base64 TEXT NOT NULL,
  confidence DECIMAL(5,4),
  extracted_data JSONB,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS label_templates (
  id SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  label_type VARCHAR(50) NOT NULL,
  width_mm DECIMAL(8,2),
  height_mm DECIMAL(8,2),
  config JSONB,
  is_default SMALLINT DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pdf_exports (
  id BIGSERIAL PRIMARY KEY,
  document_file_id BIGINT REFERENCES document_files(id),
  export_type VARCHAR(30) NOT NULL,
  row_count INT DEFAULT 0,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS document_settings (
  id SERIAL PRIMARY KEY,
  setting_scope VARCHAR(50) DEFAULT 'organization',
  setting_key VARCHAR(100) NOT NULL,
  setting_value JSONB,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(setting_scope, setting_key)
);

ALTER TABLE document_files DISABLE ROW LEVEL SECURITY;
ALTER TABLE barcode_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE barcode_history DISABLE ROW LEVEL SECURITY;
ALTER TABLE barcode_print_jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE barcode_downloads DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE print_jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE ocr_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE label_templates DISABLE ROW LEVEL SECURITY;
ALTER TABLE pdf_exports DISABLE ROW LEVEL SECURITY;
ALTER TABLE document_settings DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_documents_type_created ON document_files(document_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_documents_entity ON document_files(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_barcode_history_value ON barcode_history(barcode_value);
CREATE INDEX IF NOT EXISTS idx_print_jobs_status ON print_jobs(status);

-- Phase 3 finance and double-entry accounting engine
CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL PRIMARY KEY,
  code VARCHAR(40) UNIQUE NOT NULL,
  name VARCHAR(160) NOT NULL,
  account_type VARCHAR(20) NOT NULL CHECK (account_type IN ('asset','liability','income','expense','equity')),
  parent_id INT REFERENCES accounts(id),
  opening_balance DECIMAL(14,2) DEFAULT 0,
  is_archived SMALLINT DEFAULT 0,
  merged_into_id INT REFERENCES accounts(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journals (
  id BIGSERIAL PRIMARY KEY,
  journal_no VARCHAR(80) UNIQUE NOT NULL,
  journal_type VARCHAR(40) DEFAULT 'general',
  journal_date DATE NOT NULL,
  reference VARCHAR(160),
  description TEXT,
  total_debit DECIMAL(14,2) NOT NULL,
  total_credit DECIMAL(14,2) NOT NULL,
  status VARCHAR(30) DEFAULT 'posted',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id BIGSERIAL PRIMARY KEY,
  journal_id BIGINT NOT NULL REFERENCES journals(id) ON DELETE CASCADE,
  account_id INT NOT NULL REFERENCES accounts(id),
  debit DECIMAL(14,2) DEFAULT 0 CHECK (debit >= 0),
  credit DECIMAL(14,2) DEFAULT 0 CHECK (credit >= 0),
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  CHECK (NOT (debit > 0 AND credit > 0))
);

CREATE TABLE IF NOT EXISTS banks (
  id SERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  account_number VARCHAR(100) NOT NULL,
  ifsc VARCHAR(30),
  upi_id VARCHAR(120),
  account_id INT NOT NULL REFERENCES accounts(id),
  current_balance DECIMAL(14,2) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id BIGSERIAL PRIMARY KEY,
  bank_id INT NOT NULL REFERENCES banks(id),
  journal_id BIGINT REFERENCES journals(id),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out')),
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  method VARCHAR(30),
  reference VARCHAR(160),
  description TEXT,
  transaction_date DATE NOT NULL,
  is_reconciled SMALLINT DEFAULT 0,
  reconciled_at TIMESTAMPTZ,
  reconciled_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id BIGSERIAL PRIMARY KEY,
  payment_no VARCHAR(80) UNIQUE NOT NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out')),
  party_type VARCHAR(30),
  party_id BIGINT,
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  method VARCHAR(30),
  reference VARCHAR(160),
  payment_date DATE NOT NULL,
  journal_id BIGINT REFERENCES journals(id),
  status VARCHAR(30) DEFAULT 'completed',
  notes TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payment_allocations (
  id BIGSERIAL PRIMARY KEY,
  payment_id BIGINT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  document_type VARCHAR(30) NOT NULL,
  document_id BIGINT NOT NULL,
  amount DECIMAL(14,2) NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS expenses (
  id BIGSERIAL PRIMARY KEY,
  expense_no VARCHAR(80) UNIQUE NOT NULL,
  supplier_id INT REFERENCES suppliers(id),
  expense_account_id INT NOT NULL REFERENCES accounts(id),
  payment_account_id INT REFERENCES accounts(id),
  amount DECIMAL(14,2) NOT NULL CHECK (amount > 0),
  tax_amount DECIMAL(14,2) DEFAULT 0,
  expense_date DATE NOT NULL,
  description TEXT,
  reference VARCHAR(160),
  status VARCHAR(30) DEFAULT 'draft',
  journal_id BIGINT REFERENCES journals(id),
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS taxes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  tax_type VARCHAR(30) NOT NULL,
  rate DECIMAL(7,3) NOT NULL,
  hsn_code VARCHAR(30),
  is_active SMALLINT DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS gst_returns (
  id BIGSERIAL PRIMARY KEY,
  return_type VARCHAR(30) NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  output_tax DECIMAL(14,2) DEFAULT 0,
  input_tax DECIMAL(14,2) DEFAULT 0,
  net_payable DECIMAL(14,2) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'draft',
  filed_at TIMESTAMPTZ,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) DEFAULT 'open',
  closed_at TIMESTAMPTZ,
  closed_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO accounts (code, name, account_type) VALUES
  ('1000', 'Cash on Hand', 'asset'), ('1010', 'Bank Accounts', 'asset'),
  ('1100', 'Accounts Receivable', 'asset'), ('1200', 'Inventory Asset', 'asset'),
  ('2000', 'Accounts Payable', 'liability'), ('2100', 'GST Payable', 'liability'),
  ('3000', 'Owner Equity', 'equity'), ('4000', 'Sales Revenue', 'income'),
  ('5000', 'Cost of Goods Sold', 'expense'), ('5100', 'Purchases', 'expense'),
  ('5200', 'Operating Expenses', 'expense')
ON CONFLICT (code) DO NOTHING;

INSERT INTO taxes (name, tax_type, rate)
SELECT seed.name, 'gst', seed.rate FROM (VALUES ('GST 5%',5),('GST 12%',12),('GST 18%',18),('GST 28%',28)) AS seed(name,rate)
WHERE NOT EXISTS (SELECT 1 FROM taxes);

ALTER TABLE accounts DISABLE ROW LEVEL SECURITY;
ALTER TABLE journals DISABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries DISABLE ROW LEVEL SECURITY;
ALTER TABLE banks DISABLE ROW LEVEL SECURITY;
ALTER TABLE bank_transactions DISABLE ROW LEVEL SECURITY;
ALTER TABLE payments DISABLE ROW LEVEL SECURITY;
ALTER TABLE payment_allocations DISABLE ROW LEVEL SECURITY;
ALTER TABLE expenses DISABLE ROW LEVEL SECURITY;
ALTER TABLE taxes DISABLE ROW LEVEL SECURITY;
ALTER TABLE gst_returns DISABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_journals_date ON journals(journal_date);
CREATE INDEX IF NOT EXISTS idx_journal_entries_account ON journal_entries(account_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_journal ON journal_entries(journal_id);
CREATE INDEX IF NOT EXISTS idx_payments_party ON payments(party_type, party_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_bank_transactions_date ON bank_transactions(transaction_date);

-- Phase 4 AI Business Copilot
CREATE TABLE IF NOT EXISTS ai_conversations (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  title VARCHAR(200) NOT NULL,
  status VARCHAR(30) DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_tool_calls (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  message_id BIGINT REFERENCES ai_messages(id) ON DELETE SET NULL,
  tool_name VARCHAR(100) NOT NULL,
  arguments JSONB,
  result_summary TEXT,
  status VARCHAR(30) DEFAULT 'completed',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_action_proposals (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES ai_conversations(id) ON DELETE SET NULL,
  message_id BIGINT REFERENCES ai_messages(id) ON DELETE SET NULL,
  action_type VARCHAR(40) NOT NULL,
  title VARCHAR(200) NOT NULL,
  reason TEXT,
  payload JSONB NOT NULL,
  status VARCHAR(30) DEFAULT 'pending',
  proposed_by INT REFERENCES users(id),
  approved_by INT REFERENCES users(id),
  rejected_by INT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  rejection_reason TEXT,
  execution_result JSONB,
  execution_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_insights (
  id BIGSERIAL PRIMARY KEY,
  insight_type VARCHAR(50) NOT NULL,
  severity VARCHAR(30) NOT NULL,
  title VARCHAR(200) NOT NULL,
  message TEXT NOT NULL,
  evidence JSONB,
  status VARCHAR(30) DEFAULT 'active',
  generated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS ai_forecasts (
  id BIGSERIAL PRIMARY KEY,
  forecast_type VARCHAR(50) NOT NULL,
  entity_type VARCHAR(50),
  entity_id VARCHAR(100),
  horizon_days INT NOT NULL,
  forecast_data JSONB NOT NULL,
  model VARCHAR(100) NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_knowledge_documents (
  id BIGSERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  tags TEXT,
  source_type VARCHAR(50) DEFAULT 'manual',
  source_reference TEXT,
  status VARCHAR(30) DEFAULT 'active',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_usage_records (
  id BIGSERIAL PRIMARY KEY,
  conversation_id BIGINT REFERENCES ai_conversations(id) ON DELETE SET NULL,
  user_id INT REFERENCES users(id),
  provider VARCHAR(30) NOT NULL,
  model VARCHAR(100) NOT NULL,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  latency_ms INT DEFAULT 0,
  fallback_used SMALLINT DEFAULT 0,
  error_code VARCHAR(100),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_automations (
  id BIGSERIAL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  description TEXT,
  trigger_type VARCHAR(80) NOT NULL,
  trigger_config JSONB NOT NULL,
  action_type VARCHAR(80) NOT NULL,
  action_config JSONB NOT NULL,
  status VARCHAR(30) DEFAULT 'active',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE ai_conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_messages DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_tool_calls DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_action_proposals DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_insights DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_forecasts DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_knowledge_documents DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_records DISABLE ROW LEVEL SECURITY;
ALTER TABLE ai_automations DISABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_ai_conversations_user ON ai_conversations(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON ai_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_actions_status ON ai_action_proposals(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_knowledge_status ON ai_knowledge_documents(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage_records(user_id, created_at DESC);
