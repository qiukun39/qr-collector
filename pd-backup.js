/* 装箱台电脑端（PackDesk）局域网备份客户端 —— packdesk-lan-v1
 *
 * 和 pp-backup.js（PackingProof 通道）各管各的，两套可以同时开着。
 * 协议与判据见 packdesk-desktop/protocol/PROTOCOL.md 和 fixtures/。
 * 签名实现必须和 protocol/js/sign.mjs 一致——那份过了跨语言测试向量。
 *
 * 比 PackingProof 通道多的：照片、清单 CSV 都能传，序列号时间轴电脑端会落库。
 */
(function () {
  'use strict';

  var KEY = 'pk.pd';                  // 独立的配置键，删功能时不碰别的
  var DEFAULT_PORT = 5178;            // 电脑端默认端口，避开 PackingProof 的 5280
  var PROTO = { protocol: 'packdesk-lan-v1', clientVersion: '3.1' };

  function load() {
    try {
      var v = localStorage.getItem(KEY);
      return v ? JSON.parse(v) : {};
    } catch (e) { return {}; }
  }
  function save(c) {
    try { localStorage.setItem(KEY, JSON.stringify(c)); } catch (e) {}
  }

  var cfg = Object.assign({
    on: false,
    host: '',
    deviceId: '',
    deviceName: '',
    credential: '',
    nodeId: '',
    nodeName: '',
    auto: false
  }, load());

  /* ---------------- 工具 ---------------- */

  function hex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  async function sha256Hex(data) {
    var buf = data instanceof Blob ? await data.arrayBuffer() : data;
    if (typeof buf === 'string') buf = new TextEncoder().encode(buf);
    return hex(await crypto.subtle.digest('SHA-256', buf));
  }

  // 凭据是 64 位十六进制时取解码后的 32 字节，否则按 UTF-8 字节。
  // 这条和电脑端的 SecretBytes 必须一致，fixtures 里有专门一条测它。
  function secretBytes(credential) {
    var c = String(credential || '').trim();
    if (c.length === 64 && /^[0-9a-fA-F]+$/.test(c)) {
      var out = new Uint8Array(32);
      for (var i = 0; i < 32; i++) out[i] = parseInt(c.substr(i * 2, 2), 16);
      return out;
    }
    return new TextEncoder().encode(c);
  }

  function normPath(path) {
    var p = String(path == null ? '' : path).trim();
    if (!p) return '/';
    var q = p.indexOf('?');
    if (q >= 0) p = p.slice(0, q);
    return p.charAt(0) === '/' ? p : '/' + p;
  }

  function canonicalString(method, path, ts, nonce, contentHash, deviceId) {
    return [
      String(method).trim().toUpperCase(),
      normPath(path),
      String(ts),
      String(nonce).trim(),
      String(contentHash).trim().toLowerCase(),
      String(deviceId || '').trim().toLowerCase()
    ].join('\n');
  }

  async function sign(credential, method, path, ts, nonce, contentHash, deviceId) {
    var key = await crypto.subtle.importKey(
      'raw', secretBytes(credential), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    var msg = new TextEncoder().encode(
      canonicalString(method, path, ts, nonce, contentHash, deviceId));
    return hex(await crypto.subtle.sign('HMAC', key, msg));
  }

  /* ---------------- 请求 ---------------- */

  async function request(path, opt) {
    opt = opt || {};
    var method = opt.method || 'GET';
    var signed = opt.signed !== false;
    var headers = Object.assign({}, opt.headers || {});
    var payload = opt.body;

    if (payload != null && !(payload instanceof ArrayBuffer) && !(payload instanceof Uint8Array)) {
      payload = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }

    if (signed) {
      var bytes = payload == null ? new Uint8Array(0)
        : (typeof payload === 'string' ? new TextEncoder().encode(payload) : payload);
      var contentHash = await sha256Hex(bytes.buffer ? bytes.buffer.slice(
        bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes);
      var ts = Math.floor(Date.now() / 1000);
      var nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
      headers['X-PD-Device-Id'] = cfg.deviceId;
      // HTTP 头不能带非 ASCII，中文设备名不编码会让 fetch 直接抛 TypeError
      headers['X-PD-Device-Name'] = encodeURIComponent(cfg.deviceName || '');
      headers['X-PD-Timestamp'] = String(ts);
      headers['X-PD-Nonce'] = nonce;
      headers['X-PD-Content-SHA256'] = contentHash;
      headers['X-PD-Signature'] =
        await sign(cfg.credential, method, path, ts, nonce, contentHash, cfg.deviceId);
    }

    var res;
    try {
      res = await fetch(String(cfg.host).replace(/\/+$/, '') + path,
        { method: method, headers: headers, body: payload });
    } catch (e) {
      var msg = (e && e.message) || String(e);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        var off = new Error('连不上电脑端，确认手机和电脑在同一个 WiFi、装箱台电脑端开着');
        off.offline = true;
        throw off;
      }
      throw new Error('请求发不出去：' + msg);
    }

    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}
    if (!res.ok) {
      var code = (data && data.errorCode) || ('HTTP ' + res.status);
      var err = new Error(explain(code, data) || code);
      err.code = code; err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  function explain(code, data) {
    switch (code) {
      case 'clock_skew':
        return '手机和电脑的时间差得太多，请到系统设置里校准手机时间';
      case 'unknown_device':
        return '配对已失效，正在重新连接';
      case 'bad_signature':
        return '签名校验不通过（协议对不上，请反馈）';
      case 'pairing_expired':
        return '这个二维码已经用过或超时了。到电脑上刷新一下页面，会显示新的码';
      case 'enroll_denied':
        return '电脑端拒绝了这次连接';
      case 'enroll_unavailable':
        return '电脑端没人确认，请到电脑上看一眼';
      case 'missing_upload':
        return '有文件没传完，稍后自动重试';
      case 'storage_unavailable':
        return '电脑端存储不可用（磁盘没插好或空间不足）';
      default:
        return (data && data.error) || '';
    }
  }

  /* ---------------- 连接 ---------------- */

  /**
   * 解析电脑端二维码里的网址，形如
   *   http://192.168.31.15:5178/pair?t=9f3a2b7c
   * 也容忍手填的 ip、ip:port、完整网址。
   */
  function parseConnect(text) {
    var raw = String(text || '').trim();
    if (!raw) throw new Error('内容是空的');
    if (!/^https?:\/\//i.test(raw)) {
      var ok = /^\d{1,3}(\.\d{1,3}){3}(:\d{1,5})?\/?$/.test(raw)
            || /^[A-Za-z][\w-]*(\.[\w-]+)*:\d{1,5}\/?$/.test(raw)
            || /^[A-Za-z][\w-]*\.local\/?$/i.test(raw);
      if (!ok) throw new Error('这不像电脑端的地址。写成 192.168.1.10:' + DEFAULT_PORT + ' 这样');
      raw = 'http://' + raw;
    }
    var u;
    try { u = new URL(raw); } catch (e) { throw new Error('地址格式不对：' + raw.slice(0, 60)); }
    // 没写端口就补默认端口。少这一步会去连 80，电脑端不在那儿听，
    // 表现就是「怎么填都连不上」——PackingProof 那条通道上踩过一模一样的坑
    return {
      host: u.protocol + '//' + u.hostname + ':' + (u.port || DEFAULT_PORT),
      pairingToken: u.searchParams.get('t') || ''
    };
  }

  async function probe(host) {
    var base = String(host || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw new Error('地址要以 http:// 开头');
    var ac = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ac ? setTimeout(function () { ac.abort(); }, 6000) : null;
    var res;
    try {
      res = await fetch(base + '/api/pd/node', ac ? { signal: ac.signal } : undefined);
    } catch (e) {
      throw new Error('连不上 ' + base + (e && e.name === 'AbortError' ? '（6 秒没响应）' : '') +
        '\n\n挨个核对：\n1. 手机和电脑连的是同一个 WiFi\n' +
        '2. 电脑上的装箱台在运行\n3. 端口默认 ' + DEFAULT_PORT +
        '\n4. 电脑的防火墙放行了这个端口');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res.ok) throw new Error('对方不像装箱台电脑端（/api/pd/node 返回 ' + res.status + '）');
    var node = await res.json();
    if (node && node.protocol && node.protocol !== PROTO.protocol) {
      // 连到 PackingProof 上去了之类
      throw new Error('这是「' + node.protocol + '」，不是装箱台电脑端');
    }
    return node;
  }

  // 清掉连接信息，但留着 deviceId——重新连同一台电脑时它能认出是老设备
  function forget() {
    cfg.host = ''; cfg.credential = ''; cfg.nodeId = ''; cfg.nodeName = '';
    save(cfg);
  }

  function newDeviceId() {
    return 'pd-' + hex(crypto.getRandomValues(new Uint8Array(8)));
  }

  async function enroll(host, deviceName, pairingToken) {
    var parsed = parseConnect(host);
    var token = pairingToken || parsed.pairingToken || '';
    var node = await probe(parsed.host);
    cfg.host = parsed.host;
    var deviceId = cfg.deviceId || newDeviceId();
    var name = (deviceName || cfg.deviceName || '').trim() || ('装箱台-' + deviceId.slice(-4));

    var r = await request('/api/pd/enroll', {
      method: 'POST', signed: false,
      body: {
        deviceId: deviceId, deviceName: name, deviceKind: 'mobile',
        protocol: PROTO.protocol, clientVersion: PROTO.clientVersion,
        pairingToken: token || undefined
      }
    });
    var cred = r && r.credential;
    if (!cred) {
      throw new Error('电脑端返回了成功，但没给凭据。收到的字段：' +
        (r ? Object.keys(r).join(', ') : '(空)'));
    }
    cfg.deviceId = r.deviceId || deviceId;
    cfg.deviceName = r.deviceName || name;
    cfg.credential = cred;
    cfg.nodeId = r.nodeId || (node && node.nodeId) || '';
    cfg.nodeName = r.nodeName || (node && node.nodeName) || '';
    save(cfg);
    return { host: cfg.host, deviceId: cfg.deviceId, deviceName: cfg.deviceName, node: node };
  }

  // 凭据失效后重连：沿用已存的地址和 deviceId，电脑端那边再点一次允许即可，
  // 不该让人重新扫码/重填地址
  async function reEnroll() {
    if (!cfg.host) throw new Error('还没连过电脑端');
    return await enroll(cfg.host, cfg.deviceName, '');
  }

  /**
   * 心跳。返回里带 paired 字段——电脑端那边把这台手机断开之后，
   * 靠它才能知道自己被踢了，否则会一直以为连着，直到下次上传才失败。
   */
  async function heartbeat(connected) {
    if (!cfg.host || !cfg.deviceId) return null;
    return await request('/api/pd/heartbeat', {
      method: 'POST', signed: false,
      body: { deviceId: cfg.deviceId, deviceName: cfg.deviceName || '', connected: connected !== false }
    });
  }

  /* ---------------- 上传 ---------------- */

  // 传一个文件（分片 + 断点续传）。返回它的 sha256。
  async function putFile(blob, mime, kind, onProg) {
    var sha = await sha256Hex(blob);
    var started = await request('/api/pd/uploads', {
      method: 'POST',
      body: { sha256: sha, totalBytes: blob.size, mimeType: mime || blob.type || 'application/octet-stream', kind: kind }
    });
    if (started.complete) {                         // 电脑端已经有同一份内容
      if (onProg) onProg(blob.size, blob.size);
      return sha;
    }
    var offset = started.offset || 0;
    var chunkSize = started.chunkSize || (4 * 1024 * 1024);
    while (offset < blob.size) {
      var end = Math.min(offset + chunkSize, blob.size);
      var buf = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      var r;
      try {
        r = await request('/api/pd/uploads/' + sha + '/chunks', {
          method: 'PUT',
          body: buf,
          headers: {
            'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + blob.size,
            'X-PD-Chunk-SHA256': await sha256Hex(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)),
            'Content-Type': 'application/octet-stream'
          }
        });
      } catch (e) {
        // 错位时电脑端会告诉我们正确的位置，从那里续，别整份重来
        if (e && e.code === 'offset_mismatch' && e.data && typeof e.data.offset === 'number') {
          offset = e.data.offset;
          if (onProg) onProg(offset, blob.size);
          continue;
        }
        throw e;
      }
      offset = (r && typeof r.offset === 'number') ? r.offset : end;
      if (onProg) onProg(offset, blob.size);
    }
    return sha;
  }

  /**
   * 把一单传上去。
   * @param order  主程序的 order 对象
   * @param files  {video:{blob,name}, photos:[{blob,name,code,takenAt}], manifest:{blob,name}}
   * @param onProg (已传字节, 总字节) => void
   */
  async function upload(order, files, onProg) {
    if (!cfg.credential) throw new Error('还没连接电脑端');
    files = files || {};
    var parts = [];
    if (files.video) parts.push({ f: files.video, kind: 'video', mime: 'video/mp4' });
    (files.photos || []).forEach(function (p) { parts.push({ f: p, kind: 'photo', mime: 'image/jpeg' }); });
    if (files.manifest) parts.push({ f: files.manifest, kind: 'manifest', mime: 'text/csv' });
    if (!parts.length) throw new Error('这一单没有可传的内容');

    var total = parts.reduce(function (n, p) { return n + p.f.blob.size; }, 0);
    var done = 0;
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      var base = done;
      p.sha = await putFile(p.f.blob, p.mime, p.kind, function (a) {
        if (onProg) onProg(base + a, total);
      });
      done += p.f.blob.size;
    }

    var idx = 0;
    var photos = (files.photos || []).map(function (p) {
      var ref = parts.filter(function (x) { return x.f === p; })[0];
      idx++;
      return {
        sha256: ref.sha, fileName: p.name || (idx + '.jpg'), bytes: p.blob.size,
        takenAt: p.takenAt ? new Date(p.takenAt).toISOString() : undefined,
        code: p.code || undefined
      };
    });
    var videoRef = files.video
      ? { sha256: parts.filter(function (x) { return x.f === files.video; })[0].sha,
          fileName: files.video.name || 'video.mp4', bytes: files.video.blob.size }
      : undefined;
    var manifestRef = files.manifest
      ? { sha256: parts.filter(function (x) { return x.f === files.manifest; })[0].sha,
          fileName: files.manifest.name || 'list.csv', bytes: files.manifest.blob.size }
      : undefined;

    // 序列号时间轴——电脑端会落库，回放时点一个序列号就跳到扫那一件的那一秒。
    // 这是这套协议相对 PackingProof 唯一真正的增量
    var items = (order.items || []).filter(function (i) { return !i.snap; });
    var markers = [{
      code: order.no, kind: 'waybill',
      at: new Date(order.t).toISOString(), offsetMs: 0
    }].concat(items.map(function (i) {
      return {
        code: i.v, kind: 'serial',
        at: new Date(i.t).toISOString(),
        offsetMs: Math.max(0, i.t - order.t)
      };
    }));

    var endedAt = order.tEnd || (order.t + (order.dur || 0));
    return await request('/api/pd/sessions', {
      method: 'POST',
      body: {
        id: 'qrc-' + order.id,
        trackingNumber: order.no,
        mode: (order.type || 'out') === 'ret' ? 'return'
            : ((order.type === 'scan') ? 'inventory' : 'shipping'),
        startedAt: new Date(order.t).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        durationMs: order.dur || 0,
        device: { id: cfg.deviceId, name: cfg.deviceName || '' },
        video: videoRef,
        photos: photos.length ? photos : undefined,
        manifest: manifestRef,
        markers: markers
      }
    });
  }

  /* ---------------- 换了 IP 自己找回来 ---------------- */

  /**
   * 广播找电脑端。靠配对时记下的 nodeId 认人，不认 IP——
   * 路由器重启、换 WiFi、DHCP 续租失败之后电脑的地址就变了，
   * 没有这一步只能让人重新扫码。
   *
   * 只有 App 版能用：浏览器发不了 UDP 广播。
   */
  function discoverPlugin() {
    try {
      return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LanDiscover;
    } catch (e) { return null; }
  }

  async function discover(timeoutMs) {
    var p = discoverPlugin();
    if (!p) return [];
    try {
      var r = await p.discover({ timeoutMs: timeoutMs || 1200, nodeId: cfg.nodeId || '' });
      return (r && r.hosts) || [];
    } catch (e) { return []; }
  }

  /**
   * 连不上时自己找一次。找到了就把新地址存下来并返回 true。
   * 没配过对（没有 nodeId）就不找——那种情况下找到了也不知道是不是该连的那台。
   */
  async function rediscover() {
    if (!cfg.nodeId) return false;
    var hosts = await discover(1500);
    for (var i = 0; i < hosts.length; i++) {
      var h = hosts[i];
      if (!h || !h.host) continue;
      if (String(h.nodeId || '').toLowerCase() !== String(cfg.nodeId).toLowerCase()) continue;
      if (h.host === cfg.host) return false;   // 地址没变，问题不在这儿
      cfg.host = h.host;
      if (h.nodeName) cfg.nodeName = h.nodeName;
      save(cfg);
      return true;
    }
    return false;
  }

  /* ---------------- 失败分类 ---------------- */

  // 和电脑端 PROTOCOL.md 第 5 节那张表一一对应。两端判据必须一致，
  // 否则会出现「一边一直重试、另一边早就明确拒绝」的空转
  function classify(e) {
    if (!e) return 'unknown';
    if (e.offline) return 'offline';
    var code = e.code || '', st = e.status || 0;
    if (code === 'clock_skew') return 'clock';
    if (code === 'unknown_device') return 'credential';
    if (code === 'bad_signature') return 'credential';
    if (code === 'replay') return 'temporary';
    if (code === 'enroll_denied') return 'denied';
    if (code === 'enroll_unavailable') return 'temporary';
    if (code === 'offset_mismatch') return 'temporary';
    if (code === 'chunk_hash_mismatch') return 'temporary';
    if (code === 'file_hash_mismatch') return 'verify';
    if (code === 'storage_unavailable') return 'storage';
    if (code === 'upload_expired' || code === 'missing_upload') return 'temporary';
    if (st === 408) return 'offline';
    if (st >= 500 && st < 600) return 'temporary';
    return 'unknown';
  }

  function autoRetry(kind) {
    return kind === 'offline' || kind === 'temporary' || kind === 'storage';
  }

  var KIND_TEXT = {
    offline: '电脑端没开机或不在同一网络',
    temporary: '电脑端忙，稍后自动重试',
    storage: '电脑端存储不可用',
    credential: '连接已失效，正在重新连接',
    clock: '手机时间不准，请校准后再试',
    denied: '电脑端拒绝了连接',
    verify: '文件校验不通过',
    unknown: ''
  };

  window.PDBackup = {
    get config() { return cfg; },
    isOn: function () { return !!cfg.on; },
    isPaired: function () { return !!(cfg.host && cfg.credential); },
    set: function (patch) { Object.assign(cfg, patch || {}); save(cfg); return cfg; },
    // 先告诉电脑端一声再清本地。不通也照样清——人点了断开就是要断开，
    // 不能因为电脑关着就卡在那儿
    unpair: async function () {
      if (cfg.host && cfg.credential) {
        try {
          await request('/api/pd/unpair', { method: 'POST', body: {} });
        } catch (e) {}
      }
      forget();
    },
    // 只清本地，不通知对方。电脑端主动踢我们时用这个
    forgetLocal: forget,
    parseConnect: parseConnect,
    probe: probe,
    enroll: enroll,
    reEnroll: reEnroll,
    heartbeat: heartbeat,
    discover: discover,
    rediscover: rediscover,
    canDiscover: function () { return !!discoverPlugin(); },
    upload: upload,
    classify: classify,
    autoRetry: autoRetry,
    kindText: function (k) { return KIND_TEXT[k] || ''; },
    protocolInfo: PROTO,
    defaultPort: DEFAULT_PORT
  };
})();
