// Curaleaf — store LOCATIONS only (from curaleaf.com's public CMS API).
// Menus run on Sweed but require a per-site API token, so menus are not scraped.
// Stores show on the map/store list flagged "menu not available". To add menus, get
// permission/an API arrangement from Curaleaf and implement scrapeMenu() like muv.ts.
import type { Store } from '../types.ts';
import type { OperatorScraper } from './types.ts';
import { getJson } from './http.ts';
import { cleanText } from '../normalize.ts';
import { DAYS, emptyWeek } from '../hours.ts';

const LONG: Record<string, string> = { sun: 'sunday', mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday' };
function curaleafHours(times: any) {
  if (!times) return null;
  const w = emptyWeek();
  let any = false;
  for (const d of DAYS) {
    const slots = times[`${LONG[d]}Times`];
    if (!Array.isArray(slots)) continue;
    w[d] = slots.filter((x: any) => Array.isArray(x) && /^\d\d:\d\d$/.test(x[0]) && /^\d\d:\d\d$/.test(x[1])).map((x: any) => [x[0], x[1]] as [string, string]);
    if (w[d].length) any = true;
  }
  return any ? w : null;
}

export const curaleaf: OperatorScraper = {
  key: 'curaleaf',
  name: 'Curaleaf',

  async listStores() {
    const docs: any[] = [];
    for (let page = 1; page <= 40; page++) {
      const res = await getJson(`https://curaleaf.com/api/dispensaries?page=${page}`);
      docs.push(...(res.docs ?? []));
      if (!res.hasNextPage) break;
    }
    return docs
      .filter((d) => d.state?.abbreviation === 'FL' && d._status === 'published'
        && d.ecommerce?.dispensary_type !== 'PRERELEASE')
      .map((d): Store | null => {
        const loc = d.synced_location_information ?? {};
        const coord = loc.coordinate;
        if (!Array.isArray(coord)) return null;
        return {
          id: `curaleaf:${d.slug}`,
          operator: 'curaleaf',
          operatorName: 'Curaleaf',
          name: cleanText(d.friendly_name).replace(/,\s*FL$/, ''),
          address: cleanText(loc.address),
          city: cleanText(loc.city),
          zip: String(loc.zipcode ?? '').slice(0, 5),
          lat: Number(coord[1]),
          lng: Number(coord[0]),
          platform: 'curaleaf-cms',
          platformStoreId: d.slug,
          menuUrl: `https://curaleaf.com/shop/florida/${d.slug}/menu`,
          menuSupported: false,
          phone: cleanText(loc.phone),
          hours: curaleafHours(loc.times),
          tz: loc.timezone_string || undefined,
        };
      })
      .filter((s): s is Store => s !== null);
  },
};
