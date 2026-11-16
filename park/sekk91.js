// 91sekk (www.91sekk.com) 的 HentaiPark 站点插件。
// 站点形态：海洋CMS(seacms) 成人门户。视频分「在线视频」(/mov/HHMP4/，
// 约 496 页) 与「精彩电影」(/mov/xvodx/) 两栏，同构：20 卡/页，
// 分页 /index-<N>.html；卡片是 <a href="/mov/html/<id>.html" alt="标题">
// <img src="封面">，标题在 a / img 的 alt 里（h3 文字被截断，不能用），
// span.movie_date 是日期角标。页面本身是 UTF-8（原 py 源需强制纠正
// requests 的编码猜测；本插件走 Park.html.parse 按 UTF-8 解析，无此问题）。
// 播放链：详情页 play-list-box 里的播放页 /mov/player/<id>-<src>-<num>.html
// → 页面 <script src="/upload/playdata/<日期>/<id>/<id>.js">（日期目录逐片
// 不同，必须现取）→ js 里 mac_url=unescape('...%2Findex.m3u8')，
// 解码后就是 g1.lulugif.com 的 master m3u8，无需 Referer。
// 站内「套图精选」是图集类，与本站视频定位不符，不收录。
// 搜索：站内 /search.html 等入口全部 302 到 404 页，无可用搜索，故不声明 search。
const BASE = 'https://www.91sekk.com';

const FEEDS = {
  online: '/mov/HHMP4/',
  movies: '/mov/xvodx/',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function workPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/mov\/html\/\d+\.html/);
  return m ? m[0] : '';
}

// 列表页通用解析：带封面图的视频卡片（标题取 a / img 的 alt，h3 已截断不可用）
function parseCards(doc) {
  const items = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href*="/mov/html/"]')) {
    const id = workPath(a.getAttribute('href') || '');
    if (!id || seen.has(id)) continue;
    const img = a.querySelector('img');
    if (!img) continue;
    const title = ((a.getAttribute('alt') || '') || (img.getAttribute('alt') || '')).trim();
    if (!title) continue;
    seen.add(id);
    let cover = abs(img.getAttribute('src') || img.getAttribute('data-src') || '');
    if (cover.includes('no-image')) cover = '';
    const item = { id, title, cover, mediaKind: 'video' };
    const date = (Park.html.text(a.querySelector('.movie_date')) || '').trim();
    if (date) item.uploaded = date;
    items.push(item);
  }
  return items;
}

// 详情页播放源：每个 .play-list-box 是一个源，内含播放页锚点（集名取锚点文字）
function parseEpisodes(doc) {
  const episodes = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href*="/mov/player/"]')) {
    const href = a.getAttribute('href') || '';
    const m = /\/mov\/player\/[^\s?#]+\.html/.exec(href);
    if (!m || seen.has(m[0])) continue;
    seen.add(m[0]);
    episodes.push({ id: m[0], title: (Park.html.text(a) || '').trim() || `第${episodes.length + 1}集` });
  }
  return episodes;
}

Park.register({
  key: 'sekk91',
  name: '91sekk',
  version: '0.0.2',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'adult',
  homepage: BASE,
  domains: ['91sekk.com'],
  linkPatterns: ['91sekk\\.com(/mov/html/\\d+\\.html)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto' },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: 'online',
  feeds: [
    { key: 'online', label: '在线视频' },
    { key: 'movies', label: '精彩电影' },
  ],

  async feed(key, { page }) {
    const section = FEEDS[key];
    if (!section) throw Park.error('CONFIG', '未知视频列表');
    const url = page <= 1 ? BASE + section : `${BASE}${section}index-${page}.html`;
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    const items = parseCards(doc);
    const m = /当前\s*[:：]\s*\d+\s*\/\s*(\d+)\s*页/.exec(html);
    const totalPages = m ? parseInt(m[1], 10) : page;
    return { items, page, totalPages, hasNext: page < totalPages };
  },

  async detail(id) {
    const url = BASE + id;
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    if (!title) throw Park.error('NOT_FOUND', '影片不存在');
    const coverImg = doc.querySelector('.vcs img') || doc.querySelector('.vod_show img');
    const cover = abs(coverImg ? (coverImg.getAttribute('src') || '') : '');
    const episodes = parseEpisodes(doc);
    if (!episodes.length) throw Park.error('PARSE', '未解析到播放列表');
    const multi = episodes.length > 1;
    return {
      id,
      title,
      cover,
      url,
      mediaKind: 'video',
      chapters: multi ? episodes : null,
      singleChapterId: multi ? undefined : episodes[0].id,
    };
  },

  async videos(id, episodeId = '_') {
    let playerPath = episodeId;
    if (!playerPath || playerPath === '_' || !/^\/mov\/player\//.test(playerPath)) {
      const doc = Park.html.parse(await this.http.text(BASE + id));
      const episodes = parseEpisodes(doc);
      if (!episodes.length) throw Park.error('PARSE', '未解析到播放列表');
      playerPath = (episodes.find((e) => e.id === episodeId) || episodes[0]).id;
    }
    const playerUrl = BASE + playerPath;
    const playerHtml = await this.http.text(playerUrl);
    const jsMatch = /src=["'](\/upload\/playdata\/[^"']+\.js)["']/.exec(playerHtml);
    if (!jsMatch) throw Park.error('PARSE', '未解析到播放数据');
    const js = await this.http.text(BASE + jsMatch[1]);
    let raw = '';
    const mEsc = /mac_url\s*=\s*unescape\(\s*'([^']+)'\s*\)/.exec(js);
    if (mEsc) {
      try { raw = decodeURIComponent(mEsc[1]); } catch (_) { raw = mEsc[1]; }
    } else {
      const mPlain = /mac_url\s*=\s*'([^']+)'/.exec(js);
      if (mPlain) raw = mPlain[1];
    }
    const urls = raw.split('#').map((u) => u.trim()).filter(Boolean);
    if (!urls.length) throw Park.error('PARSE', '未解析到播放地址');
    // 播放页文件名尾号 -<num>.html 与 mac_url 中 # 分隔的集序对应
    let pick = 0;
    const mNum = /-(\d+)\.html(?:$|\?)/.exec(playerPath);
    if (mNum) pick = Math.min(Math.max(parseInt(mNum[1], 10) - 1, 0), urls.length - 1);
    const master = urls[pick];
    if (!/^https:\/\//.test(master)) throw Park.error('PARSE', '播放地址无效');
    return [{ url: master, format: 'hls', label: '原画' }];
  },
});
