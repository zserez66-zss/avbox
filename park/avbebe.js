// Avbebe (avbebe.com) 的 HentaiPark 站点插件。
// 站点形态：WordPress + jNews 主题的成人视频站（H 动画、3D 动画、AI 短剧、华语 AV 等）。
// 列表：article.jeg_post 卡片，链接 /archives/<数字 id>，每页 36 条；
// 最新流 /page/N?post_type=post，分类 /archives/category/<分类>/page/N，
// 站内搜索 /?s=<关键词>（分页 /page/N?s=<关键词>），均为站点自有链接形态。
// 详情页有两种播放器：
//  1) FV Flowplayer：<div class="flowplayer" data-item="{...}"> 里是 HTML 转义的 JSON，
//     sources[0].src 就是 m3u8（52cute.com），另有 splash 封面与 duration 秒数。
//  2) 52cute 嵌入：正文里一个或多个 <iframe src="https://play.52cute.com/e/<code>">，
//     多个即多集（iframe 的 title 就是集名）；嵌入页 <source src> 是带签名的 m3u8，每次现取。
// 两种 m3u8 都校验 Referer: https://avbebe.com/，不带会 403，播放条目统一带上。
const BASE = 'https://avbebe.com';
const REFERER = { Referer: BASE + '/' };

// feed key -> 分类路径（与站点导航一致）；latest 为全站最新流。
const FEED_PATHS = {
  latest: null,
  new: 'archives/category/new',
  hanime: 'archives/category/h動畫影片',
  anime3d: 'archives/category/3d動畫',
  paomian: 'archives/category/泡麵番',
  manga: 'archives/category/成人h漫畫',
  hdsub: 'archives/category/高清中字',
  mosaic: 'archives/category/馬賽克破解',
  amateur: 'archives/category/高清素人',
  juemei: 'archives/category/高清素人/絕美逸品',
  huayu: 'archives/category/華語av',
};

function validId(id) {
  const v = String(id || '').trim();
  if (!/^\d+$/.test(v)) throw Park.error('NOT_FOUND', '作品编号无效');
  return v;
}

function fmtDur(sec) {
  const s = parseInt(sec, 10);
  if (!s || s <= 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(r).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

// 列表页通用解析：article.jeg_post 卡片（与 TVBox 源相同的取法）。
function parseList(doc) {
  const items = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('article.jeg_post')) {
    let id = '';
    for (const a of el.querySelectorAll('a[href]')) {
      const m = /\/archives\/(\d+)\/?(?:[?#]|$)/.exec(a.getAttribute('href') || '');
      if (m) { id = m[1]; break; }
    }
    if (!id || seen.has(id)) continue;
    const titleEl = el.querySelector('h3.jeg_post_title a');
    const img = el.querySelector('img');
    const title = ((titleEl ? Park.html.text(titleEl) : '') || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!title) continue;
    seen.add(id);
    let cover = img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '';
    if (cover.startsWith('data:')) cover = '';
    const dateEl = el.querySelector('.jeg_meta_date');
    const authorEl = el.querySelector('.jeg_meta_author a');
    const author = authorEl ? Park.html.text(authorEl).trim() : '';
    const item = { id, title, cover, coverAspect: 1.4 };
    const date = dateEl ? Park.html.text(dateEl).trim() : '';
    if (date) item.subtitle = date;
    if (author) item.authors = [author];
    items.push(item);
  }
  return items;
}

// 分页：优先 "Page X of Y" 文案，其次分页链接里的最大页码。
function pageInfo(html, doc, page) {
  let total = page;
  const m = /Page\s+\d+\s+of\s+(\d+)/.exec(html || '');
  if (m) total = Math.max(total, parseInt(m[1], 10));
  for (const a of doc.querySelectorAll('a[href]')) {
    const mm = /\/page\/(\d+)(?:[/?#]|$)/.exec(a.getAttribute('href') || '');
    if (mm) total = Math.max(total, parseInt(mm[1], 10));
  }
  return { totalPages: total, hasNext: page < total };
}

// Flowplayer 的 data-item：DOM 取到的属性值已解转义，直接 JSON.parse；失败再做一次替换兜底。
function playerItem(doc) {
  const el = doc.querySelector('.flowplayer[data-item]') || doc.querySelector('[id^="wpfp_"][data-item]');
  if (!el) return null;
  const raw = el.getAttribute('data-item') || '';
  try { return JSON.parse(raw); } catch (_) {}
  try { return JSON.parse(raw.replace(/\\\//g, '/')); } catch (_) { return null; }
}

// 52cute 嵌入集：只收 play.52cute.com/e/<code>，广告 iframe 不在此列。
function embeds(doc) {
  const out = [];
  for (const f of doc.querySelectorAll('iframe[src]')) {
    const src = f.getAttribute('src') || '';
    const m = /^https:\/\/play\.52cute\.com\/e\/([A-Za-z0-9]+)/.exec(src);
    if (m && !out.some((e) => e.code === m[1])) {
      out.push({ code: m[1], title: (f.getAttribute('title') || '').trim() });
    }
  }
  return out;
}

function meta(doc, prop) {
  const el = doc.querySelector(`meta[property="${prop}"]`);
  return el ? (el.getAttribute('content') || '').trim() : '';
}

Park.register({
  key: 'avbebe',
  name: 'Avbebe',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'adult',
  homepage: BASE,
  domains: ['avbebe.com'],
  linkPatterns: ['avbebe\\.com/archives/(\\d+)'],
  idPattern: '^(\\d+)$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'browser', scope: 'session', origin: BASE },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'new', label: '新番' },
    { key: 'hanime', label: '动画卡通' },
    { key: 'anime3d', label: '3D动画' },
    { key: 'paomian', label: '泡面番' },
    { key: 'manga', label: '综合漫画' },
    { key: 'hdsub', label: '高清中字' },
    { key: 'mosaic', label: '马赛克破解' },
    { key: 'amateur', label: '高清素人' },
    { key: 'juemei', label: '绝美逸品' },
    { key: 'huayu', label: '华语AV' },
  ],
  searchHint: '搜索作品名',

  async feed(key, { page }) {
    if (!(key in FEED_PATHS)) throw Park.error('CONFIG', '未知列表');
    const path = FEED_PATHS[key];
    let url;
    if (!path) {
      url = page <= 1 ? `${BASE}/?post_type=post` : `${BASE}/page/${page}?post_type=post`;
    } else {
      url = page <= 1 ? `${BASE}/${encodePath(path)}` : `${BASE}/${encodePath(path)}/page/${page}`;
    }
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    return { items: parseList(doc), page, ...pageInfo(html, doc, page) };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, totalPages: 1, hasNext: false };
    const url = page <= 1
      ? `${BASE}/?s=${encodeURIComponent(kw)}`
      : `${BASE}/page/${page}?s=${encodeURIComponent(kw)}`;
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    return { items: parseList(doc), page, ...pageInfo(html, doc, page) };
  },

  async detail(id) {
    id = validId(id);
    const url = `${BASE}/archives/${id}`;
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    const item = playerItem(doc);
    const title = (Park.html.text(doc.querySelector('h1')) || meta(doc, 'og:title') || (item && item.fv_title) || '').trim();
    if (!title) throw Park.error('NOT_FOUND', '影片不存在');
    const cover = (item && item.splash) || meta(doc, 'og:image') || '';
    const authorEl = doc.querySelector('.jeg_meta_author a');
    const author = authorEl ? Park.html.text(authorEl).trim() : '';
    const cats = [...doc.querySelectorAll('.jeg_meta_category a')].map((a) => Park.html.text(a).trim()).filter(Boolean);
    const tags = [...doc.querySelectorAll('.jeg_post_tags a')].map((a) => Park.html.text(a).trim()).filter(Boolean);
    const eps = embeds(doc);
    const out = {
      id,
      title,
      cover,
      coverAspect: 16 / 9,
      url,
      description: meta(doc, 'og:description'),
      chapters: eps.length > 1
        ? eps.map((e, i) => ({ id: e.code, title: e.title || `第${i + 1}集` }))
        : null,
    };
    if (eps.length === 1) out.singleChapterId = eps[0].code;
    const dur = fmtDur(item && item.duration);
    if (dur) out.duration = dur;
    if (author) out.authors = [author];
    const tagGroups = [];
    if (cats.length) tagGroups.push({ namespace: 'category', label: '分类', tags: cats.map((name) => ({ name, keyword: name })) });
    if (tags.length) tagGroups.push({ namespace: 'tag', label: '标签', tags: tags.map((name) => ({ name, keyword: name })) });
    if (tagGroups.length) out.tags = tagGroups;
    return out;
  },

  async videos(id, episodeId = '_') {
    id = validId(id);
    const url = `${BASE}/archives/${id}`;
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    // 指定了嵌入集：现取嵌入页里的签名 m3u8。
    if (episodeId && episodeId !== '_') {
      if (!/^[A-Za-z0-9]+$/.test(String(episodeId))) throw Park.error('NOT_FOUND', '分集编号无效');
      const m3u8 = await this.embedM3u8(`https://play.52cute.com/e/${episodeId}`);
      if (m3u8) return [{ url: m3u8, format: 'hls', label: '原画', headers: REFERER }];
      throw Park.error('UNSUPPORTED', '未解析到可播放的视频地址');
    }
    // Flowplayer：sources 直接就是 m3u8（可能多条线路）。
    const item = playerItem(doc);
    const sources = item && Array.isArray(item.sources)
      ? item.sources.filter((s) => s && typeof s.src === 'string' && s.src)
      : [];
    if (sources.length) {
      return sources.map((s, i) => {
        const q = /-(\d{3,4})(?:[/?#]|$)/.exec(s.src);
        return {
          url: s.src,
          format: 'hls',
          label: q ? `${q[1]}P` : (sources.length > 1 ? `线路${i + 1}` : '正片'),
          ...(q ? { quality: parseInt(q[1], 10) } : {}),
          headers: REFERER,
          ...(i === 0 ? { preferred: true } : {}),
        };
      });
    }
    // 嵌入式单集：取第一个嵌入的 m3u8。
    const eps = embeds(doc);
    if (eps.length) {
      const m3u8 = await this.embedM3u8(`https://play.52cute.com/e/${eps[0].code}`);
      if (m3u8) return [{ url: m3u8, format: 'hls', label: '原画', headers: REFERER }];
    }
    throw Park.error('UNSUPPORTED', '未解析到可播放的视频地址');
  },

  // 嵌入页 <source src="...index.m3u8">，签名地址有时效，每次播放现取。
  async embedM3u8(embedUrl) {
    const html = await this.http.text(embedUrl, { headers: REFERER });
    const m = /(https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)/.exec(html || '');
    return m ? m[1] : '';
  },
});
