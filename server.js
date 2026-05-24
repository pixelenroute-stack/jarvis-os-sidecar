// Jarvis OS sidecar — REST API consumed by the local Jarvis Desktop app.
// Runs on the user's Hostinger VPS. Manages Docker containers (Agent Zero,
// Qdrant, CompreFace), installs MCP servers, exposes diagnostic endpoints.
//
// Auth: Bearer token (JARVIS_API_TOKEN env var). All endpoints require it.

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.env.PORT || '8088', 10);
const TOKEN = process.env.JARVIS_API_TOKEN;
const VERSION = require('./package.json').version;
const STARTED_AT = Date.now();

if (!TOKEN) {
  console.error('FATAL: JARVIS_API_TOKEN env var required.');
  process.exit(1);
}

// ── Service catalog (Docker containers we manage) ────────────────────────────
const SERVICES = require('./services');
const MCPS = require('./mcps');

const installJobs = new Map(); // jobId → { id, status, log, startedAt }

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'DELETE'] }));
app.use(morgan('combined'));
app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 60_000, max: 300 }));

// Bearer auth on every /api route
app.use('/api', (req, res, next) => {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Bearer token required' });
  if (auth.slice(7) !== TOKEN) return res.status(403).json({ error: 'Invalid token' });
  next();
});

// ── Helpers ──────────────────────────────────────────────────────────────────
function runCmd(cmd, args, opts = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { ...opts, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', error: err?.message });
    });
  });
}

function spawnLogged(cmd, args, opts, jobId) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...(opts || {}), shell: false });
    const job = installJobs.get(jobId);
    p.stdout.on('data', d => { if (job) job.log += d.toString(); });
    p.stderr.on('data', d => { if (job) job.log += d.toString(); });
    p.on('close', code => resolve({ ok: code === 0, code }));
    p.on('error', err => resolve({ ok: false, code: 1, error: err.message }));
  });
}

async function dockerPs(name) {
  const r = await runCmd('docker', ['ps', '--filter', `name=${name}`, '--format', '{{.Names}}|{{.Status}}|{{.Ports}}']);
  if (!r.ok || !r.stdout.trim()) return null;
  const [n, status, ports] = r.stdout.trim().split('|');
  return { name: n, status, ports };
}

async function httpHealth(url, timeoutMs = 3000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok;
  } catch { return false; }
}

async function getServiceStatus(svc) {
  const ps = await dockerPs(svc.containerName);
  let healthy = false;
  if (ps && svc.healthUrl) healthy = await httpHealth(svc.healthUrl);
  return {
    ...svc,
    status: ps ? 'running' : 'stopped',
    healthy,
    dockerStatus: ps?.status || null,
    ports: ps?.ports || null,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    hostname: os.hostname(),
    platform: process.platform,
    loadavg: os.loadavg(),
    memFreeGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(1),
    memTotalGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1),
  });
});

app.get('/api/services', async (_req, res) => {
  try {
    const results = await Promise.all(SERVICES.map(getServiceStatus));
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/services/:id/status', async (req, res) => {
  const svc = SERVICES.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service inconnu' });
  try {
    const status = await getServiceStatus(svc);
    const logs = await runCmd('docker', ['logs', '--tail', '50', svc.containerName]);
    res.json({ ...status, logs: logs.stdout.split('\n').slice(-50) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/services/:id/start', async (req, res) => {
  const svc = SERVICES.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service inconnu' });
  // Remove existing container with same name (idempotent)
  await runCmd('docker', ['rm', '-f', svc.containerName]);
  // Pull image
  await runCmd('docker', ['pull', svc.image], {}, 600_000);
  // Start
  const r = await runCmd('docker', ['run', '-d', '--name', svc.containerName,
    '--restart', 'unless-stopped', ...svc.dockerArgs, svc.image, ...(svc.cmdArgs || [])
  ], {}, 60_000);
  if (!r.ok) return res.status(500).json({ ok: false, error: r.stderr || r.error });
  res.json({ ok: true, containerName: svc.containerName });
});

app.post('/api/services/:id/stop', async (req, res) => {
  const svc = SERVICES.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Service inconnu' });
  await runCmd('docker', ['stop', svc.containerName]);
  await runCmd('docker', ['rm', svc.containerName]);
  res.json({ ok: true });
});

// Generic install for any of the toolkit IDs (docker-based ones).
app.post('/api/install/:toolId', async (req, res) => {
  const svc = SERVICES.find(s => s.id === req.params.toolId);
  if (!svc) return res.status(404).json({ error: `Unknown tool: ${req.params.toolId}` });
  const jobId = `${svc.id}-${Date.now()}`;
  installJobs.set(jobId, { id: jobId, toolId: svc.id, status: 'running', log: '', startedAt: Date.now() });
  // Run async
  (async () => {
    const job = installJobs.get(jobId);
    job.log += `[1/3] docker rm -f ${svc.containerName}\n`;
    await spawnLogged('docker', ['rm', '-f', svc.containerName], {}, jobId);
    job.log += `\n[2/3] docker pull ${svc.image}\n`;
    const pull = await spawnLogged('docker', ['pull', svc.image], {}, jobId);
    if (!pull.ok) { job.status = 'failed'; return; }
    job.log += `\n[3/3] docker run --name ${svc.containerName}\n`;
    const run = await spawnLogged('docker', ['run', '-d', '--name', svc.containerName,
      '--restart', 'unless-stopped', ...svc.dockerArgs, svc.image, ...(svc.cmdArgs || [])
    ], {}, jobId);
    job.status = run.ok ? 'completed' : 'failed';
    job.log += `\n${run.ok ? '✓ Done.' : '✗ Failed.'}\n`;
  })();
  res.json({ ok: true, jobId });
});

app.get('/api/install/:jobId', (req, res) => {
  const job = installJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job inconnu' });
  res.json(job);
});

// ── Phones (pairing + commands relay) ──────────────────────────────────────
// In-memory store for now. Production : Postgres / Redis.
const phones = new Map();       // pairingCode → { ...info, lastSeen }
const phoneCommands = new Map(); // pairingCode → [{ id, type, payload, createdAt }]

// Called by the phone app at boot/poll to announce itself.
app.post('/api/phones/register', (req, res) => {
  const { pairingCode, model, platform, osVersion } = req.body || {};
  if (!pairingCode) return res.status(400).json({ error: 'pairingCode required' });
  phones.set(pairingCode, {
    pairingCode, model: model || 'Android', platform: platform || 'android', osVersion: osVersion || '',
    registeredAt: phones.get(pairingCode)?.registeredAt || Date.now(),
    lastSeen: Date.now(),
    paired: phones.get(pairingCode)?.paired || false,
  });
  res.json({ ok: true });
});

// Called by Jarvis Desktop to pair (link) a phone by its pairing code.
app.post('/api/phones/pair', (req, res) => {
  const { pairingCode } = req.body || {};
  if (!pairingCode) return res.status(400).json({ error: 'pairingCode required' });
  const p = phones.get(pairingCode);
  if (!p) return res.status(404).json({ error: 'Téléphone non trouvé. Vérifie qu\'il a bien fait /register.' });
  p.paired = true;
  p.pairedAt = Date.now();
  phones.set(pairingCode, p);
  res.json({ ok: true, ...p });
});

// List paired phones
app.get('/api/phones', (req, res) => {
  res.json({ phones: Array.from(phones.values()).map(p => ({
    ...p, lastSeen: new Date(p.lastSeen).toISOString(),
    registeredAt: new Date(p.registeredAt).toISOString(),
  })) });
});

// Send a command to a phone (Desktop → VPS → polled by phone)
app.post('/api/phones/:code/commands', (req, res) => {
  const { code } = req.params;
  if (!phones.has(code)) return res.status(404).json({ error: 'Phone non trouvé' });
  const cmd = { id: `cmd-${Date.now()}`, ...req.body, createdAt: Date.now() };
  const list = phoneCommands.get(code) || [];
  list.push(cmd);
  phoneCommands.set(code, list);
  res.json({ ok: true, queued: cmd.id });
});

// Phone polls for pending commands
app.get('/api/phones/:code/commands', (req, res) => {
  const { code } = req.params;
  const list = phoneCommands.get(code) || [];
  phoneCommands.set(code, []); // drain queue
  // Mark seen
  const p = phones.get(code);
  if (p) { p.lastSeen = Date.now(); phones.set(code, p); }
  res.json({ commands: list });
});

// Phone reports a command result
app.post('/api/phones/:code/results', (req, res) => {
  const { code } = req.params;
  const p = phones.get(code);
  if (p) { p.lastSeen = Date.now(); p.lastResult = req.body; phones.set(code, p); }
  res.json({ ok: true });
});

// ── MCP management ──────────────────────────────────────────────────────────
const MCP_CONFIG_PATH = path.join(os.homedir(), '.config', 'Claude', 'claude_desktop_config.json');

function loadMcpConfig() {
  if (!fs.existsSync(MCP_CONFIG_PATH)) return { mcpServers: {} };
  try { return JSON.parse(fs.readFileSync(MCP_CONFIG_PATH, 'utf8')); }
  catch { return { mcpServers: {} }; }
}

function saveMcpConfig(cfg) {
  fs.mkdirSync(path.dirname(MCP_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(MCP_CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

app.get('/api/mcps', (_req, res) => {
  const cfg = loadMcpConfig();
  const installed = cfg.mcpServers || {};
  res.json(MCPS.map(m => ({
    ...m,
    installed: !!installed[m.id],
    config: installed[m.id] || null,
  })));
});

app.post('/api/mcps/:id/install', async (req, res) => {
  const mcp = MCPS.find(m => m.id === req.params.id);
  if (!mcp) return res.status(404).json({ error: 'MCP inconnu' });
  const env = (req.body && req.body.env) || {};
  // Validate required env keys
  const missing = (mcp.envKeys || []).filter(k => k.required && !env[k.key]);
  if (missing.length) return res.status(400).json({ error: `Manque: ${missing.map(k => k.key).join(', ')}` });

  const jobId = `mcp-${mcp.id}-${Date.now()}`;
  installJobs.set(jobId, { id: jobId, mcpId: mcp.id, status: 'running', log: '', startedAt: Date.now() });

  (async () => {
    const job = installJobs.get(jobId);
    try {
      // Step 1: install/pull
      if (mcp.installType === 'npx') {
        job.log += `[1/2] npm view ${mcp.npmPackage}\n`;
        await spawnLogged('npm', ['view', mcp.npmPackage, 'version'], {}, jobId);
      } else if (mcp.installType === 'git-build') {
        job.log += `[1/2] git clone ${mcp.repo}\n`;
        const dir = path.join(os.homedir(), '.jarvis-mcps', mcp.folder);
        if (fs.existsSync(dir)) {
          await spawnLogged('git', ['pull'], { cwd: dir }, jobId);
        } else {
          fs.mkdirSync(path.dirname(dir), { recursive: true });
          await spawnLogged('git', ['clone', mcp.repo, dir], {}, jobId);
        }
        for (const [cmd, args] of (mcp.buildCmds || [])) {
          job.log += `\n$ ${cmd} ${args.join(' ')}\n`;
          await spawnLogged(cmd, args, { cwd: dir }, jobId);
        }
      }

      // Step 2: write claude_desktop_config.json
      job.log += `\n[2/2] writing ${MCP_CONFIG_PATH}\n`;
      const cfg = loadMcpConfig();
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers[mcp.id] = {
        command: mcp.command,
        args: (mcp.args || []).map(a => a.replace('{HOME}', os.homedir())),
        env,
      };
      saveMcpConfig(cfg);
      job.status = 'completed';
      job.log += `\n✓ MCP ${mcp.id} installé et configuré.\n`;
    } catch (e) {
      job.status = 'failed';
      job.log += `\n✗ ${e.message}\n`;
    }
  })();

  res.json({ ok: true, jobId });
});

app.delete('/api/mcps/:id', (req, res) => {
  const cfg = loadMcpConfig();
  if (cfg.mcpServers && cfg.mcpServers[req.params.id]) {
    delete cfg.mcpServers[req.params.id];
    saveMcpConfig(cfg);
  }
  res.json({ ok: true });
});

// ── Agents (running services exposed by Jarvis OS) ──────────────────────────
app.get('/api/agents', async (_req, res) => {
  try {
    const out = [];
    for (const svc of SERVICES) {
      if (!svc.exposesAgent) continue;
      const ps = await dockerPs(svc.containerName);
      out.push({
        id: svc.id, name: svc.name, description: svc.description,
        healthy: !!ps && (!svc.healthUrl || await httpHealth(svc.healthUrl)),
        url: svc.healthUrl,
      });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/agents/:id/test', async (req, res) => {
  const svc = SERVICES.find(s => s.id === req.params.id);
  if (!svc) return res.status(404).json({ error: 'Agent inconnu' });
  const healthy = svc.healthUrl ? await httpHealth(svc.healthUrl, 5000) : false;
  const ps = await dockerPs(svc.containerName);
  res.json({ id: svc.id, healthy, container: ps, testedAt: new Date().toISOString() });
});

// ── Whitelisted exec (for diagnostics) ──────────────────────────────────────
const EXEC_WHITELIST = new Set([
  'docker ps', 'docker ps -a', 'docker images', 'docker info',
  'df -h', 'free -h', 'uptime', 'whoami', 'uname -a',
]);
app.post('/api/exec', async (req, res) => {
  const cmd = (req.body?.cmd || '').trim();
  if (!EXEC_WHITELIST.has(cmd)) return res.status(403).json({ error: 'Command not whitelisted' });
  const [bin, ...args] = cmd.split(' ');
  const r = await runCmd(bin, args);
  res.json(r);
});

// 404
app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint inconnu' }));

app.listen(PORT, () => {
  console.log(`Jarvis OS sidecar v${VERSION} listening on :${PORT}`);
  console.log(`Token configured: ${TOKEN.slice(0, 4)}…${TOKEN.slice(-4)}`);
});
