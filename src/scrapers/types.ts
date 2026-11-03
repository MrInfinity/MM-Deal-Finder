import type { Product, Store } from '../types.ts';

export interface OperatorScraper {
  /** short key, used in store ids: `${key}:${platformStoreId}` */
  key: string;
  name: string;
  /** Fetch all Florida store locations for this operator. */
  listStores(): Promise<Store[]>;
  /** Fetch & normalize the full medical menu for one store. Omit if menus aren't supported. */
  scrapeMenu?(store: Store): Promise<Product[]>;
  /**
   * Live stock re-check for specific products at one store. Returns the fresh product
   * (current qty/price) or null if it is sold out / no longer on the menu.
   */
  checkStock?(store: Store, products: Product[]): Promise<Map<string, Product | null>>;
}
