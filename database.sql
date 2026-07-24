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
('currency_code', 'USD'),
('currency_symbol', '$'),
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

-- 14. Performance Indexes for Production High-Throughput POS Lookups
CREATE INDEX IF NOT EXISTS idx_products_sku ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);
CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_sales_invoice ON sales(invoice_no);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_warehouse_stock_lookup ON warehouse_stock(warehouse_id, product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);

