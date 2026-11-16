// 鸟鸟韩漫 (nnhanman.xyz) 的 HentaiPark 站点插件。
// 站点形态：多章韩漫。列表 /comics/<分类>/ob/time/st/all，分页 /page/N；
// 热门为同路径 ob/hits。卡片 a.ImgA，封面在内嵌 img（thumb/new.niaopic.com）。
// 分类段直接是中文名，取自站点 /comics 页的真实筛选栏（Venera 源已实测）。
// 搜索 /catalog.php?key=<kw>，只有一页结果，不分页。
// 详情：章节在 #mh-chapter-list-ol-0，站点是倒序（最新在前），本插件反转为阅读顺序；
// 作者是 .sub_r 里第一个不含链接的 p.txtItme（页面明确署名，不从标题猜）。
// 阅读：章节页 img[data-src] 直出（img.nnpic.xyz），只收含 /upload 的图片。
const BASE = 'https://nnhanman.xyz';

// 主要分类：key -> 站点分类段（中文名，与 Venera 源分类表一致，挑主要的）
const CATS = {
  zhengmei: '正妹',
  lianai: '恋爱',
  chuban: '出版漫画',
  langman: '浪漫',
  xiaoyuan: '校園',
  danmei: '耽美',
  riman: '日漫',
  c3d: '3D',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function toPath(u) {
  if (!u) return '';
  let s = String(u).trim().replace(/^https?:\/\/[^/]+/i, '');
  if (!s.startsWith('/')) s = '/' + s;
  return s;
}

// 作品路径 /comic/<slug>.html（章节路径是 /comic/<slug>/chapter-<id>.html，不在此列）
function comicPath(href) {
  const p = toPath(href || '');
  return /^\/comic\/[^/]+\.html$/.test(p) ? p : '';
}

function chapterPath(href) {
  const p = toPath(href || '');
  return p.includes('/chapter-') ? p : '';
}

function listUrl(param, ob, page) {
  const seg = encodeURIComponent(param || 'all');
  let url = `${BASE}/comics/${seg}/ob/${ob}/st/all`;
  if (page > 1) url += `/page/${page}`;
  return url;
}

// 列表页通用解析：a.ImgA 卡片，去重，副标题取同 li 的 .info（更新日期）
function parseList(doc) {
  const items = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a.ImgA')) {
    const id = comicPath(a.getAttribute('href') || '');
    if (!id || seen.has(id)) continue;
    const img = a.querySelector('img');
    const title = ((a.getAttribute('title') || '') || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!title) continue;
    seen.add(id);
    let sub = '';
    try {
      const li = a.parentElement || a.parentNode;
      const info = li ? li.querySelector('.info') : null;
      sub = (info ? Park.html.text(info) : '').trim().replace(/\s+/g, ' ');
    } catch (e) { /* 忽略 */ }
    const item = {
      id,
      title,
      cover: abs(img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : ''),
    };
    if (sub) item.subtitle = sub;
    items.push(item);
  }
  return items;
}

function parseMaxPage(doc, page) {
  let max = null;
  for (const a of doc.querySelectorAll('a')) {
    const m = /\/page\/(\d+)/.exec(a.getAttribute('href') || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n)) max = max === null ? n : Math.max(max, n);
    }
  }
  return max === null ? null : Math.max(page, max);
}

Park.register({
  key: 'nnhanman',
  name: '鸟鸟韩漫',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'doujin',
  homepage: BASE,
  domains: ['nnhanman.xyz'],
  linkPatterns: ['nnhanman\\.xyz(/comic/[^\\s?#]+\\.html)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'popular',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'popular', label: '热门' },
    ...Object.entries(CATS).map(([k, label]) => ({ key: 'cat_' + k, label })),
  ],

  async feed(key, { page }) {
    let param = 'all';
    let ob = 'time';
    if (key === 'latest') {
      param = 'all'; ob = 'time';
    } else if (key === 'popular') {
      param = 'all'; ob = 'hits';
    } else if (key.startsWith('cat_')) {
      const cat = CATS[key.slice(4)];
      if (!cat) throw Park.error('CONFIG', '未知分类');
      param = cat; ob = 'time';
    } else {
      throw Park.error('CONFIG', '未知栏目');
    }
    const doc = Park.html.parse(await this.http.text(listUrl(param, ob, page)));
    const items = parseList(doc);
    const maxPage = parseMaxPage(doc, page);
    return {
      items,
      page,
      totalPages: maxPage || undefined,
      hasNext: maxPage ? page < maxPage : items.length > 0,
    };
  },

  async search({ keyword, page }) {
    // 站点搜索只有一页结果
    if (page > 1) return { items: [], page, hasNext: false };
    const doc = Park.html.parse(await this.http.text(`${BASE}/catalog.php?key=${encodeURIComponent(keyword)}`));
    return { items: parseList(doc), page, hasNext: false };
  },

  async detail(id) {
    const url = /^https?:\/\//.test(id) ? id : abs(id);
    const doc = Park.html.parse(await this.http.text(url));
    const h1El = doc.querySelector('.sub_r h1') || doc.querySelector('h1');
    const title = (h1El ? Park.html.text(h1El) : '').trim().replace(/^《|》$/g, '');
    if (!title) throw Park.error('PARSE', '未解析到作品标题');
    // 作者：.sub_r 里第一个不含链接的 p.txtItme（页面明确署名）
    let author = '';
    for (const p of doc.querySelectorAll('.sub_r p.txtItme')) {
      if (!p.querySelector('a')) {
        author = (Park.html.text(p) || '').trim();
        break;
      }
    }
    const genres = [];
    for (const a of doc.querySelectorAll('.sub_r p.txtItme a')) {
      const t = (Park.html.text(a) || '').trim();
      if (t && !genres.includes(t)) genres.push(t);
    }
    const dateEl = doc.querySelector('.sub_r span.date');
    const status = (dateEl ? Park.html.text(dateEl) : '').trim().split(/\s+/)[0] || '';
    // 章节：站点倒序 -> 反转为阅读顺序，id 用章节路径（稳定）
    const eps = [];
    for (const a of doc.querySelectorAll('#mh-chapter-list-ol-0 li a, ul.Drama li a')) {
      const href = a.getAttribute('href') || '';
      if (!href.includes('/chapter-')) continue;
      const cid = chapterPath(href);
      if (!cid) continue;
      const span = a.querySelector('span');
      const t = ((span ? Park.html.text(span) : '') || Park.html.text(a) || '').trim();
      eps.push({ id: cid, title: t || cid });
    }
    eps.reverse();
    if (!eps.length) throw Park.error('PARSE', '未解析到章节列表');
    const coverImg = doc.querySelector('#Cover img');
    const descEl = doc.querySelector('p.txtDesc');
    const description = (descEl ? Park.html.text(descEl) : '').trim().replace(/^介绍\s*[:：]\s*/, '');
    const tags = [];
    if (genres.length) {
      tags.push({ namespace: '标签', label: '标签', tags: genres.map((name) => ({ name, keyword: name })) });
    }
    if (status) {
      tags.push({ namespace: '状态', label: '状态', tags: [{ name: status, keyword: status }] });
    }
    return {
      id: comicPath(url) || id,
      title,
      cover: abs(coverImg ? (coverImg.getAttribute('src') || coverImg.getAttribute('data-src') || '') : ''),
      url,
      authors: author ? [author] : [],
      description,
      tags,
      chapters: eps,
    };
  },

  async chapter(id, chapterId) {
    const target = chapterId && chapterId !== '_' ? chapterId : id;
    const url = /^https?:\/\//.test(target) ? target : abs(target);
    const doc = Park.html.parse(await this.http.text(url));
    const images = [];
    for (const img of doc.querySelectorAll('img[data-src]')) {
      const u = abs(img.getAttribute('data-src') || '');
      if (u.includes('/upload') && !images.includes(u)) images.push(u);
    }
    if (!images.length) throw Park.error('PARSE', '未解析到章节图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
  },
});
