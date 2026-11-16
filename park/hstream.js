// HStream (hstream.moe) 的 HentaiPark 站点插件。
// 站点形态：里番单集视频站（Laravel + Livewire）。列表、分类、搜索都在 /search 页，
// 每页 25 条，页内有 "of N results" 总数：order=recently-uploaded / recently-released /
// view-count 是排序流，tags[0]=<slug> 是标签流。
// 关键词搜索的真实参数是 search=<词>（Livewire 组件属性名）；py 源用的 q 参数会被
// 站点忽略、恒返回全站列表，本插件不用，避免假搜索。
// 详情页隐藏域 #e_id 是集数编号；播放先取 XSRF-TOKEN Cookie，再 POST /player/api
// {episode_id} 换 stream_url 与 CDN 域名组，播放地址 = {cdn}/{stream_url}/x264.720p.mp4
// （MP4 直链，同一 720P 的多个 CDN 是镜像线路，按顺序回退）。
const BASE = 'https://hstream.moe';
const PER_PAGE = 25;
const ORDERS = ['recently-uploaded', 'recently-released', 'view-count'];

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 作品 ID 用 /hentai/ 后的 slug；也接受完整链接与路径形式（与 py 源一致）。
function slugOf(id) {
  let s = String(id || '').trim();
  const m = /\/hentai\/([^\s?#/]+)/.exec(s);
  if (m) s = m[1];
  s = s.replace(/\/+$/, '');
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(s)) throw Park.error('NOT_FOUND', '影片编号无效');
  return s;
}

function detailUrl(slug) {
  return BASE + '/hentai/' + slug;
}

// 详情页 JSON-LD 里的字段（py 源同款取法：第一个 "字段": "值"）。
function jsonField(html, field) {
  const m = new RegExp('"' + field + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"').exec(html || '');
  if (!m) return '';
  try {
    return String(JSON.parse('"' + m[1] + '"') || '');
  } catch (_) {
    return m[1]
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, '$1');
  }
}

// 列表页总数：of <span …>N</span> results（py 源同款）。
function totalFromHtml(html) {
  const m = /of\s*<span[^>]*>\s*(\d+)\s*<\/span>\s*results/.exec(html || '');
  return m ? parseInt(m[1], 10) : null;
}

// 列表解析：以 wire:key="episode-…" 卡片为界（py 源同款），卡内取 /hentai/ 链接与封面图。
function parseItems(doc) {
  const items = [];
  const seen = new Set();
  const take = (root) => {
    const a = root.querySelector('a[href*="/hentai/"]');
    const img = root.querySelector('img');
    if (!a || !img) return;
    const m = /\/hentai\/([^\s?#/]+)/.exec(a.getAttribute('href') || '');
    const title = (img.getAttribute('alt') || '').trim();
    if (!m || !title || seen.has(m[1])) return;
    seen.add(m[1]);
    items.push({ id: m[1], title, cover: abs(img.getAttribute('src') || '') });
  };
  for (const el of doc.querySelectorAll('[wire\\:key]')) take(el);
  if (!items.length) {
    for (const a of doc.querySelectorAll('a[href*="/hentai/"]')) take(a.parentElement || a);
  }
  return items;
}

Park.register({
  key: 'hstream',
  name: 'HStream',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'anime',
  description: '里番在线播放，支持搜索与标签分类',
  homepage: BASE,
  domains: ['hstream.moe'],
  linkPatterns: ['hstream\\.moe/hentai/([^\\s?#]+)'],
  idPattern: '^[a-z0-9][a-z0-9-]{0,120}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: 'recently-uploaded',
  feeds: [
    { key: 'recently-uploaded', label: '最新上传' },
    { key: 'recently-released', label: '最新发布' },
    { key: 'view-count', label: '最多观看' },
    { key: 'tag-4k-48fps', label: '4K 48Fps' },
    { key: 'tag-uncensored', label: '无码' },
    { key: 'tag-big-boobs', label: '巨乳' },
    { key: 'tag-maid', label: '女仆' },
    { key: 'tag-school-girl', label: '校服' },
    { key: 'tag-succubus', label: '魅魔' },
    { key: 'tag-elf', label: '精灵' },
    { key: 'tag-milf', label: '熟女' },
    { key: 'tag-tentacle', label: '触手' },
  ],
  searchHint: '搜索作品名',

  async listing(url, page) {
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    const items = parseItems(doc);
    const total = totalFromHtml(html);
    const totalPages = total != null
      ? Math.max(1, Math.ceil(total / PER_PAGE))
      : (items.length >= PER_PAGE ? page + 1 : page);
    const out = { items, page, totalPages, hasNext: page < totalPages };
    if (total != null) out.total = total;
    return out;
  },

  feedUrl(key, page) {
    let url;
    if (key.startsWith('tag-')) {
      const slug = key.slice(4);
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw Park.error('CONFIG', '筛选参数无效');
      url = `${BASE}/search?order=recently-uploaded&tags%5B0%5D=${encodeURIComponent(slug)}`;
    } else if (ORDERS.includes(key)) {
      url = `${BASE}/search?order=${key}`;
    } else {
      throw Park.error('CONFIG', '未知视频列表');
    }
    return page > 1 ? `${url}&page=${page}` : url;
  },

  async feed(key, { page }) {
    const p = Math.max(1, Number(page) || 1);
    return this.listing(this.feedUrl(key, p), p);
  },

  async search({ keyword, page, filters }) {
    const p = Math.max(1, Number(page) || 1);
    // 详情页标签点击：filters.tag 是原站标签 slug，走标签流（与标签分类同一接口）。
    const tag = filters && typeof filters.tag === 'string' ? filters.tag : '';
    if (tag) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(tag)) throw Park.error('CONFIG', '筛选参数无效');
      let url = `${BASE}/search?order=recently-uploaded&tags%5B0%5D=${encodeURIComponent(tag)}`;
      if (p > 1) url += `&page=${p}`;
      return this.listing(url, p);
    }
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, totalPages: 1, hasNext: false };
    let url = `${BASE}/search?search=${encodeURIComponent(kw)}`;
    if (p > 1) url += `&page=${p}`;
    return this.listing(url, p);
  },

  async detail(id) {
    const slug = slugOf(id);
    const url = detailUrl(slug);
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    const og = (prop) => {
      const el = doc.querySelector(`meta[property="${prop}"]`);
      return el ? el.getAttribute('content') || '' : '';
    };
    const h1 = (Park.html.text(doc.querySelector('h1')) || '').trim();
    const title = jsonField(html, 'name') || h1 || og('og:title');
    if (!title) throw Park.error('NOT_FOUND', '影片不存在');
    const tags = [];
    const seenTag = new Set();
    for (const a of doc.querySelectorAll('a[href*="tags"]')) {
      const m = /tags(?:%5B0%5D|\[0\])=([a-z0-9-]+)/i.exec(a.getAttribute('href') || '');
      const name = (Park.html.text(a) || '').trim();
      if (!m || !name || seenTag.has(m[1])) continue;
      seenTag.add(m[1]);
      tags.push({ name, keyword: '', filters: { tag: m[1] } });
    }
    return {
      id: slug,
      title,
      cover: abs(og('og:image')),
      url,
      description: jsonField(html, 'description') || og('og:description') || '',
      tags: tags.length ? [{ namespace: 'tag', label: '标签', tags }] : [],
      chapters: null,
    };
  },

  async videos(id) {
    const slug = slugOf(id);
    const url = detailUrl(slug);
    const html = await this.http.text(url);
    const doc = Park.html.parse(html);
    const eEl = doc.querySelector('#e_id');
    const eid = (eEl ? eEl.getAttribute('value') : '') ||
      ((/id="e_id"[^>]*value="([^"]*)"/.exec(html) || [])[1] || '');
    if (!eid) throw Park.error('PARSE', '未解析到集数编号');
    // Laravel 要求 XSRF-TOKEN：先保证本站 Cookie 罐里有令牌（py 源同款流程）。
    let cookies = await this.cookies.get(BASE + '/');
    if (!cookies || !cookies['XSRF-TOKEN']) {
      await this.http.text(BASE + '/');
      cookies = await this.cookies.get(BASE + '/');
    }
    const headers = {
      Accept: 'application/json',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: url,
      Origin: BASE,
    };
    const tok = cookies && cookies['XSRF-TOKEN'];
    if (tok) {
      try {
        headers['X-XSRF-TOKEN'] = decodeURIComponent(tok);
      } catch (_) {
        headers['X-XSRF-TOKEN'] = tok;
      }
    }
    const res = await this.http.request({
      url: BASE + '/player/api',
      method: 'POST',
      json: { episode_id: String(eid) },
      headers,
      readOnly: true,
      timeout: 30000,
    });
    if (!res.ok) {
      throw Park.error('HTTP', '播放接口返回 HTTP {status}', {
        params: { status: res.status },
        status: res.status,
      });
    }
    const data = res.json();
    const stream = String((data && data.stream_url) || '').replace(/^\/+|\/+$/g, '');
    const doms = [];
    for (const d of [...((data && data.stream_domains) || []), ...((data && data.asia_stream_domains) || [])]) {
      const s = String(d || '').replace(/\/+$/, '');
      if (/^https:\/\//.test(s) && !doms.includes(s)) doms.push(s);
    }
    if (!stream || !doms.length) throw Park.error('UNSUPPORTED', '此影片没有可用播放地址');
    return doms.map((d, i) => ({
      url: `${d}/${stream}/x264.720p.mp4`,
      quality: 720,
      label: '720P',
      format: 'mp4',
      headers: { Referer: BASE + '/' },
      ...(i === 0 ? { preferred: true } : {}),
    }));
  },
});
