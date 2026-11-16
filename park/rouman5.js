// 肉漫屋 (rouman5.com) 的 HentaiPark 站点插件。
// 站点形态：多话韩漫站，一部作品 = 多个章节（話），detail 返回章节列表，
// chapter(id, chapterId) 返回该话全部图片。
// 列表：/books（全部）/ ?continued=true（連載中）/ ?continued=false（已完結），
// 分页参数 page 是 0 起：插件第 N 页 = 站点 page=N-1。卡片 a.site-comic，
// 封面在 CDN（kelv47.xyz / towm85.xyz）上。
// 搜索：/search?term=<关键词>（服务端渲染，单页结果）。
// 详情：章节在 .site-chapters a.site-chapter-link，正序 /books/<id>/<话序 0 起>；
// 作者 / 地区 / 状态 / 标签在详情页 SSR 数据流里（author:"…" 等字段，只取页面明确署名）。
// 阅读：章节页 SSR 数据流里带 imagePaths 数组（towm85.xyz 分片 CDN），正则提取。
const BASE = 'https://rouman5.com';

// feed key -> /books 的筛选参数（与 Venera 源分类一致）
const FEED_PARAMS = {
  all: '',
  ongoing: 'continued=true',
  completed: 'continued=false',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 作品路径 /books/<id>（入参可以是路径或完整 URL）
function workPath(u) {
  if (!u) return '';
  const m = String(u).match(/\/books\/[^\s?#/]+/);
  return m ? m[0] : '';
}

// 章节路径 /books/<id>/<话序>（入参可以是路径或完整 URL）
function chapterPath(u) {
  if (!u) return '';
  const m = String(u).match(/\/books\/[^\s?#]+/);
  return m ? m[0] : '';
}

function booksUrl(param, page) {
  const p = page - 1; // 站点分页 0 起
  const qs = [];
  if (param) qs.push(param);
  if (p > 0) qs.push(`page=${p}`);
  return BASE + '/books' + (qs.length ? '?' + qs.join('&') : '');
}

// 列表页通用解析：a.site-comic 卡片（与 Venera 源同一套规则）
function parseList(doc) {
  const items = [];
  for (const el of doc.querySelectorAll('a.site-comic')) {
    const id = workPath(el.getAttribute('href') || '');
    if (!id) continue;
    const img = el.querySelector('.site-comic-cover img') || el.querySelector('img');
    const h3 = el.querySelector('h3');
    const meta = el.querySelector('.site-comic-meta');
    const title = ((h3 ? h3.getAttribute('title') : '') || (h3 ? Park.html.text(h3) : '') || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!title) continue;
    const item = {
      id,
      title,
      cover: abs(img ? (img.getAttribute('src') || img.getAttribute('data-src')) : ''),
    };
    const subtitle = (meta ? Park.html.text(meta) : '').trim().replace(/\s+/g, ' ');
    if (subtitle) item.subtitle = subtitle;
    items.push(item);
  }
  return items;
}

// 分页：链接里的 page 是 0 起，换算成插件页数取最大值；没有分页链接返回 null
function parseMaxPage(doc, page) {
  let max = null;
  for (const a of doc.querySelectorAll('a')) {
    const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) {
      const n = parseInt(m[1], 10) + 1;
      if (!Number.isNaN(n)) max = max === null ? n : Math.max(max, n);
    }
  }
  return max === null ? null : Math.max(page, max);
}

Park.register({
  key: 'rouman5',
  name: '肉漫屋',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'doujin',
  homepage: BASE,
  domains: ['rouman5.com'],
  linkPatterns: ['rouman5\\.com(/books/[^\\s?#/]+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'all',
  feeds: [
    { key: 'all', label: '全部漫画' },
    { key: 'ongoing', label: '连载中' },
    { key: 'completed', label: '已完结' },
  ],

  async feed(key, { page }) {
    const param = FEED_PARAMS[key] || '';
    const doc = Park.html.parse(await this.http.text(booksUrl(param, page)));
    const items = parseList(doc);
    const maxPage = parseMaxPage(doc, page);
    return { items, page, totalPages: maxPage === null ? page : maxPage, hasNext: maxPage !== null && page < maxPage };
  },

  async search({ keyword, page }) {
    // 站点搜索是单页结果，第二页起直接结束
    if (page > 1) return { items: [], page, hasNext: false };
    const doc = Park.html.parse(await this.http.text(`${BASE}/search?term=${encodeURIComponent(keyword)}`));
    return { items: parseList(doc), page, hasNext: false };
  },

  async detail(id) {
    const path = workPath(id);
    if (!path) throw Park.error('NOT_FOUND', '作品不存在');
    const url = BASE + path;
    const body = await this.http.text(url);
    const doc = Park.html.parse(body);
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    if (!title) throw Park.error('PARSE', '未解析到作品标题');
    const og = doc.querySelector('meta[property="og:image"]');
    const coverImg = doc.querySelector('.site-book-cover img') || doc.querySelector('.site-comic-cover img');
    const desc = doc.querySelector('meta[name="description"]');
    // SSR 数据流里的明确署名（只取第一处，即本作自己的数据，不从标题猜）
    const author = (body.match(/author:"([^"]+)"/) || [])[1] || '';
    const region = (body.match(/region:"([^"]+)"/) || [])[1] || '';
    const cm = body.match(/continued:!([01])/);
    const status = cm ? (cm[1] === '0' ? '连载中' : '已完结') : '';
    let tagNames = [];
    const tagArr = (body.match(/tags:\$R\[\d+\]=(\[[^\]]*\])/) || [])[1];
    if (tagArr) {
      try {
        tagNames = JSON.parse(tagArr.replace(/\\"/g, '"')).filter((x) => typeof x === 'string' && x);
      } catch (e) { /* 标签解析失败就留空 */ }
    }
    const tagGroups = [];
    if (author) tagGroups.push({ namespace: 'artist', label: '作者', tags: [{ name: author, keyword: author }] });
    if (region) tagGroups.push({ namespace: 'region', label: '地區', tags: [{ name: region, keyword: region }] });
    if (status) tagGroups.push({ namespace: 'status', label: '狀態', tags: [{ name: status, keyword: status }] });
    if (tagNames.length) tagGroups.push({ namespace: 'tag', label: '標籤', tags: tagNames.map((t) => ({ name: t, keyword: t })) });
    // 章节列表：正序，id 用章节路径（稳定），同 Venera 源的 Map 去重
    const chapters = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll('.site-chapters a.site-chapter-link')) {
      const cid = chapterPath(a.getAttribute('href') || '');
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      const span = a.querySelector('span');
      const cTitle = ((span ? Park.html.text(span) : '') || Park.html.text(a) || '').trim();
      chapters.push({ id: cid, title: cTitle || cid });
    }
    if (!chapters.length) throw Park.error('PARSE', '未解析到章节列表');
    const out = {
      id: path,
      title,
      cover: abs((og ? og.getAttribute('content') : '') || (coverImg ? coverImg.getAttribute('src') : '') || ''),
      url,
      description: (desc ? desc.getAttribute('content') : '') || '',
      tags: tagGroups,
      chapters,
    };
    if (author) {
      out.authors = [author];
      out.authorSearch = { keyword: author };
    }
    return out;
  },

  async chapter(id, chapterId) {
    const path = chapterPath(chapterId) || chapterPath(id);
    if (!path) throw Park.error('NOT_FOUND', '章节不存在');
    const url = BASE + path;
    const body = await this.http.text(url);
    const m = body.match(/imagePaths:\$R\[\d+\]=(\[[^\]]*\])/);
    if (!m) throw Park.error('PARSE', '这一话没找到图片数据（站点结构可能变了）');
    let images;
    try {
      images = JSON.parse(m[1].replace(/\\\//g, '/'));
    } catch (e) {
      throw Park.error('PARSE', '这一话没找到图片数据（站点结构可能变了）');
    }
    images = images.filter((u) => typeof u === 'string' && /^https?:\/\//.test(u));
    if (!images.length) throw Park.error('PARSE', '这一话没找到图片数据（站点结构可能变了）');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
  },
});
