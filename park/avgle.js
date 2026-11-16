// Avgle (avgle.net) 的 HentaiPark 站点插件。
// 站点形态：日本成人视频聚合站（JAV / 素人为主），普通 PHP 模板站。
// 列表：/index.php（最新）、/popular.php（人气）、/episodes.php（最新发布），
//   分类 /category.php?slug=<slug>，每页 30 条 a.card 卡片；搜索 /search.php?q=<关键词>。
// 详情：/video.php?slug=<slug>，标题取 h1，封面取 <video poster>（兜底详情缩略图），
//   简介取 og:description。解析逻辑与本地 TVBox py 源保持一致。
// 播放：播放地址不在 HTML 里，详情页内嵌带签名、有时效的
//   playEndpoint = "/video_source.php?...&token=..."，GET 它（Referer 为详情页）
//   返回 {"ok":true,"url":"...mp4?verify=..."}，是 CDN 上的 MP4 直链（无需 Referer）。
//   videos() 每次播放都重新请求详情页再换取直链，不缓存签名地址；
//   详情本身不依赖换取成功（对应 py 源 2026-11-12 的回退修复思路）。
// 分类说明：py 源硬编码的 9 个旧分类 slug（fc2 / x-market / pcolle 等）现站已清空，
//   分类页显示 0 条；站点现行分类索引（/categories.php）只有 jvip 与 voyeur-jp
//   两类，本插件按现站实测声明这两类。
const BASE = 'https://avgle.net';
const LANG = 'ja';

const FEED_PATHS = {
  latest: 'index.php',
  popular: 'popular.php',
  episodes: 'episodes.php',
  jvip: 'category.php?slug=jvip',
  'voyeur-jp': 'category.php?slug=voyeur-jp',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim().replace(/&amp;/g, '&');
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 作品 ID 统一为详情页路径 /video.php?slug=<slug>（去掉 lang 等附加参数）。
function normId(value) {
  const s = String(value || '');
  const m = /[?&]slug=([^&#]+)/.exec(s);
  if (m) return '/video.php?slug=' + m[1];
  if (s.startsWith('/')) return s;
  return '/video.php?slug=' + s;
}

function detailUrl(id) {
  const s = String(id || '');
  if (/^https?:\/\//.test(s)) return s;
  return BASE + normId(s);
}

// 列表页通用解析：a.card 卡片（href /video.php?slug=…、h3 标题、img 封面），与 py 源一致。
function parseList(doc) {
  const items = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a.card, a[href*="/video.php?slug="]')) {
    const href = a.getAttribute('href') || '';
    if (!href.includes('/video.php?slug=')) continue;
    const id = normId(href);
    if (seen.has(id)) continue;
    const img = a.querySelector('img');
    const title = ((Park.html.text(a.querySelector('h3')) || '') || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!title) continue;
    seen.add(id);
    items.push({
      id,
      title,
      cover: abs(img ? (img.getAttribute('src') || img.getAttribute('data-src')) : ''),
    });
  }
  return items;
}

// 分页：页面里的 page= 最大值优先；没有有效分页链接时按 py 源的回退规则，
// 满页（>=20 条，与 py 的阈值一致）认为还有下一页。
function hasNextPage(doc, page, count) {
  let maxPage = 0;
  for (const a of doc.querySelectorAll('a[href]')) {
    const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
  }
  if (maxPage > page) return true;
  return count >= 20;
}

Park.register({
  key: 'avgle',
  name: 'Avgle',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'jav',
  description: '日本成人视频，MP4 直链播放',
  homepage: BASE,
  domains: ['avgle.net'],
  linkPatterns: ['avgle\\.net(/video\\.php\\?slug=[^\\s&#]+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'popular', label: '人气' },
    { key: 'episodes', label: '最新发布' },
    { key: 'jvip', label: 'jvip' },
    { key: 'voyeur-jp', label: 'Voyeur JP' },
  ],
  searchHint: '搜索作品名或关键词',

  async feed(key, { page }) {
    const path = FEED_PATHS[key];
    if (!path) throw Park.error('CONFIG', '未知列表');
    const sep = path.includes('?') ? '&' : '?';
    const url = `${BASE}/${path}${sep}page=${page}&lang=${LANG}`;
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseList(doc);
    return { items, page, hasNext: hasNextPage(doc, page, items.length) };
  },

  async search({ keyword, page }) {
    const q = String(keyword || '').trim();
    const p = page || 1;
    if (!q) return { items: [], page: p, hasNext: false };
    let url = `${BASE}/search.php?q=${encodeURIComponent(q)}&lang=${LANG}`;
    if (p > 1) url += `&page=${p}`;
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseList(doc);
    return { items, page: p, hasNext: hasNextPage(doc, p, items.length) };
  },

  async detail(id) {
    const url = detailUrl(id);
    const doc = Park.html.parse(await this.http.text(url));
    const titleEl = doc.querySelector('title');
    const title = ((Park.html.text(doc.querySelector('h1')) || '') ||
      ((titleEl ? Park.html.text(titleEl) : '') || '').split(' - ')[0]).trim();
    if (!title) throw Park.error('NOT_FOUND', '影片不存在');
    const video = doc.querySelector('video');
    const thumb = doc.querySelector('img[src*="/javstream_thumbnails/"]');
    const ogImage = doc.querySelector('meta[property="og:image"]');
    const ogDesc = doc.querySelector('meta[property="og:description"]');
    const cover = abs(
      (video ? video.getAttribute('poster') : '') ||
      (thumb ? thumb.getAttribute('src') : '') ||
      (ogImage ? ogImage.getAttribute('content') : '') || ''
    );
    return {
      id: normId(id),
      title,
      cover,
      url,
      description: (ogDesc ? ogDesc.getAttribute('content') : '') || '',
      chapters: null,
    };
  },

  async videos(id) {
    const url = detailUrl(id);
    const html = await this.http.text(url);
    const m = /playEndpoint\s*=\s*"([^"]+)"/.exec(html || '');
    if (!m) throw Park.error('UNSUPPORTED', '未解析到播放地址');
    const endpoint = abs(m[1]);
    let data = null;
    try {
      const res = await this.http.get(endpoint, { headers: { Referer: url } });
      if (res.ok) data = res.json();
    } catch (_) {
      data = null;
    }
    const play = data && data.ok && data.url ? String(data.url) : '';
    if (!/^https:\/\//.test(play)) throw Park.error('UNSUPPORTED', '播放地址换取失败');
    return [{ url: play, format: 'mp4', label: '原画', preferred: true }];
  },
});
