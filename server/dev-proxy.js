// Forward all incoming traffic on 0.0.0.0:3000 to Docker on 127.0.0.1:3300
// This enables devices on the local network (smartphones, tablets, etc.) to access
// Recast running inside Docker with all 17 engines active.
import net from 'node:net';
import { basicAuthValid } from './security.js';

const LISTEN_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '3300', 10);
const TARGET_HOST = '127.0.0.1';
const AUTH_USER = process.env.RECAST_AUTH_USER || '';
const AUTH_PASSWORD = process.env.RECAST_AUTH_PASSWORD || '';

const server = net.createServer((clientSocket) => {
  const targetSocket = net.connect({ host: TARGET_HOST, port: TARGET_PORT });

  let inspected = false;
  let buffered = Buffer.alloc(0);
  clientSocket.pause();
  clientSocket.on('data', (chunk) => {
    if (inspected) return;
    buffered = Buffer.concat([buffered, chunk]);
    const end = buffered.indexOf('\r\n\r\n');
    if (end < 0 && buffered.length < 64 * 1024) return;
    inspected = true;
    const headers = buffered.subarray(0, end < 0 ? buffered.length : end).toString('latin1');
    const authorization = headers.match(/^Authorization:\s*(.+)$/im)?.[1];
    if (AUTH_USER && AUTH_PASSWORD && !basicAuthValid(authorization, AUTH_USER, AUTH_PASSWORD)) {
      clientSocket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Recast"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      targetSocket.destroy();
      return;
    }
    clientSocket.pipe(targetSocket);
    targetSocket.pipe(clientSocket);
    clientSocket.unshift(buffered);
    clientSocket.resume();
  });

  clientSocket.on('error', () => targetSocket.destroy());
  targetSocket.on('error', () => clientSocket.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[LAN Proxy] Listening on 0.0.0.0:${LISTEN_PORT} -> forwarding to Docker 127.0.0.1:${TARGET_PORT}`);
});
