'use strict';

const os = require('node:os');
const path = require('node:path');

const { buildVerifiedRuntimeArtifact, parseArgs } = require('./build-verified-runtime-artifact');

const args = parseArgs(process.argv.slice(2));
if (!args.sourceruntime || !args.version) {
  console.error('Usage: node scripts/benchmark-runtime-artifact.js --source-runtime <verified-tree> --version <version> [--output <dir>] [--artifact-url <url>] [--source-revision <sha>] [--frontend-dist <dir>] [--frontend-package-json <file>] [--heartbeat-ms <ms>]');
  process.exitCode = 2;
} else {
  if (args.heartbeatms) process.env.DSH_FACTORY_HEARTBEAT_MS = args.heartbeatms;
  const outputDirectory = args.output || path.join(os.tmpdir(), 'dsh-runtime-artifact-benchmark');
  buildVerifiedRuntimeArtifact({
    sourceRuntimeRoot: args.sourceruntime,
    outputDirectory,
    version: args.version,
    artifactUrl: args.artifacturl || `https://benchmark.invalid/dsh-runtime-${args.version}-win32-x64.zip`,
    platform: args.platform || 'win32',
    arch: args.arch || 'x64',
    sourceRevision: args.sourcerevision || null,
    nodeVersion: args.nodeversion || process.versions.node,
    pnpmVersion: args.pnpmversion || null,
    frontendDistRoot: args.frontenddist,
    frontendPackageJsonPath: args.frontendpackagejson,
    archiveMode: 'direct',
  }).then((result) => {
    console.log(JSON.stringify(result, null, 2));
  }).catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });
}
