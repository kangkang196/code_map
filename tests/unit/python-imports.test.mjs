import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PythonAdapter } from '../../dist/adapters/python.js';

const target = 'extractors/vlm_extractor.py';
const definition = 'def extract_vlm():\n    pass\n';

async function parseCaller(source, { caller = 'caller.py', files = {} } = {}) {
  // Put the caller first: package-member precedence must not depend on manifest order.
  const sources = { [caller]: source, 'extractors/__init__.py': '', [target]: definition, ...files };
  const parsed = await new PythonAdapter().parseProject({
    root: '.',
    files: Object.entries(sources).filter(([, source]) => source !== null).map(([path, source]) => ({
      path, absPath: path, language: 'python', source: Buffer.from(source),
    })),
  });
  const result = parsed.find((file) => file.path === caller);
  assert.equal(result.parseStatus, 'ok');
  const calls = result.edges.filter((edge) => edge.type === 'CALLS' && edge.target.kind === 'resolved').map((edge) => {
    const file = parsed.find((file) => file.path === edge.target.path);
    const decl = file.declarations.find((decl) => decl.localId === edge.target.localId);
    return { path: file.path, name: decl.qualifiedName, line: edge.evidence.startLine };
  });
  return { result, calls };
}

for (const [name, statement, expression, options] of [
  ['absolute', 'from extractors import vlm_extractor', 'vlm_extractor.extract_vlm()', {}],
  ['aliased', 'from extractors import vlm_extractor as vlm', 'vlm.extract_vlm()', {}],
  ['relative sibling', 'from . import vlm_extractor', 'vlm_extractor.extract_vlm()', { caller: 'extractors/caller.py' }],
  ['relative package', 'from ..extractors import vlm_extractor', 'vlm_extractor.extract_vlm()', { caller: 'tests/caller.py' }],
  ['namespace package', 'from extractors import vlm_extractor', 'vlm_extractor.extract_vlm()', { files: { 'extractors/__init__.py': null } }],
  ['subpackage', 'from extractors import vlm_extractor', 'vlm_extractor.extract_vlm()', { files: { [target]: null, 'extractors/vlm_extractor/__init__.py': definition } }],
  ['parenthesized names', 'from extractors import (other, vlm_extractor as vlm)', 'vlm.extract_vlm()', {}],
  ['explicit child re-export', 'from extractors import vlm_extractor', 'vlm_extractor.extract_vlm()', { files: { 'extractors/__init__.py': 'from . import vlm_extractor\n' } }],
  ['module alias re-export', 'from extractors import vlm_extractor', 'vlm_extractor.extract_vlm()', { files: { 'extractors/__init__.py': 'import extractors.vlm_extractor as vlm_extractor\n' } }],
  ['existing module alias', 'import extractors.vlm_extractor as vlm', 'vlm.extract_vlm()', {}],
  ['existing function import', 'from extractors.vlm_extractor import extract_vlm', 'extract_vlm()', {}],
]) {
  test(`Python from-import resolves ${name} calls`, async () => {
    const { result, calls } = await parseCaller(`${statement}\ndef run_stage():\n    ${expression}\n`, options);
    const expectedPath = name === 'subpackage' ? 'extractors/vlm_extractor/__init__.py' : target;
    assert.deepEqual(calls, [{ path: expectedPath, name: 'extract_vlm', line: 3 }]);
    assert.deepEqual(result.diagnostics, []);
  });
}

test('Python from-import preserves a package declaration over a same-named submodule', async () => {
  const { calls } = await parseCaller('from extractors import vlm_extractor\nvlm_extractor()\n', {
    files: { 'extractors/__init__.py': 'def vlm_extractor():\n    pass\n' },
  });
  assert.deepEqual(calls, [{ path: 'extractors/__init__.py', name: 'vlm_extractor', line: 2 }]);
});

for (const [name, source, options, unresolved] of [
  ['package variable', 'from extractors import vlm_extractor\nvlm_extractor.extract_vlm()\n', { files: { 'extractors/__init__.py': 'vlm_extractor = object()\n' } }, 'vlm_extractor.extract_vlm'],
  ['package re-export', 'from extractors import vlm_extractor\nvlm_extractor.extract_vlm()\n', { files: { 'extractors/__init__.py': 'from elsewhere import vlm_extractor\n' } }, 'vlm_extractor.extract_vlm'],
  ['package class member', 'from extractors import vlm_extractor\nvlm_extractor.extract_vlm()\n', { files: { 'extractors/__init__.py': 'class vlm_extractor:\n    pass\n' } }, 'vlm_extractor.extract_vlm'],
  ['package duplicate member', 'from extractors import vlm_extractor\nvlm_extractor.extract_vlm()\n', { files: { 'extractors/__init__.py': 'from . import vlm_extractor\nvlm_extractor = object()\n' } }, 'vlm_extractor.extract_vlm'],
  ['non-package parent', 'from extractors import vlm_extractor\nvlm_extractor.extract_vlm()\n', { files: { 'extractors.py': '' } }, 'vlm_extractor.extract_vlm'],
  ['parameter shadow', 'from extractors import vlm_extractor\ndef run_stage(vlm_extractor):\n    vlm_extractor.extract_vlm()\n', {}, 'vlm_extractor.extract_vlm'],
  ['local reassignment', 'from extractors import vlm_extractor\ndef run_stage():\n    vlm_extractor.extract_vlm()\n    vlm_extractor = object()\n', {}, 'vlm_extractor.extract_vlm'],
  ['duplicate import', 'from extractors import vlm_extractor\nfrom other import vlm_extractor\nvlm_extractor.extract_vlm()\n', {}, 'vlm_extractor.extract_vlm'],
  ['dynamic getattr', 'from extractors import vlm_extractor\ndef run_stage(stage):\n    target = getattr(vlm_extractor, stage)\n    target()\n', {}, 'target'],
  ['module called directly', 'from extractors import vlm_extractor\nvlm_extractor()\n', {}, 'vlm_extractor'],
  ['missing submodule', 'from extractors import missing\nmissing.extract_vlm()\n', {}, 'missing.extract_vlm'],
  ['unbound source package name', 'from extractors import vlm_extractor\nextractors.extract_vlm()\n', { files: { 'extractors/extractors.py': definition } }, 'extractors.extract_vlm'],
]) {
  test(`Python from-import keeps ${name} unresolved`, async () => {
    const { result, calls } = await parseCaller(source, options);
    assert.deepEqual(calls, []);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'UNRESOLVED_CALLEE' && diagnostic.message === unresolved));
  });
}

test('Python from-import binds a function-local aliased submodule', async () => {
  const { calls } = await parseCaller('def run_stage():\n    from extractors import vlm_extractor as vlm\n    vlm.extract_vlm()\n');
  assert.deepEqual(calls, [{ path: target, name: 'extract_vlm', line: 3 }]);
});

test('Python from-import binds a relative child in its own package initializer', async () => {
  const { calls } = await parseCaller('', { files: {
    'extractors/__init__.py': 'from . import vlm_extractor\nvlm_extractor.extract_vlm()\n',
  }, caller: 'extractors/__init__.py' });
  assert.deepEqual(calls, [{ path: target, name: 'extract_vlm', line: 2 }]);
});
