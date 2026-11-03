# FL Deal Finder

Compare in-stock prices across Florida medical marijuana dispensaries and find the cheapest way to buy what you need.

Type what you want, such as `2 oz flower`, `an eighth over 25%` or `1000mg gummies under $40`. FL Deal Finder searches the dispensary menus near you and answers with something like:

> **$132 · $2.36/g**: Candy Pavé (Savvy), **4 × 14g**, THC 15.4%, MÜV · 3.2 mi · Open · closes 9 PM

## Features

- **Search where you are.** Enter a ZIP or tap **Near me**, and pick a radius (5–100 mi or anywhere in Florida). Your ZIP stays in your browser and is never put in shared links.
- **Plain-language search:** amounts (`2 oz`, `an eighth`, `half oz`, `1000mg`), categories (`flower`, `vape carts`, `live rosin`, `gummies`), strain types, THC (`over 25%`, `under 18%`), price (`under $40`, `under 40`), or any strain, brand or product name.
- **Best ways to buy an amount.** A bounded-knapsack optimizer finds the cheapest mix of package sizes at a single store that reaches your amount, using live stock counts (4 × 14g vs 2 × 28g vs 8 × 7g).
  - Strains with the same price and size are folded into "Same price, other strains".
  - The same deal at other stores of the chain shows as "Also in stock at…".
  - A "mix" plan combining different products appears only when it beats every single-product plan.
- **Store info on every result:** open/closed status computed in the store's own time zone (the western Panhandle is on Central time), plus Directions, Call and Store page links.
- **Quick filters:** Open now, On sale, No shake/ground.
- **More filters:** category, package size, min/max THC, max price, strain type, dispensary chain, and specific stores (with an "only these stores" option). Sort by $/g, $/mg THC, price, THC % or distance.
- **Helpful empty states**, with one-tap fixes such as "Search a wider area" or "Include closed stores".
- **Shareable searches:** the URL holds the search (never your location), with a Share button.
- **Installable:** add it to your home screen. Works in light and dark mode.
- **In stock only:**
  - **Scrape:** an item is stored only if the dispensary reports a positive stock count and marks it orderable.
  - **Search:** items with zero or unknown stock are never shown, buy plans never exceed available quantity, and menus older than `MAX_MENU_AGE_HOURS` are left out (the page says which stores).
  - **Live re-check (Node server only):** `/api/verify` re-checks the top results with the dispensary after each search.
- **Store-specific links:** MÜV product links open the exact store's product page. Trulieve's site shows stock for whichever store the visitor has selected there, so Trulieve results also link to the store page with a "tap Shop Here first" note.

## Coverage

| Operator | FL stores | Menus | Source |
|---|---|---|---|
| Trulieve | ~170 | ✅ | trulieve.com Magento GraphQL (`robots.txt`: `Allow: /*graphql`), `Store:` header per location |
| MÜV | ~86 | ✅ | Sweed product API used by muvfl.com menus; store-id table read from the site's JS bundle |
| Curaleaf | ~80 | ❌ locations only | curaleaf.com public CMS API. Menus need a site token, so they aren't scraped. |
| Dutchie / Jane stores | — | ❌ | Bot-protected. Needs an official API key or partnership. |

Stores with no readable menu still appear on the store list. Searches say when they weren't included.

## Public site (GitHub Pages)

The public site is fully static. `.github/workflows/refresh.yml` runs every 3 hours from about 8am to 11pm Eastern, on every push to `main`, and on demand:

1. **test:** `npm test`.
2. **scrape:** 6 parallel jobs, each scraping one sixth of the Trulieve and MÜV stores, in about 25 minutes. Shard 0 also refreshes Curaleaf locations.
3. **deploy:** merges the shard databases, runs `scripts/build-site.ts` and publishes `site/` to GitHub Pages. Stores whose scrape failed keep the menu already live, until it ages out.

In the browser, `static-api.js` loads `data/stores.json`, then only the menus of stores in the searched area, and runs the same engine as the Node server.

**One-time setup** (repo → Settings):
- **Pages → Build and deployment → Source: GitHub Actions.**
- *(optional)* **Secrets and variables → Actions → Variables:** `SCRAPER_CONTACT` = an email or URL to put in the scraper's User-Agent. It defaults to the repo URL.

GitHub pauses scheduled workflows after 60 days with no repository activity. If that happens, re-enable the workflow from the Actions tab.

## Run it locally

Requires **Node ≥ 22.18**. There are no npm dependencies: it uses built-in `node:sqlite`, TypeScript type-stripping, and `node:test`.

```bash
export SCRAPER_CONTACT="you@example.com"     # sent in the User-Agent so sites can reach you

npm run scrape -- --zip <ZIP> --radius 25    # menus near a ZIP (Trulieve ≈ 50 s/store, MÜV ≈ 1 s/store)
npm run scrape                               # everything (~2.5 h, mostly Trulieve)
npm run scrape -- --stores-only              # refresh locations and hours only
npm run scrape -- --shard 2/6                # one slice of the stores (used by CI)

npm start                                    # Node server with live stock re-check: http://localhost:3000
npm run build:site                           # site/: the static build (serve with any static server)
npm test
```

Data is stored in `data/deals.db` (SQLite). The `price_history` table keeps a daily price per product, for future "lowest in 30 days" or price-drop features.

## API (Node server; the static site runs the same handlers in the browser)

```
GET /api/search?q=2 oz flower&zip=<ZIP>&radius=25|any
    &category=flower,vape  &strainType=indica  &minThc=20  &maxThc=25  &maxPrice=60
    &sizes=14,28  &target=56g|2oz|1000mg  &whole=1 (no shake)  &sale=1  &open=1
    &operators=muv,trulieve  &stores=<store id>,...  &only=1
    &sort=unit|thcValue|price|thc|distance  &planSort=price|thcValue|distance
GET /api/stores?zip=<ZIP>&radius=50
GET /api/meta
GET /api/nearzip?lat=..&lng=..                 # nearest Florida ZIP (for "Near me")
GET /api/verify?ids=<product ids, max 40>      # live stock re-check (server only)
```

Explicit parameters override whatever was parsed from `q`. Search results include `storeStatus` (open/closed label per store).

Environment variables: `PORT` (3000), `DB_PATH`, `MAX_MENU_AGE_HOURS` (24 on the server, 12 on the static site), `SCRAPER_CONTACT`, `SCRAPER_MIN_INTERVAL_MS` (600).

## Layout

```
src/
  scrapers/      one file per operator + polite HTTP client (rate limit, retries, honest UA)
  normalize.ts   sizes ("1/8 oz", "100mg [10-Pack]"), categories, strain types, grouping keys
  hours.ts       store hours parsing, time zones, open/closed labels
  query.ts       free-text query parser
  engine.ts      filtering, ranking, min-cost-cover optimizer, plan grouping (pure; also runs in-browser)
  api.ts         request → engine (shared by server and static site)
  db.ts          SQLite schema + snapshot replace
  server.ts      HTTP server + live stock re-check
public/          mobile-first UI (vanilla JS); static-api.js = in-browser API for the static site
scripts/         build-site.ts (GitHub Pages), build-demo.ts (single-file snapshot), bundle-lib.ts
.github/workflows/refresh.yml   scheduled scrape → build → deploy
```

### Adding an operator

Implement `OperatorScraper` (`listStores()` plus optional `scrapeMenu()` and `checkStock()`) in `src/scrapers/<name>.ts`, return normalized `Product`s and `Store`s (with `hours` if available), and register it in `src/scrapers/index.ts`.

## Scraping etiquette and caveats

- The scrapers only read the same public menu data the dispensaries' own websites load. They identify themselves (`FLDealFinderBot` + contact), follow `robots.txt` paths, and wait about 600 ms between requests per host.
- They do **not** bypass bot protection, age gates, or auth tokens. That is why Curaleaf menus and Dutchie/Jane stores are excluded.
- Check each site's Terms of Service before running this commercially. Site changes can break adapters; the MÜV store-id table in particular is read from a JS bundle.
- THC % on Trulieve varies by batch. `thcPct` is the lowest in-stock batch and `thcPctMax` the highest. The minimum-THC filter uses the lowest batch and the maximum-THC filter uses the highest, so both are conservative.
- Prices are menu prices before loyalty or first-time discounts. Store hours are regular weekly hours; holidays may differ. Florida purchase and possession limits apply.
