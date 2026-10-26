// Fake server for the Android emulator test (CI only, no real data).
// The emulator reaches it at http://10.0.2.2:8080. The page "clocks in" by starting native tracking;
// /api/auth answers ping like the real server and logs every request to pings.log.
const http = require('http');
const fs = require('fs');
let open = true;
const page = `<!doctype html><meta charset="utf-8"><title>TEST</title><body><h1 id="s">TEST</h1><script>
  addEventListener('load', () => {
    Capacitor.nativePromise('VynnNative', 'startTracking', {}).then(r => { document.getElementById('s').textContent = 'started ' + JSON.stringify(r); fetch('/log?started=' + r.tracking); });
  });
</script>`;
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const line = JSON.stringify({ t: new Date().toISOString(), m: req.method, u: req.url, cookie: req.headers.cookie || null, body });
    fs.appendFileSync(__dirname + '/pings.log', line + '\n');
    if (req.url === '/clockout') { open = false; return res.end('ok'); }
    if (req.url.startsWith('/api/auth')) {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({ open: open ? { id: 1, in_at: new Date().toISOString() } : null }));
    }
    if (req.url === '/') {
      res.setHeader('Set-Cookie', 'vos_sess=TESTTOKEN; Path=/; HttpOnly; SameSite=Lax');
      res.setHeader('Content-Type', 'text/html');
      return res.end(page);
    }
    res.end('');
  });
}).listen(8080, () => console.log('mock on 8080'));
