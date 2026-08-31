/**
 * "No React in the module graph", checked over the module graph.
 *
 * The README promises that a Node service which installs no React can import
 * `@credda/js/headless` and not fail on `Cannot find package 'react'`, and
 * `src/headless.ts` opens by saying the same. What guarded it was
 * `src/lib/surface.test.ts`, which asserts that `CreddaProvider` and the hooks
 * are not among the entry's EXPORT NAMES. That is a weaker claim than the one
 * being made: a module can import React and export nothing from it, and every
 * export-name assertion stays green while the published entry point throws on
 * load for exactly the consumer it was built for.
 *
 * So this walks the graph instead -- `headless.ts` and everything it reaches by
 * a relative import -- and fails on any React specifier anywhere in it. It reads
 * source rather than `dist/`, because CI runs the suite before the build.
 *
 * `vite.config.ts` marks React external, so a React import would not even be
 * bundled: it would become a bare `import 'react'` in `dist/headless.js` and
 * fail at the consumer's `require`, which is the failure this exists to catch
 * and the one furthest from anybody who could fix it.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

const REACT = /^(react|react-dom|react\/jsx-runtime|react\/jsx-dev-runtime)($|\/)/;

/** Every module specifier in a file: static imports, re-exports, dynamic. */
function specifiersIn(source: string): readonly string[] {
  const found: string[] = [];
  for (const pattern of [
    /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) {
    for (const match of source.matchAll(pattern)) found.push(match[1] as string);
  }
  return found;
}

/**
 * Every file reachable from `entry`, and every bare specifier any of them names.
 * Relative specifiers are written `./x.js` in source and resolve to `./x.ts` or
 * `./x.tsx` on disk.
 */
function graphFrom(entry: string): { files: string[]; bare: { file: string; specifier: string }[] } {
  const files: string[] = [];
  const bare: { file: string; specifier: string }[] = [];
  const queue = [entry];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);

    for (const specifier of specifiersIn(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) {
        bare.push({ file, specifier });
        continue;
      }
      const base = resolve(dirname(file), specifier).replace(/\.js$/, '');
      const next = [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((candidate) => {
        try {
          readFileSync(candidate);
          return true;
        } catch {
          return false;
        }
      });
      expect(next, `${file} imports ${specifier}, which resolves to no file`).toBeDefined();
      queue.push(next as string);
    }
  }
  return { files, bare };
}

describe('the headless entry point', () => {
  const graph = graphFrom(resolve(here, 'headless.ts'));

  it('reaches the modules it is made of, so an empty walk cannot pass', () => {
    // The whole file is vacuous if the walk finds nothing. `headless.ts` alone
    // re-exports from five modules under `lib/`.
    expect(graph.files.length).toBeGreaterThanOrEqual(6);
    expect(graph.files.some((f) => f.endsWith('client.ts'))).toBe(true);
    expect(graph.files.some((f) => f.endsWith('stream.ts'))).toBe(true);
  });

  it('imports React nowhere in its graph, not even for a type', () => {
    const offenders = graph.bare.filter(({ specifier }) => REACT.test(specifier));
    expect(offenders).toEqual([]);
  });

  it('reaches no component or hook module at all', () => {
    const ui = graph.files.filter((f) => /\/(components|hooks)\//.test(f));
    expect(ui).toEqual([]);
  });

  it('imports nothing bare except Node builtins the runtime already has', () => {
    // A dependency reachable from the headless entry would be a runtime
    // dependency of this package, and `package.json` declares none.
    const runtime = graph.bare.filter(({ specifier }) => !specifier.startsWith('node:'));
    expect(runtime).toEqual([]);
  });
});

describe('the root entry, by contrast', () => {
  it('does reach React, which is why it is the entry that needs it installed', () => {
    // Stated as a test so the two entry points are not accidentally made the
    // same thing -- at which point the check above would pass by having nothing
    // left to separate.
    const graph = graphFrom(resolve(here, 'index.ts'));
    expect(graph.bare.some(({ specifier }) => REACT.test(specifier))).toBe(true);
  });
});
