/*
 * PackingProof 局域网备份客户端
 * ---------------------------------------------------------------------------
 * 把本 App 录好的单据上传到局域网内的 PackingProof 电脑端（手机端多工位来源）。
 *
 * 协议出处（PackingProof-Desktop，AGPL-3.0 开源）：
 *   Services/BackupRequestAuthentication.cs          签名算法与请求头
 *   Services/BackupCompatibilityPolicy.cs            协议常量与最低版本
 *   Services/WebServer.cs                            路由
 *   protocol-fixtures/mobile-backup-v2-complete.json 请求/响应契约样本
 *
 * 两点必须知道：
 *  1. 配对需要在电脑端手动点「允许」，没有任何绕过授权的手段。
 *  2. 网页版用不了 —— https 页面请求 http://192.168.x.x 会被浏览器的混合内容
 *     规则拦死，这是硬限制。只有 APK（allowMixedContent 打开）能用。
 *
 * 本文件完全自包含，不依赖主程序的任何函数；主程序只通过 window.PPBackup 调用。
 * 要停用这个功能，把 index.html 里引用本文件的那一行删掉即可，其余不受影响。
 */
(function () {
  'use strict';

  var KEY = 'pk.pp';                 // 独立的配置键，删功能时不碰主设置

  var PROTO = {
    protocol: 'mobile-backup-v2',
    enrollmentVersion: 2,
    authVersion: 3,
    // 电脑端对手机端有最低版本门槛，低于这个 enroll 直接 426 拒绝
    clientVersion: '0.5.23',
    clientBuildNumber: 11036
  };

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
    on: false,        // 总开关，默认关 —— 不开时整个功能等于不存在
    host: '',         // http://192.168.x.x:端口
    deviceId: '',
    credential: '',
    deviceName: '',
    auto: false,      // 停止录像后自动上传
    nodeName: ''
  }, load());

  /* ---------------- 基础工具 ---------------- */

  function hex(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += a[i].toString(16).padStart(2, '0');
    return s;
  }

  async function sha256Hex(data) {
    var buf = data instanceof ArrayBuffer ? data : await data.arrayBuffer();
    return hex(await crypto.subtle.digest('SHA-256', buf));
  }

  // 与服务端 BackupRequestAuthentication.DecodeSecret 保持一致：
  // 够长且是合法 hex 就按 hex 解，否则按 UTF-8
  function secretBytes(secret) {
    var v = String(secret || '').trim();
    if (v.length >= 32 && v.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(v)) {
      var out = new Uint8Array(v.length / 2);
      for (var i = 0; i < out.length; i++) out[i] = parseInt(v.substr(i * 2, 2), 16);
      return out;
    }
    return new TextEncoder().encode(v);
  }

  async function hmacHex(secret, canonical) {
    var key = await crypto.subtle.importKey(
      'raw', secretBytes(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical)));
  }

  function normPath(u) {
    var p = String(u || '/').trim();
    var q = p.indexOf('?');
    if (q >= 0) p = p.slice(0, q);
    return p.charAt(0) === '/' ? p : '/' + p;
  }

  // 规范串的拼法必须和服务端 CreateRequestSignature 完全一致，差一个换行都验不过
  function sign(credential, method, path, ts, nonce, contentHash, deviceId) {
    var canonical = [
      String(method).trim().toUpperCase(),
      normPath(path),
      String(ts),
      String(nonce).trim(),
      String(contentHash).trim().toLowerCase(),
      String(deviceId || '').trim().toLowerCase()
    ].join('\n');
    return hmacHex(credential, canonical);
  }

  async function toBuffer(body) {
    if (body == null) return new ArrayBuffer(0);
    if (body instanceof ArrayBuffer) return body;
    if (body instanceof Blob) return await body.arrayBuffer();
    return new TextEncoder().encode(body).buffer;
  }

  /* ---------------- 请求 ---------------- */

  async function request(path, opt) {
    opt = opt || {};
    var method = opt.method || 'GET';
    var signed = opt.signed !== false;
    if (!cfg.host) throw new Error('还没配对电脑端');

    var payload = opt.body;
    var headers = Object.assign({}, opt.headers || {});
    if (payload && !(payload instanceof Blob) && !(payload instanceof ArrayBuffer)) {
      payload = JSON.stringify(payload);
      headers['Content-Type'] = 'application/json';
    }

    if (signed) {
      var buf = await toBuffer(payload);
      var contentHash = await sha256Hex(buf);
      var ts = Math.floor(Date.now() / 1000);
      var nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
      headers['X-EPM-Device-Id'] = cfg.deviceId;
      headers['X-EPM-Device-Kind'] = 'mobile';
      // HTTP 头不能带非 ASCII（中文设备名会让 fetch 直接抛 TypeError），统一百分号编码
      headers['X-EPM-Device-Name'] = encodeURIComponent(cfg.deviceName || '');
      headers['X-EPM-Auth-Version'] = String(PROTO.authVersion);
      headers['X-EPM-Timestamp'] = String(ts);
      headers['X-EPM-Nonce'] = nonce;
      headers['X-EPM-Content-SHA256'] = contentHash;
      headers['X-EPM-Signature'] =
        await sign(cfg.credential, method, path, ts, nonce, contentHash, cfg.deviceId);
    }

    var res;
    try {
      res = await fetch(cfg.host.replace(/\/+$/, '') + path, {
        method: method, headers: headers, body: payload
      });
    } catch (e) {
      // fetch 抛错可能是网络不通，也可能是请求头/参数非法 —— 别一律说成「连不上」，
      // 那样会把真正的原因盖掉，排查时毫无线索
      var msg = (e && e.message) || String(e);
      if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
        throw new Error('连不上电脑端，确认手机和电脑在同一个 WiFi、地址端口没写错、电脑端服务已启动');
      }
      throw new Error('请求发不出去：' + msg);
    }

    var text = await res.text();
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) {}

    if (!res.ok) {
      var code = (data && (data.errorCode || data.error)) || ('HTTP ' + res.status);
      var err = new Error(explain(code, data) || code);
      err.code = code; err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  // 把服务端的错误码翻译成人能看懂的话
  function explain(code, data) {
    switch (code) {
      case 'backup_client_upgrade_required':
        return '电脑端版本要求更高的客户端协议（要求 '
          + ((data && data.minimumVersion) || '?') + '），请升级 PackingProof 电脑端或联系我调整协议版本';
      case 'enrollment_denied':
        return '电脑端拒绝了配对，请在电脑端弹出的框里点「允许」';
      case 'enrollment_approval_unavailable':
        return '电脑端没有开启配对审批，请在电脑端界面上打开配对二维码那一页再试';
      case 'enrollment_approval_busy':
        return '电脑端正在处理另一台设备的配对，稍等再试';
      case 'invalid_content_range':
        return '分片范围不合法（内部错误，请反馈）';
      default:
        return (data && data.message) || '';
    }
  }

  /* ---------------- 配对 ---------------- */

  async function probe(host) {
    var base = String(host || '').trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) throw new Error('地址要以 http:// 开头，例如 http://192.168.1.10:8080');
    var res;
    try {
      res = await fetch(base + '/api/node-info');
    } catch (e) {
      throw new Error('连不上 ' + base + '，确认同一个 WiFi、地址和端口没写错');
    }
    if (!res.ok) throw new Error('对方不像 PackingProof 电脑端（/api/node-info 返回 ' + res.status + '）');
    return await res.json();
  }

  async function enroll(host, deviceName) {
    var node = await probe(host);
    cfg.host = String(host).trim().replace(/\/+$/, '');
    cfg.nodeName = (node && (node.nodeName || node.name || node.hostName)) || '';

    var deviceId = cfg.deviceId || ('qrc-' + hex(crypto.getRandomValues(new Uint8Array(8))));
    var name = (deviceName || '').trim() || ('打包留证-' + deviceId.slice(-4));

    var body = {
      deviceId: deviceId,
      deviceName: name,
      deviceKind: 'mobile',
      backupProtocol: PROTO.protocol,
      enrollmentVersion: PROTO.enrollmentVersion,
      authVersion: PROTO.authVersion,
      clientVersion: PROTO.clientVersion,
      clientBuildNumber: PROTO.clientBuildNumber
    };

    var r = await request('/api/mobile-backup/enroll', { method: 'POST', body: body, signed: false });
    var cred = r && (r.deviceCredential || r.credential);
    if (!cred) throw new Error('电脑端没有返回凭据，请确认那边的授权框点了「允许」');

    cfg.deviceId = deviceId;
    cfg.credential = cred;
    cfg.deviceName = name;
    save(cfg);
    return { host: cfg.host, deviceId: deviceId, deviceName: name, node: node };
  }

  async function capabilities() {
    return await request('/api/mobile-backup/capabilities', { method: 'GET' });
  }

  /* ---------------- 上传 ---------------- */

  /**
   * @param order    单据对象（主程序的 order）
   * @param blob     视频 Blob
   * @param fileName 文件名
   * @param onProg   (已传字节, 总字节) => void
   */
  async function upload(order, blob, fileName, onProg) {
    if (!cfg.credential) throw new Error('还没配对电脑端');
    if (!blob || !blob.size) throw new Error('这一单没有视频');

    var fileSha256 = await sha256Hex(blob);

    var started = await request('/api/mobile-backup/uploads', {
      method: 'POST',
      body: {
        fileSha256: fileSha256,
        fileName: fileName,
        fileSizeBytes: blob.size,
        sourceDeviceId: cfg.deviceId,
        sourceDeviceName: cfg.deviceName
      }
    });

    var uploadId = started.uploadId;
    var offset = started.offset || 0;                       // 服务端给的断点，支持续传
    var chunkSize = started.chunkSize || (4 * 1024 * 1024);

    while (offset < blob.size) {
      var end = Math.min(offset + chunkSize, blob.size);
      var buf = await blob.slice(offset, end).arrayBuffer();
      var r = await request('/api/mobile-backup/uploads/' + uploadId, {
        method: 'PUT',
        body: buf,
        headers: {
          'Content-Range': 'bytes ' + offset + '-' + (end - 1) + '/' + blob.size,
          'X-Chunk-SHA256': await sha256Hex(buf),
          'Content-Type': 'application/octet-stream'
        }
      });
      offset = (r && typeof r.offset === 'number') ? r.offset : end;
      if (onProg) onProg(offset, blob.size);
    }

    // 每个扫到的序列号写成时间轴打点 —— 电脑端回放时能直接跳到扫那一件的瞬间。
    // 这是本 App 独有的数据，PackingProof 自己的手机端产生不了。
    var items = (order.items || []).filter(function (i) { return !i.snap; });
    var markers = [{
      code: order.no,
      occurredAt: new Date(order.t).toISOString(),
      offsetMs: 0
    }].concat(items.map(function (i) {
      return {
        code: i.v,
        occurredAt: new Date(i.t).toISOString(),
        offsetMs: Math.max(0, i.t - order.t)
      };
    }));

    var endedAt = order.tEnd || (order.t + (order.dur || 0));
    var complete = await request('/api/mobile-backup/uploads/' + uploadId + '/complete', {
      method: 'POST',
      body: {
        fileSha256: fileSha256,
        videoCodec: /avc|h264/i.test(blob.type || '') ? 'h264' : 'h265',
        sourceDeviceId: cfg.deviceId,
        sourceDeviceName: cfg.deviceName,
        sessions: [{
          id: 'qrc-' + order.id,
          trackingNumber: order.no,
          startedAt: new Date(order.t).toISOString(),
          endedAt: new Date(endedAt).toISOString(),
          mediaStartMs: 0,
          mediaEndMs: order.dur || 0,
          mode: (order.type || 'out') === 'ret' ? 'return' : 'shipping',
          markers: markers
        }]
      }
    });
    return complete;
  }

  /* ---------------- 对外接口 ---------------- */

  window.PPBackup = {
    get config() { return cfg; },
    isOn: function () { return !!cfg.on; },
    isPaired: function () { return !!(cfg.host && cfg.credential); },
    set: function (patch) { Object.assign(cfg, patch || {}); save(cfg); return cfg; },
    unpair: function () {
      cfg.host = ''; cfg.credential = ''; cfg.nodeName = '';
      save(cfg);
    },
    probe: probe,
    enroll: enroll,
    capabilities: capabilities,
    upload: upload,
    protocolInfo: PROTO
  };
})();
