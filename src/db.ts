// SQLite storage using Node's built-in node:sqlite (no native deps).
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Product, Store } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = process.env.DB_PATH || join(here, '..', 'data', 'deals.db');

export function openDb(path = DEFAULT_DB_PATH): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS stores (
      id TEXT PRIMARY KEY, operator TEXT NOT NULL, operator_name TEXT NOT NULL,
      name TEXT NOT NULL, address TEXT, city TEXT, zip TEXT, lat REAL, lng REAL,
      platform TEXT, platform_store_id TEXT, menu_url TEXT,
      menu_supported INTEGER NOT NULL DEFAULT 0, last_scraped_at TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
      name TEXT, brand TEXT, strain TEXT, strain_type TEXT, category TEXT, subcategory TEXT,
      amount REAL, amount_unit TEXT, pack_count INTEGER,
      thc_pct REAL, thc_pct_max REAL, thc_mg REAL, cbd_pct REAL,
      price REAL, sale_price REAL, promo TEXT, qty_available REAL,
      url TEXT, image TEXT, group_key TEXT, scraped_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_products_store ON products(store_id);
    CREATE INDEX IF NOT EXISTS idx_products_cat ON products(category);
    CREATE TABLE IF NOT EXISTS price_history (
      product_id TEXT NOT NULL, day TEXT NOT NULL, price REAL, sale_price REAL,
      PRIMARY KEY (product_id, day)
    );
  `);
  // Columns added after the first release.
  const cols = new Set((db.prepare('PRAGMA table_info(stores)').all() as any[]).map((c) => c.name));
  if (!cols.has('hours')) db.exec('ALTER TABLE stores ADD COLUMN hours TEXT');
  if (!cols.has('tz')) db.exec('ALTER TABLE stores ADD COLUMN tz TEXT');
  if (!cols.has('phone')) db.exec('ALTER TABLE stores ADD COLUMN phone TEXT');
  const pcols = new Set((db.prepare('PRAGMA table_info(products)').all() as any[]).map((c) => c.name));
  if (!pcols.has('sale_ends_at')) db.exec('ALTER TABLE products ADD COLUMN sale_ends_at TEXT');
  if (!pcols.has('collections')) db.exec('ALTER TABLE products ADD COLUMN collections TEXT');
  if (!pcols.has('promo_ends')) db.exec('ALTER TABLE products ADD COLUMN promo_ends TEXT');
  return db;
}

export function upsertStores(db: DatabaseSync, stores: Store[]) {
  const stmt = db.prepare(`INSERT INTO stores (id, operator, operator_name, name, address, city, zip, lat, lng,
      platform, platform_store_id, menu_url, menu_supported, hours, tz, phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET operator=excluded.operator, operator_name=excluded.operator_name,
      name=excluded.name, address=excluded.address, city=excluded.city, zip=excluded.zip, lat=excluded.lat,
      lng=excluded.lng, platform=excluded.platform, platform_store_id=excluded.platform_store_id,
      menu_url=excluded.menu_url, menu_supported=excluded.menu_supported,
      hours=excluded.hours, tz=excluded.tz, phone=excluded.phone`);
  db.exec('BEGIN');
  try {
    for (const s of stores) {
      stmt.run(s.id, s.operator, s.operatorName, s.name, s.address, s.city, s.zip, s.lat, s.lng,
        s.platform, s.platformStoreId, s.menuUrl ?? null, s.menuSupported ? 1 : 0,
        s.hours ? JSON.stringify(s.hours) : null, s.tz ?? null, s.phone ?? null);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Replace a store's menu snapshot atomically, and log today's prices. */
export function replaceMenu(db: DatabaseSync, storeId: string, products: Product[]) {
  const ins = db.prepare(`INSERT OR REPLACE INTO products (id, store_id, name, brand, strain, strain_type, category,
      subcategory, amount, amount_unit, pack_count, thc_pct, thc_pct_max, thc_mg, cbd_pct, price, sale_price, promo,
      qty_available, url, image, group_key, scraped_at, sale_ends_at, collections, promo_ends)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const hist = db.prepare(`INSERT OR REPLACE INTO price_history (product_id, day, price, sale_price) VALUES (?,?,?,?)`);
  const day = new Date().toISOString().slice(0, 10);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM products WHERE store_id = ?').run(storeId);
    for (const p of products) {
      ins.run(p.id, p.storeId, p.name, p.brand, p.strain, p.strainType, p.category, p.subcategory, p.amount,
        p.amountUnit, p.packCount, p.thcPct, p.thcPctMax, p.thcMg, p.cbdPct, p.price, p.salePrice, p.promo,
        p.qtyAvailable, p.url, p.image, p.groupKey, p.scrapedAt, p.saleEndsAt ?? null,
        p.collections?.length ? JSON.stringify(p.collections) : null,
        p.promoEnds && Object.keys(p.promoEnds).length ? JSON.stringify(p.promoEnds) : null);
      hist.run(p.id, day, p.price, p.salePrice);
    }
    db.prepare('UPDATE stores SET last_scraped_at = ? WHERE id = ?').run(new Date().toISOString(), storeId);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** Apply a live stock check: delete sold-out products, refresh qty/price/scraped_at of the rest. */
export function applyStockCheck(db: DatabaseSync, results: Map<string, Product | null>) {
  const del = db.prepare('DELETE FROM products WHERE id = ?');
  const upd = db.prepare(`UPDATE products SET qty_available = ?, price = ?, sale_price = ?, promo = ?,
      thc_pct = ?, thc_pct_max = ?, scraped_at = ?, sale_ends_at = ? WHERE id = ?`);
  const hist = db.prepare(`INSERT OR REPLACE INTO price_history (product_id, day, price, sale_price) VALUES (?,?,?,?)`);
  const day = new Date().toISOString().slice(0, 10);
  db.exec('BEGIN');
  try {
    for (const [id, p] of results) {
      if (!p) { del.run(id); continue; }
      upd.run(p.qtyAvailable, p.price, p.salePrice, p.promo, p.thcPct, p.thcPctMax, p.scrapedAt, p.saleEndsAt ?? null, id);
      hist.run(id, day, p.price, p.salePrice);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function productsByIds(db: DatabaseSync, ids: string[]): Product[] {
  if (!ids.length) return [];
  return db.prepare(`SELECT * FROM products WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids).map(rowToProduct);
}

const rowToStore = (r: any): Store => ({
  id: r.id, operator: r.operator, operatorName: r.operator_name, name: r.name, address: r.address,
  city: r.city, zip: r.zip, lat: r.lat, lng: r.lng, platform: r.platform, platformStoreId: r.platform_store_id,
  menuUrl: r.menu_url ?? undefined, menuSupported: !!r.menu_supported, lastScrapedAt: r.last_scraped_at ?? undefined,
  hours: r.hours ? JSON.parse(r.hours) : null, tz: r.tz ?? undefined, phone: r.phone ?? undefined,
});

const rowToProduct = (r: any): Product => ({
  id: r.id, storeId: r.store_id, name: r.name, brand: r.brand, strain: r.strain, strainType: r.strain_type,
  category: r.category, subcategory: r.subcategory, amount: r.amount, amountUnit: r.amount_unit,
  packCount: r.pack_count, thcPct: r.thc_pct, thcPctMax: r.thc_pct_max, thcMg: r.thc_mg, cbdPct: r.cbd_pct,
  price: r.price, salePrice: r.sale_price, promo: r.promo ?? '', qtyAvailable: r.qty_available, url: r.url,
  image: r.image, groupKey: r.group_key, scrapedAt: r.scraped_at,
  saleEndsAt: r.sale_ends_at ?? null, collections: r.collections ? JSON.parse(r.collections) : [],
  promoEnds: r.promo_ends ? JSON.parse(r.promo_ends) : undefined,
});

export function allStores(db: DatabaseSync): Store[] {
  return db.prepare('SELECT * FROM stores ORDER BY operator, name').all().map(rowToStore);
}

export function productsForStores(db: DatabaseSync, storeIds: string[], categories?: string[]): Product[] {
  if (!storeIds.length) return [];
  const sp = storeIds.map(() => '?').join(',');
  let sql = `SELECT * FROM products WHERE store_id IN (${sp})`;
  const args: string[] = [...storeIds];
  if (categories?.length) {
    sql += ` AND category IN (${categories.map(() => '?').join(',')})`;
    args.push(...categories);
  }
  return db.prepare(sql).all(...args).map(rowToProduct);
}
