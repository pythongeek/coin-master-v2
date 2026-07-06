import { io } from 'socket.io-client';

const TOKEN = process.env.TOKEN || '';
const URL = process.env.SOCKET_URL || 'http://localhost:4000';

const socket = io(URL, {
  auth: TOKEN ? { token: TOKEN } : {},
  transports: ['websocket', 'polling'],
  timeout: 10000,
  reconnection: false,
});

socket.on('connect', () => {
  console.log('connected socket id', socket.id);
  socket.emit('game:bet', { choice: 'heads', amount: 0.1, clientSeed: 'node-test-seed-1' });
});

socket.on('game:spinning', (data) => {
  console.log('SPINNING:', JSON.stringify(data, null, 2));
});

socket.on('game:result', (data) => {
  console.log('RESULT:', JSON.stringify(data, null, 2));
  socket.disconnect();
  process.exit(0);
});

socket.on('game:error', (err) => {
  console.error('ERROR:', JSON.stringify(err, null, 2));
  socket.disconnect();
  process.exit(1);
});

socket.on('connect_error', (err) => {
  console.error('connect_error:', err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error('timeout waiting for result');
  socket.disconnect();
  process.exit(1);
}, 15000);
