// Turns the engine modules into one plain browser script (types stripped, imports/exports removed;
// the modules share no top-level names). Used by build-demo.ts and build-site.ts.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('..', import.meta.url);

export function bundleLib(): string {
  return ['src/types.ts', 'src/hours.ts', 'src/query.ts', 'src/engine.ts', 'src/api.ts']
    .map((f) => stripTypeScriptTypes(readFileSync(new URL(f, root), 'utf8'))
      .replace(/^import\s[^;]*;\s*$/gm, '')
      .replace(/^export\s+(?=(const|function|let|class|async))/gm, ''))
    .join('\n');
}
