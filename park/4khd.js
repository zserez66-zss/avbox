// 4KHD (www.4khd.com) 的 HentaiPark 站点插件。
// 站点形态：WordPress 图集站，每个帖子 = 一个图集（单章）。
// 列表：li.wp-block-post 卡片，分页参数 ?query-3-page=N；
// 分类：最新 /、Popular /pages/popular、Cosplay /pages/cosplay、Album /pages/album。
// 搜索：/search/<关键词>/，分页 /search/<关键词>/page/N/（满 12 条认为还有下一页）。
// 详情：标题 .wp-block-post-title，封面取 .entry-content 首图。
// 章节：主通道走 WP REST 按 slug 取 content.rendered 一次拿全图集，
// 失败时兜底抓详情页 .entry-content 并跟随 .page-links 子页聚合。
// 图片去代理：站点图片经 i0.wp.com（WordPress Photon）代理，该域名在部分网络不可达，
// 一律改写 i0.wp.com/pic.4khd.com/ → pic.4khd.com/ 直链（Venera v1.0.1 已验做法）。
const BASE = 'https://www.4khd.com';

const FEED_PATHS = {
  latest: '/',
  popular: '/pages/popular',
  cosplay: '/pages/cosplay',
  album: '/pages/album',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function deproxy(u) {
  return String(u || '').replace(/^https:\/\/i0\.wp\.com\/pic\.4khd\.com\//, 'https://pic.4khd.com/');
}

function postPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/content\/[^\s?#]+/);
  return m ? m[0] : '';
}

function parseList(doc) {
  const items = [];
  for (const el of doc.querySelectorAll('li.wp-block-post')) {
    const a = el.querySelector('.wp-block-post-title a');
    const img = el.querySelector('.wp-block-post-featured-image img');
    const id = postPath(a ? a.getAttribute('href') : '');
    const title = (a ? Park.html.text(a) : '').trim();
    if (!id || !title) continue;
    const timeEl = el.querySelector('.wp-block-post-date time');
    const item = {
      id,
      title,
      cover: deproxy(abs(img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '')),
    };
    const date = (timeEl ? Park.html.text(timeEl) : '').trim();
    if (date) item.subtitle = date;
    items.push(item);
  }
  return items;
}

function parseMaxPage(doc, page) {
  let max = page;
  for (const a of doc.querySelectorAll('a')) {
    const m = /query-3-page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

function listUrl(path, page) {
  const u = BASE + path;
  return page > 1 ? `${u}?query-3-page=${page}` : u;
}

// 与 Venera 已验逻辑一致：content.rendered 里的 i0.wp.com 代理原图，去代理后保序去重
function extractGalleryImages(html) {
  const out = [];
  const re = /<img[^>]+src="(https:\/\/i0\.wp\.com\/pic\.4khd\.com\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    const u = deproxy(m[1].replace(/&amp;/g, '&'));
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

// 章节图集：WP REST 主通道 + 详情页 .entry-content / .page-links 兜底聚合
async function fetchGallery(http, url) {
  let images = [];
  const m = String(url).match(/\/content\/\d+\/([^/]+)\.html/);
  if (m) {
    try {
      const arr = await http.json(`${BASE}/wp-json/wp/v2/posts?slug=${m[1]}`);
      const rendered = (Array.isArray(arr) && arr[0] && arr[0].content && arr[0].content.rendered) || '';
      images = extractGalleryImages(rendered);
    } catch (_) {
      images = [];
    }
  }
  if (!images.length) {
    const seen = new Set();
    const queue = [url];
    const visited = new Set();
    while (queue.length && visited.size < 30) {
      const cur = queue.shift();
      if (!cur || visited.has(cur)) continue;
      visited.add(cur);
      const doc = Park.html.parse(await http.text(cur));
      for (const img of doc.querySelectorAll('.entry-content img')) {
        const u = deproxy(abs(img.getAttribute('data-src') || img.getAttribute('src') || ''));
        if (u && u.includes('pic.4khd.com') && !seen.has(u)) {
          seen.add(u);
          images.push(u);
        }
      }
      for (const a of doc.querySelectorAll('.page-links a.page-numbers')) {
        const href = abs(a.getAttribute('href') || '');
        if (href && !visited.has(href) && !queue.includes(href)) queue.push(href);
      }
    }
  }
  return images;
}

Park.register({
  key: '4khd',
  name: '4KHD',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'gallery',
  description: '4khd.com 图集：最新/Popular/Cosplay/Album，图片去 Photon 代理直链，可搜索',
  homepage: BASE,
  domains: ['4khd.com'],
  linkPatterns: ['4khd\\.com(/content/[^\\s?#]+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'popular', label: 'Popular' },
    { key: 'cosplay', label: 'Cosplay' },
    { key: 'album', label: 'Album' },
  ],

  async feed(key, { page }) {
    const path = FEED_PATHS[key];
    if (!path) throw Park.error('CONFIG', '未知图集列表');
    const doc = Park.html.parse(await this.http.text(listUrl(path, page)));
    const items = parseList(doc);
    const maxPage = parseMaxPage(doc, page);
    return { items, page, totalPages: maxPage, hasNext: page < maxPage };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, totalPages: 1, hasNext: false };
    const q = encodeURIComponent(kw);
    const url = page > 1 ? `${BASE}/search/${q}/page/${page}/` : `${BASE}/search/${q}/`;
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseList(doc);
    // 搜索页不渲染分页链接：满 12 条认为还有下一页（Venera 已验规则）
    const hasNext = items.length >= 12;
    return { items, page, totalPages: hasNext ? page + 1 : page, hasNext };
  },

  async detail(id) {
    const url = String(id || '').startsWith('http') ? String(id) : BASE + id;
    const doc = Park.html.parse(await this.http.text(url));
    const titleEl = doc.querySelector('.wp-block-post-title');
    const title = (titleEl ? Park.html.text(titleEl) : '').trim() || '4KHD 图集';
    const img = doc.querySelector('.entry-content img');
    const cover = deproxy(abs(img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : ''));
    return {
      id,
      title,
      cover,
      url,
      description: title,
      chapters: null,
      singleChapterId: 'gallery',
    };
  },

  async chapter(id, chapterId) {
    const url = String(id || '').startsWith('http') ? String(id) : BASE + id;
    const images = await fetchGallery(this.http, url);
    if (!images.length) throw Park.error('PARSE', '未解析到图集图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
  },
});
