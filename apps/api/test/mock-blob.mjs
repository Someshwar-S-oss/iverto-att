// Minimal Azure Blob stand-in for local tests (UseDevelopmentStorage=true → 127.0.0.1:10000):
// accepts container creation and block-blob uploads, keeps nothing. Use Azurite for anything more.
import http from 'node:http';

const PORT = Number(process.env.MOCK_BLOB_PORT || 10000);
const containers = new Set();

http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const headers = { 'x-ms-request-id': '1', 'x-ms-version': '2025-01-05', etag: '"0x1"', 'last-modified': new Date().toUTCString(), date: new Date().toUTCString() };
    if (req.method === 'PUT' && url.searchParams.get('restype') === 'container') {
      const exists = containers.has(url.pathname);
      containers.add(url.pathname);
      res.writeHead(exists ? 409 : 201, { ...headers, ...(exists ? { 'x-ms-error-code': 'ContainerAlreadyExists' } : {}) });
      return res.end();
    }
    if (req.method === 'PUT') {
      res.writeHead(201, { ...headers, 'x-ms-request-server-encrypted': 'true' });
      return res.end();
    }
    res.writeHead(req.method === 'DELETE' ? 202 : 404, headers);
    res.end();
  });
}).listen(PORT, '127.0.0.1', () => console.log(`mock blob on ${PORT}`));
