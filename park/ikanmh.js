// 漫小肆韓漫 (ikanmh.xyz) 的 HentaiPark 站点插件。
// 站点形态：韩漫多话连载。列表 /booklist/?page=N，可带单个筛选参数：
//   end=-1 全部 / 0 连载中 / 1 已完结；area=-1 全部 / 1 韩国 / 2 日本 / 3 台湾；
//   tag=<题材>（题材表与 Venera 源一致，来自站点 /tag 页的真实分类）。
//   列表卡片 ul.manga-list-2 li；分页只有上一页/下一页按钮，有指向下一页的链接即 hasNext。
// 搜索 /search?keyword=（结果卡片是 ul.book-list li，与列表页不同；无分页，只取第 1 页）。
// 详情：.detail-main-* 结构，章节在 #detail-list-select 里正序全量渲染，
//   章节 id 用章节路径 /chapter/<数字>（稳定）；作者/别名/地区在三行同 class 的
//   .detail-main-info-author 里，按行首标签区分，只取页面明确署名。
// 阅读：#cp_img img.lazy 的 data-original，图片路径含 /upload/book/（图片域名会轮换，不按域名过滤）。
const BASE = 'https://ikanmh.xyz';

// 题材标签：与 Venera 源 category 的题材表一致（站点真实分类）。
const TAGS = [
  '青春', '性感', '长腿', '多人', '御姐', '巨乳', '新婚', '媳妇', '暧昧', '清纯',
  '调教', '少妇', '风骚', '同居', '淫乱', '好友', '女神', '诱惑', '偷情', '出轨',
  '正妹', '家教',
];

// 无筛选 / 状态 / 地区类 feed 的 booklist 参数（genre 单独走 tag 参数）。
const FEED_PARAM = {
  latest: '',
  ongoing: 'end=0',
  completed: 'end=1',
  korea: 'area=1',
  japan: 'area=2',
  taiwan: 'area=3',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function bookPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/book\/\d+/);
  return m ? m[0] : '';
}

function chapterPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/chapter\/\d+/);
  return m ? m[0] : '';
}

// 与 Venera 源 booklistUrl 同一口径：?page=N 后拼单个 key=value 参数。
function booklistUrl(param, page) {
  let url = `${BASE}/booklist/?page=${page}`;
  if (param) {
    const i = param.indexOf('=');
    url += `&${param.slice(0, i)}=${encodeURIComponent(param.slice(i + 1))}`;
  }
  return url;
}

// 列表页与搜索页共用解析（与 Venera 源 parseList 同一口径）：
// 先试列表卡片 ul.manga-list-2 li，无结果再试搜索卡片 ul.book-list li。
function parseList(doc) {
  const items = [];
  for (const el of doc.querySelectorAll('.manga-list-2 li')) {
    const a = el.querySelector('.manga-list-2-cover a') || el.querySelector('a');
    const img = el.querySelector('img');
    const titleEl = el.querySelector('.manga-list-2-title a') || el.querySelector('.manga-list-2-title');
    const id = bookPath(a ? a.getAttribute('href') : '');
    const title = ((titleEl ? Park.html.text(titleEl) : '') || (a ? a.getAttribute('title') : '') || '').trim();
    if (!id || !title) continue;
    const item = {
      id,
      title,
      cover: abs(img ? (img.getAttribute('data-original') || img.getAttribute('src')) : ''),
    };
    const tip = el.querySelector('.manga-list-2-tip');
    const subtitle = (tip ? Park.html.text(tip) : '').trim();
    if (subtitle) item.subtitle = subtitle;
    items.push(item);
  }
  if (items.length) return items;
  for (const el of doc.querySelectorAll('.book-list li')) {
    const a = el.querySelector('.book-list-cover a') || el.querySelector('a');
    const img = el.querySelector('img');
    const titleEl = el.querySelector('.book-list-info-title');
    const id = bookPath(a ? a.getAttribute('href') : '');
    const title = ((titleEl ? Park.html.text(titleEl) : '') || (a ? a.getAttribute('title') : '') || '').trim();
    if (!id || !title) continue;
    const item = {
      id,
      title,
      cover: abs(img ? (img.getAttribute('data-original') || img.getAttribute('src')) : ''),
    };
    const desc = el.querySelector('.book-list-info-desc');
    const subtitle = (desc ? Park.html.text(desc) : '').trim();
    if (subtitle) item.subtitle = subtitle;
    items.push(item);
  }
  return items;
}

// 站点分页只有「下一页」按钮：有指向 page+1 的分页链接就还能翻（与 Venera 源 parseMaxPage 同一口径）。
function hasNextPage(doc, page) {
  for (const a of doc.querySelectorAll('.pagination a')) {
    const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m && parseInt(m[1], 10) === page + 1) return true;
  }
  return false;
}

Park.register({
  key: 'ikanmh',
  name: '漫小肆韓漫',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'doujin',
  homepage: BASE,
  domains: ['ikanmh.xyz'],
  linkPatterns: ['ikanmh\\.xyz(/book/\\d+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'ongoing', label: '连载中' },
    { key: 'completed', label: '已完结' },
    { key: 'korea', label: '韩国' },
    { key: 'japan', label: '日本' },
    { key: 'taiwan', label: '台湾' },
    {
      key: 'genre',
      label: '题材',
      options: [
        {
          key: 'tag',
          label: '题材',
          type: 'select',
          // 默认不用表首的「青春」：该题材全站只有 1 部作品（已实测），默认落到有整页数据的「性感」。
          default: '性感',
          values: TAGS.map((t) => ({ value: t, label: t })),
        },
      ],
    },
  ],

  async feed(key, { page, options }) {
    let param;
    if (key === 'genre') {
      const tag = (options && options.tag) || '性感';
      param = `tag=${tag}`;
    } else if (Object.prototype.hasOwnProperty.call(FEED_PARAM, key)) {
      param = FEED_PARAM[key];
    } else {
      throw Park.error('CONFIG', '未知漫画列表');
    }
    const doc = Park.html.parse(await this.http.text(booklistUrl(param, page)));
    return { items: parseList(doc), page, hasNext: hasNextPage(doc, page) };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    // 站点搜索无分页（Venera 源同样只取第 1 页），后续页直接返回空。
    if (page > 1) return { items: [], page, hasNext: false };
    const doc = Park.html.parse(await this.http.text(`${BASE}/search?keyword=${encodeURIComponent(kw)}`));
    return { items: parseList(doc), page: 1, hasNext: false };
  },

  async detail(id) {
    const url = String(id || '').startsWith('http') ? String(id) : abs(id);
    const doc = Park.html.parse(await this.http.text(url));
    const titleEl = doc.querySelector('.detail-main-info-title') || doc.querySelector('.normal-top-title');
    const title = (titleEl ? Park.html.text(titleEl) : '').trim();
    if (!title) throw Park.error('PARSE', '漫画详情解析失败');
    // .detail-main-info-author 三行同 class：别名 / 作者 / 地区，按行首标签区分，只取 <a> 明确署名。
    let author = '';
    let alias = '';
    for (const p of doc.querySelectorAll('.detail-main-info-author')) {
      const label = (Park.html.text(p) || '').split(/[:：]/)[0].trim();
      const a = p.querySelector('a');
      const val = (a ? Park.html.text(a) : '').trim();
      if (!val) continue;
      if (label.includes('作者')) author = val;
      else if (label.includes('别名')) alias = val;
    }
    const genres = [...doc.querySelectorAll('.detail-main-info-class a')]
      .map((a) => (Park.html.text(a) || '').trim())
      .filter(Boolean);
    const tags = [];
    if (author) tags.push({ namespace: '作者', label: '作者', tags: [{ name: author, keyword: author }] });
    if (alias && alias !== title) tags.push({ namespace: '别名', label: '别名', tags: [{ name: alias, keyword: alias }] });
    if (genres.length) tags.push({ namespace: '题材', label: '题材', tags: genres.map((g) => ({ name: g, keyword: g })) });
    // 章节：ul#detail-list-select，页面默认正序（第 1 话在前），全量渲染；按章节路径去重保稳定 id。
    const seen = new Set();
    const chapters = [];
    for (const a of doc.querySelectorAll('#detail-list-select a')) {
      const href = a.getAttribute('href') || '';
      if (!href.includes('/chapter/')) continue;
      const cid = chapterPath(href);
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      chapters.push({ id: cid, title: (Park.html.text(a) || '').trim() || (a.getAttribute('title') || '').trim() || cid });
    }
    if (!chapters.length) throw Park.error('PARSE', '未解析到章节列表');
    const coverImg = doc.querySelector('.detail-main-cover img');
    const descEl = doc.querySelector('.detail-desc');
    return {
      id: bookPath(url) || id,
      title,
      cover: abs(coverImg ? (coverImg.getAttribute('data-original') || coverImg.getAttribute('src')) : ''),
      url,
      authors: author ? [author] : [],
      description: (descEl ? Park.html.text(descEl) : '').trim(),
      tags,
      chapters,
    };
  },

  async chapter(id, chapterId) {
    const epUrl = String(chapterId || '').startsWith('http') ? String(chapterId) : abs(chapterId);
    if (!epUrl) throw Park.error('NOT_FOUND', '章节编号无效');
    const doc = Park.html.parse(await this.http.text(epUrl));
    // 与 Venera 源 loadEp 同一口径：#cp_img img 的 data-original/src，只收 /upload/book/ 路径。
    let images = [...doc.querySelectorAll('#cp_img img')]
      .map((img) => abs(img.getAttribute('data-original') || img.getAttribute('src')))
      .filter((u) => u && /\/upload\/book\//.test(u));
    if (!images.length) {
      images = [...doc.querySelectorAll('img')]
        .map((img) => abs(img.getAttribute('data-original') || ''))
        .filter((u) => /\/upload\/book\//.test(u));
    }
    if (!images.length) throw Park.error('PARSE', '未解析到章节图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: epUrl } })) };
  },
});
