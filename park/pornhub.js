// Pornhub (pornhub.com) 的 HentaiPark 站点插件。
// 站点形态：服务端直出完整 HTML，列表卡片是 li[data-video-vkey]，
// viewkey 就是作品 ID，详情页是 /view_video.php?viewkey=<viewkey>。
// 播放数据在详情页脚本的 flashvars_<数字> JSON 里（mediaDefinitions）：
// format=hls 的 videoUrl 是签名主清单，插件会下钻一层到媒体清单并逐条
// 验活（个别码率的签名链偶发 410，验不过就跳过，整批全灭就重新渲染
// 详情页换一轮新签名重试）；
// format=mp4 的 videoUrl 是 get_media 接口，要再请求一层才拿到直链 MP4。
// 所有签名链接都绑请求 IP 且约 2 小时过期，所以插件只存 viewkey，
// 每次播放都回详情页重新解析，不缓存流地址。
// 搜索是站方服务端搜索 /video/search?search=<关键词>。
// 分类只挑常用的几个（照本站 TVBox 源的固定排序 + 兜底分类），不全量搬运。
// 列表页除了主列表之外，每页还重复挂着推广栏（桌面版 premiumStyle、
// 移动版 scrollable，都是 10 条）和导航下拉的卡片，全页抓会让相邻页互相重复，
// 所以列表只取主列表容器内的卡片：桌面版是 ul#videoCategory（搜索页
// ul#videoSearchResult），移动版是 ul.browseVideo-tabSplit（搜索页
// ul#videoListSearchResults）；详情页的相关推荐取 ul#relatedVideos(Listing)。
const BASE = 'https://www.pornhub.com';

const FEED_PATHS = {
  hot: '/video?o=ht',
  latest: '/video?o=cm',
  mostviewed: '/video?o=mv',
  toprated: '/video?o=tr',
  asian: '/video?c=1',
  japanese: '/video?c=111',
  cartoon: '/video?c=86',
  cosplay: '/video?c=241',
};

function validVkey(id) {
  const raw = String(id || '').trim();
  const m = /viewkey=([a-z0-9]{5,64})/i.exec(raw);
  const key = m ? m[1] : raw;
  if (!/^[a-z0-9]{5,64}$/i.test(key)) throw Park.error('NOT_FOUND', '影片编号无效');
  return key;
}

function watchUrl(vkey) {
  return BASE + '/view_video.php?viewkey=' + vkey;
}

// 列表卡片解析（列表页、搜索页、详情页的相关推荐共用同一套卡片结构）。
// root 可以是整个文档，也可以是某个列表容器元素。
function parseCards(root) {
  const items = [];
  const seen = new Set();
  for (const el of root.querySelectorAll('li[data-video-vkey]')) {
    // 导航栏的热门/推荐下拉每页都有，不是列表内容
    if (typeof el.closest === 'function' && el.closest('#hottestMenuSection, #recommMenuSection')) continue;
    const id = el.getAttribute('data-video-vkey') || '';
    if (!id || seen.has(id)) continue;
    const a = el.querySelector('a.linkVideoThumb') || el.querySelector('a[href*="view_video.php"]');
    const img = el.querySelector('img');
    const title = ((a && a.getAttribute('title')) || Park.html.text(el.querySelector('.title a')) || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!title) continue;
    seen.add(id);
    const item = {
      id,
      title,
      cover: img ? (img.getAttribute('data-image') || img.getAttribute('src') || '') : '',
      coverAspect: 16 / 9,
    };
    const duration = Park.html.text(el.querySelector('.duration'));
    if (duration) item.duration = duration;
    const views = Park.utils.parseCount(Park.html.text(el.querySelector('.views var, .videoViews')));
    if (views) item.views = views;
    const uploader = Park.html.text(el.querySelector('.usernameWrap a, .uploaderLink'));
    if (uploader) item.uploader = uploader;
    items.push(item);
  }
  return items;
}

// 只取指定容器里的卡片；容器不存在时退回全页解析
function parseScopedCards(doc, scopes) {
  for (const scope of scopes) {
    const root = doc.querySelector(scope);
    if (root) {
      const items = parseCards(root);
      if (items.length) return items;
    }
  }
  return parseCards(doc);
}

// 页内所有带 page= 参数的链接里最大的页码（与 TVBox 源的 pagecount 口径一致）
function maxPageOf(doc, page) {
  let max = page;
  for (const a of doc.querySelectorAll('a[href]')) {
    const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// 从详情页 HTML 里截取 flashvars_<数字> 的 JSON 对象（按大括号配平截取，
// 不能用非贪婪正则：对象里有嵌套结构）
function parseFlashvars(html) {
  const m = /flashvars_\d+\s*=\s*/.exec(html || '');
  if (!m) return null;
  const start = m.index + m[0].length;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function formatDuration(sec) {
  const n = parseInt(sec, 10);
  if (!Number.isFinite(n) || n <= 0) return '';
  const p = (x) => String(x).padStart(2, '0');
  const h = Math.floor(n / 3600);
  const mm = Math.floor((n % 3600) / 60);
  const ss = n % 60;
  return h > 0 ? `${h}:${p(mm)}:${p(ss)}` : `${mm}:${p(ss)}`;
}

function metaContent(doc, property) {
  const el = doc.querySelector(`meta[property="${property}"]`);
  return el ? (el.getAttribute('content') || '').trim() : '';
}

Park.register({
  key: 'pornhub',
  name: 'Pornhub',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'adult',
  color: '#FF9900',
  description: '综合成人视频：热门、最新与分类浏览，支持搜索和多清晰度播放',
  homepage: BASE,
  domains: ['pornhub.com'],
  linkPatterns: ['pornhub\\.com/view_video\\.php\\?(?:[^#]*&)?viewkey=([a-z0-9]{5,64})'],
  idPattern: '^[a-z0-9]{5,64}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: 'https://www.pornhub.com' },
  defaultFeed: 'hot',
  feeds: [
    { key: 'hot', label: '热门' },
    { key: 'latest', label: '最新' },
    { key: 'mostviewed', label: '最多观看' },
    { key: 'toprated', label: '最高分' },
    { key: 'asian', label: '亚洲' },
    { key: 'japanese', label: '日本' },
    { key: 'cartoon', label: '卡通' },
    { key: 'cosplay', label: 'Cosplay' },
  ],
  searchHint: '搜索作品名或标签',

  // 列表页抓取 + 解析；站点偶尔限流返回空页，空了就隔一秒重试一次
  async listing(path, page) {
    const url = BASE + path + (page > 1 ? (path.includes('?') ? '&' : '?') + 'page=' + page : '');
    let doc = null;
    let items = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      doc = Park.html.parse(await this.http.text(url));
      items = parseScopedCards(doc, ['#videoCategory', '#videoSearchResult', '#videoListSearchResults', 'ul.browseVideo-tabSplit']);
      if (items.length) break;
      if (attempt === 0) await Park.utils.sleep(1000);
    }
    const maxPage = doc ? maxPageOf(doc, page) : page;
    return { items, page, totalPages: maxPage, hasNext: page < maxPage };
  },

  async feed(key, { page }) {
    const path = FEED_PATHS[key];
    if (!path) throw Park.error('CONFIG', '未知视频列表');
    return this.listing(path, page);
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    return this.listing('/video/search?search=' + encodeURIComponent(kw), page);
  },

  async detail(id) {
    const vkey = validVkey(id);
    const url = watchUrl(vkey);
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    const fv = parseFlashvars(html);
    let title = (fv && fv.video_title) || Park.html.text(doc.querySelector('h1')) || metaContent(doc, 'og:title');
    title = String(title || '').replace(/\s*-\s*Pornhub\.com\s*$/, '').trim();
    if (!title) throw Park.error('PARSE', '视频详情解析失败');
    const out = {
      id: vkey,
      title,
      cover: (fv && fv.image_url) || metaContent(doc, 'og:image'),
      coverAspect: 16 / 9,
      url,
      chapters: null,
    };
    // 上传者只取页面明确署名的用户行，不从标题猜。
    // 桌面版在 .video-info-row .usernameWrap，移动版在 .userInfoContainer .usernameWrapper，
    // 按顺序逐个试（querySelector 的逗号列表按文档顺序返回，没法表达优先级）。
    const upEl = doc.querySelector('.video-info-row .usernameWrap a') || doc.querySelector('.userRow .usernameWrap a') || doc.querySelector('.userInfoContainer .usernameWrapper a');
    const uploader = Park.html.text(upEl);
    if (uploader) {
      out.uploader = uploader;
      out.authors = [uploader];
    }
    const desc = Park.html.text(doc.querySelector('.videoDescription')) || metaContent(doc, 'og:description');
    if (desc) out.description = desc;
    if (fv && fv.video_duration) {
      const d = formatDuration(fv.video_duration);
      if (d) out.duration = d;
    }
    const viewsText = Park.html.text(doc.querySelector('li.views span')) || Park.html.text(doc.querySelector('.views var'));
    const views = Park.utils.parseCount(viewsText);
    if (views) out.views = views;
    const tags = [];
    const seenTag = new Set();
    // 本片标签是带 data-label="tag" 的搜索链接（移动/桌面一致）；
    // 页面别处的同类链接是热门搜索，不能混进来
    let tagLinks = doc.querySelectorAll('a[data-label="tag"][href*="/video/search"]');
    if (!tagLinks.length) tagLinks = doc.querySelectorAll('.video-detailed-info a[href*="/video/search"], .abovePlayerButtons a[href*="/video/search"]');
    for (const a of tagLinks) {
      const m = /[?&]search=([^&]+)/.exec(a.getAttribute('href') || '');
      const name = Park.html.text(a);
      if (!m || !name) continue;
      let keyword = m[1].replace(/\+/g, ' ');
      try {
        keyword = decodeURIComponent(keyword);
      } catch (_) {
        /* 保持原文 */
      }
      if (!keyword || seenTag.has(keyword)) continue;
      seenTag.add(keyword);
      tags.push({ name, keyword });
    }
    if (tags.length) out.tags = [{ namespace: 'tag', label: '标签', tags }];
    const related = parseScopedCards(doc, ['#relatedVideosListing', '#relatedVideos', '#recommendedVideosListing', '#recommendedVideos']).filter((it) => it.id !== vkey);
    if (related.length) out.related = related;
    return out;
  },

  // 把一条 HLS 定义的主清单下钻到媒体清单并验活（照 TVBox 源的口径）：
  // 主清单本身已是媒体清单就直接用；是 variant 清单就按码率从高到低
  // 逐条试，第一个含 #EXTINF 的媒体清单胜出。个别码率的签名链会偶发
  // 410，验不过返回 null，由上层换一轮新签名重试或跳过该清晰度。
  async drillHls(master, watch) {
    let body = '';
    try {
      const r = await this.http.get(master, { headers: { Referer: watch } });
      if (r.ok) body = r.body || '';
    } catch (_) {
      body = '';
    }
    if (!body || !body.startsWith('#EXTM3U')) return null;
    if (body.includes('#EXTINF')) return master;
    if (!body.includes('#EXT-X-STREAM-INF')) return null;
    const variants = [];
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const bw = parseInt((/BANDWIDTH=(\d+)/.exec(lines[i]) || [])[1], 10) || 0;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j].trim();
        if (t) {
          variants.push({ bw, url: new URL(t, master).href });
          break;
        }
      }
    }
    variants.sort((a, b) => b.bw - a.bw);
    for (const v of variants) {
      try {
        const r = await this.http.get(v.url, { headers: { Referer: watch } });
        if (r.ok && r.body && r.body.includes('#EXTINF')) return v.url;
      } catch (_) {
        /* 试下一条 */
      }
    }
    return null;
  },

  async videos(id) {
    const vkey = validVkey(id);
    const watch = watchUrl(vkey);
    // 签名链偶发整批 410 时，歇一下重新渲染详情页换一轮新签名再试（最多两轮）
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await Park.utils.sleep(1200);
      const html = await this.http.text(watch);
      const fv = parseFlashvars(html);
      if (!fv) throw Park.error('PARSE', '视频播放数据解析失败');
      const defs = Array.isArray(fv.mediaDefinitions) ? fv.mediaDefinitions : [];
      const hls = defs
        .filter((d) => d && d.format === 'hls' && d.videoUrl)
        .sort((a, b) => (parseInt(b.quality, 10) || 0) - (parseInt(a.quality, 10) || 0));
      if (hls.length) {
        const seenQ = new Set();
        const out = [];
        for (const d of hls) {
          const q = parseInt(d.quality, 10) || 0;
          const master = String(d.videoUrl).replace(/&amp;/g, '&');
          if (!/^https:\/\//.test(master) || (q && seenQ.has(q))) continue;
          const media = await this.drillHls(master, watch);
          if (!media) continue;
          if (q) seenQ.add(q);
          out.push({ quality: q, label: q ? q + 'P' : '原画', url: media, format: 'hls', headers: { Referer: watch } });
        }
        if (out.length) {
          const def = hls.find((d) => d.defaultQuality);
          const pref = (def && out.find((v) => v.quality === (parseInt(def.quality, 10) || 0))) || out[0];
          if (pref) pref.preferred = true;
          return out;
        }
        continue; // 本轮签名全灭，换一轮再试
      }
      return this.videosMp4(defs, watch);
    }
    throw Park.error('UNSUPPORTED', '此影片没有可用的播放地址');
  },

  // 无 HLS 时的 MP4 兜底（从 videos 拆出，逻辑不变）
  async videosMp4(defs, watch) {
    const seenQ = new Set();
    const out = [];
    // 兜底：MP4 定义。remote 的 videoUrl 是 get_media 接口，再取一层拿直链
    for (const d of defs) {
      if (!d || d.format !== 'mp4' || !d.videoUrl) continue;
      const u = String(d.videoUrl).replace(/&amp;/g, '&');
      if (/\.mp4($|\?)/.test(u)) {
        out.push({ quality: 0, label: '原画', url: u, headers: { Referer: watch } });
        continue;
      }
      let list = null;
      try {
        list = JSON.parse(await this.http.text(u, { headers: { Referer: watch } }));
      } catch (_) {
        list = null;
      }
      if (!Array.isArray(list)) continue;
      for (const e of list) {
        if (!e || !e.videoUrl) continue;
        const q = parseInt(e.quality, 10) || 0;
        const mu = String(e.videoUrl).replace(/&amp;/g, '&');
        if (!/^https:\/\//.test(mu) || (q && seenQ.has(q))) continue;
        if (q) seenQ.add(q);
        out.push({ quality: q, label: q ? q + 'P' : '原画', url: mu, headers: { Referer: watch } });
      }
    }
    out.sort((a, b) => b.quality - a.quality);
    if (!out.length) throw Park.error('UNSUPPORTED', '此影片没有可用的播放地址');
    out[0].preferred = true;
    return out;
  },
});
