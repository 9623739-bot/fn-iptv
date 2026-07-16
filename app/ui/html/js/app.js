/* 飞牛 IPTV 管家 - 前端逻辑（原生 JS，无需构建） */
(function () {
  'use strict';

  var DEFAULTS = {
    nas: '',
    miguUserId: '',
    miguToken: '',
    miguRateType: '3',
    miguHiddenGroups: '',
    epg: '/migu/playback.xml'
  };
  var SET = load();
  var STATE = { channels: [], cats: [], cur: null };
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

      if (old.epg === 'http://epg.51zmt.top:8000/e.xml' || old.epg === '/epg/e.xml') cfg.epg = DEFAULTS.epg;
      return cfg;
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function save() { localStorage.setItem('fn-iptv', JSON.stringify(SET)); }
  function nasBase() {
    var host = (SET.nas && SET.nas.trim()) ? SET.nas.trim().replace(/\/+$/, '') : location.host;
    if (/^https?:\/\//.test(host)) return host;
    return 'http://' + host + (host.indexOf(':') >= 0 ? '' : ':8510');
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

  function miguUserId() { return (SET.miguUserId || '').trim(); }
  function miguToken() { return (SET.miguToken || '').trim(); }
  function miguRateType() { return String(SET.miguRateType || '3'); }
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
  function hasMiguCreds() { return !!(miguUserId() && miguToken()); }
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
  function saveMiguServerConfig() {
    if (!hasMiguCreds()) return Promise.resolve();
    return fetch('/migu/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: miguUserId(),
        token: miguToken(),
        rateType: miguRateType(),
        hiddenGroups: miguHiddenGroups()
      })
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }
  function loadMiguServerConfig() {
    return fetch('/migu/config', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (cfg) {
      if (cfg.rateType) SET.miguRateType = String(cfg.rateType);
      if (typeof cfg.hiddenGroups === 'string') SET.miguHiddenGroups = cfg.hiddenGroups;
      save();
      return cfg;
    }).catch(function () {});
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
    if (hls) {
      try { hls.destroy(); } catch (e) {}
      hls = null;
    }
    if (url.indexOf('.m3u8') >= 0 || /\.m3u8(\?|$)/.test(url) || url.indexOf('/migu/') >= 0) {
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls();
        hls.loadSource(url);
        hls.attachMedia(v);
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
    $('#setNas').value = SET.nas || '';
    $('#setMiguUserId').value = SET.miguUserId || '';
    $('#setMiguToken').value = SET.miguToken || '';
    $('#setMiguRateType').value = miguRateType();
    setHiddenGroupChecks();
    $('#setEpg').value = SET.epg || '';
    $('#settingsModal').classList.add('open');
    $('#settingsModal').setAttribute('aria-hidden', 'false');
    loadMiguServerConfig().then(function () {
      $('#setMiguRateType').value = miguRateType();
      setHiddenGroupChecks();
    });
  }
  function closeSettings() {
    $('#settingsModal').classList.remove('open');
    $('#settingsModal').setAttribute('aria-hidden', 'true');
  }
  function saveSettings() {
    SET.nas = $('#setNas').value.trim();
    SET.miguUserId = $('#setMiguUserId').value.trim();
    SET.miguToken = $('#setMiguToken').value.trim();
    SET.miguRateType = $('#setMiguRateType').value || '3';
    SET.miguHiddenGroups = readHiddenGroupChecks();
    SET.epg = $('#setEpg').value.trim();
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
    loadChannels();
    checkStatus();
    $('#btnTokenHelp').onclick = openTokenHelp;
    $('#btnTvboxHelp').onclick = openTvboxHelp;
    $('#btnRefresh').onclick = function () { loadChannels(); checkStatus(); toast('已刷新'); };
    $('#btnTheme').onclick = toggleTheme;
    $('#btnSettings').onclick = openSettings;
    $('#btnSaveSettings').onclick = saveSettings;
    $('#btnResetSettings').onclick = function () {
      SET = Object.assign({}, DEFAULTS);
      EPG = { doc: null, loaded: false, url: '' };
      save();
      openSettings();
      loadChannels();
      checkStatus();
      toast('已恢复默认');
    };
    $('#btnClosePlayer').onclick = closePlayer;
    $('#btnCopyStream').onclick = function () { if (STATE.cur) copy(cleanStreamUrl(STATE.cur.url)); };
    $('#btnEpgToggle').onclick = function () { var p = $('#epgPanel'); p.hidden = !p.hidden; };
    $('#search').oninput = function () { renderChannels(activeCat(), this.value); };
    $all('[data-close]').forEach(function (b) { b.onclick = closeSettings; });
    $all('[data-close-tvbox]').forEach(function (b) { b.onclick = closeTvboxHelp; });
    $all('[data-close-token]').forEach(function (b) { b.onclick = closeTokenHelp; });
    $all('[data-copy-tvbox]').forEach(function (b) {
      b.onclick = function () {
        var urls = tvboxUrls();
        copy(urls[this.getAttribute('data-copy-tvbox')]);
      };
    });
    $all('.modal').forEach(function (m) { m.onclick = function (e) { if (e.target === m) m.classList.remove('open'); }; });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closePlayer(); closeSettings(); closeTvboxHelp(); closeTokenHelp(); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
