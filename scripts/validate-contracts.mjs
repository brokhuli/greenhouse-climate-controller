#!/usr/bin/env node
// Contract-validation harness for `contracts/`.
//
// Automates the per-contract check each contract README specifies (and `docs/backlog.md`
// previously tracked as "blocked on CI"): every positive example fixture must validate against
// its schema, and every `*.bad-*.json` counter-example must fail. Two contract shapes:
//
//   - JSON-Schema contracts (mqtt/, frontend-ws/): each `examples/<frame>.*.json` is validated
//     against `<frame>.schema.json`, named by the fixture's first dot-segment.
//   - OpenAPI contracts (controller-rest/, frontend-rest/): each example is validated against a
//     named component schema under `components/schemas/`, mapped by `examples/cases.json`; the
//     `openapi.json` document is additionally linted with Redocly using the contract's redocly.yaml.
//
// Cross-schema `$ref`s resolve offline: every schema file is registered under an `$id` derived
// from its repo-relative path (`https://greenhouse.local/<path>`), matching the base the MQTT/WS
// schemas already embed (see contracts/mqtt/README.md "consuming the schemas").
//
// Exit code: 0 when every fixture matches its expectation and every lint passes; 1 otherwise.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, relative, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const ID_BASE = 'https://greenhouse.local/';

// strict:false so the harness tolerates OpenAPI component fragments (files keyed by component
// name) and any OpenAPI vocabulary; "compiles clean under strict" stays a schema-authoring
// property checked separately. allErrors so a failing fixture reports every violation.
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true, allowUnionTypes: true }));

/** Repo-relative POSIX path → stable `$id`. Matches the `$id` mqtt/ws schemas already embed. */
const idFor = (absPath) => ID_BASE + relative(repoRoot, absPath).split(/[\\/]/).join(posix.sep);

const listJson = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => join(dir, f)) : [];

/** Register a schema file under its `$id` (embedded if present, else derived from its path). */
function registerSchema(absPath) {
  const schema = JSON.parse(readFileSync(absPath, 'utf8'));
  const id = schema.$id ?? idFor(absPath);
  if (!schema.$id) schema.$id = id; // OpenAPI component fragments carry no $id; inject for ref resolution
  if (!ajv.getSchema(id)) ajv.addSchema(schema, id);
  return id;
}

const CONTRACTS = [
  { dir: 'contracts/mqtt', kind: 'jsonschema' },
  { dir: 'contracts/frontend-ws', kind: 'jsonschema' },
  { dir: 'contracts/controller-rest', kind: 'openapi' },
  { dir: 'contracts/frontend-rest', kind: 'openapi' },
];

const results = []; // { contract, name, ok, detail }
const record = (contract, name, ok, detail = '') => results.push({ contract, name, ok, detail });

/** Validate one fixture against an already-registered schema ref; check the pass/fail expectation. */
function checkFixture(contract, fixturePath, schemaRef, expectPass, label = basename(fixturePath)) {
  const validate = ajv.getSchema(schemaRef);
  if (!validate) {
    record(contract, label, false, `schema not found: ${schemaRef}`);
    return;
  }
  const data = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const valid = validate(data);
  if (valid === expectPass) {
    record(contract, label, true, expectPass ? 'valid' : 'rejected as expected');
  } else if (expectPass) {
    const errs = (validate.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
    record(contract, label, false, `expected valid but failed: ${errs}`);
  } else {
    record(contract, label, false, 'expected to fail but validated');
  }
}

/** JSON-Schema contract: fixture `<frame>.*.json` → `<frame>.schema.json`; `*.bad-*` must fail. */
function runJsonSchemaContract(contract) {
  const dir = join(repoRoot, contract.dir);
  for (const f of listJson(dir).filter((p) => p.endsWith('.schema.json'))) registerSchema(f);

  const unionPath = join(dir, 'message.schema.json'); // present on the WS contract; absent on MQTT
  for (const fixture of listJson(join(dir, 'examples'))) {
    const file = basename(fixture);
    const frame = file.split('.')[0];
    const expectPass = !/\.bad-/.test(file);
    checkFixture(contract.dir, fixture, idFor(join(dir, `${frame}.schema.json`)), expectPass);
    // Where the contract carries a discriminated union, a positive frame must also validate against it.
    if (expectPass && existsSync(unionPath)) {
      checkFixture(contract.dir, fixture, idFor(unionPath), true, `${file} (union)`);
    }
  }
}

/** OpenAPI contract: register components/schemas, run examples/cases.json, then Redocly-lint. */
function runOpenApiContract(contract) {
  const dir = join(repoRoot, contract.dir);
  for (const f of listJson(join(dir, 'components', 'schemas'))) registerSchema(f);

  const casesPath = join(dir, 'examples', 'cases.json');
  if (!existsSync(casesPath)) {
    record(contract.dir, 'cases.json', false, 'missing fixture manifest');
  } else {
    for (const c of JSON.parse(readFileSync(casesPath, 'utf8')).cases) {
      const [file, pointer] = c.schema.split('#');
      const schemaRef = `${idFor(join(dir, 'components', 'schemas', file))}#${pointer}`;
      checkFixture(contract.dir, join(dir, 'examples', c.fixture), schemaRef, c.expect === 'pass');
    }
  }
  lintOpenApi(contract.dir, dir);
}

/** Run `redocly lint` via the pinned @redocly/cli, cross-platform (spawn node on its bin script). */
function lintOpenApi(contract, dir) {
  let cli;
  try {
    const pkgPath = require.resolve('@redocly/cli/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    cli = join(dirname(pkgPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.redocly);
  } catch {
    record(contract, 'redocly lint', false, '@redocly/cli not installed — run `npm install`');
    return;
  }
  const res = spawnSync(process.execPath, [cli, 'lint', '--config', join(dir, 'redocly.yaml'), join(dir, 'openapi.json')], {
    encoding: 'utf8',
  });
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
  // Redocly's own Node process can hit a libuv teardown assertion (UV_HANDLE_CLOSING in async.c)
  // on Node 24 / Windows *after* printing a clean result, yielding a nonzero exit on a valid doc.
  // Forgive a nonzero exit only when both the teardown crash and the success marker are present.
  const valid = /API description is valid/i.test(out);
  const teardownCrash = /Assertion failed:[^\n]*async\.c/i.test(out);
  if (res.status === 0 || (valid && teardownCrash)) {
    record(contract, 'redocly lint', true, 'openapi.json');
  } else {
    record(contract, 'redocly lint', false, out.trim().split('\n').slice(-12).join('\n') || `exit ${res.status}`);
  }
}

for (const contract of CONTRACTS) {
  if (contract.kind === 'jsonschema') runJsonSchemaContract(contract);
  else runOpenApiContract(contract);
}

let lastContract = '';
for (const r of results) {
  if (r.contract !== lastContract) {
    console.log(`\n${r.contract}`);
    lastContract = r.contract;
  }
  console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
}

const failures = results.filter((r) => !r.ok);
console.log(`\n${results.length - failures.length}/${results.length} checks passed.`);
if (failures.length) {
  console.error(`${failures.length} check(s) failed.`);
  process.exit(1);
}
