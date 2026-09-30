// Forward all incoming traffic on 0.0.0.0:3000 to Docker on 127.0.0.1:3300
// This enables devices on the local network (smartphones, tablets, etc.) to access
// Recast running inside Docker with all 17 engines active.
import net from 'node:net';

const LISTEN_PORT = parseInt(process.env.PROXY_PORT || '3000', 10);
const TARGET_PORT = parseInt(process.env.TARGET_PORT || '3300', 10);
const TARGET_HOST = '127.0.0.1';

const server = net.createServer((clientSocket) => {
  const targetSocket = net.connect({ host: TARGET_HOST, port: TARGET_PORT });

  clientSocket.pipe(targetSocket);
  targetSocket.pipe(clientSocket);

  clientSocket.on('error', () => targetSocket.destroy());
  targetSocket.on('error', () => clientSocket.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[LAN Proxy] Listening on 0.0.0.0:${LISTEN_PORT} -> forwarding to Docker 127.0.0.1:${TARGET_PORT}`);
});
