// PornPics (www.pornpics.com) 的 HentaiPark 站点插件。
// 站点形态：写真图集站，每个图集 = 一个作品（单章），图集内的照片就是章节页。
// 列表：排序页（热门/最新/评分/点赞）与分类页第 1 页是 SSR HTML，
// 之后走站点自身的无限滚动 JSON 接口（offset/limit）；搜索全部走 JSON 接口。
// 章节图取详情页 PhotoSwipe 锚点（#tiles 里 a.rel-link）的 href，即 cdni.pornpics.com 的 /1280/ 全图。
// 年龄墙：站点约 1/6 概率随机返回整页 'Age Verification Required' 墙，
// 取页时最多重试 3 次，仍被墙才报错，不把墙页当内容解析。
// 广告版页面：站点按出口地区给部分会话下发广告版图集页（Cookie ppavnv=1），
// 多数图位被 /av/ 广告占位图替换、只剩少数真图；插件重取最多 3 次、取真图最多的一份，
// 广告占位图永不入章。ppavnv 由服务端按 IP 下发，改 Cookie 无效（实测）。
// 以上抓取逻辑与已实测的 Venera 源 pornpics.js 一致（广告版重取为其“缩水页重取”的推广）。
const BASE = 'https://www.pornpics.com';
const PAGE_SIZE = 20;

const SORT_PATHS = {
  popular: '/popular/',
  recent: '/recent/',
  rating: '/rating/',
  likes: '/likes/',
};

// 分类共 172 个，这里只放 Venera 源分类表前列的主要入口，通过 feed options 选择。
const CATEGORIES = [
  ['milf', 'MILF'],
  ['amateur', 'Amateur'],
  ['teens', 'Teen'],
  ['thick', 'Thick'],
  ['pussy', 'Pussy'],
  ['mature', 'Mature'],
  ['public', 'Public'],
  ['redhead', 'Redhead'],
  ['ass', 'Ass'],
  ['big-tits', 'Big Tits'],
  ['asian', 'Asian'],
  ['mom', 'Mom'],
  ['black', 'Black'],
  ['ai', 'AI'],
  ['curvy', 'Curvy'],
  ['lingerie', 'Lingerie'],
  ['wife', 'Wife'],
  ['petite', 'Petite'],
  ['cumshot', 'Cumshot'],
  ['latina', 'Latina'],
  ['cougar', 'Cougar'],
  ['beautiful', 'Beautiful'],
  ['homemade', 'Homemade'],
  ['bikini', 'Bikini'],
  ['pov', 'POV'],
  ['fetish', 'Fetish'],
  ['pornstar', 'Pornstar'],
  ['cosplay', 'Cosplay'],
  ['lesbian', 'Lesbian'],
  ['solo', 'Solo'],
];

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 作品 ID = 图集路径 /galleries/<slug>-<数字>/
function galleryPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/galleries\/[^\s?#]+/);
  if (!m) return '';
  return m[0].endsWith('/') ? m[0] : m[0] + '/';
}

// gallery URL 的 slug 还原成标题（排序页卡片 img 的 alt 是空的，只能用这个）
function slugTitle(gurl) {
  const slug = String(gurl || '').replace(/\/+$/, '').split('/').pop() || '';
  const t = slug.replace(/-\d+$/, '').replace(/-/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

// SSR 列表页：#tiles 内的图集卡片
function parseHtmlList(doc) {
  const items = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('#tiles li.thumbwook a.rel-link')) {
    const href = a.getAttribute('href') || '';
    const id = galleryPath(href);
    if (!id || seen.has(id)) continue;
    const img = a.querySelector('img');
    let cover = img ? (img.getAttribute('data-src') || '') : '';
    if (!cover || cover.includes('1px.png')) cover = (img ? img.getAttribute('src') : '') || cover;
    const title = ((img ? img.getAttribute('alt') : '') || '').trim() || slugTitle(href);
    if (!title || !cover) continue;
    seen.add(id);
    items.push({ id, title, cover: abs(cover) });
  }
  return items;
}

// 无限滚动 JSON 条目：desc 是标题（末尾可能拼了 gid，去掉），空 desc 时用 slug 还原
function dtoToItem(d) {
  const gurl = (d && d.g_url) || '';
  const id = galleryPath(gurl);
  if (!id) return null;
  let title = String((d && d.desc) || '').trim();
  const gid = String((d && d.gid) || '');
  if (gid && title.endsWith(' ' + gid)) title = title.slice(0, title.length - gid.length - 1).trim();
  if (!title) title = slugTitle(gurl);
  const cover = (d && (d.t_url_460 || d.t_url)) || '';
  if (!title || !cover) return null;
  return { id, title, cover: abs(cover) };
}

function jsonToItems(arr) {
  const items = [];
  const seen = new Set();
  for (const d of arr) {
    const item = dtoToItem(d);
    if (item && !seen.has(item.id)) {
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

// 图集照片：#tiles 中 PhotoSwipe 锚点 href 即 1280px 原图，按页面顺序
function galleryImages(doc) {
  const out = [];
  for (const a of doc.querySelectorAll('#tiles li.thumbwook a.rel-link')) {
    const href = a.getAttribute('href') || '';
    if (href.includes('cdni.pornpics.com') && href.includes('/1280/') && !out.includes(href)) out.push(abs(href));
  }
  return out;
}

// 详情页信息区：.gallery-info__item 按标题分组（Models 是页面明确署名，作 authors）
function parseInfo(doc) {
  const groups = [];
  let authors = [];
  for (const item of doc.querySelectorAll('.gallery-info__item')) {
    const labelEl = item.querySelector('.gallery-info__title');
    const label = ((labelEl ? Park.html.text(labelEl) : '') || '').trim().replace(/:$/, '');
    if (!label) continue;
    const values = [];
    for (const a of item.querySelectorAll('a')) {
      const span = a.querySelector('span');
      const v = ((span ? Park.html.text(span) : Park.html.text(a)) || '').trim();
      if (v && !values.includes(v)) values.push(v);
    }
    if (!values.length) continue;
    const tags = values.map((name) => ({ name, keyword: name }));
    if (label === 'Models') {
      authors = values;
      groups.push({ namespace: 'artist', label: '模特', tags });
    } else if (label === 'Categories') {
      groups.push({ namespace: 'category', label: '分类', tags });
    } else if (label === 'Tags') {
      groups.push({ namespace: 'tag', label: '标签', tags });
    } else if (label === 'Channel') {
      groups.push({ namespace: 'channel', label: '频道', tags });
    }
  }
  return { groups, authors };
}

Park.register({
  key: 'pornpics',
  name: 'PornPics',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'gallery',
  color: '#F16E24',
  description: '国际写真图集，支持热门、最新、评分榜、搜索与整套原图阅读',
  homepage: BASE,
  domains: ['pornpics.com'],
  linkPatterns: ['pornpics\\.com(/galleries/[^\\s?#]+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'popular',
  feeds: [
    { key: 'popular', label: '热门' },
    { key: 'recent', label: '最新' },
    { key: 'rating', label: '评分榜' },
    { key: 'likes', label: '最多点赞' },
    {
      key: 'category', label: '分类',
      options: [{
        key: 'category', label: '分类', type: 'select', default: 'milf',
        values: CATEGORIES.map(([value, label]) => ({ value, label })),
      }],
    },
  ],
  searchHint: '搜索作品、模特或关键词',

  _sortMeta: {},

  // ---------- 基础请求（带年龄墙重试） ----------
  async getText(url) {
    for (let i = 0; i < 3; i++) {
      const body = await this.http.text(url);
      if (!body.includes('Age Verification Required')) return body;
    }
    throw Park.error('CONFIRM_REQUIRED', '站点连续返回年龄验证页面，请稍后重试', { url });
  },

  async getDoc(url) {
    return Park.html.parse(await this.getText(url));
  },

  async getJson(url) {
    const body = await this.getText(url);
    let data;
    try { data = JSON.parse(body); } catch (_) { throw Park.error('PARSE', '图集列表解析失败'); }
    if (!Array.isArray(data)) throw Park.error('PARSE', '图集列表解析失败');
    return data;
  },

  // ---------- 列表 ----------
  // 分类页：/slug/ ，第 1 页 SSR，之后走同路径 offset/limit JSON
  async loadCategory(slug, page) {
    if (page <= 1) {
      const doc = await this.getDoc(`${BASE}/${slug}/`);
      const items = parseHtmlList(doc);
      return { items, page, hasNext: items.length >= PAGE_SIZE };
    }
    const offset = (page - 1) * PAGE_SIZE;
    const items = jsonToItems(await this.getJson(`${BASE}/${slug}/?offset=${offset}&limit=${PAGE_SIZE}`));
    return { items, page, hasNext: items.length >= PAGE_SIZE };
  },

  // 排序页：/popular/ /recent/ /rating/ /likes/ ，第 1 页 SSR，
  // 之后走 /popular/api/galleries/list/（category_id、period 从页面全局变量读）
  async loadSort(path, page) {
    if (page <= 1) {
      const body = await this.getText(BASE + path);
      this.rememberSortMeta(path, body);
      const items = parseHtmlList(Park.html.parse(body));
      return { items, page, hasNext: items.length >= PAGE_SIZE };
    }
    let meta = this._sortMeta[path];
    if (!meta) {
      this.rememberSortMeta(path, await this.getText(BASE + path));
      meta = this._sortMeta[path];
    }
    if (!meta) throw Park.error('PARSE', '图集列表解析失败');
    const offset = (page - 1) * PAGE_SIZE;
    const url = `${BASE}/popular/api/galleries/list/?offset=${offset}&limit=${PAGE_SIZE}&lang=en&category_id=${meta.cid}&period=${meta.per}&orientation=0`;
    const items = jsonToItems(await this.getJson(url));
    return { items, page, hasNext: items.length >= PAGE_SIZE };
  },

  rememberSortMeta(path, body) {
    const cid = /P_CID\s*=\s*"(\d+)"/.exec(body);
    const per = /PP_PERIOD\s*=\s*"(\d+)"/.exec(body);
    if (cid) this._sortMeta[path] = { cid: cid[1], per: per ? per[1] : '0' };
  },

  async feed(key, { page, options } = {}) {
    const p = Math.max(1, Math.floor(Number(page) || 1));
    if (key === 'category') {
      const slug = String((options && options.category) || 'milf');
      if (!CATEGORIES.some(([s]) => s === slug)) throw Park.error('CONFIG', '分类参数无效');
      return this.loadCategory(slug, p);
    }
    const path = SORT_PATHS[key];
    if (!path) throw Park.error('CONFIG', '未知列表');
    return this.loadSort(path, p);
  },

  // ---------- 搜索：/search/srch.php?q= ，全部页都是 offset/limit JSON ----------
  async search({ keyword, page } = {}) {
    const q = String(keyword || '').trim();
    const p = Math.max(1, Math.floor(Number(page) || 1));
    if (!q) return { items: [], page: p, hasNext: false };
    const offset = (p - 1) * PAGE_SIZE;
    const url = `${BASE}/search/srch.php?q=${encodeURIComponent(q)}&offset=${offset}&limit=${PAGE_SIZE}`;
    const items = jsonToItems(await this.getJson(url));
    return { items, page: p, hasNext: items.length >= PAGE_SIZE };
  },

  // ---------- 详情与阅读 ----------
  // 取图集页：广告版/缩水版页面真图不满图位时重取（最多 3 次），保留真图最多的一份
  async getGalleryDoc(url) {
    let best = null;
    for (let i = 0; i < 3; i++) {
      const doc = await this.getDoc(url);
      const images = galleryImages(doc);
      const slots = doc.querySelectorAll('#tiles li.thumbwook a.rel-link').length;
      if (!best || images.length > best.images.length) best = { doc, images };
      if (images.length && images.length >= slots) break;
    }
    return best;
  },

  async detail(id) {
    const url = BASE + galleryPath(id);
    const { doc, images } = await this.getGalleryDoc(url);
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim() || slugTitle(id);
    // 封面取第一张 /460/ 缩略图，跳过 /av/ 广告占位图
    let cover = '';
    for (const img of doc.querySelectorAll('#tiles li.thumbwook img')) {
      const u = img.getAttribute('data-src') || img.getAttribute('src') || '';
      if (u.includes('/460/')) { cover = u; break; }
      if (!cover && u && !u.includes('1px.png') && !u.includes('/av/')) cover = u;
    }
    const desc = doc.querySelector('meta[name="description"]');
    const { groups, authors } = parseInfo(doc);
    const count = images.length;
    return {
      id: galleryPath(id),
      title,
      cover: abs(cover),
      url,
      authors,
      tags: groups,
      pages: count || undefined,
      description: ((desc ? desc.getAttribute('content') : '') || '').trim() || `共 ${count} 张图片（原图）。`,
      chapters: null,
      singleChapterId: 'gallery',
    };
  },

  async chapter(id, chapterId) {
    const url = BASE + galleryPath(id);
    const { images } = await this.getGalleryDoc(url);
    if (!images.length) throw Park.error('PARSE', '未解析到图集图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
  },
});
