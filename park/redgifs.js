// RedGIFs (redgifs.com) 的 HentaiPark 站点插件。
// 站点形态：GIF 风格短视频站，走官方公开 API v2，全程 JSON，无 HTML 解析。
// 每个作品 = 一个短视频，videos(id, '_') 返回 urls.hd 直链 MP4（SD 作备选）。
// 匿名鉴权：GET /v2/auth/temporary 拿 JWT，存 this.store，请求带 Bearer；
// 令牌与出口 IP 绑定，401 时刷新一次再重试（逻辑照本站 TVBox py 源）。
// 信息流统一走搜索端点：/v2/gifs/search?order=trending|latest&count=30&page=N。
// 搜索关键词参数实测为 query=（py 源写的 search_text 会被 API 忽略、原样返回
// 热门流，是假搜索；query=zzzz 类无结果词返回空、真实词返回对应结果，已对照验证）。
// 分区（niche）：GET /v2/niches/<slug>/gifs?count=30&page=N，该端点传
// order=trending 会 400，故不传 order 用默认排序（同 py 源）。
// type=2 的条目是图片帖（urls 只有 .jpg、没有 mp4），列表里过滤掉，只收视频。
const API = 'https://api.redgifs.com';
const SITE = 'https://www.redgifs.com';
const PER_PAGE = 30;

// py 源实测存在的分区：[slug, 显示名]
const NICHES = [
  ['just-boobs', 'Just Boobs'],
  ['blowjobs', 'Blowjobs'],
  ['thick-booty', 'Thick Booty'],
  ['lips-that-grip', 'Lips That Grip'],
  ['legal-teens', 'Legal Teens'],
  ['amateur-girls', 'Amateur Girls'],
  ['real-orgasms', 'Real Orgasms'],
  ['tik-tok', 'Tik Tok'],
  ['real-couples', 'Real Couples'],
  ['rough-sex', 'Rough Sex'],
  ['creampies', 'Creampies'],
  ['girls-finishing-the-job', 'Girls Finishing The Job'],
  ['goth-girls', 'Goth Girls'],
];

function playUrl(gif) {
  const urls = (gif && gif.urls) || {};
  for (const k of ['hd', 'sd', 'silent']) {
    const u = String(urls[k] || '').trim();
    if (/^https:\/\//i.test(u) && u.split('?')[0].endsWith('.mp4')) return u;
  }
  return '';
}

// API 条目 → WorkItem；无 mp4 的图片帖返回 null（同 py 源 _to_vod）。
// 标题只取 API 明确字段：description 为空时按 py 源用 userName + 前 3 个 tags 拼，不猜。
function toItem(gif) {
  if (!gif || typeof gif !== 'object') return null;
  const id = String(gif.id || '').trim();
  if (!id || !playUrl(gif)) return null;
  const urls = gif.urls || {};
  const cover = String(urls.poster || urls.thumbnail || '').trim();
  let title = String(gif.description || '').replace(/\s+/g, ' ').trim();
  if (!title) {
    const user = String(gif.userName || '').trim();
    const tags = (Array.isArray(gif.tags) ? gif.tags : []).slice(0, 3).map((t) => String(t));
    title = [user, ...tags].filter(Boolean).join(' ') || id;
  }
  const item = { id, title, cover: /^https:\/\//i.test(cover) ? cover : '' };
  const dur = Number(gif.duration);
  if (Number.isFinite(dur) && dur > 0) item.duration = dur;
  const w = Number(gif.width), h = Number(gif.height);
  if (w > 0 && h > 0) item.coverAspect = w / h;
  if (Number.isFinite(Number(gif.likes))) item.likes = Number(gif.likes);
  if (Number.isFinite(Number(gif.views))) item.views = Number(gif.views);
  const user = String(gif.userName || '').trim();
  if (user) { item.authors = [user]; item.uploader = user; }
  if (Array.isArray(gif.tags) && gif.tags.length) item.tags = gif.tags.map((t) => String(t));
  return item;
}

Park.register({
  key: 'redgifs',
  name: 'RedGIFs',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'shortvideo',
  color: '#e52d27',
  description: '短视频热门、最新与分区浏览，支持搜索与 MP4 播放',
  homepage: SITE + '/',
  domains: ['redgifs.com'],
  linkPatterns: ['redgifs\\.com/watch/([A-Za-z0-9]+)'],
  idPattern: '^[A-Za-z0-9]{4,64}$',
  network: { mode: 'native', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: 'https://www.redgifs.com' },
  defaultFeed: 'trending',
  feeds: [
    { key: 'trending', label: '热门' },
    { key: 'latest', label: '最新' },
    {
      key: 'niche', label: '分区',
      options: [{
        key: 'niche', label: '分区', type: 'select', default: 'just-boobs',
        values: NICHES.map(([value, label]) => ({ value, label })),
      }],
    },
  ],

  async auth() {
    const res = await this.http.get(API + '/v2/auth/temporary', { timeout: 30000 });
    if (!res.ok) throw Park.error('HTTP', 'RedGIFs 授权失败，站点返回 HTTP {status}', { status: res.status, params: { status: res.status } });
    let data;
    try { data = res.json(); } catch (_) { throw Park.error('PARSE', 'RedGIFs 授权响应解析失败'); }
    const token = String((data && data.token) || '');
    if (!token) throw Park.error('PARSE', 'RedGIFs 授权响应解析失败');
    this.store.set('token', token);
    return token;
  },

  // 带令牌的 GET；401 时刷新令牌重试一次（令牌与出口 IP 绑定，换 IP 必 401）。
  async api(path, params, retry = true) {
    let token = this.store.get('token', '');
    if (!token) token = await this.auth();
    const res = await this.http.get(API + path, {
      params, timeout: 30000,
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    });
    if (res.status === 401 && retry) {
      this.store.set('token', null);
      await this.auth();
      return this.api(path, params, false);
    }
    if (!res.ok) throw Park.error('HTTP', 'RedGIFs 请求失败，站点返回 HTTP {status}', { status: res.status, params: { status: res.status } });
    try { return res.json(); } catch (_) { throw Park.error('PARSE', 'RedGIFs 返回的数据无效'); }
  },

  async gifPage(path, params, page) {
    const data = await this.api(path, params);
    const rows = data && Array.isArray(data.gifs) ? data.gifs : [];
    const items = rows.map(toItem).filter(Boolean);
    const pages = Number(data && data.pages) || 0;
    return { items, page, totalPages: pages || undefined, hasNext: pages > page };
  },

  async feed(key, { page, options } = {}) {
    const p = Math.max(1, Number(page) || 1);
    if (key === 'trending' || key === 'latest') {
      const order = key === 'trending' ? 'trending' : 'latest';
      return this.gifPage('/v2/gifs/search', { order, count: PER_PAGE, page: p }, p);
    }
    if (key === 'niche') {
      const slug = String((options && options.niche) || 'just-boobs');
      if (!NICHES.some(([s]) => s === slug)) throw Park.error('CONFIG', '分区参数无效');
      // 该端点不接 order（传 trending 会 400），用默认排序，同 py 源。
      return this.gifPage(`/v2/niches/${slug}/gifs`, { count: PER_PAGE, page: p }, p);
    }
    throw Park.error('CONFIG', '未知的信息流');
  },

  async search({ keyword, page } = {}) {
    const q = String(keyword || '').trim();
    if (!q) throw Park.error('CONFIG', '搜索关键词为空');
    const p = Math.max(1, Number(page) || 1);
    // 关键词参数实测为 query=；search_text 会被 API 忽略（见文件头注释）。
    return this.gifPage('/v2/gifs/search', { query: q, order: 'trending', count: PER_PAGE, page: p }, p);
  },

  async detail(id) {
    const gid = String(id || '').trim().toLowerCase();
    if (!/^[a-z0-9]{4,64}$/.test(gid)) throw Park.error('NOT_FOUND', '短视频编号无效');
    const data = await this.api('/v2/gifs/' + gid);
    const gif = data && data.gif;
    const item = toItem(gif);
    if (!item) throw Park.error('NOT_FOUND', '短视频不存在或没有可用视频');
    const tags = (Array.isArray(gif.tags) ? gif.tags : []).map((t) => ({ name: String(t), keyword: String(t) }));
    return {
      ...item,
      url: `${SITE}/watch/${gid}`,
      description: String(gif.description || '').trim(),
      chapters: null,
      tags: tags.length ? [{ namespace: 'tag', label: '标签', tags }] : [],
    };
  },

  async videos(id, episodeId = '_') {
    const gid = String(id || '').trim().toLowerCase();
    if (!/^[a-z0-9]{4,64}$/.test(gid)) throw Park.error('NOT_FOUND', '短视频编号无效');
    const data = await this.api('/v2/gifs/' + gid);
    const gif = data && data.gif;
    if (!gif) throw Park.error('NOT_FOUND', '短视频不存在');
    const urls = gif.urls || {};
    const out = [];
    const hd = String(urls.hd || '').trim();
    if (/^https:\/\//i.test(hd) && hd.split('?')[0].endsWith('.mp4')) {
      out.push({ url: hd, format: 'mp4', label: 'HD', preferred: true, headers: { Referer: SITE + '/' } });
    }
    const sd = String(urls.sd || '').trim();
    if (/^https:\/\//i.test(sd) && sd.split('?')[0].endsWith('.mp4') && sd !== hd) {
      out.push({ url: sd, format: 'mp4', label: 'SD', headers: { Referer: SITE + '/' } });
    }
    if (!out.length) throw Park.error('UNSUPPORTED', '此短视频没有可用 MP4');
    return out;
  },
});
