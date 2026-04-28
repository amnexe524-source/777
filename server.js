const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

const PORT = 5000;
const HOST = '0.0.0.0';
const INDEX_PATH = path.join(__dirname, 'index.html');

let previousCpuTimes = readCpuTimes();

function readCpuTimes() {
  const stat = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
  const values = stat
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((v) => Number(v));

  const idle = values[3] + (values[4] || 0);
  const total = values.reduce((sum, v) => sum + v, 0);
  return { idle, total };
}

function getSystemCpuUsage() {
  const current = readCpuTimes();
  const idleDiff = current.idle - previousCpuTimes.idle;
  const totalDiff = current.total - previousCpuTimes.total;
  previousCpuTimes = current;

  if (totalDiff <= 0) return 0;
  const usage = (1 - idleDiff / totalDiff) * 100;
  return Number(Math.max(0, Math.min(100, usage)).toFixed(2));
}

function getRamInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const usagePercent = (used / total) * 100;

  return {
    totalBytes: total,
    freeBytes: free,
    usedBytes: used,
    usagePercent: Number(usagePercent.toFixed(2)),
  };
}

function bytesToGb(bytes) {
  return Number((bytes / 1024 / 1024 / 1024).toFixed(2));
}

function getTopProcesses(callback) {
  const cmd = 'ps -A -o pid,comm,%cpu,%mem --sort=-%mem 2>/dev/null';

  exec(cmd, { maxBuffer: 1024 * 1024 }, (err, stdout) => {
    if (err || !stdout) {
      callback({ memoryTop: [], cpuTop: [] });
      return;
    }

    const lines = stdout
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);

    const processes = lines
      .map((line) => {
        const parts = line.split(/\s+/);
        if (parts.length < 4) return null;

        const pid = parts[0];
        const cpu = Number(parts[parts.length - 2]);
        const mem = Number(parts[parts.length - 1]);
        const name = parts.slice(1, parts.length - 2).join(' ');

        if (Number.isNaN(cpu) || Number.isNaN(mem)) return null;

        return {
          pid,
          name,
          cpuPercent: Number(cpu.toFixed(2)),
          memPercent: Number(mem.toFixed(2)),
        };
      })
      .filter(Boolean);

    const memoryTop = [...processes]
      .sort((a, b) => b.memPercent - a.memPercent)
      .slice(0, 6);

    const cpuTop = [...processes]
      .sort((a, b) => b.cpuPercent - a.cpuPercent)
      .slice(0, 6);

    callback({ memoryTop, cpuTop });
  });
}

function sendMetrics(res) {
  const ram = getRamInfo();
  const cpu = getSystemCpuUsage();

  getTopProcesses(({ memoryTop, cpuTop }) => {
    const payload = {
      time: new Date().toISOString(),
      ram: {
        usagePercent: ram.usagePercent,
        usedGb: bytesToGb(ram.usedBytes),
        freeGb: bytesToGb(ram.freeBytes),
        totalGb: bytesToGb(ram.totalBytes),
        shortfallGb: bytesToGb(Math.max(0, ram.totalBytes - ram.freeBytes)),
      },
      cpu: {
        usagePercent: cpu,
      },
      processes: {
        memoryTop,
        cpuTop,
      },
    };

    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  });
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

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Realtime monitor started: http://${HOST}:${PORT}`);
  console.log('For Termux: open http://127.0.0.1:5000 in browser');
});
