import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it } from 'node:test';

const root = new URL('..', import.meta.url).pathname;
const spec = JSON.parse(readFileSync(join(root, 'public/openapi.json'), 'utf8'));

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full) : name === 'route.ts' ? [full] : [];
  });
}

/** The HTTP operations the code actually serves, found from each route file's exports. */
function servedOperations(): string[] {
  const out: string[] = [];
  for (const base of ['src/app/api', 'src/app/.well-known']) {
    for (const file of routeFiles(join(root, base))) {
      const path =
        '/' +
        relative(join(root, 'src/app'), file)
          .replace(/\/route\.ts$/, '')
          .replace(/\[(\w+)\]/g, '{$1}');
      const source = readFileSync(file, 'utf8');
      for (const m of source.matchAll(/export (?:async )?function (GET|POST|PUT|PATCH|DELETE)\b/g)) out.push(`${m[1].toLowerCase()} ${path}`);
    }
  }
  return out.sort();
}

const documentedOperations = () =>
  Object.entries(spec.paths as Record<string, Record<string, unknown>>)
    .flatMap(([path, ops]) => Object.keys(ops).map((method) => `${method} ${path}`))
    .sort();

describe('OpenAPI spec', () => {
  it('documents exactly the operations the code serves', () => {
    assert.deepEqual(documentedOperations(), servedOperations());
  });

  it('has every $ref pointing at a schema that exists', () => {
    const missing: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (k === '$ref' && typeof v === 'string') {
            const name = v.replace('#/components/schemas/', '');
            if (!(name in spec.components.schemas)) missing.push(v);
          } else walk(v);
        }
      }
    };
    walk(spec);
    assert.deepEqual(missing, []);
  });

  it('declares every path parameter', () => {
    for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, { parameters?: { name: string; in: string }[] }>>)) {
      const needed = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      for (const [method, op] of Object.entries(ops)) {
        const declared = (op.parameters ?? []).filter((p) => p.in === 'path').map((p) => p.name);
        assert.deepEqual(declared.sort(), needed.sort(), `${method} ${path}`);
      }
    }
  });

  it('gives every operation a summary and at least one response', () => {
    for (const [path, ops] of Object.entries(spec.paths as Record<string, Record<string, { summary?: string; responses?: object }>>)) {
      for (const [method, op] of Object.entries(ops)) {
        assert.ok(op.summary, `${method} ${path} has no summary`);
        assert.ok(Object.keys(op.responses ?? {}).length > 0, `${method} ${path} has no responses`);
      }
    }
  });

  it('keeps approval out of the agent surface: the MCP description lists no approve tool', () => {
    const mcp = JSON.stringify(spec.paths['/api/mcp']);
    assert.match(mcp, /There is no approve tool/);
  });
});
