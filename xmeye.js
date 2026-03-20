/**
 * XMEye / Sofia / DVRIP binary protocol client (port 34567).
 * Supports login, file listing, and playback stream initiation.
 *
 * Protocol reference: wireshark captures + dvr-ip project + ioBroker.xmeye
 *
 * Header format (20 bytes, little-endian):
 *   [0]    0xFF  magic
 *   [1]    0x00  version
 *   [2-3]  0x0000 reserved
 *   [4-7]  session_id  (u32 LE)
 *   [8-11] sequence    (u32 LE)
 *   [12]   total_packets (u8)
 *   [13]   cur_packet    (u8)
 *   [14-15] msg_id      (u16 LE)
 *   [16-19] data_len    (u32 LE)
 */

const net = require('net');
const crypto = require('crypto');

const MSG = {
  LOGIN: 1000,
  LOGIN_RESP: 1001,
  LOGOUT: 1002,
  KEEPALIVE: 1006,
  KEEPALIVE_RESP: 1007,
  FILE_QUERY: 1420,
  FILE_QUERY_RESP: 1421,
  PLAYBACK_START: 1420,
  PLAYBACK_CLAIM: 1412,
  PLAYBACK_CLAIM_RESP: 1413,
  TIME_QUERY: 1452,
  TIME_SETTING: 1450,
};

const HEADER_LEN = 20;
// (#16) Maximum buffer size to prevent memory exhaustion from malformed responses
const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MB

function xmeyeHash(password) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const md5 = crypto.createHash('md5').update(password, 'utf8').digest();
  let result = '';
  for (let i = 0; i < 16; i += 2) {
    result += chars[(md5[i] + md5[i + 1]) % 62];
  }
  return result;
}

function makePacket(sessionId, seq, msgId, payload) {
  const data = typeof payload === 'object' && !Buffer.isBuffer(payload)
    ? Buffer.from(JSON.stringify(payload) + '\n\x00', 'utf8')
    : payload;
  const header = Buffer.alloc(HEADER_LEN);
  header[0] = 0xff;
  header[1] = 0x00;
  header.writeUInt16LE(0, 2);
  header.writeUInt32LE(sessionId, 4);
  header.writeUInt32LE(seq, 8);
  header[12] = 0;
  header[13] = 0;
  header.writeUInt16LE(msgId, 14);
  header.writeUInt32LE(data.length, 16);
  return Buffer.concat([header, data]);
}

function parsePacket(buf) {
  if (buf.length < HEADER_LEN) return null;
  const msgId = buf.readUInt16LE(14);
  const dataLen = buf.readUInt32LE(16);
  if (buf.length < HEADER_LEN + dataLen) return null;
  const sessionId = buf.readUInt32LE(4);
  const seq = buf.readUInt32LE(8);
  // (#21) Use subarray instead of deprecated slice (avoids copy in newer Node.js)
  const raw = buf.subarray(HEADER_LEN, HEADER_LEN + dataLen);
  let body = null;
  try {
    const str = raw.toString('utf8').replace(/\x00/g, '').trim();
    if (str) body = JSON.parse(str);
  } catch (_) {
    body = raw;
  }
  return { msgId, sessionId, seq, body, totalLen: HEADER_LEN + dataLen };
}

class XMEyeSession {
  constructor(host, port) {
    this.host = host;
    this.port = port || 34567;
    this.socket = null;
    this.sessionId = 0;
    this.seq = 0;
    this._buf = Buffer.alloc(0);
    this._pending = new Map(); // seq -> {resolve, reject, timer}
    this._alive = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      sock.setTimeout(10000);
      sock.connect(this.port, this.host, () => {
        this.socket = sock;
        this._alive = true;
        sock.on('data', (chunk) => this._onData(chunk));
        sock.on('close', () => { this._alive = false; this._rejectAll('Connection closed'); });
        sock.on('error', (e) => { this._alive = false; this._rejectAll(e.message); });
        sock.on('timeout', () => { sock.destroy(); });
        resolve();
      });
      sock.on('error', reject);
    });
  }

  _onData(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    // (#16) Prevent unbounded buffer growth from malformed/noisy responses
    if (this._buf.length > MAX_BUFFER_SIZE) {
      this._rejectAll('Buffer overflow (>1MB) — disconnecting');
      this.close();
      return;
    }
    while (this._buf.length >= HEADER_LEN) {
      const pkt = parsePacket(this._buf);
      if (!pkt) break;
      // (#21) Use subarray instead of deprecated slice
      this._buf = this._buf.subarray(pkt.totalLen);
      // Find pending request by seq or msgId-1 (response msgId = request msgId + 1)
      const entry = this._pending.get(pkt.seq) || this._pending.get(pkt.msgId);
      if (entry) {
        clearTimeout(entry.timer);
        this._pending.delete(pkt.seq);
        this._pending.delete(pkt.msgId);
        entry.resolve(pkt.body);
      }
    }
  }

  _rejectAll(reason) {
    for (const [, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this._pending.clear();
  }

  send(msgId, payload, timeoutMs = 8000) {
    const seq = this.seq++;
    return new Promise((resolve, reject) => {
      const pkt = makePacket(this.sessionId, seq, msgId, payload);
      const timer = setTimeout(() => {
        this._pending.delete(seq);
        this._pending.delete(msgId + 1);
        reject(new Error(`Timeout waiting for response to msgId ${msgId}`));
      }, timeoutMs);
      // Register by both seq and response msgId (camera sometimes ignores seq)
      this._pending.set(seq, { resolve, reject, timer });
      this._pending.set(msgId + 1, { resolve, reject, timer });
      this.socket.write(pkt);
    });
  }

  async login(username, password) {
    const hashed = xmeyeHash(password || '');
    const resp = await this.send(MSG.LOGIN, {
      EncryptType: 'MD5',
      LoginType: 'DVRIP-Web',
      PassWord: hashed,
      UserName: username || 'admin',
    });
    if (!resp || resp.Ret !== 100) {
      throw new Error(`XMEye login failed: Ret=${resp && resp.Ret} (203=wrong password, 206=locked)`);
    }
    // Parse session id
    const sid = parseInt(resp.SessionID, 16);
    if (!isNaN(sid)) this.sessionId = sid;
    return resp;
  }

  _formatTime(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  _parseTime(str) {
    const match = str.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
    if (!match) return null;
    return new Date(
      parseInt(match[1]),
      parseInt(match[2]) - 1,
      parseInt(match[3]),
      parseInt(match[4]),
      parseInt(match[5]),
      parseInt(match[6])
    );
  }

  async getTime() {
    const resp = await this.send(MSG.TIME_QUERY, {
      Name: 'OPTimeQuery',
      SessionID: `0x${this.sessionId.toString(16).padStart(8, '0')}`,
    });
    if (!resp || resp.Ret !== 100) {
      throw new Error(`Failed to get camera time: Ret=${resp && resp.Ret}`);
    }
    const timeStr = resp.OPTimeQuery;
    if (!timeStr) return null;
    return this._parseTime(timeStr);
  }

  async setTime(date) {
    const timeStr = this._formatTime(date);
    const resp = await this.send(MSG.TIME_SETTING, {
      Name: 'OPTimeSetting',
      SessionID: `0x${this.sessionId.toString(16).padStart(8, '0')}`,
      OPTimeSetting: timeStr,
    });
    if (!resp || resp.Ret !== 100) {
      throw new Error(`Failed to set camera time: Ret=${resp && resp.Ret}`);
    }
    return true;
  }

  async syncTime() {
    return this.setTime(new Date());
  }

  async listFiles(channel, startTime, endTime, type = 'h264') {
    const resp = await this.send(MSG.FILE_QUERY, {
      Name: 'OPFileQuery',
      OPFileQuery: {
        BeginTime: this._formatTime(startTime),
        EndTime: this._formatTime(endTime),
        Channel: channel || 0,
        DriverTypeMask: '0xFFFFFFFF',
        Event: type,
      },
    }, 15000);
    if (!resp) return [];
    if (resp.Ret !== 100) return [];
    return (resp.OPFileQuery || []).map((f) => ({
      startTime: f.BeginTime,
      endTime: f.EndTime,
      size: f.FileLength || 0,
      name: f.FileName || '',
    }));
  }

  close() {
    this._alive = false;
    if (this.socket) {
      try { this.socket.destroy(); } catch (_) {}
      this.socket = null;
    }
  }
}

async function withSession(host, port, username, password, fn) {
  const session = new XMEyeSession(host, port);
  await session.connect();
  try {
    await session.login(username, password);
    return await fn(session);
  } finally {
    session.close();
  }
}

module.exports = { XMEyeSession, withSession, xmeyeHash };
