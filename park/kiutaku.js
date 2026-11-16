// Kiutaku 的 HentaiPark 站点插件。
// 站点形态：Kiutaku 是 Mitaku 图集的镜像站（xiuren 模板）——列表、详情等 HTML 页面
// 走镜像域名 kiutaku.com，图片文件托管在原站 mitaku.net 的 wp-content/uploads 下，
// 故 domains 同时声明两个域名，homepage 用镜像入口 kiutaku.com。
// 列表：.items-row 卡片，偏移分页 ?start=N（每页 20 条）；搜索 /?search=<kw>&start=N。
// 分类照 Venera 源实测：最新 / 热门 /hot + 热门标签 /tag/<id>。
// 详情：单图集 = 一个章节；正文 .article-fulltext 每子页 20 图，图集自身还有
// ?page=N 分页，chapter() 会把所有子页拼齐。
// 图片 Referer 必须用 https://mitaku.net/：mitaku.net 的防盗链拒绝 kiutaku.com 的
// Referer（403），imageHeaders 与 chapter 每页 headers 都带 mitaku.net。
const BASE = 'https://kiutaku.com';
const IMG_REFERER = 'https://mitaku.net/';
const PER_PAGE = 20;

// feed key -> 列表路径参数（'' = 首页最新流；对齐 Venera 源分类）
const FEEDS = {
  latest: '',
  hot: 'hot',
  nikke: 'tag/899',
  zzz: 'tag/1607',
  genshin: 'tag/425',
  wuthering: 'tag/1723',
  byoru: 'tag/516',
  umeko: 'tag/677',
  rumipeach: 'tag/2077',
  tinyasa: 'tag/1395',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 作品 ID 统一为路径形式 /<数字>；兼容纯数字与完整 URL 输入。
function workPath(id) {
  const s = String(id || '').trim();
  const m = s.match(/\/(\d+)(?:[?#].*)?$/) || s.match(/^(\d+)$/);
  if (m) return '/' + m[1];
  if (s.startsWith('/')) return s.split(/[?#]/)[0];
  return s;
}

function workUrl(id) {
  return BASE + workPath(id);
}

// 列表页通用解析：.items-row 卡片（对齐 Venera 源 parseList）
function parseList(doc) {
  const items = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('.items-row')) {
    const a = el.querySelector('a.item-link');
    const img = el.querySelector('.item-thumb img');
    const titleEl = el.querySelector('.item-content h2 a') || a;
    const href = a ? a.getAttribute('href') : '';
    const id = href ? workPath(abs(href)) : '';
    const title = ((titleEl ? Park.html.text(titleEl) : '') || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      title,
      cover: abs(img ? (img.getAttribute('src') || img.getAttribute('data-src')) : ''),
    });
  }
  return items;
}

// 分页链接里的最大 start 偏移（对齐 Venera 源 parseMaxPage）；没有分页链接返回 null。
function parseMaxStart(doc) {
  let maxStart = null;
  for (const a of doc.querySelectorAll('a')) {
    const m = /[?&]start=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) maxStart = maxStart === null ? n : Math.max(maxStart, n);
    }
  }
  return maxStart;
}

// 偏移分页：Park 的 page/cursor 映射到 ?start=N（cursor 即下一页的 start 值）。
function listResult(doc, start) {
  const items = parseList(doc);
  const maxStart = parseMaxStart(doc);
  const page = Math.floor(start / PER_PAGE) + 1;
  if (maxStart === null) return { items, page, hasNext: false };
  const hasNext = start + PER_PAGE <= maxStart;
  const out = {
    items,
    page,
    totalPages: Math.floor(maxStart / PER_PAGE) + 1,
    hasNext,
  };
  if (hasNext) out.cursor = String(start + PER_PAGE);
  return out;
}

function startOf(page, cursor) {
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    const n = parseInt(String(cursor), 10);
    if (!Number.isNaN(n) && n >= 0) return n;
  }
  const p = Math.max(1, Number(page) || 1);
  return (p - 1) * PER_PAGE;
}

function listUrl(param, start, extra = '') {
  const path = param ? `/${param}` : '/';
  return `${BASE}${path}?start=${start}${extra}`;
}

// 正文图集：.article-fulltext 内的图片（去重保序）
function galleryImages(doc) {
  const out = [];
  for (const img of doc.querySelectorAll('.article-fulltext img')) {
    const u = abs(img.getAttribute('src') || img.getAttribute('data-src') || '');
    if (u && !out.includes(u)) out.push(u);
  }
  return out;
}

// 图集子页最大页数：分页链接 ?page=N（对齐 Venera 源 loadEp）
function maxSubPage(doc) {
  let maxSub = 1;
  for (const a of doc.querySelectorAll('a.pagination-link')) {
    const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) maxSub = Math.max(maxSub, parseInt(m[1], 10));
  }
  return maxSub;
}

Park.register({
  key: 'kiutaku',
  name: 'Kiutaku',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'doujin',
  description: 'Kiutaku（Mitaku 镜像）Cosplay 图集：最新/热门/标签流，子页拼全图，可搜索',
  homepage: BASE,
  domains: ['kiutaku.com', 'mitaku.net'],
  linkPatterns: ['kiutaku\\.com(/\\d+)'],
  idPattern: '^(\\d+)$',
  imageHeaders: { Referer: IMG_REFERER },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'hot', label: '热门' },
    { key: 'nikke', label: 'NIKKE' },
    { key: 'zzz', label: '绝区零' },
    { key: 'genshin', label: '原神' },
    { key: 'wuthering', label: '鸣潮' },
    { key: 'byoru', label: 'Byoru' },
    { key: 'umeko', label: 'Umeko J' },
    { key: 'rumipeach', label: 'Rumipeach' },
    { key: 'tinyasa', label: 'Tiny Asa' },
  ],

  async feed(key, { page, cursor } = {}) {
    if (!(key in FEEDS)) throw Park.error('CONFIG', '未知列表');
    const start = startOf(page, cursor);
    const doc = Park.html.parse(await this.http.text(listUrl(FEEDS[key], start)));
    return listResult(doc, start);
  },

  async search({ keyword, page, cursor } = {}) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    const start = startOf(page, cursor);
    const doc = Park.html.parse(
      await this.http.text(listUrl('', start, `&search=${encodeURIComponent(kw)}`)),
    );
    return listResult(doc, start);
  },

  async detail(id) {
    const path = workPath(id);
    const url = BASE + path;
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    if (!title) throw Park.error('PARSE', '未解析到作品标题');
    const firstImages = galleryImages(doc);
    const cover = firstImages[0] || '';
    // 总张数：子页每页图数与第一页一致（实测 20），末页单独数一张尾页即可算准。
    const maxSub = maxSubPage(doc);
    let total = firstImages.length;
    if (maxSub > 1 && firstImages.length) {
      const lastDoc = Park.html.parse(await this.http.text(`${url}?page=${maxSub}`));
      total = (maxSub - 1) * firstImages.length + galleryImages(lastDoc).length;
    }
    // 详情页明确署名的标签在 .article-tags（正文所属标签区，不含相关推荐卡片的标签）
    const tagNames = [];
    for (const a of doc.querySelectorAll('.article-tags a.tag')) {
      const name = (Park.html.text(a) || '').trim().replace(/^#/, '').trim();
      if (name && !tagNames.includes(name)) tagNames.push(name);
    }
    const out = {
      id: path,
      title,
      cover,
      url,
      description: total ? `共 ${total} 张图片。` : '',
      chapters: null,
      singleChapterId: 'gallery',
    };
    if (total) out.pages = total;
    if (tagNames.length) {
      out.tags = [
        { namespace: 'tag', label: '标签', tags: tagNames.map((name) => ({ name, keyword: name })) },
      ];
    }
    return out;
  },

  async chapter(id, chapterId) {
    const url = workUrl(id);
    const first = Park.html.parse(await this.http.text(url));
    const images = galleryImages(first);
    const seen = new Set(images);
    const maxSub = maxSubPage(first);
    for (let p = 2; p <= maxSub; p++) {
      const doc = Park.html.parse(await this.http.text(`${url}?page=${p}`));
      for (const u of galleryImages(doc)) {
        if (!seen.has(u)) {
          seen.add(u);
          images.push(u);
        }
      }
    }
    if (!images.length) throw Park.error('PARSE', '未解析到图集图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: IMG_REFERER } })) };
  },
});
