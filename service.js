// TV Diag service — TizenBrew Node.js service context
// Collects system info, beacons to Mac, AND writes local fallback file
const fs = require('fs');
const BEACON_HOST = '192.168.0.73';
const BEACON_PORT = 8008;
const results = {};

function collect() {
  results.uid = process.getuid ? process.getuid() : 'no getuid';
  results.gid = process.getgid ? process.getgid() : 'no getgid';
  results.pid = process.pid;
  results.ppid = process.ppid;
  results.node = process.version;
  results.arch = process.arch;
  results.env = JSON.parse(JSON.stringify(process.env || {}));

  const paths = ['/proc/version','/proc/cpuinfo','/proc/self/status','/proc/self/maps','/proc/self/environ','/etc/passwd','/bin/','/usr/bin/','/system/bin/','/opt/usr/bin/'];
  results.fs = {};
  for (const p of paths) {
    try {
      if (p.endsWith('/')) results.fs[p] = fs.readdirSync(p).slice(0,50).join(',');
      else results.fs[p] = fs.readFileSync(p,'utf-8').substring(0,3000);
    } catch(e) { results.fs[p] = 'ERR: '+e.message; }
  }

  // child_process — the big one
  try {
    const cp = require('child_process');
    results.cp = 'AVAILABLE';
    results.id = cp.execSync('id',{timeout:5000}).toString().trim();
    results.uname = cp.execSync('uname -a',{timeout:5000}).toString().trim();
    results.whoami = cp.execSync('whoami',{timeout:5000}).toString().trim();
    try { results.suid = cp.execSync('find / -perm -4000 -type f 2>/dev/null | head -40',{timeout:15000}).toString().trim(); } catch(e){results.suid='ERR:'+e.message;}
    try { results.smack = cp.execSync('cat /proc/self/attr/current 2>/dev/null; echo ---; cat /proc/self/attr/exec 2>/dev/null; echo ---; ls /sys/fs/smack/ 2>/dev/null',{timeout:5000}).toString().trim(); } catch(e){results.smack='ERR:'+e.message;}
    try { results.bins = cp.execSync('which nc ncat socat python python2 busybox su wget curl 2>/dev/null; ls /bin/sh /system/bin/sh /system/bin/busybox 2>/dev/null',{timeout:5000}).toString().trim(); } catch(e){results.bins='ERR:'+e.message;}
    try { results.kmods = cp.execSync('head -30 /proc/modules 2>/dev/null',{timeout:5000}).toString().trim(); } catch(e){results.kmods='ERR:'+e.message;}
  } catch(e) {
    results.cp = 'NOT_AVAILABLE: '+e.message;
  }

  // Tizen APIs
  try { results.tver = tizen.systeminfo.getCapability('http://tizen.org/feature/platform.version'); } catch(e){results.tver='n/a';}
  try { results.model = tizen.systeminfo.getCapability('http://tizen.org/feature/device/model'); } catch(e){results.model='n/a';}

  return results;
}

// Write local fallback (readable via sdbd sync or TizenBrew proxy)
function writeLocal(data) {
  try {
    const json = JSON.stringify(data, null, 2);
    fs.writeFileSync('/home/owner/share/tvdiag-results.json', json);
    console.log('[tvdiag] wrote /home/owner/share/tvdiag-results.json ('+json.length+' bytes)');
    return true;
  } catch(e) {
    console.log('[tvdiag] local write failed: '+e.message);
    return false;
  }
}

// Beacon: try EVERY possible method, with retry
function beacon(data, attempt) {
  attempt = attempt || 0;
  const body = JSON.stringify(data, null, 2);
  const url = 'http://' + BEACON_HOST + ':' + BEACON_PORT + '/tv-results';
  const promises = [];

  // Method 1: global fetch
  if (typeof fetch === 'function') {
    promises.push(
      fetch(url, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: body
      }).then(function(r) { return r.text(); })
        .then(function(t) { console.log('[tvdiag] fetch beacon: '+t); })
        .catch(function(e) { console.log('[tvdiag] fetch beacon failed: '+e.message); })
    );
  } else {
    console.log('[tvdiag] fetch not available');
  }

  // Method 2: http module
  try {
    var http = require('http');
    console.log('[tvdiag] http module available');
    var req = http.request({
      hostname: BEACON_HOST, port: BEACON_PORT,
      path: '/tv-results', method: 'POST',
      headers: {'Content-Type':'application/json','Content-Length': Buffer.byteLength(body)},
      timeout: 10000
    }, function(res) {
      var d = '';
      res.on('data', function(c) { d += c; });
      res.on('end', function() { console.log('[tvdiag] http beacon: '+d); });
    });
    req.on('error', function(e) { console.log('[tvdiag] http beacon failed: '+e.message); });
    req.on('timeout', function() { req.destroy(); });
    req.write(body);
    req.end();
    promises.push(new Promise(function(resolve) {
      setTimeout(function() { resolve('http timeout'); }, 12000);
    }));
  } catch(e) {
    console.log('[tvdiag] http module unavailable: '+e.message);
  }

  // Method 3: net module
  try {
    var net = require('net');
    console.log('[tvdiag] net module available');
    var sock = net.connect({host:BEACON_HOST, port:BEACON_PORT});
    var httpBody = 'POST /tv-results HTTP/1.1\r\nHost: '+BEACON_HOST+':'+BEACON_PORT+'\r\nContent-Type: application/json\r\nContent-Length: '+body.length+'\r\nConnection: close\r\n\r\n'+body;
    var done = false;
    var p = new Promise(function(resolve) {
      var resp = '';
      sock.on('data', function(d) { resp += d.toString(); });
      sock.on('end', function() { console.log('[tvdiag] net beacon: '+resp.substring(0,200)); resolve(); });
      sock.on('error', function(e) { console.log('[tvdiag] net beacon failed: '+e.message); resolve(); });
      sock.setTimeout(10000);
      sock.on('timeout', function() { sock.destroy(); resolve(); });
    });
    sock.write(httpBody);
    promises.push(p);
  } catch(e) {
    console.log('[tvdiag] net module unavailable: '+e.message);
  }

  // Method 4: tizen network API
  try {
    var tnet = tizen.require('network');
    console.log('[tvdiag] tizen.network available');
  } catch(e) {
    console.log('[tvdiag] tizen.network not available');
  }

  // Retry after 5s if nothing worked
  setTimeout(function() {
    if (attempt < 5 && promises.length === 0) {
      console.log('[tvdiag] retrying beacon (attempt '+attempt+')');
      beacon(data, attempt + 1);
    }
  }, 5000);

  return Promise.all(promises).catch(function(e) { console.log('[tvdiag] all beacons failed: '+e.message); });
}

// Run
collect();
writeLocal(results);
console.log('[tvdiag] data collected, '+Object.keys(results).length+' fields');
beacon(results, 0);
