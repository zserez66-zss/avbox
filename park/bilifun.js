// Bili影院 (www.bili-fun.com) 的 HentaiPark 站点插件。
// 站点形态：Next.js 服务端渲染，无需 API。列表卡片是 <a href="/video/<数字id>">
// 包 <img alt="完整标题">，封面 src 是本站 cdn-cgi 图床代理地址，剥壳可还原
// img.tphsck.com 原图；卡片尾部火焰图标后是播放量。
// 首页分页 /page/N；分类分页 /category/<slug>/page/N（第 1 页是裸分类路径）。
// 分类只收站内有内容的四区：国产区 / AV区 / 欧美区 / 动漫区（「其他区」站方为空，不收）。
// 详情页 <video> 自带 poster 封面与 title 全标题，<source src> 是 master m3u8 直链，
// 整条播放链不需要 Referer。搜索 /search?q=<关键词>&page=N 为服务端搜索。
const BASE = 'https://www.bili-fun.com';

const CATEGORIES = {
  'chinese-mainland': '国产区',
  'japanese-av': 'AV区',
  western: '欧美区',
  anime: '动漫区',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 剥掉本站 cdn-cgi 图床代理壳，还原原图地址（与 TVBox 源 _cover 一致）。
function cleanCover(raw) {
  if (!raw) return '';
  let src = String(raw).trim();
  const m = /\/cdn-cgi\/image\/[^/]+\/(https?:\/\/.+)$/.exec(src);
  if (m) src = m[1];
  return abs(src);
}

function coverFromImg(img) {
  if (!img) return '';
  let src = img.getAttribute('src') || '';
  if (!src) {
    const ss = img.getAttribute('srcset') || img.getAttribute('srcSet') || '';
    if (ss) src = ss.split(',')[0].trim().split(' ')[0];
  }
  return cleanCover(src);
}

function videoId(href) {
  if (!href) return '';
  const m = /\/video\/(\d+)(?:[?#]|$)/.exec(String(href));
  return m ? m[1] : '';
}

// 列表页通用解析：带封面图的视频卡片，按作品 ID 去重（页面里有重复卡片）。
function parseCards(doc) {
  const items = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href*="/video/"]')) {
    const id = videoId(a.getAttribute('href') || '');
    if (!id || seen.has(id)) continue;
    const img = a.querySelector('img');
    if (!img) continue;
    const title = (img.getAttribute('alt') || '').trim();
    if (!title) continue;
    seen.add(id);
    const item = { id, title, cover: coverFromImg(img) };
    // 播放量：火焰图标所在小块的文本（如 10.0K），只取页面明确给出的数字。
    const flame = a.querySelector('.lucide-flame');
    if (flame && flame.parentElement) {
      const vm = /([\d.]+[KM]?)/.exec(Park.html.text(flame.parentElement) || '');
      if (vm) item.subtitle = '🔥' + vm[1];
    }
    items.push(item);
  }
  return items;
}

// 分页总数：扫页面里的分页链接取最大页码（与 TVBox 源 _pagecount 一致）；
// 没有分页链接时按本页条数推断（满 20 条视为还有下一页）。
function pageInfo(doc, pattern, page, got) {
  let maxPage = page;
  let found = false;
  for (const a of doc.querySelectorAll('a')) {
    const m = pattern.exec(a.getAttribute('href') || '');
    if (m) {
      found = true;
      const n = parseInt(m[1], 10);
      if (n > maxPage && n < 1000000) maxPage = n;
    }
  }
  if (!found) maxPage = got < 20 ? page : page + 1;
  return { page, totalPages: maxPage, hasNext: page < maxPage };
}

Park.register({
  key: 'bilifun',
  name: 'Bili影院',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'adult',
  homepage: BASE,
  domains: ['bili-fun.com'],
  linkPatterns: ['bili-fun\\.com/video/(\\d+)'],
  idPattern: '^(\\d+)$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'browser', scope: 'session', origin: BASE },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'chinese-mainland', label: '国产区' },
    { key: 'japanese-av', label: 'AV区' },
    { key: 'western', label: '欧美区' },
    { key: 'anime', label: '动漫区' },
  ],
  searchHint: '搜索作品名',

  async feed(key, { page }) {
    let url, pattern;
    if (key === 'latest') {
      url = page <= 1 ? BASE + '/' : `${BASE}/page/${page}`;
      pattern = /\/page\/(\d+)/;
    } else if (CATEGORIES[key]) {
      url = page <= 1 ? `${BASE}/category/${key}` : `${BASE}/category/${key}/page/${page}`;
      pattern = new RegExp(`/category/${key}/page/(\\d+)`);
    } else {
      throw Park.error('CONFIG', '未知视频列表');
    }
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseCards(doc);
    return { items, ...pageInfo(doc, pattern, page, items.length) };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, totalPages: 1, hasNext: false };
    const url = `${BASE}/search?q=${encodeURIComponent(kw)}&page=${page}`;
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseCards(doc);
    return { items, ...pageInfo(doc, /[?&]page=(\d+)/, page, items.length) };
  },

  async detail(id) {
    const vid = String(id || '').trim();
    if (!/^\d+$/.test(vid)) throw Park.error('NOT_FOUND', '影片编号无效');
    const url = `${BASE}/video/${vid}`;
    const doc = Park.html.parse(await this.http.text(url));
    const video = doc.querySelector('video');
    let title = '';
    if (video) title = (video.getAttribute('title') || video.getAttribute('aria-label') || '').trim();
    if (!title) {
      const t = (Park.html.text(doc.querySelector('title')) || '').trim();
      title = t.split(/\s+-\s+作品详情/)[0].split(/\s*\|\s*Bili/)[0].trim();
    }
    if (!title) throw Park.error('PARSE', '影片详情解析失败');
    const ogImage = doc.querySelector('meta[property="og:image"]');
    const ogDesc = doc.querySelector('meta[property="og:description"]');
    const cover = cleanCover(
      (video ? video.getAttribute('poster') : '') || (ogImage ? ogImage.getAttribute('content') : '') || ''
    );
    return {
      id: vid,
      title,
      cover,
      url,
      description: (ogDesc ? ogDesc.getAttribute('content') : '') || '',
      related: parseCards(doc).filter((it) => it.id !== vid),
    };
  },

  async videos(id) {
    const vid = String(id || '').trim();
    if (!/^\d+$/.test(vid)) throw Park.error('NOT_FOUND', '影片编号无效');
    const url = `${BASE}/video/${vid}`;
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    let m3u8 = '';
    const source = doc.querySelector('video source') || doc.querySelector('source');
    if (source) {
      const src = source.getAttribute('src') || '';
      if (/\.m3u8/.test(src)) m3u8 = abs(src);
    }
    if (!m3u8) {
      const m = /(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/.exec(html);
      if (m) m3u8 = m[1];
    }
    if (!m3u8) throw Park.error('UNSUPPORTED', '未解析到播放地址');
    return [{ url: m3u8, format: 'hls', label: '原画', preferred: true }];
  },
});
