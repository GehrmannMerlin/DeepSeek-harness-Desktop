'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs').promises;
const path = require('node:path');
const test = require('node:test');
const unzipper = require('unzipper');

const { buildVerifiedRuntimeArtifact } = require('../scripts/build-verified-runtime-artifact');
const { withTempDir, writeJson } = require('./test-helpers');

test('factory creates a portable ZIP, index identity, and archive self-smoke', async () => {
  await withTempDir(async (root) => {
    const source = path.join(root, 'source-runtime');
    await writeJson(path.join(source, 'package.json'), { name: '@deepseek-ai/dsh', version: '0.1.0-rc.7', bin: { dsh: 'lib/bin.js' } });
    await fs.mkdir(path.join(source, 'lib'), { recursive: true });
    await fs.writeFile(path.join(source, 'lib', 'bin.js'), '#!/usr/bin/env node\n', 'utf8');
    const output = path.join(root, 'artifacts');

    const result = await buildVerifiedRuntimeArtifact({
      sourceRuntimeRoot: source,
      outputDirectory: output,
      version: '0.1.0-rc.7',
      artifactUrl: 'https://updates.example.test/dsh-0.1.0-rc.7-win32-x64.zip',
      sourceRevision: '99f6f02fe',
      pnpmVersion: '11.7.0',
      runCommand: async (_command, args) => {
        assert.equal(args.at(-1), '--version');
        return { code: 0, stdout: 'dsh 0.1.0-rc.7\n', stderr: '' };
      },
      smokeImpl: async () => ({ web: 'passed', native: 'passed' }),
    });

    assert.equal(result.indexEntry.sizeBytes > 0, true);
    assert.match(result.indexEntry.sha256, /^[a-f0-9]{64}$/);
    const archive = await unzipper.Open.file(result.archivePath);
    const names = archive.files.map((file) => file.path);
    assert.ok(names.includes('runtime-manifest.json'));
    assert.ok(names.includes('node_modules/@deepseek-ai/dsh/package.json'));
    assert.ok(names.includes('node_modules/@deepseek-ai/dsh/lib/bin.js'));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(output, 'runtime-index.json'), 'utf8')).artifacts, [result.indexEntry]);
  });
});
