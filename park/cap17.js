// 17cap (17cap.cc，站名「91网址」) 的 HentaiPark 站点插件。
// 站点形态：综合成人视频站，播放为 HLS (m3u8)。
// 列表卡片：ul.video-items 里 a[href=/video/play/<id>-1-1.html] 带 img[data-src=封面][alt=标题]，
// 卡片内 .dur 是时长（短剧条目为 00:00:00 占位，不采用）。
// 最新列表是首页「最近更新」的更多页 /label/hot/by/time.html?page=N（24 条/页）；
// 分类页 /video/Categories/<分类id>.html?page=N（20 条/页），分类 id 与名称取自站内导航。
// 搜索是服务端搜索：/search/keyword/wd/<关键词>.html，翻页 /search/keyword/page/N/wd/<关键词>.html。
// 详情页 JSON-LD 的 contentUrl 即 m3u8（部分为协议相对地址，需补 https:）；
// 短剧类作品在详情页有「第N集」选集链接 /video/play/<id>-1-<集数>.html，每集一个 m3u8。
// m3u8 与分片无需 Referer 鉴权（TVBox 源实测）。
const BASE = 'https://17cap.cc';

// 分类 id 与名称全部取自站内真实导航（与 TVBox 源一致）
const CATEGORIES = [
  [1, '国产'], [2, '日韩'], [3, '欧美'], [4, '伦理'], [5, '动漫'], [6, '同性恋'],
  [9, '成人AI'], [16, '福利姬'], [18, '成人主播'], [19, '无码中字'], [20, 'JAV自拍'],
  [21, '中文字幕'], [22, 'JAV无码'], [23, 'AV解说'], [25, '欧美黑人'], [26, '留学生'],
  [27, '港台三级'], [28, '日韩三级'], [29, '欧美三级'], [30, '3D动漫'], [32, '男同'],
  [33, '女同百合'], [36, 'AI短剧'],
];

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function match(text, pattern) {
  const m = pattern.exec(text || '');
  return m ? (m[1] || '').trim() : '';
}

function cleanTitle(t) {
  return String(t || '').replace(/\s*[-_|]\s*91网址.*$/, '').replace(/_免费在线播放.*$/, '').trim();
}

// ISO 8601 时长 PT34M45S / PT1H2M3S → 秒
function isoDurationSeconds(s) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(s || '');
  if (!m) return 0;
  return (parseInt(m[1] || '0', 10) * 3600) + (parseInt(m[2] || '0', 10) * 60) + parseInt(m[3] || '0', 10);
}

function formatDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const mm = String(Math.floor(sec / 60) % 60).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${h}:${mm}:${ss}`;
}

// 列表页通用解析：带封面图的播放链接（同一作品出现两次链接，按数字 id 去重）
function parseList(doc) {
  const items = [];
  const seen = new Set();
  for (const a of doc.querySelectorAll('a[href*="/video/play/"]')) {
    const m = /\/video\/play\/(\d+)-/.exec(a.getAttribute('href') || '');
    if (!m || seen.has(m[1])) continue;
    const img = a.querySelector('img');
    if (!img) continue;
    const title = (img.getAttribute('alt') || '').trim();
    if (!title || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(title)) continue;
    if (/\[广告\]|推广|APP下载|立即下载/.test(title)) continue;
    seen.add(m[1]);
    let cover = abs(img.getAttribute('data-src') || img.getAttribute('src') || '');
    if (cover.includes('poster_loading')) cover = '';
    const item = { id: m[1], title, cover, coverAspect: 16 / 9 };
    const dur = (Park.html.text(a.querySelector('.dur')) || '').trim();
    if (dur && dur !== '00:00:00') item.duration = dur;
    items.push(item);
  }
  return items;
}

// 详情页 m3u8 提取（与 TVBox 源同一顺序：JSON-LD contentUrl → hlsUrl 变量 → 任意 m3u8 地址）
function extractM3u8(html) {
  const raw = match(html, /"contentUrl"\s*:\s*"([^"]+\.m3u8[^"]*)"/)
    || match(html, /var\s+hlsUrl\s*=\s*["']([^"']+\.m3u8[^"']*)/)
    || match(html, /["']((?:https?:)?\/\/[^"']+\.m3u8[^"']*)/)
    || match(html, /["']([^"']*?\/index\.m3u8[^"']*)/);
  return raw ? abs(raw.replace(/\\\//g, '/')) : '';
}

function playUrl(id, episode) {
  return `${BASE}/video/play/${id}-1-${episode}.html`;
}

// 按 EXT-X-DISCONTINUITY 把媒体清单切成组，挑正片组重建为无 discontinuity 的
// 完整 VOD 清单：优先带 EXT-X-KEY 的组，否则分片最多的一组。KEY 的相对地址
// 按清单 URL 补成绝对地址。重建失败返回空字符串（调用方回退为直出原清单）。
function rebuildFeaturePlaylist(text, playlistUrl) {
  const lines = String(text).split(/\r?\n/);
  let targetDuration = '4';
  const groups = [];
  let group = { keyLine: '', entries: [] };
  let pendingInf = '';
  const pushGroup = () => { if (group.entries.length || group.keyLine) groups.push(group); };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) { targetDuration = line.split(':')[1] || '4'; continue; }
    if (line.startsWith('#EXT-X-DISCONTINUITY')) { pushGroup(); group = { keyLine: '', entries: [] }; pendingInf = ''; continue; }
    if (line.startsWith('#EXT-X-KEY:')) { group.keyLine = line; continue; }
    if (line.startsWith('#EXTINF:')) { pendingInf = line; continue; }
    if (line.startsWith('#')) continue;
    group.entries.push({ inf: pendingInf || '#EXTINF:4.000000,', uri: line });
    pendingInf = '';
  }
  pushGroup();
  if (!groups.length) return '';
  const feature = groups.find((g) => g.keyLine) || groups.slice().sort((a, b) => b.entries.length - a.entries.length)[0];
  if (!feature || !feature.entries.length) return '';
  let keyLine = feature.keyLine;
  if (keyLine) {
    keyLine = keyLine.replace(/URI="([^"]+)"/, (m, uri) => {
      try { return 'URI="' + new URL(uri, playlistUrl).href + '"'; } catch (_) { return m; }
    });
  }
  const out = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + targetDuration, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD'];
  if (keyLine) out.push(keyLine);
  for (const e of feature.entries) { out.push(e.inf, e.uri); }
  out.push('#EXT-X-ENDLIST', '');
  return out.join('\n');
}

Park.register({
  key: 'cap17',
  name: '17cap',
  version: '0.0.2',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'adult',
  description: '17cap.cc（91网址）成人视频：最新与全部分类，支持搜索与 HLS 播放',
  homepage: BASE,
  domains: ['17cap.cc'],
  linkPatterns: ['17cap\\.cc/video/play/(\\d+)-'],
  idPattern: '^\\d+$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    ...CATEGORIES.map(([id, label]) => ({ key: 'c' + id, label })),
  ],
  searchHint: '搜索视频关键词',

  async feed(key, { page }) {
    let url, pageSize;
    if (key === 'latest') {
      url = page <= 1 ? BASE + '/label/hot/by/time.html' : `${BASE}/label/hot/by/time.html?page=${page}`;
      pageSize = 24;
    } else {
      const cat = CATEGORIES.find(([id]) => 'c' + id === key);
      if (!cat) throw Park.error('CONFIG', '未知视频列表');
      url = page <= 1
        ? `${BASE}/video/Categories/${cat[0]}.html`
        : `${BASE}/video/Categories/${cat[0]}.html?page=${page}`;
      pageSize = 20;
    }
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseList(doc);
    return { items, page, hasNext: items.length >= pageSize };
  },

  async search({ keyword, page }) {
    const q = String(keyword || '').trim();
    if (!q) return { items: [], page: 1, hasNext: false };
    const enc = encodeURIComponent(q);
    const url = page <= 1
      ? `${BASE}/search/keyword/wd/${enc}.html`
      : `${BASE}/search/keyword/page/${page}/wd/${enc}.html`;
    const doc = Park.html.parse(await this.http.text(url));
    const items = parseList(doc);
    return { items, page, hasNext: items.length >= 24 };
  },

  async detail(id) {
    if (!/^\d+$/.test(String(id))) throw Park.error('NOT_FOUND', '视频编号无效');
    const url = playUrl(id, 1);
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    const ogTitle = (() => {
      const el = doc.querySelector('meta[property="og:title"]');
      return el ? el.getAttribute('content') || '' : '';
    })();
    let title = cleanTitle(Park.html.text(doc.querySelector('h1')) || ogTitle);
    title = title.replace(/\s*第\d+集\s*$/, '').trim();
    if (!title) throw Park.error('NOT_FOUND', '视频不存在');
    const ogImage = doc.querySelector('meta[property="og:image"]');
    const poster = doc.querySelector('video[poster]');
    const cover = abs((ogImage ? ogImage.getAttribute('content') : '') || (poster ? poster.getAttribute('poster') : '') || '');
    const description = match(html, /"description"\s*:\s*"([^"]{0,600})"/).replace(/\\n/g, ' ')
      || (() => {
        const el = doc.querySelector('meta[property="og:description"]');
        return el ? el.getAttribute('content') || '' : '';
      })();
    const genre = match(html, /"genre"\s*:\s*"([^"]*)"/);
    const kwRaw = match(html, /"keywords"\s*:\s*\[([^\]]{0,300})\]/);
    const keywords = kwRaw ? [...kwRaw.matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
    const uploaded = match(html, /"uploadDate"\s*:\s*"([^"]*)"/).slice(0, 10);
    const seconds = isoDurationSeconds(match(html, /"duration"\s*:\s*"([^"]*)"/));
    // 选集：详情页内文本为「第N集」且指向本作品的链接
    const episodes = [];
    const epSeen = new Set();
    for (const a of doc.querySelectorAll('a[href*="/video/play/"]')) {
      const m = new RegExp(`/video/play/${id}-1-(\\d+)\\.html`).exec(a.getAttribute('href') || '');
      if (!m || epSeen.has(m[1])) continue;
      const label = (Park.html.text(a) || '').trim();
      if (!/^第\d+集$/.test(label)) continue;
      epSeen.add(m[1]);
      episodes.push({ id: m[1], title: label });
    }
    episodes.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
    const out = {
      id: String(id),
      title,
      cover,
      coverAspect: 16 / 9,
      url,
      description,
      uploaded,
      duration: formatDuration(seconds),
      tags: keywords.length ? [{ namespace: 'tag', label: '标签', tags: keywords.map((name) => ({ name, keyword: name })) }] : [],
      chapters: episodes.length > 1 ? episodes : null,
    };
    if (genre) out.category = genre;
    if (episodes.length <= 1) out.singleChapterId = '1';
    return out;
  },

  async videos(id, episodeId) {
    if (!/^\d+$/.test(String(id))) throw Park.error('NOT_FOUND', '视频编号无效');
    const ep = (!episodeId || episodeId === '_') ? '1' : String(episodeId);
    if (!/^\d+$/.test(ep)) throw Park.error('CONFIG', '集数无效');
    const url = playUrl(id, ep);
    const html = await this.http.text(url);
    const m3u8 = extractM3u8(html);
    if (!m3u8) throw Park.error('PARSE', '未解析到播放地址');
    const plain = { url: m3u8, format: 'hls', label: '原画', preferred: true };
    // 短剧清单带 EXT-X-DISCONTINUITY（未加密广告前贴 + AES-128 正片），而应用的
    // 点播管线不支持 discontinuity（真机报「HLS 使用了不支持的媒体格式」）。
    // 取到清单后按 discontinuity 切组，选带 EXT-X-KEY 的正片组（无则选最长组），
    // 重建成无 discontinuity 的完整 VOD 清单经 hls.manifest 交给应用；正片 KEY 的
    // IV 是显式全零，删掉广告前缀不影响解密。普通视频无此标记，原样直出。
    let text = '';
    try { text = await this.http.text(m3u8); } catch (_) { text = ''; }
    if (!text.includes('#EXT-X-DISCONTINUITY')) return [plain];
    const rebuilt = rebuildFeaturePlaylist(text, m3u8);
    if (!rebuilt) return [plain];
    return [{ ...plain, hls: { manifest: rebuilt } }];
  },
});
