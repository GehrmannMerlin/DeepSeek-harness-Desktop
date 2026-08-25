'use strict';

const http = require('node:http');

const [watchedPidText, portText = '3080'] = process.argv.slice(2);
const watchedPid = Number(watchedPidText);
const port = Number(portText);
if (!Number.isInteger(watchedPid) || watchedPid <= 0 || !Number.isInteger(port) || port <= 0) {
  throw new Error('usage: release-e2e-port-blocker <watched-pid> [port]');
}

let server = null;
let timer = null;

function watchedProcessAlive() {
  try {
    process.kill(watchedPid, 0);
    return true;
  } catch (error) {
    return error && error.code === 'EPERM';
  }
}

function retry() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tryBind, 250);
}

function tryBind() {
  if (watchedProcessAlive()) {
    retry();
    return;
  }
  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><body>release-e2e-port-blocker</body></html>');
  });
  server.once('error', () => {
    server.close();
    server = null;
    retry();
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`${JSON.stringify({ blocked: true, watchedPid, port })}\n`);
  });
}

function stop() {
  if (timer) clearTimeout(timer);
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
tryBind();
