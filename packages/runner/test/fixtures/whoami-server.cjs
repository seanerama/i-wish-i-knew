'use strict';
// A one-endpoint service for the CLI tests: GET /v1/whoami with the given
// token answers the identity; everything else is 401/404. Runs in its own
// process because the CLI tests drive `iwik` with spawnSync, which blocks the
// test process's event loop. Prints one JSON line `{"port":N}` when
// listening and appends one line per request to the file named by argv[2].
const fs = require('node:fs');
const http = require('node:http');

const token = process.argv[2];
const logFile = process.argv[3];
const server = http.createServer((req, res) => {
  const authed = req.headers.authorization === `Bearer ${token}`;
  fs.appendFileSync(logFile, `${req.method} ${req.url} ${authed ? 'auth' : 'anon'}\n`);
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!authed) return json(401, { error: { code: 'unauthorized', message: 'no' } });
  if (req.method === 'GET' && req.url === '/v1/whoami') {
    return json(200, {
      node_id: '01ARZ3NDEKTSV4RRFFQ69G5N0D',
      org_display_name: 'Whoami Org',
      scopes: ['query', 'submit'],
    });
  }
  return json(404, { error: { code: 'not_found', message: 'no' } });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + '\n');
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
