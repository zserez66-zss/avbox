// 第一动漫 (1anime.me) 的 HentaiPark 站点插件。
// 站点形态：苹果CMS (MacCMS) + mxone 模板。多集番剧形态：
// 列表卡片是 .module-item，详情链接 /voddetail/<id>.html，封面在 img[data-src]，
// 备注在 .module-item-text。分类走 /vodshow/<tid>-...（12 段，页码在第 9 段），
// 站点导航「绅士」一支下 里番(20) / 短片(21) / 3D(22) 与绅士(3) 都有内容，其余频道列表为空。
// 搜索走 /vodsearch/<关键词>-...（14 段，页码在第 11 段），结果卡片是 .module-search-item。
// 详情页选集在 #glist-<sid> 里（sid 对应线路，线路名在 data-dropdown-value），
// 播放页 /vodplay/<id>-<sid>-<nid>.html 内有 player_aaaa JSON，url 是直链 .m3u8 / .mp4。
// 本插件：detail 返回 chapters 分集列表，videos(id, episodeId) 按集解析 player_aaaa 取流。
const BASE = 'https://1anime.me';

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// /vodshow/<tid>-... 共 12 段，页码在第 9 段（index 8），与 py 源一致。
function vodshowUrl(tid, page) {
  const parts = [String(tid), '', '', '', '', '', '', '', '', '', '', ''];
  if (page > 1) parts[8] = String(page);
  return `${BASE}/vodshow/${parts.join('-')}.html`;
}

// /vodsearch/<wd>-... 共 14 段，页码在第 11 段（index 10），与 py 源一致。
function vodsearchUrl(keyword, page) {
  const parts = [encodeURIComponent(String(keyword)), '', '', '', '', '', '', '', '', '', '', '', '', ''];
  if (page > 1) parts[10] = String(page);
  return `${BASE}/vodsearch/${parts.join('-')}.html`;
}

// 从分页链接里取最大页码：segmentIndex 段为纯数字的最大值（与 py 的 _pagecount_* 一致）。
function maxPageFromLinks(doc, segment, segmentIndex) {
  let max = 0;
  for (const a of doc.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!href.includes('/' + segment + '/')) continue;
    const core = href.split('/').pop().replace(/\.html.*$/, '');
    const fields = core.split('-');
    if (fields.length > segmentIndex && /^\d+$/.test(fields[segmentIndex])) {
      max = Math.max(max, parseInt(fields[segmentIndex], 10));
    }
  }
  return max;
}

function coverOf(el) {
  const img = el.querySelector('img');
  if (!img) return '';
  const u = img.getAttribute('data-src') || img.getAttribute('src') || '';
  if (!u || u.includes('loading.gif')) return '';
  return abs(u);
}

function idOf(el) {
  for (const a of el.querySelectorAll('a[href*="/voddetail/"]')) {
    const m = /\/voddetail\/(\d+)\.html/.exec(a.getAttribute('href') || '');
    if (m) return m[1];
  }
  return '';
}

function titleOf(el) {
  const img = el.querySelector('img');
  const nameA = el.querySelector('.video-name a') || el.querySelector('h3 a');
  const t = clean(
    (nameA ? Park.html.text(nameA) : '') ||
    (el.querySelector('.module-item-title') ? el.querySelector('.module-item-title').getAttribute('title') : '') ||
    (img ? img.getAttribute('alt') : '') ||
    ''
  );
  return t;
}

// 首页 / 分类页卡片：.module-item
function parseList(doc) {
  const items = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('.module-item')) {
    const id = idOf(el);
    if (!id || seen.has(id)) continue;
    const title = titleOf(el);
    if (!title) continue;
    seen.add(id);
    const item = { id, title, cover: coverOf(el) };
    const remarks = clean(Park.html.text(el.querySelector('.module-item-text')));
    if (remarks) item.subtitle = remarks;
    items.push(item);
  }
  return items;
}

// 搜索结果卡片：.module-search-item（结构不同，备注在 .video-serial）
function parseSearch(doc) {
  const items = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('.module-search-item')) {
    const id = idOf(el);
    if (!id || seen.has(id)) continue;
    const title = titleOf(el);
    if (!title) continue;
    seen.add(id);
    const item = { id, title, cover: coverOf(el) };
    const remarks = clean(Park.html.text(el.querySelector('.video-serial')));
    if (remarks) item.subtitle = remarks;
    items.push(item);
  }
  return items;
}

// 详情页选集：按 py 的 #glist-<sid> 分组逻辑用 DOM 复刻；
// 线路名按顺序取 data-dropdown-value，多线路时给分集标题加线路名前缀以区分同名集。
function parseChapters(doc) {
  const tabNames = [];
  for (const el of doc.querySelectorAll('[data-dropdown-value]')) {
    const v = clean(el.getAttribute('data-dropdown-value'));
    if (v) tabNames.push(v);
  }
  const groups = new Map(); // sid -> [{id, title}]
  for (const g of doc.querySelectorAll('[id^="glist-"]')) {
    const gm = /^glist-(\d+)$/.exec(g.getAttribute('id') || '');
    if (!gm) continue;
    const sid = parseInt(gm[1], 10);
    const eps = [];
    const seen = new Set();
    for (const a of g.querySelectorAll('a[href*="/vodplay/"]')) {
      const href = a.getAttribute('href') || '';
      const m = /\/vodplay\/(\d+-\d+-\d+)\.html/.exec(href);
      if (!m || seen.has(m[1])) continue;
      seen.add(m[1]);
      let ep = clean(Park.html.text(a)) || clean(a.getAttribute('title'));
      const di = ep.indexOf('第');
      if (di > 0) ep = ep.slice(di);
      eps.push({ id: m[1], title: ep || `第${eps.length + 1}集` });
    }
    if (eps.length) groups.set(sid, eps);
  }
  if (!groups.size) {
    // 兜底：整页 vodplay 链接按 sid 分组（与 py 兜底一致，跳过「立即播放」）
    for (const a of doc.querySelectorAll('a[href*="/vodplay/"]')) {
      const href = a.getAttribute('href') || '';
      const m = /\/vodplay\/(\d+)-(\d+)-(\d+)\.html/.exec(href);
      if (!m) continue;
      const epId = `${m[1]}-${m[2]}-${m[3]}`;
      const sid = parseInt(m[2], 10);
      let ep = clean(Park.html.text(a)) || clean(a.getAttribute('title'));
      if (!ep || ep === '立即播放') continue;
      const di = ep.indexOf('第');
      if (di > 0) ep = ep.slice(di);
      if (!groups.has(sid)) groups.set(sid, []);
      if (!groups.get(sid).some((e) => e.id === epId)) groups.get(sid).push({ id: epId, title: ep });
    }
  }
  const sids = [...groups.keys()].sort((x, y) => x - y);
  const chapters = [];
  sids.forEach((sid, i) => {
    const lineName = tabNames[i] || '';
    for (const ep of groups.get(sid)) {
      chapters.push({
        id: ep.id,
        title: sids.length > 1 && lineName ? `${lineName} · ${ep.title}` : ep.title,
      });
    }
  });
  return chapters;
}

Park.register({
  key: 'anime1',
  name: '第一动漫',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'anime',
  description: '里番动漫：绅士分类、多集选集与 HLS 播放',
  homepage: BASE,
  domains: ['1anime.me'],
  linkPatterns: ['1anime\\.me/voddetail/(\\d+)\\.html'],
  idPattern: '^\\d+$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  // 播放直链以 HLS (m3u8) 为主，少数为 MP4；HLS 按协议用 browser 会话授权。
  media: { mode: 'browser', scope: 'session', origin: BASE },
  defaultFeed: '3',
  feeds: [
    { key: '3', label: '绅士' },
    { key: '20', label: '里番' },
    { key: '21', label: '短片' },
    { key: '22', label: '3D' },
  ],
  searchHint: '搜索作品名',

  async feed(key, { page }) {
    const tid = ['3', '20', '21', '22'].includes(String(key)) ? String(key) : '3';
    const doc = Park.html.parse(await this.http.text(vodshowUrl(tid, page)));
    const items = parseList(doc);
    const totalPages = Math.max(maxPageFromLinks(doc, 'vodshow', 8), page);
    return { items, page, totalPages, hasNext: page < totalPages };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    const doc = Park.html.parse(await this.http.text(vodsearchUrl(kw, page)));
    let items = parseSearch(doc);
    if (!items.length) items = parseList(doc);
    const totalPages = Math.max(maxPageFromLinks(doc, 'vodsearch', 10), page);
    return { items, page, totalPages, hasNext: page < totalPages };
  },

  async detail(id) {
    const vid = String(id || '').replace(/\D/g, '');
    if (!vid) throw Park.error('NOT_FOUND', '作品编号无效');
    const url = `${BASE}/voddetail/${vid}.html`;
    const doc = Park.html.parse(await this.http.text(url));
    const meta = (prop) => {
      const el = doc.querySelector(`meta[property="${prop}"]`);
      return el ? el.getAttribute('content') || '' : '';
    };
    const title = clean(Park.html.text(doc.querySelector('h1'))) || meta('og:title').replace(/剧情介绍.*$/, '').trim();
    if (!title) throw Park.error('NOT_FOUND', '作品不存在');
    const chapters = parseChapters(doc);
    if (!chapters.length) throw Park.error('PARSE', '未解析到分集列表');
    return {
      id: vid,
      title,
      cover: abs(meta('og:image')),
      url,
      description: meta('og:description') || '',
      chapters,
    };
  },

  async videos(id, episodeId) {
    const ep = String(episodeId || '');
    const m = /^(\d+)-(\d+)-(\d+)$/.exec(ep);
    if (!m) throw Park.error('NOT_FOUND', '分集编号无效');
    const playUrl = `${BASE}/vodplay/${ep}.html`;
    const html = await this.http.text(playUrl);
    let direct = '';
    const pm = /player_aaaa\s*=\s*(\{.*?\})\s*<\/script>/s.exec(html);
    if (pm) {
      try {
        const data = JSON.parse(pm[1]);
        direct = String(data.url || '');
        const enc = parseInt(data.encrypt || 0, 10);
        if (enc === 1) {
          try { direct = decodeURIComponent(direct); } catch (_) {}
        } else if (enc === 2) {
          try { direct = decodeURIComponent(atob(direct)); } catch (_) {}
        }
      } catch (_) {
        const um = /"url"\s*:\s*"([^"]+)"/.exec(pm[1]);
        if (um) direct = um[1].replace(/\\\//g, '/');
      }
    }
    if (!direct) {
      const dm = /["'](https?:\/\/[^"']+\.(?:m3u8|mp4)[^"']*)/.exec(html);
      if (dm) direct = dm[1];
    }
    if (!direct) throw Park.error('PARSE', '未解析到播放地址');
    direct = abs(direct);
    const headers = { Referer: playUrl };
    if (/\.m3u8(?:[?#]|$)/i.test(direct)) {
      return [{ url: direct, format: 'hls', label: '原画', headers }];
    }
    if (/\.mp4(?:[?#]|$)/i.test(direct)) {
      return [{ url: direct, format: 'mp4', label: '原画', headers }];
    }
    throw Park.error('UNSUPPORTED', '不支持的播放地址格式');
  },
});
