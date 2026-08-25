'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(process.argv[2] || '');
const archivePath = path.join(root, 'dsh-runtime-0.1.1-rc.2-win32-x64.zip');
const indexPath = path.join(root, 'runtime-index.json');
const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));

const server = http.createServer((request, response) => {
  if (request.url === '/runtime-index.json') {
    const body = JSON.parse(JSON.stringify(index));
    for (const artifact of body.artifacts) {
      artifact.artifactUrl = `http://127.0.0.1:${server.address().port}/artifact.zip`;
    }
    const bytes = Buffer.from(JSON.stringify(body));
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': bytes.length,
    });
    response.end(bytes);
    return;
  }

  if (request.url === '/artifact.zip') {
    const stat = fs.statSync(archivePath);
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': stat.size,
    });
    fs.createReadStream(archivePath).pipe(response);
    return;
  }

  response.writeHead(404);
  response.end('not found');
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

