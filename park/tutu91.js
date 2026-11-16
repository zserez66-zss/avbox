// 91图图网 (91tutu.cc) 的 HentaiPark 站点插件。
// 站点形态：Cosplay / 写真图集博客，每个帖子 = 一个图集（单章）。
// 列表：首页 /page/N/ 分页；分类按尺度分 R18 / R17 / R16，/category/R18/N/ 分页。
// 详情页 article 内的 img 即整套图（张数与标题标注的 P 数一致）。
// 站内搜索是 Pagefind 静态索引（分片二进制），没有服务端搜索接口，故不声明 search。
const BASE = 'https://91tutu.cc';

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function postPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/posts\/[^\s?#]+/);
  if (!m) return '';
  return m[0].endsWith('/') ? m[0] : m[0] + '/';
}

function pagesFromTitle(title) {
  const m = /(\d+)\s*P(?:[,\]_\s]|$)/.exec(title || '');
  return m ? parseInt(m[1], 10) : undefined;
}

// 列表页通用解析：带封面图的帖子链接（首页大卡片与分类页磁贴结构不同，统一按链接+图提取）
function parseList(doc) {
  const items = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href*="/posts/"]')) {
    const id = postPath(a.getAttribute('href') || '');
    if (!id || seen.has(id)) continue;
    const img = a.querySelector('img');
    if (!img) continue;
    const h = a.querySelector('h2, h3, h4');
    const title = ((h ? Park.html.text(h) : '') || img.getAttribute('alt') || '').trim();
    if (!title) continue;
    seen.add(id);
    const item = { id, title, cover: abs(img.getAttribute('src') || img.getAttribute('data-src') || '') };
    const pages = pagesFromTitle(title);
    if (pages) item.pages = pages;
    items.push(item);
  }
  return items;
}

function hasNextPage(doc, pattern, page) {
  for (const a of doc.querySelectorAll('a')) {
    const m = pattern.exec(a.getAttribute('href') || '');
    if (m && parseInt(m[1], 10) === page + 1) return true;
  }
  return false;
}

// 详情页图集：article 内的图片（只收本站图片 CDN，排除文末推荐位）
function galleryImages(doc) {
  const art = doc.querySelector('article');
  if (!art) return [];
  const out = [];
  for (const img of art.querySelectorAll('img')) {
    const u = abs(img.getAttribute('data-src') || img.getAttribute('src') || '');
    if (u.includes('image.91tutu.cc') && !out.includes(u)) out.push(u);
  }
  return out;
}

Park.register({
  key: 'tutu91',
  name: '91图图网',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'gallery',
  homepage: BASE,
  domains: ['91tutu.cc'],
  linkPatterns: ['91tutu\\.cc(/posts/[^\\s?#]+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'r18', label: 'R18' },
    { key: 'r17', label: 'R17' },
    { key: 'r16', label: 'R16' },
  ],

  async feed(key, { page }) {
    let url, pattern;
    if (key === 'latest') {
      url = page <= 1 ? BASE + '/' : `${BASE}/page/${page}/`;
      pattern = /\/page\/(\d+)\//;
    } else {
      const cat = key.toUpperCase();
      url = `${BASE}/category/${cat}/${page}/`;
      pattern = new RegExp(`/category/${cat}/(\\d+)/`);
    }
    const doc = Park.html.parse(await this.http.text(url));
    return { items: parseList(doc), page, hasNext: hasNextPage(doc, pattern, page) };
  },

  async detail(id) {
    const url = BASE + id;
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    const images = galleryImages(doc);
    const og = doc.querySelector('meta[property="og:image"]');
    const desc = doc.querySelector('meta[name="description"]');
    return {
      id,
      title,
      cover: abs((og ? og.getAttribute('content') : '') || images[0] || ''),
      url,
      pages: images.length || undefined,
      description: (desc ? desc.getAttribute('content') : '') || `共 ${images.length} 张图片。`,
      chapters: null,
      singleChapterId: 'gallery',
    };
  },

  async chapter(id, chapterId) {
    const url = BASE + id;
    const doc = Park.html.parse(await this.http.text(url));
    const images = galleryImages(doc);
    if (!images.length) throw Park.error('PARSE', '未解析到图集图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
  },
});
