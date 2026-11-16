// CosplayTele (cosplaytele.com) 的 HentaiPark 站点插件。
// 站点形态：WordPress / Flatsome 的 Cosplay 图集站，每个帖子 = 一个图集（单章）。
// 列表：首页与 /category/<slug>/ 归档页的主列表 #post-list，卡片 .post-item，分页 /page/N/。
// 注意：每页页脚部件里还有 55 个 .post-item（Popular/Video/Nude/Ero/Random 滑块），
// 每页原样重复，故列表只取 #post-list 内的卡片，否则翻页全是重复项。
// 热门·24小时/3天/7天页是 WordPress Popular Posts 的 AJAX 占位（无 SSR 列表），不声明。
// 搜索：WordPress 原生 /?s=<kw>，翻页 /page/N/?s=<kw>。
// 详情：图片在 .gallery .gallery-item 里，<a href> 是原图，<img src> 是展示图；
// 本插件 chapter 取 <a href> 原图，detail 封面取首张展示图（与 Venera 源一致）。
// 作者/Coser 只在分类里混排出现，帖子页无明确独立署名，故不填 authors，不从标题猜测。
const BASE = 'https://cosplaytele.com';

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function postPath(href) {
  if (!href) return '';
  const full = abs(href);
  if (!full.startsWith(BASE + '/')) return '';
  const rest = full.slice(BASE.length + 1).split(/[?#]/)[0];
  // 作品链接是单段 slug：/<slug>/（与 Venera 源 linkToId 的正则一致）
  if (!/^[a-z0-9\-]+\/$/.test(rest)) return '';
  return '/' + rest;
}

function workUrl(id) {
  const s = String(id || '');
  if (/^https?:\/\//.test(s)) return s;
  return BASE + (s.startsWith('/') ? s : '/' + s);
}

// 列表卡片解析：首页 / 归档 / 搜索共用，只取主列表 #post-list 的 .post-item
// （页脚部件的 .post-item 每页重复，不取）；无 #post-list 时退到 main 内找。
function parseList(doc) {
  const items = [];
  const seen = new Set();
  let cards = doc.querySelectorAll('#post-list .post-item');
  if (!cards.length) cards = doc.querySelectorAll('main .post-item');
  for (const el of cards) {
    const a = el.querySelector('.box-image a') || el.querySelector('a');
    const img = el.querySelector('.box-image img') || el.querySelector('img');
    const id = postPath(a ? a.getAttribute('href') : '');
    const titleEl = el.querySelector('.post-title a') || el.querySelector('.post-title');
    const title = ((titleEl ? Park.html.text(titleEl) : '') || (a ? a.getAttribute('aria-label') : '') || '').trim();
    if (!id || !title || /广告|推广/.test(title) || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title,
      cover: abs(img ? (img.getAttribute('src') || img.getAttribute('data-src')) : ''),
    });
  }
  return items;
}

function parseMaxPage(doc, page) {
  let max = null;
  for (const a of doc.querySelectorAll('a')) {
    const m = /\/page\/(\d+)\//.exec(a.getAttribute('href') || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) max = max === null ? n : Math.max(max, n);
    }
  }
  return max === null ? null : Math.max(page, max);
}

function pageUrl(param, page) {
  // param 形如 ''（全部）/ 'category/cosplay/' / '24-hours/'
  if (page <= 1) return `${BASE}/${param}`;
  return `${BASE}/${param}page/${page}/`;
}

// 详情页图集原图：.gallery .gallery-item 里 <a href> 优先，无则 <img src>
function galleryImages(doc) {
  const out = [];
  const seen = new Set();
  for (const fig of doc.querySelectorAll('.gallery .gallery-item')) {
    const a = fig.querySelector('a');
    const img = fig.querySelector('img');
    const u = abs((a ? a.getAttribute('href') : '') || (img ? img.getAttribute('src') : '') || '');
    if (u && /\.(jpe?g|png|webp|avif)(\?|$)/i.test(u) && !seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

const FEED_PATHS = {
  latest: '',
  cosplay: 'category/cosplay/',
  'cosplay-ero': 'category/cosplay-ero/',
  'cosplay-nude': 'category/cosplay-nudee/',
  'video-cosplay': 'category/video-cosplayyy/',
};

Park.register({
  key: 'cosplaytele',
  name: 'CosplayTele',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'gallery',
  homepage: BASE,
  domains: ['cosplaytele.com'],
  linkPatterns: ['cosplaytele\\.com(/[a-z0-9\\-]+/)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'cosplay', label: 'Cosplay' },
    { key: 'cosplay-ero', label: 'Cosplay Ero' },
    { key: 'cosplay-nude', label: 'Cosplay Nude' },
    { key: 'video-cosplay', label: 'Video Cosplay' },
  ],

  async feed(key, { page }) {
    const param = FEED_PATHS[key];
    if (param === undefined) throw Park.error('CONFIG', '未知列表');
    const doc = Park.html.parse(await this.http.text(pageUrl(param, page)));
    const items = parseList(doc);
    const maxPage = parseMaxPage(doc, page);
    const out = { items, page, hasNext: maxPage !== null ? page < maxPage : false };
    if (maxPage !== null) out.totalPages = maxPage;
    return out;
  },

  async search({ keyword, page }) {
    const kw = encodeURIComponent(String(keyword || '').trim());
    const url = page <= 1 ? `${BASE}/?s=${kw}` : `${BASE}/page/${page}/?s=${kw}`;
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseList(doc);
    const maxPage = parseMaxPage(doc, page);
    const out = { items, page, hasNext: maxPage !== null ? page < maxPage : false };
    if (maxPage !== null) out.totalPages = maxPage;
    return out;
  },

  async detail(id) {
    const url = workUrl(id);
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    const images = galleryImages(doc);
    const firstImg = doc.querySelector('.gallery .gallery-item img');
    const cover = abs((firstImg ? firstImg.getAttribute('src') : '') || images[0] || '');
    // 分类/标签只取 article 内的链接（全页取会混入导航菜单的分类名）
    const scope = doc.querySelector('article') || doc;
    const groups = [];
    const cats = [...new Set([...scope.querySelectorAll('a[href*="/category/"]')].map((a) => (Park.html.text(a) || '').trim()).filter(Boolean))];
    if (cats.length) groups.push({ namespace: 'category', label: '分类', tags: cats.map((name) => ({ name, keyword: name })) });
    const tagnames = [...new Set([...scope.querySelectorAll('a[href*="/tag/"]')].map((a) => (Park.html.text(a) || '').trim()).filter(Boolean))];
    if (tagnames.length) groups.push({ namespace: 'tag', label: '标签', tags: tagnames.map((name) => ({ name, keyword: name })) });
    return {
      id,
      title,
      cover,
      url,
      pages: images.length || undefined,
      description: images.length ? `共 ${images.length} 张图片（原图）。` : '',
      tags: groups,
      chapters: null,
      singleChapterId: 'gallery',
    };
  },

  async chapter(id, chapterId) {
    const url = workUrl(id);
    const doc = Park.html.parse(await this.http.text(url));
    const images = galleryImages(doc);
    if (!images.length) throw Park.error('PARSE', '未解析到图集图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
  },
});
