import type { OperatorScraper } from './types.ts';
import { trulieve } from './trulieve.ts';
import { muv } from './muv.ts';
import { curaleaf } from './curaleaf.ts';

/** Register new operators here. */
export const SCRAPERS: OperatorScraper[] = [trulieve, muv, curaleaf];

export function getScraper(key: string): OperatorScraper | undefined {
  return SCRAPERS.find((s) => s.key === key);
}
