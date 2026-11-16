// Hanman18 (hanman18.com) 的 HentaiPark 站点插件。
// 站点形态：韩漫多话连载。列表 /list-manga，路径分页 /list-manga/<N>，
// 排序 order_by=lastest（最新发布）/ views（最多观看）/ name（A-Z）；
// 站点侧栏的标签链接目前全部 302 跳回首页（站点自身死链），故不做标签分类。
// 搜索 /list-manga?search=<关键词>（按标题，无分页，只取第 1 页结果）。
// 作品 id 多数是数字，少数是拼音 slug（如 /manhwa/mimijiaohua），一律取完整路径段。
// 详情 /manhwa/<id>：章节 .chapter_box a.chapter_num 为倒序（最新在前），
// 本插件反转为阅读顺序，章节 id 用章节路径（稳定）。
// 阅读 /manhwa/<id>/<话序>：图片地址在页面内联 JS 的 slides_p_path 数组里，
// 每项是 Base64 编码的完整图片 URL，解码后即图片直链。
// 详情页 Author / Artist 栏是占位值 "Updating"，不是真实署名，故不填作者。
const BASE = 'https://hanman18.com';

const ORDER = { latest: 'lastest', views: 'views', name: 'name' };

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function workPath(href) {
  if (!href) return '';
  // 作品 id 不全是数字：部分作品是拼音 slug（如 /manhwa/mimijiaohua），取完整路径段。
  const m = String(href).match(/\/manhwa\/[^\s/?#]+/);
  return m ? m[0] : '';
}

function chapterPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/manhwa\/[^\s/?#]+\/\d+/);
  return m ? m[0] : '';
}

// slides_p_path 的每项是 Base64 编码的 UTF-8 图片 URL。
function b64Decode(s) {
  try {
    const bin = atob(String(s));
    if (typeof TextDecoder !== 'undefined') {
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder('utf-8').decode(bytes);
    }
    return decodeURIComponent(
      bin.split('').map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    );
  } catch (_) {
    return '';
  }
}

function listUrl(order, page, extra) {
  let url = BASE + '/list-manga';
  if (page > 1) url += `/${page}`;
  const qs = [];
  if (order) qs.push(`order_by=${order}`);
  if (extra) qs.push(extra);
  if (qs.length) url += '?' + qs.join('&');
  return url;
}

// 列表页通用解析：.story_item 卡片（与 Venera 源 parseList 同一口径）。
function parseList(doc) {
  const items = [];
  for (const el of doc.querySelectorAll('.story_item')) {
    const a = el.querySelector('.story_images a') || el.querySelector('.mg_name a');
    const img = el.querySelector('.story_images img') || el.querySelector('img');
    const nameA = el.querySelector('.mg_name a');
    const chap = el.querySelector('.mg_chapter');
    const id = workPath(a ? a.getAttribute('href') : '');
    const title = (
      (nameA ? Park.html.text(nameA) : '') ||
      (a ? a.getAttribute('title') : '') ||
      (img ? img.getAttribute('alt') : '') ||
      ''
    ).trim();
    if (!id || !title) continue;
    const item = {
      id,
      title,
      cover: abs(img ? (img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src')) : ''),
    };
    const subtitle = chap ? Park.html.text(chap) : '';
    if (subtitle) item.subtitle = subtitle;
    items.push(item);
  }
  return items;
}

function parseMaxPage(doc, page) {
  let max = null;
  for (const a of doc.querySelectorAll('a')) {
    const m = /\/list-manga\/(\d+)/.exec(a.getAttribute('href') || '');
    if (m) {
      const n = parseInt(m[1], 10);
      if (!Number.isNaN(n)) max = max === null ? n : Math.max(max, n);
    }
  }
  return max === null ? null : Math.max(page, max);
}

Park.register({
  key: 'hanman18',
  name: 'Hanman18',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'doujin',
  homepage: BASE,
  domains: ['hanman18.com'],
  linkPatterns: ['hanman18\\.com(/manhwa/[^\\s?#]+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新发布' },
    { key: 'views', label: '最多观看' },
    { key: 'name', label: 'A-Z' },
  ],

  async feed(key, { page }) {
    const order = ORDER[key];
    if (!order) throw Park.error('CONFIG', '未知漫画列表');
    const doc = Park.html.parse(await this.http.text(listUrl(order, page)));
    const items = parseList(doc);
    const maxPage = parseMaxPage(doc, page);
    return {
      items,
      page,
      totalPages: maxPage === null ? page : maxPage,
      hasNext: maxPage === null ? items.length > 0 : page < maxPage,
    };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    // 站点搜索无分页（Venera 源同样只取第 1 页），后续页直接返回空。
    if (page > 1) return { items: [], page, hasNext: false };
    const doc = Park.html.parse(
      await this.http.text(listUrl('', 1, `search=${encodeURIComponent(kw)}`))
    );
    return { items: parseList(doc), page: 1, hasNext: false };
  },

  async detail(id) {
    const url = String(id || '').startsWith('http') ? String(id) : abs(id);
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    if (!title) throw Park.error('PARSE', '漫画详情解析失败');
    const ogImg = doc.querySelector('meta[property="og:image"]');
    const ogDesc = doc.querySelector('meta[property="og:description"]');
    // 章节：站点按最新在前排列，反转为阅读顺序；按章节路径去重保稳定 id。
    const seen = new Set();
    const chapters = [];
    const links = [...doc.querySelectorAll('.chapter_box a.chapter_num')].reverse();
    for (const a of links) {
      const cid = chapterPath(a.getAttribute('href') || '');
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      chapters.push({ id: cid, title: (Park.html.text(a) || '').trim() || cid });
    }
    if (!chapters.length) throw Park.error('PARSE', '未解析到章节列表');
    return {
      id: workPath(url) || id,
      title,
      cover: abs(ogImg ? ogImg.getAttribute('content') : ''),
      url,
      description: (ogDesc ? ogDesc.getAttribute('content') : '') || '',
      chapters,
    };
  },

  async chapter(id, chapterId) {
    const epUrl = String(chapterId || '').startsWith('http') ? String(chapterId) : abs(chapterId);
    if (!epUrl) throw Park.error('NOT_FOUND', '章节编号无效');
    const body = await this.http.text(epUrl);
    const m = body.match(/slides_p_path\s*=\s*(\[[^\]]*\])/);
    if (!m) throw Park.error('PARSE', '这一话没找到图片数据（站点结构可能变了）');
    const items = m[1].match(/"([^"]+)"/g) || [];
    const images = items
      .map((s) => s.slice(1, -1))
      .map(b64Decode)
      .filter((u) => /^https?:\/\//.test(u));
    if (!images.length) throw Park.error('PARSE', '未解析到章节图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: epUrl } })) };
  },
});
