const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PORT = 5000;
const HOST = '0.0.0.0';
const INDEX_PATH = path.join(__dirname, 'index.html');
const PAGE_SIZE_BYTES = 4096;

let previousSystemCpu = readSystemCpuTimes();
let previousProcessCpu = new Map();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function readSystemCpuTimes() {
  const text = readTextSafe('/proc/stat');
  if (!text) return null;

  const firstLine = text.split('\n')[0] || '';
  const fields = firstLine.trim().split(/\s+/);
  if (fields[0] !== 'cpu' || fields.length < 5) return null;

  const values = fields.slice(1).map((v) => Number(v));
  if (values.some((v) => Number.isNaN(v))) return null;

  const idle = values[3] + (values[4] || 0);
  const total = values.reduce((sum, v) => sum + v, 0);
  return { idle, total };
}

function getSystemCpuUsage() {
  const current = readSystemCpuTimes();
  if (!current || !previousSystemCpu) {
    previousSystemCpu = current;
    return {
      usagePercent: Number(clamp(((os.loadavg()[0] || 0) / Math.max(1, os.cpus().length)) * 100, 0, 100).toFixed(2)),
      source: 'loadavg_fallback',
      totalDelta: null,
    };
  }

  const idleDelta = current.idle - previousSystemCpu.idle;
  const totalDelta = current.total - previousSystemCpu.total;
  previousSystemCpu = current;

  if (totalDelta <= 0) {
    return { usagePercent: 0, source: 'proc_stat', totalDelta: null };
  }

  const usage = (1 - idleDelta / totalDelta) * 100;
  return {
    usagePercent: Number(clamp(usage, 0, 100).toFixed(2)),
    source: 'proc_stat',
    totalDelta,
  };
}

function parseMeminfo() {
  const text = readTextSafe('/proc/meminfo');
  if (!text) return null;

  const data = {};
  text.split('\n').forEach((line) => {
    const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
    if (!match) return;
    data[match[1]] = Number(match[2]) * 1024;
  });

  if (!data.MemTotal) return null;
  return data;
}

function getRamInfo() {
  const meminfo = parseMeminfo();
  const osTotal = os.totalmem();
  const physTotal = readPhysicalMemoryBytes();
  const trustedTotal = pickTrustedTotal(meminfo?.MemTotal, osTotal, physTotal);

  if (meminfo) {
    const total = trustedTotal || meminfo.MemTotal;
    const available = meminfo.MemAvailable ?? meminfo.MemFree ?? 0;
    const clampedAvailable = clamp(available, 0, total);
    const used = Math.max(0, total - clampedAvailable);

    return {
      source: 'proc_meminfo',
      totalBytes: total,
      usedBytes: used,
      availableBytes: clampedAvailable,
      freeBytes: meminfo.MemFree ?? 0,
      usagePercent: Number(((used / total) * 100).toFixed(2)),
    };
  }

  const total = trustedTotal || osTotal;
  const free = os.freemem();
  const used = total - free;

  return {
    source: 'os_fallback',
    totalBytes: total,
    usedBytes: used,
    availableBytes: free,
    freeBytes: free,
    usagePercent: Number(((used / total) * 100).toFixed(2)),
  };
}

function readPhysicalMemoryBytes() {
  try {
    const pages = Number(execSync('getconf _PHYS_PAGES 2>/dev/null', { encoding: 'utf8' }).trim());
    const pageSize = Number(execSync('getconf PAGE_SIZE 2>/dev/null', { encoding: 'utf8' }).trim());
    if (!Number.isFinite(pages) || !Number.isFinite(pageSize) || pages <= 0 || pageSize <= 0) return null;
    return pages * pageSize;
  } catch {
    return null;
  }
}

function pickTrustedTotal(procTotal, osTotal, physTotal) {
  const candidates = [procTotal, osTotal, physTotal].filter((v) => Number.isFinite(v) && v > 0);
  if (!candidates.length) return null;
  candidates.sort((a, b) => a - b);

  // ถ้าค่าหนึ่งโดดสูงเกินไป (เช่นเห็น RAM 8 ทั้งที่เครื่อง 4) ให้ใช้ค่าที่ต่ำกว่าและนิ่งกว่า
  const smallest = candidates[0];
  const largest = candidates[candidates.length - 1];
  if (largest > smallest * 1.5) return smallest;
  return candidates[Math.floor(candidates.length / 2)];
}

function bytesToGb(bytes) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

function listProcessIds() {
  let entries = [];
  try {
    entries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => entry.name);
}

function parseProcessStat(pid) {
  const statText = readTextSafe(`/proc/${pid}/stat`);
  if (!statText) return null;

  const open = statText.indexOf('(');
  const close = statText.lastIndexOf(')');
  if (open < 0 || close < 0 || close <= open) return null;

  const name = statText.slice(open + 1, close);
  const rest = statText.slice(close + 2).trim().split(/\s+/);
  if (rest.length < 22) return null;

  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const rssPages = Number(rest[21]);
  if ([utime, stime, rssPages].some((v) => Number.isNaN(v))) return null;

  return {
    pid,
    name,
    totalJiffies: utime + stime,
    rssBytes: Math.max(0, rssPages * PAGE_SIZE_BYTES),
  };
}

function getTopProcesses(ramTotalBytes, systemTotalDelta) {
  const pids = listProcessIds();
  const currentCpuMap = new Map();
  const processes = [];

  for (const pid of pids) {
    const stat = parseProcessStat(pid);
    if (!stat) continue;

    currentCpuMap.set(pid, stat.totalJiffies);

    const prev = previousProcessCpu.get(pid);
    const procDelta = prev == null ? 0 : stat.totalJiffies - prev;

    const cpuPercent = systemTotalDelta && systemTotalDelta > 0
      ? clamp((procDelta / systemTotalDelta) * 100, 0, 100)
      : 0;

    const memPercent = ramTotalBytes > 0
      ? clamp((stat.rssBytes / ramTotalBytes) * 100, 0, 100)
      : 0;

    processes.push({
      pid: stat.pid,
      name: stat.name,
      cpuPercent: Number(cpuPercent.toFixed(2)),
      memPercent: Number(memPercent.toFixed(2)),
      rssGb: bytesToGb(stat.rssBytes),
    });
  }

  previousProcessCpu = currentCpuMap;

  return {
    memoryTop: [...processes].sort((a, b) => b.memPercent - a.memPercent).slice(0, 8),
    cpuTop: [...processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 8),
  };
}

function sendMetrics(res) {
  const payload = getMetricsPayload();
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getMetricsPayload() {
  const ram = getRamInfo();
  const cpu = getSystemCpuUsage();
  const processes = getTopProcesses(ram.totalBytes, cpu.totalDelta);

  return {
    time: new Date().toISOString(),
    sources: { ram: ram.source, cpu: cpu.source },
    ram: {
      usagePercent: ram.usagePercent,
      usedGb: bytesToGb(ram.usedBytes),
      availableGb: bytesToGb(ram.availableBytes),
      freeGb: bytesToGb(ram.freeBytes),
      totalGb: bytesToGb(ram.totalBytes),
      shortfallGb: bytesToGb(ram.usedBytes),
    },
    cpu: { usagePercent: cpu.usagePercent },
    processes,
  };
}

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    fs.readFile(INDEX_PATH, 'utf8', (err, html) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Cannot load index.html');
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    });
    return;
  }

  if (req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    sendMetrics(res);
    const interval = setInterval(() => sendMetrics(res), 1000);

    req.on('close', () => {
      clearInterval(interval);
    });
    return;
  }

  if (req.url === '/metrics') {
    const payload = getMetricsPayload();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify(payload));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Realtime monitor started: http://${HOST}:${PORT}`);
  console.log('For Termux: open http://127.0.0.1:5000 in browser');
});
