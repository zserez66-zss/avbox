// TwittHub (www.twitthub.com) 的 HentaiPark 站点插件。
// 站点形态：X / Twitter 视频聚合站，无分类，只有一个「最新」流
// （/?page=N，每页 24 条）与搜索（/?q=<关键词>&page=N）。
// 列表卡片以 <a href="/v/<推文 status id>"> 为锚点：主锚点带
// aria-label="观看<标题> - @<handle> 分享的视频"，内含缩略图与时长文本；
// 同一 /v/<id> 还会以标题链接再出现一次，按 status id 去重；
// 作者只取卡片内明确署名的 /author/<handle> 链接或 aria-label 中的 @handle。
// 本站对机房出口有 Vercel Security Checkpoint：应用内 network auto 会先走
// 浏览器回退尝试过校验，仍拿到校验页时抛 CLOUDFLARE，不把校验页当内容解析。
// 播放走 FixTweet 公开 API：GET https://api.fxtwitter.com/<handle>/status/<id>
// -> tweet.media.videos[].formats 里挑 container=mp4 的最高码率，
// 退回 videos[].url；均为 video.twimg.com 的 MP4 直链，不需要 Referer。
const BASE = 'https://www.twitthub.com';
const FX = 'https://api.fxtwitter.com';
const PAGE_SIZE = 24;

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function clean(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// 与 TVBox 源一致：aria-label「观看<标题> - @<handle> 分享的视频」-> 标题
function titleFromLabel(label, handle) {
  let t = clean(label);
  if (t.startsWith('观看')) t = t.slice('观看'.length).trim();
  if (t.endsWith('分享的视频')) t = t.slice(0, t.length - '分享的视频'.length).trim();
  if (handle) {
    const suffix = '- @' + handle;
    if (t.endsWith(suffix)) t = t.slice(0, t.length - suffix.length).trim();
  }
  if (!t || (handle && t === '@' + handle)) return handle ? '@' + handle : t;
  return t;
}

// 与 TVBox 源一致：标签一律换成空格再取文本，避免相邻文本节点粘连（如日期与播放量）
function spacedText(node) {
  if (!node) return '';
  return clean(String(node.innerHTML || '').replace(/<[^>]+>/g, ' '));
}

// 「33:15」/「1:02:03」-> 秒
function durationSeconds(text) {
  const m = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/.exec(text || '');
  if (!m) return undefined;
  return m[3] !== undefined
    ? parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
    : parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// 作品 ID：handle/statusId、纯 statusId、/v/<id> 链接都拆成 { handle, sid }
function splitRef(ref) {
  const s = String(ref || '').trim();
  let m = /\/v\/(\d{10,})/.exec(s);
  if (m) {
    const hm = /\/author\/([A-Za-z0-9_]+)/.exec(s);
    return { handle: hm ? hm[1] : '', sid: m[1] };
  }
  m = /([A-Za-z0-9_]+)\/(\d{10,})/.exec(s);
  if (m) return { handle: m[1], sid: m[2] };
  m = /(\d{10,})/.exec(s);
  if (m) return { handle: '', sid: m[1] };
  return { handle: '', sid: '' };
}

// 卡片根节点：从主锚点向上找不包含其他 /v/<id> 链接的最近祖先（上限 5 层）
function cardRoot(anchor, sid) {
  let node = anchor;
  for (let depth = 0; depth < 5 && node.parentElement; depth++) {
    const parent = node.parentElement;
    let foreign = false;
    for (const a of parent.querySelectorAll('a[href*="/v/"]')) {
      const m = /\/v\/(\d{10,})/.exec(a.getAttribute('href') || '');
      if (m && m[1] !== sid) { foreign = true; break; }
    }
    if (foreign) break;
    node = parent;
    if (node.querySelector('a[href*="/author/"]')) break;
  }
  return node;
}

// 列表页通用解析（最新流与搜索共用同一套卡片网格）
function parseCards(doc) {
  const items = [];
  const seen = new Set();
  for (const anchor of doc.querySelectorAll('a[href*="/v/"]')) {
    const m = /\/v\/(\d{10,})/.exec(anchor.getAttribute('href') || '');
    if (!m) continue;
    const sid = m[1];
    if (seen.has(sid)) continue;
    const root = cardRoot(anchor, sid);
    const img = root.querySelector('img') || anchor.querySelector('img');
    const cover = abs(img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '');
    if (!cover) continue; // 与 TVBox 源一致：无缩略图的锚点不算卡片
    const label = anchor.getAttribute('aria-label') || (img ? img.getAttribute('alt') : '') || '';
    let handle = '';
    const authorLink = root.querySelector('a[href*="/author/"]');
    if (authorLink) {
      const hm = /\/author\/([A-Za-z0-9_]+)/.exec(authorLink.getAttribute('href') || '');
      if (hm) handle = hm[1];
    }
    if (!handle) {
      const hm = /@([A-Za-z0-9_]+)\s*分享的视频/.exec(label);
      if (hm) handle = hm[1];
    }
    let title = titleFromLabel(label, handle);
    if (!title || (handle && title === '@' + handle)) {
      // 兜底：同卡标题链接的文本（仍是页面明确文本，不猜作者）
      for (const a of root.querySelectorAll('a[href*="/v/"]')) {
        const am = /\/v\/(\d{10,})/.exec(a.getAttribute('href') || '');
        if (!am || am[1] !== sid) continue;
        const text = clean(Park.html.text(a));
        if (text) { title = titleFromLabel(text, handle); break; }
      }
    }
    if (!title) title = handle ? '@' + handle : sid;
    const text = spacedText(root);
    const item = {
      id: handle ? handle + '/' + sid : sid,
      title,
      cover,
      mediaKind: 'video',
    };
    const duration = durationSeconds(text);
    if (duration) item.duration = duration;
    const vm = /([\d.]+\s*万|[\d,]{2,})\s*(?:播放|次观看|views?)/i.exec(text);
    if (vm) {
      const views = Park.utils.parseCount(vm[1].replace(/,/g, ''));
      if (views) item.views = views;
    }
    if (handle) {
      item.authors = [handle];
      item.uploader = handle;
    }
    seen.add(sid);
    items.push(item);
  }
  return items;
}

function pageInfo(doc, page, count) {
  let maxPage = 0;
  for (const a of doc.querySelectorAll('a')) {
    const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
  }
  const total = /共\s*(\d+)\s*页/.exec(clean(Park.html.text(doc)));
  if (total) maxPage = Math.max(maxPage, parseInt(total[1], 10));
  // 分页链接给出更大页码 -> 有下一页；没有明确页码时满页则按 TVBox 源口径认为还有下一页
  const hasNext = maxPage > page || (maxPage <= page && count >= PAGE_SIZE);
  return { maxPage: maxPage > 0 ? Math.max(maxPage, page) : undefined, hasNext };
}

Park.register({
  key: 'twitthub',
  name: 'TwittHub',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'shortvideo',
  description: 'X 视频聚合：最新流、关键词搜索与 MP4 直链播放',
  homepage: BASE,
  domains: ['twitthub.com'],
  linkPatterns: ['twitthub\\.com/v/(\\d{10,})'],
  idPattern: '^\\d{10,}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: 'https://twitthub.com' },
  defaultFeed: 'latest',
  feeds: [{ key: 'latest', label: '最新' }],
  searchHint: '输入关键词搜索视频',

  // 站内页面：校验页抛 CLOUDFLARE（应用会引导去验证），其余非 2xx 抛 HTTP
  async fetchDoc(url) {
    const res = await this.http.get(url, { timeout: 30000 });
    const body = res.body || '';
    if (res.status === 429 || /Vercel Security Checkpoint/i.test(body.slice(0, 4000))) {
      throw Park.error('CLOUDFLARE', '站点触发了 Vercel 安全校验，请完成验证后重试', { status: res.status, url });
    }
    if (!res.ok) throw Park.error('HTTP', '站点返回 HTTP {status}', { status: res.status, params: { status: res.status } });
    return Park.html.parse(body);
  },

  async listing(url, page) {
    const doc = await this.fetchDoc(url);
    const items = parseCards(doc);
    if (!items.length && page <= 1) throw Park.error('PARSE', '未解析到视频列表');
    const info = pageInfo(doc, page, items.length);
    return { items, page, totalPages: info.maxPage, hasNext: info.hasNext };
  },

  async feed(key, { page }) {
    if (key !== 'latest') throw Park.error('CONFIG', '未知视频列表');
    const p = Math.max(1, Math.floor(Number(page) || 1));
    return this.listing(`${BASE}/?page=${p}`, p);
  },

  async search(req = {}) {
    const keyword = String(req.keyword || '').trim();
    const p = Math.max(1, Math.floor(Number(req.page) || 1));
    if (!keyword) return { items: [], page: 1, hasNext: false };
    let url = `${BASE}/?q=${encodeURIComponent(keyword)}`;
    if (p > 1) url += `&page=${p}`;
    return this.listing(url, p);
  },

  // FixTweet 公开 API：返回 tweet 对象；404 抛 NOT_FOUND，其余失败抛 HTTP/PARSE
  async fxTweet(handle, sid) {
    const api = `${FX}/${handle || 'i'}/status/${sid}`;
    const res = await this.http.get(api, { headers: { Accept: 'application/json' }, timeout: 30000 });
    if (res.status === 404) throw Park.error('NOT_FOUND', '推文不存在或已被删除');
    if (!res.ok) throw Park.error('HTTP', '视频解析服务返回 HTTP {status}', { status: res.status, params: { status: res.status } });
    let data;
    try { data = res.json(); } catch (_) { throw Park.error('PARSE', '视频解析服务返回的数据无效'); }
    if (!data || !data.tweet) throw Park.error('NOT_FOUND', '推文不存在或已被删除');
    return data.tweet;
  },

  // 推文里的全部视频条目（media.videos 优先，退回 media.all 中的 video）
  fxVideos(tweet) {
    const media = (tweet && tweet.media) || {};
    let videos = Array.isArray(media.videos) ? media.videos.slice() : [];
    if (!videos.length && Array.isArray(media.all)) {
      videos = media.all.filter((x) => x && x.type === 'video');
    }
    return videos;
  },

  // 与 TVBox 源一致：formats 里挑 container=mp4 按码率排序，退回 videos[].url
  fxSources(tweet) {
    const out = [];
    const seen = new Set();
    for (const v of this.fxVideos(tweet)) {
      const formats = Array.isArray(v.formats) ? v.formats : [];
      const mp4s = [];
      for (const f of formats) {
        const u = String((f && f.url) || '');
        if (!u || (!u.includes('.mp4') && f.container !== 'mp4')) continue;
        if (f.container != null && f.container !== 'mp4') continue;
        mp4s.push({ url: u, bitrate: Number(f.bitrate) || 0 });
      }
      mp4s.sort((a, b) => b.bitrate - a.bitrate);
      for (const f of mp4s) {
        if (seen.has(f.url)) continue;
        seen.add(f.url);
        const dim = /\/vid\/(\d+)x(\d+)\//.exec(f.url);
        out.push({
          url: f.url,
          format: 'mp4',
          quality: dim ? parseInt(dim[2], 10) : 0,
          label: dim ? dim[2] + 'P' : (f.bitrate ? Math.round(f.bitrate / 1000) + 'kbps' : '原画'),
        });
      }
      if (!mp4s.length && v.url && !seen.has(String(v.url))) {
        seen.add(String(v.url));
        out.push({ url: String(v.url), format: 'mp4', quality: 0, label: '原画' });
      }
    }
    if (out.length) out[0].preferred = true;
    return out;
  },

  async detail(id, preview) {
    const { handle, sid } = splitRef(id);
    if (!sid) throw Park.error('NOT_FOUND', '视频编号无效');
    const url = `${BASE}/v/${sid}`;
    let tweet = null;
    try { tweet = await this.fxTweet(handle, sid); } catch (_) { tweet = null; }
    if (tweet) {
      const author = tweet.author || {};
      const authorName = String(author.name || '').trim();
      const screenName = String(author.screen_name || handle || '').trim();
      const videos = this.fxVideos(tweet);
      const video = videos[0] || {};
      const photos = (tweet.media && Array.isArray(tweet.media.photos)) ? tweet.media.photos : [];
      const cover = String(video.thumbnail_url || (photos[0] && photos[0].url) || '');
      const text = clean(tweet.text || tweet.raw_text?.text || '');
      const item = {
        id: (screenName || handle) ? (screenName || handle) + '/' + sid : sid,
        title: text || (preview && preview.title) || (screenName ? '@' + screenName + ' 的视频' : '视频'),
        cover,
        url,
        description: text,
        chapters: null,
        mediaKind: 'video',
      };
      if (authorName) item.authors = [authorName];
      if (screenName) item.uploader = screenName;
      if (Number(video.duration)) item.duration = Math.round(Number(video.duration));
      if (Number(tweet.views)) item.views = Number(tweet.views);
      if (Number(tweet.likes)) item.likes = Number(tweet.likes);
      if (Number(tweet.created_timestamp)) item.uploaded = new Date(Number(tweet.created_timestamp) * 1000).toISOString();
      if (Number(video.width) && Number(video.height)) item.coverAspect = Number(video.width) / Number(video.height);
      return item;
    }
    // FixTweet 不可用时退回本站详情页的 og 信息（校验页会抛 CLOUDFLARE）
    const doc = await this.fetchDoc(url);
    const ogTitle = doc.querySelector('meta[property="og:title"]');
    const ogImage = doc.querySelector('meta[property="og:image"]');
    const ogDesc = doc.querySelector('meta[property="og:description"]');
    const h1 = clean(Park.html.text(doc.querySelector('h1')));
    const title = h1 || clean(ogTitle ? ogTitle.getAttribute('content') : '') || (preview && preview.title) || '';
    if (!title) throw Park.error('PARSE', '未解析到视频详情');
    return {
      id: handle ? handle + '/' + sid : sid,
      title,
      cover: abs(ogImage ? ogImage.getAttribute('content') : ''),
      url,
      description: clean(ogDesc ? ogDesc.getAttribute('content') : ''),
      chapters: null,
      mediaKind: 'video',
    };
  },

  async videos(id) {
    const { handle, sid } = splitRef(id);
    if (!sid) throw Park.error('NOT_FOUND', '视频编号无效');
    const tweet = await this.fxTweet(handle, sid);
    const sources = this.fxSources(tweet);
    if (!sources.length) throw Park.error('UNSUPPORTED', '此推文没有可用视频');
    return sources;
  },
});
