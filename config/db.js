import sqlite3 from 'sqlite3';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

dotenv.config();

const isSupabaseConfigured = () => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  return url && key && !url.includes('your-project-id') && !url.includes('placeholder') && key !== 'your-supabase-anon-key';
};

let supabaseClient = null;
let sqliteDb = null;

if (isSupabaseConfigured()) {
  console.log('🔌 Connecting to Supabase cloud database...');
  supabaseClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
} else {
  console.log('📂 No valid Supabase credentials found. Initializing local SQLite fallback database (pos.db)...');
  
  const dbPath = path.join(process.cwd(), 'pos.db');
  sqliteDb = new sqlite3.Database(dbPath);
  
  // Wrap database operations in promises
  sqliteDb.runAsync = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      sqliteDb.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  };
  
  sqliteDb.allAsync = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      sqliteDb.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  };
  
  sqliteDb.getAsync = (sql, params = []) => {
    return new Promise((resolve, reject) => {
      sqliteDb.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  };

  // Initialize SQLite schema synchronously
  sqliteDb.serialize(() => {
    // 1. Brands
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS brands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE,
      logo_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. Categories
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      parent_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      description TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 3. Products
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sku TEXT UNIQUE NOT NULL,
      barcode TEXT UNIQUE,
      name TEXT NOT NULL,
      brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      description TEXT,
      uom TEXT DEFAULT 'piece',
      coverage_per_box REAL,
      cost_price REAL NOT NULL DEFAULT 0.0,
      selling_price REAL NOT NULL DEFAULT 0.0,
      material TEXT,
      finish TEXT,
      dimensions TEXT,
      shade_lot_number TEXT,
      min_stock_alert INTEGER DEFAULT 5,
      image_url TEXT,
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 4. Warehouses
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      type TEXT DEFAULT 'warehouse',
      address TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 5. Warehouse Stock
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS warehouse_stock (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER DEFAULT 0,
      bin_location TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(warehouse_id, product_id)
    )`);

    // 6. Customers
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT UNIQUE,
      email TEXT,
      address TEXT,
      credit_limit REAL DEFAULT 0.0,
      balance REAL DEFAULT 0.0,
      loyalty_points INTEGER DEFAULT 0,
      tier TEXT DEFAULT 'bronze',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 7. Users
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT DEFAULT 'cashier',
      status INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 8. Sales
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT UNIQUE NOT NULL,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      subtotal REAL NOT NULL,
      discount REAL DEFAULT 0.0,
      tax_amount REAL DEFAULT 0.0,
      total REAL NOT NULL,
      payment_method TEXT DEFAULT 'cash',
      payment_status TEXT DEFAULT 'completed',
      sale_date TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 9. Sale Items
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sale_id INTEGER REFERENCES sales(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL,
      unit_price REAL NOT NULL,
      total_price REAL NOT NULL
    )`);

    // 10. Inventory Logs
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS inventory_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE CASCADE,
      change_qty INTEGER NOT NULL,
      reason TEXT,
      reference_id INTEGER,
      notes TEXT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 11. Stock Transfers
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS stock_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      from_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      to_warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
      product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
      quantity INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      requested_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // 12. App Settings
    sqliteDb.run(`CREATE TABLE IF NOT EXISTS app_settings (
      setting_key TEXT PRIMARY KEY,
      setting_value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // ----------------------------------------------------
    // SEED DEFAULT DATA IF TABLES ARE EMPTY
    // ----------------------------------------------------

    // Seed Users
    sqliteDb.get(`SELECT COUNT(*) as count FROM users`, (err, row) => {
      if (row && row.count === 0) {
        sqliteDb.run(`INSERT INTO users (username, password_hash, full_name, email, role) VALUES 
          ('admin', '$2y$10$jYDiutpajwvRPjavffXbVugffjwINhEua/lGu//OE7.iwBtW7Qwli', 'System Admin', 'admin@interiorpos.com', 'admin'),
          ('vivin', '$2y$10$eox4o4yXp0nUjHPtbDsHyeUqu432gONbWU5pbQUebMdv6ab.VXgwq', 'Vivin Store Manager', 'manager@interiorpos.com', 'manager')`);
      }
    });

    // Seed Brands
    sqliteDb.get(`SELECT COUNT(*) as count FROM brands`, (err, row) => {
      if (row && row.count === 0) {
        sqliteDb.run(`INSERT INTO brands (name, code) VALUES 
          ('Kohler', 'KOH'),
          ('Havells', 'HAV'),
          ('Asian Paints', 'ASP'),
          ('CenturyPly', 'CEN')`);
      }
    });

    // Seed Categories
    sqliteDb.get(`SELECT COUNT(*) as count FROM categories`, (err, row) => {
      if (row && row.count === 0) {
        sqliteDb.run(`INSERT INTO categories (name) VALUES 
          ('Flooring & Tiles'),
          ('Lighting'),
          ('Furniture & Decor'),
          ('Food & Beverages'),
          ('Clothing'),
          ('Electronics'),
          ('Home & Garden')`);
      }
    });

    // Seed Warehouses
    sqliteDb.get(`SELECT COUNT(*) as count FROM warehouses`, (err, row) => {
      if (row && row.count === 0) {
        sqliteDb.run(`INSERT INTO warehouses (name, code, type) VALUES 
          ('Main Warehouse', 'WH-MAIN', 'warehouse'),
          ('City Showroom', 'SR-CITY', 'showroom'),
          ('Transit Dock', 'TD-TRANSIT', 'transit')`);
      }
    });

    // Seed App Settings
    sqliteDb.get(`SELECT COUNT(*) as count FROM app_settings`, (err, row) => {
      if (row && row.count === 0) {
        sqliteDb.run(`INSERT INTO app_settings (setting_key, setting_value) VALUES
          ('company_name', 'Inventia'),
          ('company_address', '123 Business Street, City, State 12345'),
          ('company_email', 'info@inventia.com'),
          ('company_phone', '+1 234 567 890'),
          ('currency_code', 'USD'),
          ('currency_symbol', '$'),
          ('tax_rate', '0.10')`);
      }
    });

    // Seed Products
    sqliteDb.get(`SELECT COUNT(*) as count FROM products`, (err, row) => {
      if (row && row.count === 0) {
        sqliteDb.run(`INSERT INTO products (sku, barcode, name, brand_id, category_id, uom, coverage_per_box, cost_price, selling_price, material, finish, dimensions, shade_lot_number, min_stock_alert, image_url) VALUES 
          ('FOD001', 'FOD001', 'Chocolate Bar', 1, 4, 'piece', NULL, 1.50, 2.99, 'Organic', 'Standard', '100g', 'LOT-CHOC', 50, 'https://images.unsplash.com/photo-1582176647444-f7b60e6f7734?w=400'),
          ('FOD002', 'FOD002', 'Coffee Beans', 1, 4, 'piece', NULL, 6.00, 12.99, 'Arabica', 'Roasted', '500g', 'LOT-COFF', 5, 'https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400'),
          ('CLT001', 'CLT001', 'Cotton T-Shirt', 2, 5, 'piece', NULL, 8.00, 19.99, 'Cotton', 'Blue', 'Medium', 'LOT-TSHIRT', 10, 'https://images.unsplash.com/photo-1521572267360-ee0c2909d518?w=400'),
          ('HOM001', 'HOM001', 'Gardening Tools Set', 3, 7, 'piece', NULL, 25.00, 59.99, 'Steel & Wood', 'Natural', '3-Piece', 'LOT-GARD', 5, 'https://images.unsplash.com/photo-1617576683096-00fc8eecb3af?w=400'),
          ('CLT002', 'CLT002', 'Jeans', 2, 5, 'piece', NULL, 20.00, 49.99, 'Denim', 'Classic Wash', 'Size 32', 'LOT-JEANS', 10, 'https://images.unsplash.com/photo-1542272604-780c96856592?w=400'),
          ('ELE001', 'ELE001', 'Laptop Pro', 4, 6, 'piece', NULL, 800.00, 1299.99, 'Aluminum', 'Space Gray', '15-inch', 'LOT-LAPTOP', 2, 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=400'),
          ('TL-CAR-60-GL', 'TL-CAR-60-GL', 'Carrara White Glossy Tile', 1, 1, 'box', 14.4, 18.50, 32.99, 'Ceramic', 'Glossy', '600x600 mm', 'BATCH-2026A', 10, 'https://images.unsplash.com/photo-1615873968403-89e068629265?w=400'),
          ('LT-CHN-BR-12', 'LT-CHN-BR-12', 'Brushed Brass Chandelier', 2, 2, 'piece', NULL, 120.00, 249.99, 'Brass & Glass', 'Brushed', '12-Light', 'N/A', 3, 'https://images.unsplash.com/photo-1540932239986-30128078f3c5?w=400'),
          ('FN-SOF-WL-03', 'FN-SOF-WL-03', 'Walnut Wood 3-Seater Sofa', 4, 3, 'piece', NULL, 450.00, 899.00, 'Teak/Walnut Wood', 'Walnut Stain', '3-Seater', 'WL-03', 2, 'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?w=400')`, (err) => {
            // Also seed warehouse_stock for these products in warehouse 1 & 2
            sqliteDb.all(`SELECT id FROM products`, (err, rows) => {
              if (rows) {
                // Stock values corresponding to original mocks:
                const stockVals = {
                  1: 1200, // Chocolate Bar
                  2: 3,    // Coffee Beans
                  3: 99,   // Cotton T-Shirt
                  4: 18,   // Gardening Tools
                  5: 74,   // Jeans
                  6: 15,   // Laptop Pro
                  7: 45,   // Carrara Tile
                  8: 8,    // Brass Chandelier
                  9: 1     // Sofa
                };
                rows.forEach(r => {
                  const qty = stockVals[r.id] || 10;
                  sqliteDb.run(`INSERT OR IGNORE INTO warehouse_stock (warehouse_id, product_id, quantity) VALUES (1, ?, ?), (2, ?, 10)`, [r.id, qty, r.id]);
                });
              }
            });
          });
      }
    });

    // Seed Customers
    sqliteDb.get(`SELECT COUNT(*) as count FROM customers`, (err, row) => {
      if (row && row.count === 0) {
        sqliteDb.run(`INSERT INTO customers (name, phone, email, address, credit_limit, balance, loyalty_points, tier) VALUES 
          ('John Doe', '+1 555-0199', 'john@example.com', '123 Pine St', 1000.00, 0.00, 120, 'silver'),
          ('Apex Builders', '+1 555-9011', 'billing@apex.com', '45 Industrial Ave', 50000.00, 14500.00, 2450, 'platinum')`);
      }
    });
  });
}

// Custom mock Supabase query chain for SQLite
class SQLiteBuilder {
  constructor(table) {
    this.table = table;
    this.queryType = 'select'; // select, insert, update, upsert, delete
    this.selectFields = '*';
    this.wheres = [];
    this.orders = [];
    this.limitVal = null;
    this.insertData = null;
    this.updateData = null;
    this.isSingle = false;
    this.isMaybeSingle = false;
  }

  select(fields = '*') {
    this.queryType = 'select';
    this.selectFields = fields;
    return this;
  }

  insert(data) {
    this.queryType = 'insert';
    this.insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data) {
    this.queryType = 'update';
    this.updateData = data;
    return this;
  }

  upsert(data) {
    this.queryType = 'upsert';
    this.insertData = Array.isArray(data) ? data : [data];
    return this;
  }

  delete() {
    this.queryType = 'delete';
    return this;
  }

  eq(col, val) {
    this.wheres.push({ col, val, op: '=' });
    return this;
  }

  order(col, options = { ascending: true }) {
    this.orders.push({ col, asc: options.ascending });
    return this;
  }

  limit(num) {
    this.limitVal = num;
    return this;
  }

  single() {
    this.isSingle = true;
    return this;
  }

  maybeSingle() {
    this.isMaybeSingle = true;
    return this;
  }

  // To support `.then()` await
  async then(onfulfilled, onrejected) {
    try {
      const res = await this.execute();
      return onfulfilled ? onfulfilled(res) : res;
    } catch (e) {
      if (onrejected) return onrejected(e);
      throw e;
    }
  }

  async execute() {
    try {
      let sql = '';
      let params = [];

      if (this.queryType === 'select') {
        let joins = [];
        let projection = '*';

        // Parse custom nested selections, e.g. "*, brands(name, code), categories(name)"
        if (this.selectFields && this.selectFields !== '*') {
          const fieldsStr = this.selectFields.replace(/\s+/g, ' ');
          if (fieldsStr.includes('(')) {
            // It has nested joins
            projection = `${this.table}.*`;
            
            // Extract relationships
            const relations = fieldsStr.match(/(\w+)\(([^)]+)\)/g);
            if (relations) {
              relations.forEach(rel => {
                const parts = rel.match(/(\w+)\(([^)]+)\)/);
                if (parts) {
                  const joinTable = parts[1];
                  const joinFields = parts[2].split(',').map(f => f.trim());
                  
                  // Add join mapping
                  if (joinTable === 'brands' && this.table === 'products') {
                    joins.push({
                      table: 'brands',
                      on: 'products.brand_id = brands.id',
                      fields: joinFields
                    });
                  } else if (joinTable === 'categories' && this.table === 'products') {
                    joins.push({
                      table: 'categories',
                      on: 'products.category_id = categories.id',
                      fields: joinFields
                    });
                  } else if (joinTable === 'warehouses' && this.table === 'warehouse_stock') {
                    joins.push({
                      table: 'warehouses',
                      on: 'warehouse_stock.warehouse_id = warehouses.id',
                      fields: joinFields
                    });
                  } else if (joinTable === 'customers' && this.table === 'sales') {
                    joins.push({
                      table: 'customers',
                      on: 'sales.customer_id = customers.id',
                      fields: joinFields
                    });
                  } else if (joinTable === 'users' && this.table === 'sales') {
                    joins.push({
                      table: 'users',
                      on: 'sales.user_id = users.id',
                      fields: joinFields
                    });
                  } else if (joinTable === 'products' && this.table === 'sale_items') {
                    joins.push({
                      table: 'products',
                      on: 'sale_items.product_id = products.id',
                      fields: joinFields
                    });
                  }
                }
              });
            }
          } else {
            // Standard fields projection
            projection = this.selectFields;
          }
        }

        // Build Join Select Columns
        let selectCols = [projection];
        joins.forEach(j => {
          j.fields.forEach(f => {
            selectCols.push(`${j.table}.${f} AS _join_${j.table}_${f}`);
          });
        });

        sql = `SELECT ${selectCols.join(', ')} FROM ${this.table}`;
        
        joins.forEach(j => {
          sql += ` LEFT JOIN ${j.table} ON ${j.on}`;
        });

      } else if (this.queryType === 'insert' || this.queryType === 'upsert') {
        // Assume first row determines columns
        const row = this.insertData[0];
        const cols = Object.keys(row);
        const placeholders = cols.map(() => '?').join(', ');
        
        if (this.queryType === 'upsert') {
          sql = `INSERT OR REPLACE INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders})`;
        } else {
          sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders})`;
        }
        
        params = cols.map(c => row[c]);
      } else if (this.queryType === 'update') {
        const cols = Object.keys(this.updateData);
        sql = `UPDATE ${this.table} SET ${cols.map(c => `${c} = ?`).join(', ')}`;
        params = cols.map(c => this.updateData[c]);
      } else if (this.queryType === 'delete') {
        sql = `DELETE FROM ${this.table}`;
      }

      // Add Whers
      if (this.wheres.length > 0) {
        const whereClauses = this.wheres.map(w => {
          params.push(w.val);
          return `${w.col} ${w.op} ?`;
        });
        sql += ` WHERE ${whereClauses.join(' AND ')}`;
      }

      // Add Order
      if (this.queryType === 'select' && this.orders.length > 0) {
        const orderClauses = this.orders.map(o => `${o.col} ${o.asc ? 'ASC' : 'DESC'}`);
        sql += ` ORDER BY ${orderClauses.join(', ')}`;
      }

      // Add Limit
      if (this.queryType === 'select' && this.limitVal !== null) {
        sql += ` LIMIT ${this.limitVal}`;
      }

      // Execute SQL
      if (this.queryType === 'select') {
        let rows = await sqliteDb.allAsync(sql, params);
        
        // Map nested joined fields back into objects
        // E.g. _join_brands_name -> brands: { name }
        rows = rows.map(row => {
          const formatted = { ...row };
          const nested = {};
          
          Object.keys(row).forEach(k => {
            if (k.startsWith('_join_')) {
              const parts = k.split('_'); // ['', 'join', 'tableName', 'fieldName']
              const joinTable = parts[2];
              const joinField = parts[3];
              
              if (!nested[joinTable]) nested[joinTable] = {};
              nested[joinTable][joinField] = row[k];
              delete formatted[k];
            }
          });
          
          // Map database structure names if needed:
          // SQLite table has columns (e.g. products has stock_quantity, but routes check products.stock)
          // Wait, routes select products.*, let's copy stock_quantity to stock
          // Also check for other fields.
          // Wait, what does the products table have?
          // SQLite schema: we have products with uom, cost_price, selling_price, etc.
          // Wait, in database.sql: the products table doesn't have a 'stock' column! The stock is stored in `warehouse_stock` table!
          // But wait, the backend `routes/inventory.js` queries all products:
          // `supabase.from('products').select('*, brands(*), categories(*)')`.
          // Wait, how does it get stock? Let's check how the PHP database structure or Node database structure gets stock:
          // In routes/inventory.js:
          // Wait, let's view routes/inventory.js to see if there is an endpoint for products that aggregates stock.
          // Let's inspect routes/inventory.js to check how products are loaded and stock is returned.
          
          return { ...formatted, ...nested };
        });

        if (this.isSingle) {
          return { data: rows[0] || null, error: rows[0] ? null : new Error('No record found') };
        }
        if (this.isMaybeSingle) {
          return { data: rows[0] || null, error: null };
        }
        return { data: rows, error: null };
      } else {
        const result = await sqliteDb.runAsync(sql, params);
        // Map lastID to select results if needed
        if (this.queryType === 'insert' || this.queryType === 'upsert') {
          // Fetch inserted row
          const insertedRow = await sqliteDb.getAsync(`SELECT * FROM ${this.table} WHERE id = ?`, [result.id]);
          return { data: [insertedRow], error: null };
        }
        return { data: [{ id: result.id, changes: result.changes }], error: null };
      }
    } catch (err) {
      console.error('SQLite execution error:', err);
      return { data: null, error: err };
    }
  }
}

// Unified client exported
export const supabase = isSupabaseConfigured() ? supabaseClient : {
  from: (tableName) => {
    return new SQLiteBuilder(tableName);
  }
};
