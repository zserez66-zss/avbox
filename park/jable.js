// JableTV (jable.tv) 的 HentaiPark 站点插件。
// 站点形态：JAV 视频站，一个影片 = 一个作品，播放地址在详情页的 hlsUrl（HLS 清单，
// 带每次渲染新签的时效令牌，videos() 每次都回详情页现取）。
// 域名：jable.tv 对普通 HTTP 有 Cloudflare 挑战；按本站 TVBox 源的实测路线，
// 请求按 jable.sbs（会跳转到当前镜像 jable01.net）→ jable01.net → jable.tv 顺序轮询，
// 路径结构三站一致（/latest-updates/、/hot/、/categories/...、/tags/...、/search/<词>/、/videos/<番号>/）。
// 列表卡片 .video-img-box：封面在 img 的 data-src（src 是占位图，不能用），时长在 .label。
// 详情：标题 .video-info h4，封面 og:image，女优只取 .models a.model 明确标注的名字。
// 详情页没有本片标签区（页面上的 a.tag 是全站标签目录），故 detail 不填 tags，也不从标题猜作者。
const HOSTS = ['https://jable.sbs', 'https://jable01.net', 'https://jable.tv'];
const CANON = 'https://jable.tv';

const FEED_PATHS = {
  latest: 'latest-updates',
  hot: 'hot',
  release: 'new-release',
  zhsub: 'categories/chinese-subtitle',
  uncensored: 'categories/uncensored',
  roleplay: 'categories/roleplay',
  pov: 'categories/pov',
  cosplay: 'tags/Cosplay',
};

function slugOf(href) {
  if (!href) return '';
  const m = /\/videos\/([a-z0-9][a-z0-9-]{1,120})\/?(?:[?#]|$)/i.exec(String(href));
  return m ? m[1].toLowerCase() : '';
}

// 番号与版本标记只来自影片 slug 本身与页面明确角标，不猜测。
function identity(id, labelText) {
  const code = id.replace(/(?:-(?:uncensored-leak|uncensored|chinese-subtitle|english-subtitle))+$/, '');
  const editions = [];
  const text = id + ' ' + (labelText || '');
  if (/uncensored-leak|无码流出|無碼流出/.test(text)) editions.push('无码流出');
  else if (/uncensored|无码|無碼/.test(text)) editions.push('无码');
  if (/chinese-subtitle|中文字幕/.test(text)) editions.push('中文字幕');
  if (/english-subtitle|英文字幕/.test(text)) editions.push('英文字幕');
  const out = { editions };
  if (/^(?:\d{0,4}[a-z]{2,12}-\d{2,8}[a-z]?|fc2-ppv-\d{2,12})$/i.test(code)) out.workCode = code.toUpperCase();
  return out;
}

function parseCards(doc) {
  const items = [];
  const seen = new Set();
  for (const card of doc.querySelectorAll('.video-img-box')) {
    const a = card.querySelector('a[href*="/videos/"]');
    const id = slugOf(a ? a.getAttribute('href') : '');
    if (!id || seen.has(id)) continue;
    const titleEl = card.querySelector('h6.title a') || a;
    const img = card.querySelector('img');
    const title = ((titleEl ? Park.html.text(titleEl) : '') || (a ? a.getAttribute('title') : '') || (img ? img.getAttribute('alt') : '') || '').trim();
    if (!title || /^\d{1,2}:\d{2}(?::\d{2})?$/.test(title) || title.includes('广告')) continue;
    seen.add(id);
    const labelText = [...card.querySelectorAll('.label, .badge')].map((el) => Park.html.text(el)).join(' ');
    const duration = (Park.html.text(card.querySelector('.label')) || '').trim();
    const item = {
      id,
      title,
      cover: img ? (img.getAttribute('data-src') || img.getAttribute('src') || '') : '',
      coverAspect: 16 / 9,
      ...identity(id, labelText),
    };
    if (duration && /^\d{1,2}:\d{2}/.test(duration)) item.duration = duration;
    items.push(item);
  }
  return items;
}

function totalPagesOf(doc, feedPath, page) {
  let total = page;
  const anchors = doc.querySelectorAll('.pagination a[href], a[href]');
  for (const a of anchors) {
    const href = a.getAttribute('href') || '';
    if (feedPath && !href.includes('/' + feedPath + '/')) continue;
    const m = /\/(\d+)\/?(?:[?#]|$)/.exec(href);
    if (m) total = Math.max(total, parseInt(m[1], 10));
  }
  return total;
}

Park.register({
  key: 'jable',
  name: 'JableTV',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'jav',
  color: '#14B8A6',
  description: 'JAV 视频，支持热门、搜索与 HLS 播放',
  homepage: CANON,
  domains: ['jable.tv', 'jable.sbs', 'jable01.net'],
  linkPatterns: ['(?:jable\\.tv|jable\\.sbs|jable01\\.net)/videos/([a-z0-9][a-z0-9-]{1,120})(?:/|[?#]|$)'],
  idPattern: '^[a-z0-9][a-z0-9-]{1,120}$',
  imageHeaders: { Referer: CANON + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'browser', scope: 'session', origin: 'https://jable.tv' },
  defaultFeed: 'hot',
  feeds: [
    { key: 'hot', label: '热门影片' },
    { key: 'latest', label: '最近更新' },
    { key: 'release', label: '全新上市' },
    { key: 'zhsub', label: '中文字幕' },
    { key: 'uncensored', label: '无码流出' },
    { key: 'roleplay', label: '角色扮演' },
    { key: 'pov', label: '主观视角' },
    { key: 'cosplay', label: 'Cosplay' },
  ],
  searchHint: '搜索番号、作品名或演员',

  // 按 py 源的备用域名顺序取页面：先用上次成功的域名，再依次轮询其余域名。
  async fetchPage(path) {
    const order = this._host ? [this._host, ...HOSTS.filter((h) => h !== this._host)] : HOSTS;
    let lastErr = null;
    for (const host of order) {
      try {
        const text = await this.http.text(host + path);
        if (text && text.includes('Just a moment')) {
          lastErr = Park.error('CLOUDFLARE', '站点要求人机验证');
          continue;
        }
        this._host = host;
        return { text, url: host + path, host };
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || Park.error('NETWORK', '站点请求失败');
  },

  async listing(feedPath, page) {
    const path = '/' + feedPath + '/' + (page > 1 ? page + '/' : '');
    const { text } = await this.fetchPage(path);
    const doc = Park.html.parse(text);
    const totalPages = totalPagesOf(doc, feedPath, page);
    return { items: parseCards(doc), page, totalPages, hasNext: page < totalPages };
  },

  async feed(key, { page }) {
    const feedPath = FEED_PATHS[key];
    if (!feedPath) throw Park.error('CONFIG', '未知视频列表');
    return this.listing(feedPath, Math.max(1, page || 1));
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, totalPages: 1, hasNext: false };
    return this.listing('search/' + encodeURIComponent(kw), Math.max(1, page || 1));
  },

  async detail(id) {
    id = String(id || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,120}$/.test(id)) throw Park.error('NOT_FOUND', '影片编号无效');
    const path = '/videos/' + id + '/';
    const { text, host } = await this.fetchPage(path);
    const doc = Park.html.parse(text);
    const title = (Park.html.text(doc.querySelector('.video-info h4')) || Park.html.text(doc.querySelector('h4')) || '').trim();
    if (!title) throw Park.error('NOT_FOUND', '影片不存在');
    const ogImage = doc.querySelector('meta[property="og:image"]');
    const ogDesc = doc.querySelector('meta[property="og:description"]');
    const descEl = doc.querySelector('.video-info .desc, .video-info h5.desc');
    // 女优：只取详情页 .models 区明确标注的名字（span 的 title 属性）。
    const authors = [];
    for (const a of doc.querySelectorAll('.models a.model')) {
      const span = a.querySelector('span[title], [data-original-title]');
      const name = ((span ? (span.getAttribute('title') || span.getAttribute('data-original-title')) : '') || Park.html.text(a) || '').trim();
      if (name && !authors.includes(name)) authors.push(name);
    }
    const editionLabel = (Park.html.text(doc.querySelector('.video-info .header-right')) || '').trim();
    const related = parseCards(doc).filter((it) => it.id !== id);
    return {
      id,
      title,
      cover: ogImage ? (ogImage.getAttribute('content') || '') : '',
      coverAspect: 16 / 9,
      url: host + path,
      description: ((descEl ? Park.html.text(descEl) : '') || (ogDesc ? ogDesc.getAttribute('content') : '') || '').trim(),
      authors,
      tags: [],
      ...identity(id, editionLabel),
      chapters: null,
      related,
    };
  },

  async videos(id) {
    id = String(id || '').toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,120}$/.test(id)) throw Park.error('NOT_FOUND', '影片编号无效');
    const path = '/videos/' + id + '/';
    const { text, url, host } = await this.fetchPage(path);
    // 播放地址带每次渲染新签的时效令牌，只能现取，不能缓存旧地址。
    const m = /\bhlsUrl\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/.exec(text)
      || /['"](https?:\/\/[^'"]+\.m3u8[^'"]*)['"]/.exec(text)
      || /['"]([^'"]*\.m3u8[^'"]*)['"]/.exec(text);
    let media = null;
    if (m) {
      try {
        const u = new URL(m[1], url);
        if (u.protocol === 'https:' && !u.username && !u.password) media = u.href;
      } catch (_) { /* 地址无效时按无可用清晰度处理 */ }
    }
    if (!media) throw Park.error('UNSUPPORTED', '此影片没有可用的 HLS 清晰度');
    return [{
      url: media,
      format: 'hls',
      label: '原画',
      preferred: true,
      headers: { Referer: url, Origin: host },
    }];
  },
});
