import { generateSecretKey, finalizeEvent } from 'nostr-tools/pure';
import WebSocket from 'ws';
const sk = generateSecretKey();
const ev = finalizeEvent({ kind:1, created_at: Math.floor(Date.now()/1000), content:'probe', tags:[['p','a'.repeat(64)]] }, sk);

const ws = new WebSocket('wss://nostr.hoppe-relay.it.com');
ws.on('open', () => { console.log('연결됨 → EVENT 전송'); ws.send(JSON.stringify(['EVENT', ev])); });
ws.on('message', (m) => console.log('← 수신:', m.toString().slice(0,300)));
ws.on('close', (c, r) => { console.log('닫힘: code=', c, 'reason=', r.toString().slice(0,200) || '(없음)'); process.exit(0); });
ws.on('error', (e) => console.log('에러:', e.message));
setTimeout(() => { console.log('타임아웃'); process.exit(0); }, 12000);
