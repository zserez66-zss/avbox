// Taiav (taiav.com) 的 HentaiPark 站点插件。
// 站点形态：JAV / 国产 AV 聚合站，服务端渲染，中文区在 /cn/ 下，
// 影片 ID 为 24 位十六进制。列表卡片是 <a href="/cn/movie/<id>"> 包
// <img alt=全标题 src=海报>，每页 15 条，?page=N 分页；热门 /hots 是
// 固定 39 条榜单、无分页。详情页 <h1> 是干净标题，JSON-LD 里有
// thumbnailUrl 海报与 duration，标签是正文区 a.uk-button 的 /cn/tag/ 链接。
// 播放：GET /api/getmovie?type=1280&id=<id>（type 必带，1280 对应 720P）
// 返回本站签名 m3u8（AES-128 加密 HLS），地址有时效，故 videos() 每次
// 现调现取，只返回清单地址，清单与密钥由框架按媒体权限处理。
// 站点整体偏慢：所有请求给 30000 超时，失败自动重试一次。
const BASE = 'https://taiav.com';

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// JSON-LD 的 ISO8601 时长 PT35M / PT1H2M / PT45S -> 显示用 H:MM:SS / M:SS
function isoDuration(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || '').trim());
  if (!m) return '';
  const total = (Number(m[1]) || 0) * 3600 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
  if (total <= 0) return '';
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const ss = String(total % 60).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

Park.register({
  key: 'taiav',
  name: 'Taiav',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'jav',
  description: 'JAV 与国产 AV 视频，支持最新、热门、分类、搜索与 HLS 播放',
  homepage: BASE,
  domains: ['taiav.com'],
  linkPatterns: ['taiav\\.com/cn/movie/([0-9a-f]{24})'],
  idPattern: '^[0-9a-f]{24}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'browser', scope: 'session', origin: BASE },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'hot', label: '热门' },
    { key: 'uncensored', label: '无码' },
    { key: 'censored', label: '有码' },
    { key: 'domestic', label: '国产AV' },
    { key: 'streamer', label: '网红主播' },
  ],
  searchHint: '搜索作品名或标签',

  validId(id) {
    const m = /([0-9a-f]{24})/.exec(String(id || ''));
    if (!m) throw Park.error('NOT_FOUND', '影片编号无效');
    return m[1];
  },

  // 站点偏慢：30 秒超时，失败重试一次再抛
  async getText(url) {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        return await this.http.text(url, { timeout: 30000 });
      } catch (e) {
        last = e;
        if (e && e.code === 'NOT_FOUND') throw e;
      }
    }
    throw last;
  },

  async getJson(url) {
    let last;
    for (let i = 0; i < 2; i++) {
      try {
        return await this.http.json(url, { timeout: 30000 });
      } catch (e) {
        last = e;
        if (e && e.code === 'NOT_FOUND') throw e;
      }
    }
    throw last;
  },

  // 列表卡片：<a href="/cn/movie/<24hex>"> 里包 <img alt=全标题 src=海报>
  cards(doc) {
    const items = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll('a[href*="/cn/movie/"]')) {
      const m = /\/cn\/movie\/([0-9a-f]{24})/.exec(a.getAttribute('href') || '');
      if (!m || seen.has(m[1])) continue;
      const img = a.querySelector('img');
      if (!img) continue;
      const title = (img.getAttribute('alt') || '').trim();
      if (!title) continue;
      seen.add(m[1]);
      const item = {
        id: m[1],
        title,
        cover: abs(img.getAttribute('src') || img.getAttribute('data-src') || ''),
        coverAspect: 16 / 9,
      };
      const dur = /\b\d{1,2}:\d{2}(?::\d{2})?\b/.exec(Park.html.text(a) || '');
      if (dur) item.duration = dur[0];
      items.push(item);
    }
    return items;
  },

  totalPages(doc, page) {
    let max = page;
    for (const a of doc.querySelectorAll('a[href]')) {
      const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return max;
  },

  async listing(path, page) {
    page = Math.max(1, Math.floor(Number(page) || 1));
    const sep = path.includes('?') ? '&' : '?';
    // 只编码路径部分（中文分类/标签名），query 已是编码好的串、不能二次编码
    const qi = path.indexOf('?');
    const pathname = qi >= 0 ? path.slice(0, qi) : path;
    const query = qi >= 0 ? path.slice(qi) : '';
    const url = BASE + encodeURI(pathname) + query + (page > 1 ? `${sep}page=${page}` : '');
    const doc = Park.html.parse(await this.getText(url));
    const totalPages = this.totalPages(doc, page);
    return { items: this.cards(doc), page, totalPages, hasNext: page < totalPages };
  },

  async feed(key, { page }) {
    if (key === 'hot') {
      // 热门是固定榜单，无分页
      if (page > 1) return { items: [], page, totalPages: 1, hasNext: false };
      const doc = Park.html.parse(await this.getText(BASE + '/hots'));
      return { items: this.cards(doc), page: 1, totalPages: 1, hasNext: false };
    }
    const routes = {
      latest: '/cn/news',
      uncensored: '/cn/category/无码',
      censored: '/cn/category/有码',
      domestic: '/cn/category/国产AV',
      streamer: '/cn/category/网红主播',
    };
    const path = routes[key];
    if (!path) throw Park.error('CONFIG', '未知视频列表');
    return this.listing(path, page);
  },

  async search({ keyword, page, filters }) {
    // 详情页标签直达：filters.category 是原站明确的标签/分类路径
    const category = (filters || {}).category;
    if (typeof category === 'string' && /^\/cn\/(?:tag|category)\/[^?#]+$/.test(category)) {
      return this.listing(category, page);
    }
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, totalPages: 1, hasNext: false };
    return this.listing(`/cn/search?q=${encodeURIComponent(kw)}`, page);
  },

  async detail(id) {
    id = this.validId(id);
    const url = `${BASE}/cn/movie/${id}`;
    const html = await this.getText(url);
    const doc = Park.html.parse(html);
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    if (!title) throw Park.error('NOT_FOUND', '影片不存在');
    const thumb = /"thumbnailUrl"\s*:\s*"([^"]+)"/.exec(html);
    const dur = /"duration"\s*:\s*"([^"]+)"/.exec(html);
    const og = doc.querySelector('meta[property="og:image"]');
    const desc = doc.querySelector('meta[name="description"]');
    const time = doc.querySelector('.time');
    const uploadedText = time ? (Park.html.text(time) || '').trim() : '';
    const tags = [];
    const seenTag = new Set();
    for (const a of doc.querySelectorAll('a.uk-button[href*="/cn/tag/"]')) {
      const href = a.getAttribute('href') || '';
      const m = /^(\/cn\/tag\/[^?#]+)$/.exec(href);
      const name = (Park.html.text(a) || '').trim();
      if (!m || !name || seenTag.has(m[1])) continue;
      seenTag.add(m[1]);
      tags.push({ name, keyword: '', filters: { category: m[1] } });
    }
    return {
      id,
      title,
      cover: abs((thumb ? thumb[1] : '') || (og ? og.getAttribute('content') : '') || ''),
      coverAspect: 16 / 9,
      url,
      duration: isoDuration(dur ? dur[1] : ''),
      uploaded: /^\d{4}-\d{2}-\d{2}/.test(uploadedText) ? uploadedText.slice(0, 10) : '',
      description: desc ? desc.getAttribute('content') || '' : '',
      tags: tags.length ? [{ namespace: 'tag', label: '标签', tags }] : [],
    };
  },

  async videos(id) {
    id = this.validId(id);
    // 签名地址有时效：每次播放现调 /api/getmovie 换新（type 必带）
    const data = await this.getJson(`${BASE}/api/getmovie?type=1280&id=${id}`);
    const raw = data && typeof data.m3u8 === 'string' ? data.m3u8.replace(/\\\//g, '/') : '';
    if (!raw) throw Park.error('UNSUPPORTED', '此影片没有可用的 HLS 清晰度');
    const url = abs(raw);
    let parsed;
    try { parsed = new URL(url); } catch (_) { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || !/\.m3u8$/i.test(parsed.pathname)) {
      throw Park.error('UNSUPPORTED', '此影片没有可用的 HLS 清晰度');
    }
    return [{ url, quality: 720, label: '720P', format: 'hls', preferred: true }];
  },
});
