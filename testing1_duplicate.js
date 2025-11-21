/**
 * testing.js - multi-call safe SIPREC client for Drachtio + Vosk
 * Reworked to avoid premature/duplicate cleanup and support concurrent calls.
 *
 * Notes:
 * - Keep ffmpeg in PATH or set FFMPEG_PATH below.
 * - Ensure Drachtio control is reachable at drachtioIp:9022 and OpenSIPS sends INVITEs to 10.16.7.210:5060.
 */

const Srf = require('drachtio-srf');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net');

const srf = new Srf();

// Configuration
const drachtioIp = '10.16.7.210';
const RECORDINGS_DIR = '/opt/srs/recordings';
const voskBaseUrl = 'wss://10.16.7.130:2700';
const FFMPEG_PATH = 'ffmpeg'; // change to full path if needed

// Dynamic port management
const MIN_RTP_PORT = 31000;
const MAX_RTP_PORT = 32000;
const usedPorts = new Set();

// activeCalls maps uniqueCallKey -> callData
// callData contains: callIdRaw, uniqueKey, ports[], ffmpegProcesses[], websockets[], startTime, ended, siprecMeta
const activeCalls = new Map();

console.log('SIPREC Client Starting...');

// Optional xml2js for more robust xml handling
let xml2js = null;
try { xml2js = require('xml2js'); } catch (e) { xml2js = null; console.warn('xml2js not installed — using regex fallback'); }

// ----------------- Utility functions (kept & hardened) -----------------

function extractIdFromSipUri(uri) {
  if (!uri) return null;
  const match = /sip:(\d+)[@;>]/.exec(uri);
  if (match) return match[1];
  const digitsMatch = /(\d+)/.exec(uri);
  return digitsMatch ? digitsMatch[1] : uri;
}

function parseMultipartMixed(body, contentTypeHeader) {
  if (!body || !contentTypeHeader) return [];
  const boundaryMatch = /boundary\s*=\s*([^;\s]+)/i.exec(contentTypeHeader);
  if (!boundaryMatch) return [];
  let boundary = boundaryMatch[1].trim();
  if ((boundary.startsWith('"') && boundary.endsWith('"')) || (boundary.startsWith("'") && boundary.endsWith("'"))) {
    boundary = boundary.slice(1, -1);
  }
  const delimiter = `--${boundary}`;
  const endDelimiter = `--${boundary}--`;
  const segments = body.split(delimiter).map(s => s.trim()).filter(s => s && s !== '--' && s !== endDelimiter);
  const parts = [];
  for (const seg of segments) {
    const [rawHeaders, ...rest] = seg.split(/\r?\n\r?\n/);
    const payload = rest.join('\r\n\r\n');
    const headers = {};
    if (rawHeaders) {
      for (const line of rawHeaders.split(/\r?\n/)) {
        const idx = line.indexOf(':');
        if (idx > -1) {
          const k = line.slice(0, idx).trim().toLowerCase();
          const v = line.slice(idx + 1).trim();
          headers[k] = v;
        }
      }
    }
    parts.push({ headers, body: payload });
  }
  return parts;
}

function getSiprecXmlFromParts(parts) {
  for (const p of parts) {
    const ct = (p.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/rs-metadata+xml')) return p.body;
  }
  return null;
}

function getSdpFromParts(parts) {
  for (const p of parts) {
    const ct = (p.headers['content-type'] || '').toLowerCase();
    if (ct.includes('application/sdp') || ct === 'application/sdp') return p.body;
  }
  return null;
}

function parseSdpAudioPorts(sdp) {
  if (!sdp) return [];
  const ports = [];
  for (const line of sdp.split(/\r?\n/)) {
    const m = /^m=audio\s+(\d+)/.exec(line);
    if (m) {
      ports.push(parseInt(m[1], 10));
      if (ports.length === 2) break;
    }
  }
  return ports;
}

async function parseSiprecXml(xml) {
  const result = { startTime: null, participants: [] };
  if (!xml) return result;

  if (xml2js) {
    try {
      const parsed = await xml2js.parseStringPromise(xml, { explicitArray: false, tagNameProcessors: [xml2js.processors.stripPrefix] });
      const rec = parsed && (parsed.recording || parsed.Recording);
      if (rec && rec['$'] && rec['$']['start-time']) result.startTime = rec['$']['start-time'];
      else if (parsed && parsed.session && parsed.session['$'] && parsed.session['$']['start-time']) result.startTime = parsed.session['$']['start-time'];

      const toArray = x => Array.isArray(x) ? x : (x ? [x] : []);
      let parts = [];
      if (rec && rec.participants && rec.participants.participant) parts = toArray(rec.participants.participant);
      else if (rec && rec.participant) parts = toArray(rec.participant);

      result.participants = parts.map(p => {
        const attrs = p['$'] || {};
        const id = attrs.id || p.id || attrs.participant_id || null;
        const role = attrs.role || p.role || null;
        const aor = p.aor || p.uri || (p.address && p.address.uri) || (p.nameID && (p.nameID.aor || (p.nameID['$'] && p.nameID['$'].aor))) || null;
        const name = p.name || p['display-name'] || p.displayName || (p.nameID && (p.nameID.name || p.nameID['#text'])) || null;
        const tel = p.tel || null;
        const extractedId = extractIdFromSipUri(aor);
        const identifier = extractedId || aor || tel || name || id;
        return { id, role, aor, name, tel, identifier, extractedId };
      });

      return result;
    } catch (e) {
      console.error('xml2js parse error:', e && e.message ? e.message : e);
      // fall through to regex fallback
    }
  }

  // fallback parsing
  const m1 = /start-time\s*=\s*"([^"]+)"/i.exec(xml);
  const m2 = /<associate-time>\s*([^<]+)\s*<\/associate-time>/i.exec(xml);
  if (m1) result.startTime = m1[1];
  else if (m2) result.startTime = m2[1];

  const participants = [];
  const re = /<participant\b([^>]*)>([\s\S]*?)<\/participant>/gi;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const idm = /participant_id\s*=\s*"([^"]+)"/i.exec(attrs);
    const rolem = /role\s*=\s*"([^"]+)"/i.exec(attrs);
    const nameIdMatch = /<nameID[^>]*aor\s*=\s*"([^"]+)"/i.exec(body);
    const aorm = nameIdMatch || /<aor>\s*([^<]+)\s*<\/aor>/i.exec(body);
    const namem = /<(?:display-name|name)>\s*([^<]+)\s*<\/(?:display-name|name)>/i.exec(body);
    const telm = /<tel>\s*([^<]+)\s*<\/tel>/i.exec(body);
    const id = idm ? idm[1] : null;
    const role = rolem ? rolem[1] : null;
    const aor = aorm ? aorm[1] : null;
    const name = namem ? namem[1] : null;
    const tel = telm ? telm[1] : null;
    const extractedId = extractIdFromSipUri(aor);
    const identifier = extractedId || aor || tel || name || id;
    participants.push({ id, role, aor, name, tel, identifier, extractedId });
  }
  result.participants = participants;
  return result;
}

function resolveAgentCustomer(participants) {
  let agent = null, customer = null;
  for (const p of participants) {
    if (!agent && p.role && /agent|speaker2|farend/i.test(p.role)) agent = p;
    if (!customer && p.role && /cust|customer|speaker1|nearend/i.test(p.role)) customer = p;
  }
  for (const p of participants) {
    const text = `${p.identifier || ''} ${p.name || ''}`.toLowerCase();
    if (!agent && /agent|csr|advisor/.test(text)) agent = p;
    if (!customer && /cust|customer|caller|client/.test(text)) customer = p;
  }
  if (!customer && participants[0]) customer = participants[0];
  if (!agent && participants[1]) agent = participants[1];
  return {
    agentId: agent ? (agent.extractedId || agent.identifier || agent.id || null) : null,
    customerId: customer ? (customer.extractedId || customer.identifier || customer.id || null) : null
  };
}

async function extractInviteSiprecMetadata(req) {
  try {
    const contentType = req.get('Content-Type') || req.get('content-type');
    const body = req.body || '';
    if (!contentType || !/multipart\/mixed/i.test(contentType)) {
      return { startTime: null, invitePorts: [], agentId: null, customerId: null };
    }
    const parts = parseMultipartMixed(body, contentType);
    const xml = getSiprecXmlFromParts(parts);
    const sdp = getSdpFromParts(parts);
    const parsed = await parseSiprecXml(xml);
    const invitePorts = parseSdpAudioPorts(sdp);
    const roles = resolveAgentCustomer(parsed.participants || []);
    console.log(`📋 Extracted IDs - Customer: ${roles.customerId}, Agent: ${roles.agentId}`);
    return { startTime: parsed.startTime || null, invitePorts, agentId: roles.agentId, customerId: roles.customerId };
  } catch (e) {
    console.error('Metadata extraction error:', e && e.message ? e.message : e);
    return { startTime: null, invitePorts: [], agentId: null, customerId: null };
  }
}

// ---------- RTP port helpers (UDP ports should be probed in environment)
// your existing checkPortAvailable uses TCP createServer; keep it but it's OK for local probing
function getRandomPort(min = MIN_RTP_PORT, max = MAX_RTP_PORT) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function checkPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => { reject(err); });
    server.listen(port, '0.0.0.0', () => {
      server.close(() => resolve(port));
    });
  });
}

async function findAvailablePort() {
  for (let attempts = 0; attempts < 200; attempts++) {
    const port = getRandomPort();
    if (!usedPorts.has(port)) {
      try {
        await checkPortAvailable(port);
        usedPorts.add(port);
        return port;
      } catch (e) {
        // try next
      }
    }
  }
  throw new Error('No available ports found');
}

function releasePort(port) {
  if (!port) return;
  if (usedPorts.has(port)) {
    usedPorts.delete(port);
    // console.log(`🔁 Released port ${port}`);
  }
}

// --------- Safe cleanup (idempotent and time-guarded) ----------
function cleanupCall(uniqueKey, reason = 'normal') {
  const callData = activeCalls.get(uniqueKey);
  if (!callData) {
    // already cleaned or never existed
    // console.log(`[CLEANUP] No callData for ${uniqueKey}`);
    return;
  }

  // Prevent duplicate cleanup
  if (callData.ended) {
    console.log(`[CLEANUP] ⏩ Skipping duplicate cleanup for ${uniqueKey}`);
    return;
  }

  // Prevent very-early cleanup (e.g., simultaneous INVITE overlap)
  const ageMs = Date.now() - (callData.startTime || 0);
  if (ageMs < 1500 && reason === 'unknown') {
    console.log(`[CLEANUP] ⚠ Ignoring early cleanup for ${uniqueKey} (age ${ageMs}ms)`);
    return;
  }

  callData.ended = true;
  console.log(`[CLEANUP] 🟥 Cleaning up ${uniqueKey} (reason: ${reason})`);

  // Kill FFmpeg processes
  if (callData.ffmpegProcesses && Array.isArray(callData.ffmpegProcesses)) {
    for (const proc of callData.ffmpegProcesses) {
      try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch (e) {}
    }
  }

  // Close websockets
  if (callData.websockets && Array.isArray(callData.websockets)) {
    for (const ws of callData.websockets) {
      try {
        if (ws && ws.readyState === WebSocket.OPEN) {
	      ws.send(JSON.stringify({ event: 'call_end' }));
          ws.send(JSON.stringify({ eof: 1 }));
          ws.close();
        } else if (ws) {
          ws.terminate();
        }
      } catch (e) {}
    }
  }

  // Release ports
  if (callData.ports && Array.isArray(callData.ports)) {
    for (const p of callData.ports) releasePort(p);
  }

  // Remove metadata or mark ended
  try {
    const metaPath = path.join(RECORDINGS_DIR, callData.uniqueKey || 'unknown', 'metadata.json');
    if (fs.existsSync(metaPath)) {
      const cur = JSON.parse(fs.readFileSync(metaPath, 'utf8') || '{}');
      cur.status = 'ended';
      cur.end_time = new Date().toISOString();
      try { fs.writeFileSync(metaPath, JSON.stringify(cur, null, 2)); } catch (_) {}
    }
  } catch (_) {}

  activeCalls.delete(uniqueKey);
}

// ---------------- Connect to Drachtio ----------------
srf.connect({ host: drachtioIp, port: 9022, secret: 'cymru' });

srf.on('connect', (err, hp) => {
  if (err) {
    console.error('Drachtio connect error:', err);
    process.exit(1);
  }
  console.log(`✅ Connected to Drachtio at ${hp}`);
});

srf.on('error', (err) => {
  console.error('❌ Drachtio error:', err && err.message ? err.message : err);
});

// ---------------- INVITE handler ----------------
srf.invite(async (req, res) => {
  // Use raw call-id as base
  const callIdRaw = (req.get('Call-ID') || req.get('call-id') || `call_${Date.now()}`).toString();
  // Create unique key so a new INVITE with same Call-ID doesn't collide
  const uniqueKey = `${callIdRaw}_${Date.now()}_${Math.floor(Math.random()*99999)}`;

  console.log(`📞 Incoming INVITE -> callIdRaw=${callIdRaw} uniqueKey=${uniqueKey}`);

  // allocate ports and store call record
  try {
    const rtpPort1 = await findAvailablePort();
    const rtpPort2 = await findAvailablePort();
    console.log(`Allocated ports for ${uniqueKey}: ${rtpPort1}, ${rtpPort2}`);

    // parse SIPREC metadata (if present)
    const siprecMeta = await extractInviteSiprecMetadata(req);
    const startTimeIso = siprecMeta.startTime || new Date().toISOString();

    const callData = {
      callIdRaw,
      uniqueKey,
      ports: [rtpPort1, rtpPort2],
      ffmpegProcesses: [],
      websockets: [],
      startTime: Date.now(),
      ended: false,
      siprecMeta,
      startTimeIso
    };

    activeCalls.set(uniqueKey, callData);

    // prepare answer SDP (SIPREC)
    const sdp = [
      'v=0',
      `o=- 0 0 IN IP4 ${drachtioIp}`,
      's=SIPREC',
      `c=IN IP4 ${drachtioIp}`,
      't=0 0',
      `m=audio ${rtpPort1} RTP/AVP 0 8 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=recvonly',
      'a=label:0',
      `m=audio ${rtpPort2} RTP/AVP 0 8 101`,
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
      'a=rtpmap:101 telephone-event/8000',
      'a=recvonly',
      'a=label:1'
    ].join('\r\n');

    // Create UAS and receive dialog
    const uas = await srf.createUAS(req, res, {
      headers: { 'Contact': `<sip:${drachtioIp}:5060;transport=udp>` },
      localSdp: sdp
    });

    console.log(`✅ Answered INVITE for ${uniqueKey}, waiting for ACK`);

    // When ACK arrives, start RTP capture
    uas.on('ack', () => {
      console.log(`✅ Call active (ACK) for ${uniqueKey}`);
      // start both legs
      startRtpCapture(`${uniqueKey}-A_leg`, rtpPort1, uniqueKey);
      startRtpCapture(`${uniqueKey}-B_leg`, rtpPort2, uniqueKey);
    });

    // BYE -> cleanup
    uas.on('bye', () => {
      console.log(`BYE received for ${uniqueKey}`);
      cleanupCall(uniqueKey, 'bye');
    });

    // destroy -> cleanup
    uas.on('destroy', () => {
      console.log(`Dialog destroy for ${uniqueKey}`);
      cleanupCall(uniqueKey, 'destroy');
    });

    uas.on('error', (err) => {
      console.error(`Dialog error for ${uniqueKey}:`, err && err.message ? err.message : err);
      cleanupCall(uniqueKey, 'dialog-error');
    });

  } catch (err) {
    console.error(`❌ Call setup failed for ${uniqueKey}:`, err && err.message ? err.message : err);
    cleanupCall(uniqueKey, 'error');
    try { res.send(500); } catch (_) {}
  }
});

// ---------------- RTP capture / FFmpeg / WS per leg ----------------
function startRtpCapture(label, rtpPort, uniqueKey) {
  const callData = activeCalls.get(uniqueKey);
  if (!callData || callData.ended) {
    console.warn(`startRtpCapture: call not active for ${uniqueKey} (${label})`);
    return;
  }

  const siprecMeta = callData.siprecMeta || {};
  const startTimeIso = callData.startTimeIso || new Date().toISOString();

  const legPath = label.toLowerCase().includes('a_leg') ? '/A_leg' : '/B_leg';
  const wsBase = (voskBaseUrl.startsWith('ws://') || voskBaseUrl.startsWith('wss://')) ? voskBaseUrl : `ws://${voskBaseUrl}`;
  const wsUrl = `${wsBase}${legPath}?callId=${encodeURIComponent(callData.callIdRaw)}`;

  const outputDir = path.join(RECORDINGS_DIR, callData.uniqueKey);
  fs.mkdirSync(outputDir, { recursive: true });
  const wavPath = path.join(outputDir, `${label}.wav`);

  // write metadata (once B_leg starts)
  const metaPath = path.join(outputDir, 'metadata.json');
  if (label.includes('B_leg') && !fs.existsSync(metaPath)) {
    try {
      const customerPort = (siprecMeta.invitePorts && siprecMeta.invitePorts[0]) ? siprecMeta.invitePorts[0] : null;
      const agentPort = (siprecMeta.invitePorts && siprecMeta.invitePorts[1]) ? siprecMeta.invitePorts[1] : null;
      const metadata = {
        call_id: callData.callIdRaw,
        unique_key: callData.uniqueKey,
        customer_port: customerPort,
        agent_port: agentPort,
        start_time: startTimeIso,
        customer_id: siprecMeta.customerId || null,
        agent_id: siprecMeta.agentId || null,
        status: 'active'
      };
      fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
      console.log(`📝 Wrote metadata: ${metaPath}`);
    } catch (e) {
      console.error('Metadata write error:', e && e.message ? e.message : e);
    }
  }

  // local per-leg resources
  let ws = null;
  let ffmpegProcess = null;
  let fileStream = null;
  let piecesCounter = 0;

  function cleanupLocal() {
    try { if (ffmpegProcess && !ffmpegProcess.killed) ffmpegProcess.kill('SIGKILL'); } catch (e) {}
    try { if (fileStream && !fileStream.destroyed) fileStream.end(); } catch (e) {}
    try { if (ws && ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ event: 'call_end' })); ws.close(); } } catch (e) {}
  }

  function connectWebSocket() {
    if (!activeCalls.has(uniqueKey) || activeCalls.get(uniqueKey).ended) return;

    try {
      ws = new WebSocket(wsUrl, { handshakeTimeout: 10000, perMessageDeflate: false });
      // store for global cleanup
      const cd = activeCalls.get(uniqueKey);
      if (cd) cd.websockets.push(ws);

      ws.on('open', () => {
        try {
          let baseMeta = {};
          try { baseMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (_) { baseMeta = { call_id: callData.callIdRaw, start_time: startTimeIso, status: 'active' }; }
          const legRole = label.includes('A_leg') ? 'customer' : 'agent';
          const metaToSend = { ...baseMeta, leg: legRole, rtp_port: rtpPort, label };
          ws.send(JSON.stringify({ metadata: metaToSend }));
          ws.send(JSON.stringify({ config: { sample_rate: 16000, call_id: metaToSend.call_id, leg: metaToSend.leg, agent_id: metaToSend.agent_id, customer_id: metaToSend.customer_id, start_time: metaToSend.start_time, agent_port: metaToSend.agent_port, customer_port: metaToSend.customer_port, label: metaToSend.label } }));
        } catch (e) {
          console.warn('WS metadata send failed:', e && e.message ? e.message : e);
        }
        // start FFmpeg only after WS open to avoid data lost
        startFFmpegCapture();
      });

      ws.on('message', (data) => {
        try {
          const result = JSON.parse(data);
          if (result && result.final && result.final.trim()) {
            const now = new Date().toLocaleTimeString();
            const legLabel = label.includes('A_leg') ? 'Customer' : 'Agent';
            console.log(`[${now}] ${legLabel}: ${result.final}`);
          }
        } catch (_) {}
      });

      ws.on('close', () => { cleanupLocal(); });
      ws.on('error', (err) => { console.error('WS error:', err && err.message ? err.message : err); cleanupLocal(); });

    } catch (err) {
      console.error('connectWebSocket error:', err && err.message ? err.message : err);
      cleanupLocal();
    }
  }

  function startFFmpegCapture() {
    if (!activeCalls.has(uniqueKey) || activeCalls.get(uniqueKey).ended) return;

    try {
      const ffmpegArgs = [
        '-hide_banner',
        '-loglevel', 'fatal',
        '-protocol_whitelist', 'file,udp,rtp',
        '-f', 'rtp',
        '-i', `udp://0.0.0.0:${rtpPort}`,
        '-vn',
		'-af', 'anlmdn', 
        '-acodec', 'pcm_s16le',
        '-ar', '16000',
        '-ac', '1',
        '-f', 'wav',
        'pipe:1'
      ];

      console.log(`[FFmpeg] 🚀 Starting FFmpeg for ${label} on port ${rtpPort}`);
      ffmpegProcess = spawn(FFMPEG_PATH, ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

      const cd = activeCalls.get(uniqueKey);
      if (cd) cd.ffmpegProcesses.push(ffmpegProcess);

      fileStream = fs.createWriteStream(wavPath);

      let gotFirstChunk = false;

      ffmpegProcess.stdout.on('data', (chunk) => {
        if (!gotFirstChunk) {
          gotFirstChunk = true;
          console.log(`[FFmpeg] 🎧 First audio chunk for ${label} (size ${chunk.length})`);
        }

        if (fileStream && !fileStream.destroyed) fileStream.write(chunk);

        if (ws && ws.readyState === WebSocket.OPEN) {
          const chunkSize = 640;
          for (let i = 0; i < chunk.length; i += chunkSize) {
            const piece = chunk.slice(i, i + chunkSize);
            try { ws.send(piece); } catch (e) { console.error('[FFmpeg] WS send error:', e && e.message ? e.message : e); break; }
            piecesCounter++;
          }
          // periodic progress log
          if (!global.audioCount) global.audioCount = {};
          if (!global.audioCount[uniqueKey]) global.audioCount[uniqueKey] = 0;
          global.audioCount[uniqueKey] += 1;
          if (global.audioCount[uniqueKey] % 50 === 0) {
            console.log(`[FFmpeg] ✅ Sent ${global.audioCount[uniqueKey]} pieces of audio for ${label}`);
          }
        } else {
          // web socket not ready; tolerate but log occasionally
          if ((++piecesCounter) % 200 === 0) console.log(`[FFmpeg] ⚠️ WS not ready for ${label} (sent chunks: ${piecesCounter})`);
        }
      });

      ffmpegProcess.stderr.on('data', (d) => {
        const s = d.toString().trim();
        if (s) console.log(`[FFmpeg stderr ${label}]: ${s}`);
      });

      ffmpegProcess.on('close', (code) => {
        console.log(`[FFmpeg] closed for ${label} (code ${code})`);
        // trigger cleanup for this call once both legs are closed or if call already ended
        // Mark this leg as closed on callData and if both legs closed -> cleanup
        try {
          const cd2 = activeCalls.get(uniqueKey);
          if (cd2) {
            // mark a small flag per leg
            if (!cd2.legClosed) cd2.legClosed = {};
            cd2.legClosed[label] = true;
            const bothClosed = cd2.legClosed[`${uniqueKey}-A_leg`] && cd2.legClosed[`${uniqueKey}-B_leg`];
            if (bothClosed) cleanupCall(uniqueKey, 'ffmpeg-legs-closed');
            else {
              // If only one leg closed, set a small timeout to avoid premature full cleanup on transient close
              setTimeout(() => {
                const cd3 = activeCalls.get(uniqueKey);
                if (cd3 && cd3.legClosed && cd3.legClosed[label] && (!cd3.legClosed[`${uniqueKey}-A_leg`] || !cd3.legClosed[`${uniqueKey}-B_leg`])) {
                  // if other leg still active, do nothing
                }
              }, 1000);
            }
          }
        } catch (_) {}
        cleanupLocal();
      });

      ffmpegProcess.on('error', (err) => {
        console.error(`[FFmpeg] error for ${label}:`, err && err.message ? err.message : err);
        cleanupLocal();
        cleanupCall(uniqueKey, 'ffmpeg-error');
      });

    } catch (err) {
      console.error('startFFmpegCapture error:', err && err.message ? err.message : err);
      cleanupLocal();
    }
  }

  // register references for global cleanup
  const callRef = activeCalls.get(uniqueKey);
  if (callRef) {
    if (!callRef.ffmpegProcesses) callRef.ffmpegProcesses = [];
    if (!callRef.websockets) callRef.websockets = [];
  }

  // Start websocket (which then starts ffmpeg)
  connectWebSocket();
}

// --------- Process signals & errors ----------
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  for (const key of Array.from(activeCalls.keys())) cleanupCall(key, 'shutdown');
  usedPorts.clear();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('SIGTERM received');
  for (const key of Array.from(activeCalls.keys())) cleanupCall(key, 'shutdown');
  usedPorts.clear();
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.stack ? err.stack : err);
  for (const key of Array.from(activeCalls.keys())) cleanupCall(key, 'uncaughtException');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

// done
console.log('✅ SIPREC Client Ready');
