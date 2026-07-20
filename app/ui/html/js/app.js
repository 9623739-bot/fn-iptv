/* 飞牛 IPTV 管家 - 前端逻辑（原生 JS，无需构建） */
(function () {
  'use strict';

  var APP_VERSION = '1.2.22';
  var UPDATE_MANIFEST_API = 'https://api.github.com/repos/9623739-bot/fn-iptv/contents/manifest?ref=main';
  var UPDATE_DOWNLOAD_URL = 'https://github.com/9623739-bot/fn-iptv/raw/main/fn-iptv_x86.fpk';

  var DEFAULTS = {
    port: '',
    miguUserId: '',
    miguToken: '',
    miguRateType: 'auto',
    miguHiddenGroups: '',
    epg: '/migu/playback.xml',
    restartIntervalHours: '',
    restartAt: ''
  };
  var SET = load();
  var STATE = { channels: [], cats: [], cur: null, serverConfigured: false };
  var EPG = { doc: null, loaded: false, url: '' };

  function $(s) { return document.querySelector(s); }
  function $all(s) { return Array.prototype.slice.call(document.querySelectorAll(s)); }
  function load() {
    try {
      var old = JSON.parse(localStorage.getItem('fn-iptv') || '{}');
      var cfg = Object.assign({}, DEFAULTS, old);

      // 兼容旧版本设置，清掉已删除的多源配置。
      delete cfg.srcA;
      delete cfg.srcB;
      delete cfg.srcBtxt;
      delete cfg.srcC;
      delete cfg.srcCtxt;
      delete cfg.def;

      if (!cfg.port && old.nas) {
        var portMatch = String(old.nas).match(/:(\d{1,5})(?:\/)?$/);
        if (portMatch) cfg.port = portMatch[1];
      }
      delete cfg.nas;

      if (old.epg === 'http://epg.51zmt.top:8000/e.xml' || old.epg === '/epg/e.xml') cfg.epg = DEFAULTS.epg;
      return cfg;
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function save() { localStorage.setItem('fn-iptv', JSON.stringify(SET)); }
  function nasBase() {
    var protocol = location.protocol === 'https:' ? 'https:' : 'http:';
    var hostname = location.hostname || location.host.split(':')[0];
    var port = String(SET.port || '').trim() || location.port || '8510';
    return protocol + '//' + hostname + (port ? ':' + port : '');
  }
  function buildUrl(path) {
    if (/^https?:\/\//.test(path)) return path;
    return nasBase() + (path.charAt(0) === '/' ? '' : '/') + path;
  }
  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('已复制链接'); }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }
  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制链接'); } catch (e) { toast('复制失败，请手动复制'); }
    document.body.removeChild(ta);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m];
    });
  }
  function isM3U(t) {
    if (!t) return false;
    var s = t.trim();
    return s.indexOf('#EXTM3U') === 0 || s.indexOf('http') >= 0 || s.indexOf('rtsp://') === 0;
  }
  function cleanStreamUrl(url) {
    return String(url || '').replace(/\$[^?#]*$/, '');
  }
  function resolutionLabel(width, height) {
    width = parseInt(width, 10) || 0;
    height = parseInt(height, 10) || 0;
    if (!width || !height) return '';
    var quality = '标清';
    if (height >= 2160 || width >= 3840) quality = '4K';
    else if (height >= 1080 || width >= 1920) quality = '1080P';
    else if (height >= 720 || width >= 1280) quality = '720P';
    return width + 'x' + height + ' · ' + quality;
  }
  function setPlayerResolution(text) {
    var el = $('#playerResolution');
    if (el) el.textContent = text || '分辨率检测中';
  }
  function updateVideoResolution() {
    var v = $('#video');
    var label = resolutionLabel(v.videoWidth, v.videoHeight);
    if (label) setPlayerResolution('实际分辨率：' + label);
  }
  function parseXmltvTime(s) {
    var m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
    if (!m) return 0;
    var utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
    if (m[7]) {
      var sign = m[7].charAt(0) === '-' ? -1 : 1;
      var off = sign * ((+m[7].slice(1, 3)) * 3600 + (+m[7].slice(3, 5)) * 60);
      return utc - off;
    }
    return utc;
  }
  function fetchText(url, validate) {
    return fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.text();
    }).then(function (txt) {
      if (!validate || validate(txt)) return { url: url, text: txt };
      throw new Error('invalid response');
    });
  }
  function toLocalDatetimeValue(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    var pad = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function fromLocalDatetimeValue(value) {
    if (!value) return '';
    var d = new Date(value);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  function timeAgo(seconds) {
    seconds = parseInt(seconds, 10) || 0;
    if (seconds < 60) return seconds + ' 秒前';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分钟前';
    return Math.floor(minutes / 60) + ' 小时前';
  }

  function compareVersions(a, b) {
    var pa = String(a || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var pb = String(b || '').split('.').map(function (n) { return parseInt(n, 10) || 0; });
    var len = Math.max(pa.length, pb.length);
    for (var i = 0; i < len; i++) {
      var x = pa[i] || 0;
      var y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }
  function parseManifestVersion(text) {
    var m = String(text || '').match(/^\s*version\s*=\s*([0-9]+(?:\.[0-9]+){1,3})\s*$/m);
    return m ? m[1] : '';
  }
  function decodeBase64Utf8(content) {
    var binary = atob(String(content || '').replace(/\s/g, ''));
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }
  function checkForUpdates() {
    var dismissed = localStorage.getItem('fn-iptv-update-dismissed');
    fetch(UPDATE_MANIFEST_API, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('update http ' + r.status);
      return r.json();
    }).then(function (data) {
      var remoteVersion = parseManifestVersion(decodeBase64Utf8(data.content));
      if (!remoteVersion || compareVersions(remoteVersion, APP_VERSION) <= 0) return;
      if (dismissed === remoteVersion) return;
      $('#updateText').textContent = '当前版本 v' + APP_VERSION + '，GitHub 最新版本 v' + remoteVersion + '。';
      $('#btnDownloadUpdate').href = UPDATE_DOWNLOAD_URL;
      $('#updateBanner').hidden = false;
    }).catch(function () {});
  }
  function dismissUpdate() {
    var text = $('#updateText').textContent || '';
    var m = text.match(/最新版本 v([0-9]+(?:\.[0-9]+){1,3})/);
    if (m) localStorage.setItem('fn-iptv-update-dismissed', m[1]);
    $('#updateBanner').hidden = true;
  }

  function miguUserId() { return (SET.miguUserId || '').trim(); }
  function miguToken() { return (SET.miguToken || '').trim(); }
  function miguRateType() { return String(SET.miguRateType || 'auto'); }
  function miguHiddenGroups() { return (SET.miguHiddenGroups || '').trim(); }
  function hiddenGroupList() {
    return miguHiddenGroups().split(/[,，;；\n\r]+/).map(function (item) { return item.trim(); }).filter(Boolean);
  }
  function setHiddenGroupChecks() {
    var selected = hiddenGroupList();
    $all('[data-hidden-group]').forEach(function (input) {
      input.checked = selected.indexOf(input.getAttribute('data-hidden-group')) >= 0;
    });
  }
  function readHiddenGroupChecks() {
    return $all('[data-hidden-group]').filter(function (input) {
      return input.checked;
    }).map(function (input) {
      return input.getAttribute('data-hidden-group');
    }).join(',');
  }
  function hasMiguCreds() { return true; }
  function miguM3uUrl() { return '/migu/m3u'; }
  function miguAdminM3uUrl() { return '/migu/m3u?all=1'; }
  function miguTxtUrl() { return '/migu/txt'; }
  function miguEpgUrl() {
    var epg = (SET.epg || '').trim();
    if (!epg || epg === DEFAULTS.epg) return '/migu/playback.xml';
    return epg;
  }
  function addMiguCredsToUrl(url) {
    return url;
  }
  function tvboxUrls() {
    return {
      config: buildUrl('/tvbox.json'),
      live: buildUrl(miguTxtUrl()),
      epg: buildUrl(miguEpgUrl())
    };
  }
  function openTvboxHelp() {
    var urls = tvboxUrls();
    Object.keys(urls).forEach(function (key) {
      var el = $('[data-tvbox="' + key + '"]');
      if (el) el.textContent = urls[key];
    });
    $('#tvboxModal').classList.add('open');
    $('#tvboxModal').setAttribute('aria-hidden', 'false');
  }
  function closeTvboxHelp() {
    $('#tvboxModal').classList.remove('open');
    $('#tvboxModal').setAttribute('aria-hidden', 'true');
  }
  function openTokenHelp() {
    $('#tokenHelpModal').classList.add('open');
    $('#tokenHelpModal').setAttribute('aria-hidden', 'false');
  }
  function closeTokenHelp() {
    $('#tokenHelpModal').classList.remove('open');
    $('#tokenHelpModal').setAttribute('aria-hidden', 'true');
  }
  function saveMiguServerConfig(options) {
    options = options || {};
    return fetch('/migu/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: miguUserId(),
        token: miguToken(),
        rateType: miguRateType(),
        hiddenGroups: miguHiddenGroups(),
        restartIntervalHours: SET.restartIntervalHours || '',
        restartAt: SET.restartAt || '',
        clearCredentials: options.clearCredentials === true
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (cfg) {
      STATE.serverConfigured = !!(cfg.configured || (!options.clearCredentials && STATE.serverConfigured && (!miguUserId() || !miguToken())) || (miguUserId() && miguToken()));
      if (cfg.rateType) SET.miguRateType = String(cfg.rateType);
      if (typeof cfg.hiddenGroups === 'string') SET.miguHiddenGroups = cfg.hiddenGroups;
      if (typeof cfg.restartIntervalHours !== 'undefined') SET.restartIntervalHours = String(cfg.restartIntervalHours || '');
      if (typeof cfg.restartAt === 'string') SET.restartAt = cfg.restartAt;
      save();
      return cfg;
    });
  }
  function loadMiguServerConfig() {
    return fetch('/migu/config', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (cfg) {
      STATE.serverConfigured = !!cfg.configured;
      if (cfg.rateType) SET.miguRateType = String(cfg.rateType);
      if (typeof cfg.hiddenGroups === 'string') SET.miguHiddenGroups = cfg.hiddenGroups;
      if (typeof cfg.restartIntervalHours !== 'undefined') SET.restartIntervalHours = String(cfg.restartIntervalHours || '');
      if (typeof cfg.restartAt === 'string') SET.restartAt = cfg.restartAt;
      save();
      return cfg;
    }).catch(function () {
      STATE.serverConfigured = !!(miguUserId() && miguToken());
    });
  }

  function parseM3U(text) {
    var lines = text.split(/\r?\n/), ch = [], cur = null, groups = {};
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (line.indexOf('#EXTINF') === 0) {
        var nm = (line.match(/,(.*)$/) || [, '未命名'])[1].trim();
        var gp = (line.match(/group-title="([^"]*)"/i) || [, '其他'])[1].trim();
        var lg = (line.match(/tvg-logo="([^"]*)"/i) || [, ''])[1].trim();
        cur = { name: nm, group: gp, logo: lg, url: '' };
        if (!groups[gp]) groups[gp] = 0;
      } else if (line && line.charAt(0) !== '#' && cur) {
        cur.url = addMiguCredsToUrl(line);
        ch.push(cur);
        groups[cur.group]++;
        cur = null;
      }
    }
    var cats = Object.keys(groups).map(function (k) { return { name: k, cnt: groups[k] }; })
      .sort(function (x, y) { return y.cnt - x.cnt; });
    return { channels: ch, cats: cats };
  }

  function renderSources() {
    var box = $('#sourceCards');
    box.innerHTML = '';
    var card = document.createElement('div');
    card.className = 'card';
    card.innerHTML =
      '<h3><span class="dot wait" data-dot="migu"></span>MiguTV 源<span class="badge">MIGU</span></h3>' +
      '<div class="desc">使用你填写的咪咕凭据生成直播列表，订阅与播放都走本机同源代理。</div>' +
      '<div class="stats"><div class="stat"><b data-cnt="migu">-</b><span>频道</span></div>' +
      '<div class="stat"><b data-st="migu">检测中</b><span>状态</span></div></div>' +
      '<div class="actions">' +
      '<button class="btn primary sm" id="btnBrowse">浏览频道</button>' +
      '<button class="btn sm" id="btnCopyM3u">复制 m3u</button>' +
      '<button class="btn sm" id="btnCopyTxt">复制 txt</button>' +
      '<button class="btn ghost sm" id="btnOpenMigu">详情</button>' +
      '</div>';
    box.appendChild(card);

    $('#btnBrowse').onclick = loadChannels;
    $('#btnCopyM3u').onclick = function () {
      if (!hasMiguCreds()) { toast('请先填写咪咕 userId 和 token'); return; }
      copy(buildUrl(miguM3uUrl()));
    };
    $('#btnCopyTxt').onclick = function () {
      if (!hasMiguCreds()) { toast('请先填写咪咕 userId 和 token'); return; }
      copy(buildUrl(miguTxtUrl()));
    };
    $('#btnOpenMigu').onclick = function () { window.open(miguM3uUrl(), '_blank'); };
  }

  function setSourceStatus(cls, status, count) {
    var dot = $('[data-dot="migu"]');
    var st = $('[data-st="migu"]');
    var cnt = $('[data-cnt="migu"]');
    if (dot) dot.className = 'dot ' + cls;
    if (st) st.textContent = status;
    if (cnt) cnt.textContent = count;
  }
  function loadDevices() {
    return fetch('/migu/devices', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (data) {
      var list = data.devices || [];
      $('#devicesSummary').textContent = '当前在线 ' + (data.onlineCount || 0) + ' 台设备';
      var box = $('#devicesList');
      if (!list.length) {
        box.innerHTML = '<div class="empty compact">暂无播放设备</div>';
        return;
      }
      box.innerHTML = list.map(function (d) {
        var status = d.online ? '播放中' : '离线';
        var cls = d.online ? 'on' : 'off';
        return '<div class="device-row">' +
          '<div><b>' + escapeHtml(d.ip || '未知 IP') + '</b><span>' + escapeHtml(d.userAgent || '未知播放器') + '</span></div>' +
          '<div><b>' + escapeHtml(d.channelName || d.channelId || '未知频道') + '</b><span>最后活跃 ' + timeAgo(d.secondsAgo) + '</span></div>' +
          '<em class="' + cls + '">' + status + '</em>' +
        '</div>';
      }).join('');
    }).catch(function () {
      $('#devicesSummary').textContent = '在线设备加载失败';
      $('#devicesList').innerHTML = '';
    });
  }
  function openDevices() {
    $('#devicesModal').classList.add('open');
    $('#devicesModal').setAttribute('aria-hidden', 'false');
    loadDevices();
    clearInterval(openDevices._timer);
    openDevices._timer = setInterval(loadDevices, 10000);
  }
  function closeDevices() {
    $('#devicesModal').classList.remove('open');
    $('#devicesModal').setAttribute('aria-hidden', 'true');
    clearInterval(openDevices._timer);
  }
  function restartNow() {
    if (!confirm('确认立即重启咪咕源服务？重启期间播放会短暂中断。')) return;
    fetch('/migu/restart', { method: 'POST' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      toast('已发送重启指令，稍后自动恢复');
      closeSettings();
      setTimeout(function () { checkStatus(); }, 8000);
    }).catch(function () {
      toast('重启指令发送失败');
    });
  }

  function checkStatus() {
    if (!hasMiguCreds()) {
      setSourceStatus('wait', '待配置', '-');
      return;
    }
    setSourceStatus('wait', '检测中', '-');
    fetchText(miguAdminM3uUrl(), isM3U).then(function (res) {
      var d = parseM3U(res.text);
      var ok = d.channels.length > 0;
      setSourceStatus(ok ? 'on' : 'off', ok ? '在线 ' + d.channels.length + ' 个' : '空/异常', ok ? d.channels.length : '×');
    }).catch(function () {
      setSourceStatus('off', '离线', '×');
    });
  }

  function loadChannels() {
    if (!hasMiguCreds()) {
      $('#channelList').innerHTML = '<div class="empty">请先在设置中填写咪咕 userId 和 token</div>';
      $('#catList').innerHTML = '';
      STATE.channels = [];
      STATE.cats = [];
      return;
    }
    $('#channelList').innerHTML = '<div class="empty">加载中...</div>';
    $('#catList').innerHTML = '';
    fetchText(miguAdminM3uUrl(), isM3U).then(function (res) {
      var d = parseM3U(res.text);
      STATE.channels = d.channels;
      STATE.cats = d.cats;
      renderCats('全部');
      renderChannels('全部', $('#search').value);
    }).catch(function () {
      $('#channelList').innerHTML = '<div class="empty">加载失败，请检查咪咕凭据或网络</div>';
    });
  }

  function activeCat() {
    var el = document.querySelector('.cat.active');
    if (!el) return '全部';
    return el.textContent.replace(/\s*\d+\s*$/, '').trim() || '全部';
  }
  function renderCats(active) {
    var box = $('#catList');
    box.innerHTML = '';
    var all = document.createElement('div');
    all.className = 'cat' + (active === '全部' ? ' active' : '');
    all.innerHTML = '全部 <span class="cnt">' + STATE.channels.length + '</span>';
    all.onclick = function () { renderCats('全部'); renderChannels('全部', $('#search').value); };
    box.appendChild(all);
    STATE.cats.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'cat' + (c.name === active ? ' active' : '');
      el.innerHTML = escapeHtml(c.name) + ' <span class="cnt">' + c.cnt + '</span>';
      el.onclick = function () { renderCats(c.name); renderChannels(c.name, $('#search').value); };
      box.appendChild(el);
    });
  }
  function renderChannels(cat, q) {
    q = (q || '').trim().toLowerCase();
    var list = STATE.channels.filter(function (c) {
      var okCat = cat === '全部' || c.group === cat;
      var okQ = !q || c.name.toLowerCase().indexOf(q) >= 0 || c.group.toLowerCase().indexOf(q) >= 0;
      return okCat && okQ;
    });
    var box = $('#channelList');
    if (!list.length) {
      box.innerHTML = '<div class="empty">没有匹配的频道</div>';
      return;
    }
    box.innerHTML = '';
    list.forEach(function (c) {
      var el = document.createElement('div');
      el.className = 'ch';
      var logo = c.logo ? '<img class="logo" src="' + c.logo + '" onerror="this.style.display=\'none\'" />' : '<div class="logo"></div>';
      el.innerHTML = logo + '<div class="nm">' + escapeHtml(c.name) + '</div>';
      el.onclick = function () { openPlayer(c); };
      box.appendChild(el);
    });
  }

  var hls = null;
  function openPlayer(ch) {
    STATE.cur = ch;
    $('#playerTitle').textContent = ch.name;
    $('#epgChannel').textContent = ch.name;
    $('#playerDrawer').classList.add('open');
    $('#playerDrawer').setAttribute('aria-hidden', 'false');
    playUrl(cleanStreamUrl(ch.url));
    if (miguEpgUrl()) {
      $('#epgPanel').hidden = false;
      $('#epgBody').textContent = '匹配节目单中...';
      ensureEpg(function (doc) { matchEpg(doc, ch.name); });
    } else {
      $('#epgPanel').hidden = true;
    }
  }
  function playUrl(url) {
    var v = $('#video');
    setPlayerResolution('分辨率检测中');
    v.onloadedmetadata = updateVideoResolution;
    v.onresize = updateVideoResolution;
    if (hls) {
      try { hls.destroy(); } catch (e) {}
      hls = null;
    }
    if (url.indexOf('.m3u8') >= 0 || /\.m3u8(\?|$)/.test(url) || url.indexOf('/migu/') >= 0) {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls();
        hls.loadSource(url);
        hls.attachMedia(v);
        hls.on(window.Hls.Events.MANIFEST_PARSED, function (e, d) {
          var levels = (d && d.levels) || [];
          var best = levels.slice().sort(function (a, b) {
            return (b.height || 0) - (a.height || 0);
          })[0];
          var label = best && resolutionLabel(best.width, best.height);
          if (label) setPlayerResolution('最高可用：' + label);
        });
        hls.on(window.Hls.Events.LEVEL_SWITCHED, function (e, d) {
          var level = hls && hls.levels ? hls.levels[d.level] : null;
          var label = level && resolutionLabel(level.width, level.height);
          if (label) setPlayerResolution('当前分辨率：' + label);
        });
        hls.on(window.Hls.Events.ERROR, function (e, d) { if (d && d.fatal) toast('该频道暂时无法播放'); });
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = url;
      } else {
        toast('当前浏览器不支持该流');
      }
    } else {
      v.src = url;
    }
    v.play().catch(function () {});
  }
  function closePlayer() {
    var v = $('#video');
    v.pause();
    setPlayerResolution('未播放');
    v.onloadedmetadata = null;
    v.onresize = null;
    if (v.src) v.removeAttribute('src');
    v.load();
    if (hls) {
      try { hls.destroy(); } catch (e) {}
      hls = null;
    }
    $('#playerDrawer').classList.remove('open');
    $('#playerDrawer').setAttribute('aria-hidden', 'true');
  }

  function ensureEpg(cb) {
    var url = miguEpgUrl();
    if (!url) {
      cb(null);
      return;
    }
    if (EPG.loaded && EPG.url === url) {
      cb(EPG.doc);
      return;
    }
    fetch(url, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('epg http ' + r.status);
      return r.text();
    }).then(function (xml) {
      EPG.doc = new DOMParser().parseFromString(xml, 'text/xml');
      if (EPG.doc.querySelector('parsererror')) throw new Error('epg parse error');
      EPG.loaded = true;
      EPG.url = url;
      cb(EPG.doc);
    }).catch(function () {
      cb(null);
    });
  }
  function matchEpg(doc, name) {
    if (!doc) {
      $('#epgBody').textContent = '节目单加载失败';
      return;
    }
    var nodes = doc.querySelectorAll('channel');
    var match = null, exact = null;
    for (var i = 0; i < nodes.length; i++) {
      var dn = ((nodes[i].querySelector('display-name') || nodes[i]).textContent || '');
      if (dn.indexOf(name) >= 0 || name.indexOf(dn) >= 0) {
        var id = nodes[i].getAttribute('id');
        if (!match) match = id;
        if (dn === name) {
          exact = id;
          break;
        }
      }
    }
    match = exact || match;
    if (!match) {
      $('#epgBody').textContent = '未匹配到该频道节目单';
      return;
    }
    var progs = Array.prototype.filter.call(doc.querySelectorAll('programme'), function (p) {
      return p.getAttribute('channel') === match;
    });
    var now = Date.now() / 1000, html = '', shown = 0;
    for (var j = 0; j < progs.length; j++) {
      var p = progs[j];
      var start = parseXmltvTime(p.getAttribute('start'));
      var end = parseXmltvTime(p.getAttribute('stop'));
      var title = (p.querySelector('title') || {}).textContent || '';
      if (!title) continue;
      if (end && end < now) continue;
      var isNow = start <= now && now < end;
      var t = new Date(start * 1000);
      var hh = ('0' + t.getHours()).slice(-2) + ':' + ('0' + t.getMinutes()).slice(-2);
      html += '<div class="epg-row' + (isNow ? ' now' : '') + '"><span class="t">' + hh + '</span>' + escapeHtml(title) + '</div>';
      shown++;
      if (shown >= 12) break;
    }
    $('#epgBody').innerHTML = html || '暂无节目单';
  }

  function openSettings() {
    $('#setPort').value = SET.port || location.port || '8510';
    $('#setMiguUserId').value = SET.miguUserId || '';
    $('#setMiguToken').value = SET.miguToken || '';
    $('#setMiguRateType').value = miguRateType();
    $('#setRestartInterval').value = SET.restartIntervalHours || '';
    $('#setRestartAt').value = toLocalDatetimeValue(SET.restartAt);
    setHiddenGroupChecks();
    $('#setEpg').value = SET.epg || '';
    $('#settingsModal').classList.add('open');
    $('#settingsModal').setAttribute('aria-hidden', 'false');
    loadMiguServerConfig().then(function () {
      $('#setMiguRateType').value = miguRateType();
      $('#setRestartInterval').value = SET.restartIntervalHours || '';
      $('#setRestartAt').value = toLocalDatetimeValue(SET.restartAt);
      setHiddenGroupChecks();
      if (STATE.serverConfigured && !$('#setMiguUserId').value && !$('#setMiguToken').value) {
        $('#setMiguToken').placeholder = '已在服务端保存，留空不修改';
      }
    });
  }
  function closeSettings() {
    $('#settingsModal').classList.remove('open');
    $('#settingsModal').setAttribute('aria-hidden', 'true');
  }
  function saveSettings() {
    SET.port = $('#setPort').value.trim();
    SET.miguUserId = $('#setMiguUserId').value.trim();
    SET.miguToken = $('#setMiguToken').value.trim();
    SET.miguRateType = $('#setMiguRateType').value || 'auto';
    SET.miguHiddenGroups = readHiddenGroupChecks();
    SET.epg = $('#setEpg').value.trim();
    SET.restartIntervalHours = $('#setRestartInterval').value.trim();
    SET.restartAt = fromLocalDatetimeValue($('#setRestartAt').value);
    EPG = { doc: null, loaded: false, url: '' };
    save();
    saveMiguServerConfig().then(function () {
      closeSettings();
      checkStatus();
      loadChannels();
      toast('设置已保存');
    }).catch(function () {
      toast('咪咕凭据保存失败');
    });
  }

  function applyTheme(t) {
    if (t === 'light') document.documentElement.classList.add('light');
    else document.documentElement.classList.remove('light');
  }
  function toggleTheme() {
    var light = document.documentElement.classList.toggle('light');
    localStorage.setItem('fn-iptv-theme', light ? 'light' : 'dark');
  }

  function init() {
    applyTheme(localStorage.getItem('fn-iptv-theme') || 'dark');
    save();
    renderSources();
    checkForUpdates();
    loadMiguServerConfig().then(function () {
      loadChannels();
      checkStatus();
    });
    $('#btnTokenHelp').onclick = openTokenHelp;
    $('#btnTvboxHelp').onclick = openTvboxHelp;
    $('#btnDevices').onclick = openDevices;
    $('#btnDismissUpdate').onclick = dismissUpdate;
    $('#btnRefresh').onclick = function () { loadChannels(); checkStatus(); toast('已刷新'); };
    $('#btnTheme').onclick = toggleTheme;
    $('#btnSettings').onclick = openSettings;
    $('#btnSaveSettings').onclick = saveSettings;
    $('#btnRestartNow').onclick = restartNow;
    $('#btnResetSettings').onclick = function () {
      SET = Object.assign({}, DEFAULTS);
      EPG = { doc: null, loaded: false, url: '' };
      save();
      saveMiguServerConfig({ clearCredentials: true }).then(function () {
        openSettings();
        loadChannels();
        checkStatus();
        toast('已恢复默认');
      }).catch(function () {
        openSettings();
        toast('本地已恢复，服务端配置清空失败');
      });
    };
    $('#btnClosePlayer').onclick = closePlayer;
    $('#btnCopyStream').onclick = function () { if (STATE.cur) copy(cleanStreamUrl(STATE.cur.url)); };
    $('#btnEpgToggle').onclick = function () { var p = $('#epgPanel'); p.hidden = !p.hidden; };
    $('#search').oninput = function () { renderChannels(activeCat(), this.value); };
    $all('[data-close]').forEach(function (b) { b.onclick = closeSettings; });
    $all('[data-close-tvbox]').forEach(function (b) { b.onclick = closeTvboxHelp; });
    $all('[data-close-token]').forEach(function (b) { b.onclick = closeTokenHelp; });
    $all('[data-close-devices]').forEach(function (b) { b.onclick = closeDevices; });
    $all('[data-copy-tvbox]').forEach(function (b) {
      b.onclick = function () {
        var urls = tvboxUrls();
        copy(urls[this.getAttribute('data-copy-tvbox')]);
      };
    });
    $all('.modal').forEach(function (m) { m.onclick = function (e) { if (e.target === m) { m.classList.remove('open'); closeDevices(); } }; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePlayer(); closeSettings(); closeTvboxHelp(); closeTokenHelp(); closeDevices(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
