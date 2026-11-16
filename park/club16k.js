// 16K图片资源库 (16k.club) 的 HentaiPark 站点插件。
// 站点形态：每个帖子 = 一个图集（单章）。最新流 /?p=N&size=50（50 条/页），
// 最佳榜 /top.html（单页）。详情页图片在 div.position-relative 的 img 里：
// src 是展示版 .webp，data-src 是 .jpg 原图——本插件取 data-src 原图。
// 少数老帖是视频帖（<video> mp4），图集阅读里只能给封面图，详情里会注明。
// 本站没有站内搜索（导航搜索跳外部站），故不声明 search。
const BASE = 'https://16k.club';

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

function postPath(href) {
  if (!href) return '';
  const m = String(href).match(/\/post\/[^\s?#]+/);
  return m ? m[0] : '';
}

// 详情页图集：div.position-relative 里的 img（src 展示版 / data-src 原图，取原图）。
// 只收图片 CDN 域名，天然排除广告位（广告图不在 position-relative 容器里）。
function galleryImages(doc, title) {
  const out = [];
  for (const div of doc.querySelectorAll('div.position-relative')) {
    const img = div.querySelector('img');
    if (!img) continue;
    const u = abs(img.getAttribute('data-src') || img.getAttribute('src') || '');
    if (u.includes('img.16k.club') && !out.includes(u)) out.push(u);
  }
  if (out.length) return out;
  // 兜底：全页带帖子标题 alt 的 CDN 图（图集图 alt=标题，广告图 alt 是广告词）
  for (const img of doc.querySelectorAll('img')) {
    const u = abs(img.getAttribute('data-src') || img.getAttribute('src') || '');
    if (u.includes('img.16k.club') && (img.getAttribute('alt') || '').trim() === title && !out.includes(u)) out.push(u);
  }
  return out;
}

Park.register({
  key: 'club16k',
  name: '16K图片资源库',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'gallery',
  homepage: BASE,
  domains: ['16k.club'],
  linkPatterns: ['16k\\.club(/post/[^\\s?#]+)'],
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'top', label: '最佳' },
  ],

  async feed(key, { page }) {
    if (key === 'top') {
      if (page > 1) return { items: [], hasNext: false };
      const doc = Park.html.parse(await this.http.text(BASE + '/top.html'));
      const items = [];
      for (const el of doc.querySelectorAll('.bg-gray-100')) {
        const a = el.querySelector('a[href*="/post/"]') || el.querySelector('a');
        const img = el.querySelector('img');
        const id = postPath(a ? a.getAttribute('href') : '');
        const title = (Park.html.text(el.querySelector('h2')) || (img ? img.getAttribute('alt') : '') || '').trim();
        if (!id || !title || /广告|推广/.test(title)) continue;
        items.push({
          id,
          title,
          cover: abs(img ? (img.getAttribute('src') || img.getAttribute('data-src')) : ''),
          subtitle: (Park.html.text(el.querySelector('h3')) || '').trim(),
        });
      }
      return { items, hasNext: false };
    }
    const doc = Park.html.parse(await this.http.text(`${BASE}/?p=${page}&size=50`));
    const items = [];
    for (const el of doc.querySelectorAll('.grid-item')) {
      const a = el.querySelector('a[href*="/post/"]') || el.querySelector('a');
      const img = el.querySelector('img');
      const id = postPath(a ? a.getAttribute('href') : '');
      const title = ((img ? img.getAttribute('alt') : '') || (a ? a.getAttribute('title') : '') || '').trim();
      if (!id || !title || /广告|推广/.test(title)) continue;
      const badge = (Park.html.text(el.querySelector('.badge')) || '').trim();
      const item = {
        id,
        title,
        cover: abs(img ? (img.getAttribute('src') || img.getAttribute('data-src')) : ''),
      };
      if (/^\d+$/.test(badge)) item.pages = parseInt(badge, 10);
      items.push(item);
    }
    let maxPage = page;
    for (const a of doc.querySelectorAll('a')) {
      const m = /[?&]p=(\d+)/.exec(a.getAttribute('href') || '');
      if (m) maxPage = Math.max(maxPage, parseInt(m[1], 10));
    }
    return { items, page, totalPages: maxPage, hasNext: page < maxPage };
  },

  async detail(id) {
    const url = BASE + id;
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    const images = galleryImages(doc, title);
    const og = doc.querySelector('meta[property="og:image"]');
    const video = doc.querySelector('video');
    const isVideo = !images.length && !!video;
    const cover = abs((og ? og.getAttribute('content') : '') || images[0] || (video ? video.getAttribute('poster') : '') || '');
    return {
      id,
      title,
      cover,
      url,
      pages: images.length || undefined,
      description: isVideo
        ? '本帖是视频帖：图集阅读内只能显示封面图，视频请到站点页面观看。'
        : `共 ${images.length} 张图片（原图）。`,
      chapters: null,
      singleChapterId: 'gallery',
    };
  },

  async chapter(id, chapterId) {
    const url = BASE + id;
    const doc = Park.html.parse(await this.http.text(url));
    const title = (Park.html.text(doc.querySelector('h1')) || '').trim();
    const images = galleryImages(doc, title);
    if (images.length) {
      return { pages: images.map((u) => ({ url: u, headers: { Referer: url } })) };
    }
    // 视频帖：只给封面（poster / og:image）
    const video = doc.querySelector('video');
    const og = doc.querySelector('meta[property="og:image"]');
    const poster = abs((video ? video.getAttribute('poster') : '') || (og ? og.getAttribute('content') : '') || '');
    if (poster) return { pages: [{ url: poster, headers: { Referer: url } }] };
    throw Park.error('PARSE', '未解析到图集图片');
  },
});
