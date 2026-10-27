import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Guards the package's layering: a lower layer never depends on a higher
// one, and only the DDD layer (`aggregate`) may reach `@quilla-be-kit/ddd`.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const ALLOWED: Record<string, readonly string[]> = {
  database: [],
  'db-adapter': ['database'],
  query: [],
  'query-schema': ['query'],
  errors: [],
  dao: ['database', 'db-adapter', 'query', 'errors'],
  'unit-of-work': ['database'],
  postgres: ['database', 'db-adapter', 'query'],
  repository: ['dao', 'database', 'db-adapter', 'query', 'errors', 'unit-of-work'],
  aggregate: ['repository', 'dao', 'database', 'db-adapter', 'query', 'errors', 'unit-of-work'],
};

const PACKAGES: Record<string, readonly string[]> = {
  pg: ['postgres'],
  zod: ['query-schema'],
  '@quilla-be-kit/errors': ['errors'],
  '@quilla-be-kit/ddd': ['aggregate'],
};

function files(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path, ext);
    return path.endsWith(ext) ? [path] : [];
  });
}

function specifiers(path: string): string[] {
  const info = ts.preProcessFile(readFileSync(path, 'utf8'), true, true);
  return info.importedFiles.map((file) => file.fileName);
}

function layerOf(path: string): string {
  return relative(src, path).split(sep)[0] ?? '';
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

const sources = files(src, '.ts').filter((path) => relative(src, path) !== 'index.ts');
const imports = new Map(sources.map((path) => [path, specifiers(path)]));

describe('package layers', () => {
  it('every source folder is a known layer', () => {
    const layers = new Set(sources.map(layerOf));
    expect([...layers].sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('relative imports only reach the same or an allowed lower layer', () => {
    const violations: string[] = [];
    for (const path of sources) {
      const layer = layerOf(path);
      for (const specifier of (imports.get(path) ?? []).filter((s) => s.startsWith('.'))) {
        const target = layerOf(resolve(dirname(path), specifier));
        if (target !== layer && !ALLOWED[layer]?.includes(target)) {
          violations.push(`${relative(root, path)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('packages are imported only by the layers that own them', () => {
    const violations: string[] = [];
    for (const path of sources) {
      const layer = layerOf(path);
      for (const specifier of (imports.get(path) ?? []).filter((s) => !s.startsWith('.'))) {
        if (specifier.startsWith('node:')) continue;
        const owners = PACKAGES[packageName(specifier)];
        if (!owners?.includes(layer)) {
          violations.push(`${relative(root, path)} → ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('the main entry does not expose the DDD layer', () => {
    expect(specifiers(join(src, 'index.ts'))).not.toContain('./aggregate/index.js');
  });

  it('package.json keeps DDD optional and execution-context out', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    expect(pkg.peerDependenciesMeta['@quilla-be-kit/ddd']).toEqual({ optional: true });
    expect(pkg.peerDependencies).not.toHaveProperty('@quilla-be-kit/execution-context');
    expect(pkg.exports).toHaveProperty('./aggregate');
  });

  // Declaration emit can inline `import("…")` types the source never imports.
  it.skipIf(!existsSync(join(root, 'dist')))(
    'built declarations outside aggregate never reference ddd or execution-context',
    () => {
      const dist = join(root, 'dist');
      const leaks = files(dist, '.d.ts')
        .filter((path) => layerOf(path.replace(dist, src)) !== 'aggregate')
        .filter((path) =>
          specifiers(path).some((s) => /^@quilla-be-kit\/(ddd|execution-context)(\/|$)/.test(s)),
        )
        .map((path) => relative(root, path));
      expect(leaks).toEqual([]);
    },
  );
});
