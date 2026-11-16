// 漫小肆韓漫 (www.jjmhw2.top) 的 HentaiPark 站点插件。
// 站点形态：多章韩漫，一部作品 = 多话连载。
// 列表：/booklist/ 卡片 ul.manga-list-2 li，筛选参数 tag/area/end + page 分页
//       （end -1全部/0连载中/1已完结，area 1韩国/2日本/3台湾，标签来自 /tag 页的 22 个真实标签）。
// 搜索：/search?keyword=<kw>，结果是 ul.book-list 卡片（与列表页结构不同，单独解析），无分页。
// 详情：章节全在服务端 HTML 里（#detail-list-select，正序），
//       「展开全部章节」只是去掉 CSS 高度限制，没有 ajax 接口。
// 阅读：章节页 #cp_img img.lazy 的 data-original 直出（图在同系域名 jjmhw*.top 上）。
// 抓取逻辑翻译自已实测的 Venera 源 jjmhw2.js，未重新发明解析。
const BASE = 'https://www.jjmhw2.top';

const TAGS = [
  '青春', '性感', '长腿', '多人', '御姐', '巨乳', '新婚', '媳妇', '暧昧', '清纯',
  '调教', '少妇', '风骚', '同居', '淫乱', '好友', '女神', '诱惑', '偷情', '出轨',
  '正妹', '家教',
];

// 各 feed 对应的 /booklist/ 筛选参数（tag feed 走 options 单独处理）
const FEED_PARAMS = {
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

// 作品 ID：详情页路径 /book/<数字>
function bookPath(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return '/book/' + s;
  const m = s.match(/\/book\/\d+/);
  return m ? m[0] : '';
}

// 章节 ID：章节页路径 /chapter/<数字>（稳定，不用临时图片地址）
function chapterPath(v) {
  if (!v) return '';
  const m = String(v).match(/\/chapter\/\d+/);
  return m ? m[0] : '';
}

function listUrl(param, page) {
  let qs = '';
  if (param) {
    if (param.startsWith('tag=')) {
      qs = 'tag=' + encodeURIComponent(param.slice(4));
    } else {
      qs = param;
    }
  }
  return `${BASE}/booklist/?${qs ? qs + '&' : ''}page=${page}`;
}

// 分页器只有「下一页」链接：有更大的 page=N 就说明还有下一页
function parseHasNext(doc, page) {
  for (const a of doc.querySelectorAll('.pagination a')) {
    const m = (a.getAttribute('href') || '').match(/[?&]page=(\d+)/);
    if (m && parseInt(m[1], 10) > page) return true;
  }
  return false;
}

// 列表页卡片（/booklist/）：ul.manga-list-2 li
function parseList(doc) {
  const items = [];
  for (const e of doc.querySelectorAll('.manga-list-2 li')) {
    const a = e.querySelector('.manga-list-2-cover a') || e.querySelector('a');
    const img = e.querySelector('img');
    const titleEl = e.querySelector('.manga-list-2-title a');
    const id = bookPath(a ? a.getAttribute('href') : '');
    const title = (titleEl ? Park.html.text(titleEl) : '').trim();
    if (!id || !title || /广告|推广/.test(title)) continue;
    items.push({
      id,
      title,
      cover: abs(img ? (img.getAttribute('data-original') || img.getAttribute('src')) : ''),
      subtitle: (Park.html.text(e.querySelector('.manga-list-2-tip')) || '').trim(),
    });
  }
  return items;
}

// 搜索结果卡片（/search）：ul.book-list li，结构与列表页不同
function parseSearchList(doc) {
  const items = [];
  for (const e of doc.querySelectorAll('.book-list li')) {
    const a = e.querySelector('.book-list-cover a') || e.querySelector('a');
    const img = e.querySelector('img');
    const id = bookPath(a ? a.getAttribute('href') : '');
    const title = ((Park.html.text(e.querySelector('.book-list-info-title')) || '') || (a ? a.getAttribute('title') : '') || '').trim();
    if (!id || !title) continue;
    const item = {
      id,
      title,
      cover: abs(img ? (img.getAttribute('data-original') || img.getAttribute('src')) : ''),
      subtitle: (Park.html.text(e.querySelector('.book-list-info-bottom-item')) || '').trim(),
    };
    // 副标题是卡片上明确署名的「作者：xxx」，只按原文提取，不从标题猜
    const author = item.subtitle.replace(/^作者：/, '').trim();
    if (author && author !== item.subtitle) item.authors = [author];
    items.push(item);
  }
  return items;
}

Park.register({
  key: 'jjmhw2',
  name: '漫小肆韓漫',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'doujin',
  description: '韩漫多章连载：最新、连载中、已完结与地区、标签分类，可搜索',
  homepage: BASE,
  domains: ['jjmhw2.top'],
  linkPatterns: ['jjmhw2\\.top(/book/\\d+)'],
  idPattern: '^(\\d+)$',
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
      key: 'tag', label: '标签',
      options: [{
        key: 'tag', label: '标签', type: 'select', default: '巨乳',
        values: TAGS.map((t) => ({ value: t, label: t })),
      }],
    },
  ],
  searchHint: '搜索作品名',

  async feed(key, { page, options }) {
    let param;
    if (key === 'tag') {
      const tag = options && TAGS.includes(options.tag) ? options.tag : '巨乳';
      param = 'tag=' + tag;
    } else {
      param = FEED_PARAMS[key] || '';
    }
    const doc = Park.html.parse(await this.http.text(listUrl(param, page)));
    return { items: parseList(doc), page, hasNext: parseHasNext(doc, page) };
  },

  async search({ keyword, page }) {
    // 站点搜索无分页参数（Venera 源 maxPage=null）：第 2 页起返回空，避免重复
    if (page > 1) return { items: [], page, hasNext: false };
    const doc = Park.html.parse(await this.http.text(`${BASE}/search?keyword=${encodeURIComponent(keyword)}`));
    return { items: parseSearchList(doc), page, hasNext: false };
  },

  async detail(id) {
    const bp = bookPath(id);
    if (!bp) throw Park.error('NOT_FOUND', '作品不存在');
    const url = BASE + bp;
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('.detail-main-info-title')) || '').trim();
    if (!title) throw Park.error('PARSE', '未解析到作品标题');

    // 作者 / 地区 / 别名：详情页 .detail-main-info-author 明确署名，只按原文提取
    const authors = [];
    let region = '';
    let alias = '';
    for (const p of doc.querySelectorAll('.detail-main-info-author')) {
      const t = (Park.html.text(p) || '').trim();
      const a = p.querySelector('a');
      if (!a) continue;
      const name = (Park.html.text(a) || '').trim();
      if (!name) continue;
      if (t.startsWith('作者')) authors.push(name);
      else if (t.startsWith('地区')) region = name;
      else if (t.startsWith('别名')) alias = name;
    }
    const genre = [...doc.querySelectorAll('.detail-main-info-class a')]
      .map((a) => (Park.html.text(a) || '').trim()).filter(Boolean);
    const tagGroups = [];
    if (genre.length) tagGroups.push({ namespace: 'category', label: '分类', tags: genre.map((name) => ({ name, keyword: name })) });
    if (region) tagGroups.push({ namespace: 'region', label: '地区', tags: [{ name: region, keyword: region }] });
    if (alias) tagGroups.push({ namespace: 'alias', label: '别名', tags: [{ name: alias, keyword: alias }] });

    // 章节：服务端全量渲染，DOM 即阅读顺序（第1話在前），按章节路径去重保序
    const chapters = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll('#detail-list-select a')) {
      const href = a.getAttribute('href') || '';
      if (!href.includes('/chapter/')) continue;
      const cid = chapterPath(href);
      if (!cid || seen.has(cid)) continue;
      seen.add(cid);
      chapters.push({ id: cid, title: (a.getAttribute('title') || Park.html.text(a) || '').trim() });
    }
    if (!chapters.length) throw Park.error('PARSE', '未解析到章节列表');

    const coverImg = doc.querySelector('.detail-main-cover img') || doc.querySelector('.detail-main-bg');
    return {
      id: bp,
      title,
      cover: abs(coverImg ? (coverImg.getAttribute('data-original') || coverImg.getAttribute('src')) : ''),
      url,
      authors,
      description: (Park.html.text(doc.querySelector('.detail-desc')) || '').trim(),
      tags: tagGroups,
      chapters,
    };
  },

  async chapter(id, chapterId) {
    const cp = chapterPath(chapterId) || chapterPath(id);
    if (!cp) throw Park.error('NOT_FOUND', '章节不存在');
    const url = BASE + cp;
    const doc = Park.html.parse(await this.http.text(url));
    const images = [];
    for (const img of doc.querySelectorAll('#cp_img img')) {
      const u = abs(img.getAttribute('data-original') || img.getAttribute('src') || '');
      if (u && u.includes('/static/upload/book/') && !images.includes(u)) images.push(u);
    }
    if (!images.length) throw Park.error('PARSE', '未解析到章节图片');
    return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
  },
});
