// TwiHub (twihub.link) 的 HentaiPark 站点插件。
// 站点形态：Twitter 视频保存/排行榜站（SvelteKit SSR）。每个帖子 = 一条带视频的推文。
// 列表走站内 JSON 接口 GET /api/v1/posts?type=<realtime|1d|7d|30d>&limit=40&cursor=<游标>，
// 返回 {posts:[{postId, thumbnailUrl(pbs.twimg.com), likesCount, firstVideoDuration(秒)}], hasMore, nextCursor}；
// 列表接口不提供标题与作者，列表标题只能先用帖子编号占位，打开详情后以推文正文为真实标题。
// 搜索走 GET /api/v1/posts/search?q=<词>&sort=<newest|likes>&limit=40&cursor=<游标>（服务端搜索，
// 关键词至少 3 个字符、最长 100 个字符，与站内搜索页规则一致）。
// 详情页 /zh-cn/posts/<uuid> 是 SSR：#author-handle 是明确署名的推特作者（@handle），
// 其后的正文段落是推文原文，#video-link 指向 /r/v/<推文ID>。
// 播放：/r/v/<推文ID> 会 302 跳到 video.twimg.com 的 amplify_video MP4 直链；
// videos() 用 followRedirects:false 取 Location 后返回该 MP4（native 媒体会话）。
const BASE = 'https://twihub.link';
const PAGE_SIZE = 40;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fmtDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return undefined;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(r).padStart(2, '0')}`;
}

Park.register({
  key: 'twihub',
  name: 'TwiHub',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'shortvideo',
  color: '#A855F7',
  description: 'Twitter 视频保存排行榜，支持榜单、最新、搜索与 MP4 播放',
  homepage: BASE + '/zh-cn',
  domains: ['twihub.link'],
  linkPatterns: ['twihub\\.link/(?:zh-cn/)?posts/([0-9a-fA-F-]{36})'],
  idPattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: '1d',
  feeds: [
    { key: '1d', label: '24小时榜' },
    { key: '7d', label: '7天榜' },
    { key: '30d', label: '30天榜' },
    { key: 'realtime', label: '最新' },
  ],
  searchHint: '至少输入 3 个字符，可按推文关键词搜索',
  searchFilters: [{ key: 'sort', label: '排序', default: 'newest', values: [{ value: 'newest', label: '最新' }, { value: 'likes', label: '人气' }] }],

  validId(id) {
    const v = String(id || '');
    if (!UUID_RE.test(v)) throw Park.error('NOT_FOUND', '帖子编号无效');
    return v;
  },

  item(post) {
    const id = String(post?.postId || '');
    if (!UUID_RE.test(id)) return null;
    const cover = String(post?.thumbnailUrl || '');
    if (!/^https:\/\//.test(cover)) return null;
    // 列表接口没有标题/作者：标题先用编号占位（详情会给真实推文标题），不猜测内容。
    const item = { id, title: id, cover, coverAspect: 16 / 9, mediaKind: 'video' };
    const likes = Number(post?.likesCount);
    if (Number.isFinite(likes) && likes >= 0) item.likes = likes;
    const duration = fmtDuration(post?.firstVideoDuration);
    if (duration) item.duration = duration;
    return item;
  },

  async apiPage(path, params, cursor) {
    const q = { ...params, limit: String(PAGE_SIZE) };
    if (cursor) q.cursor = cursor;
    const data = await this.http.json(BASE + path, { params: q, timeout: 30000 });
    if (!data || !Array.isArray(data.posts)) throw Park.error('PARSE', '列表数据解析失败');
    return data;
  },

  // 游标分页：优先用上次返回的 cursor；没有 cursor 又要深页时从第一页逐页走到目标页。
  async listing(path, params, page, cursor) {
    page = Math.max(1, Number(page) || 1);
    let data = null;
    if (cursor) {
      data = await this.apiPage(path, params, String(cursor));
    } else if (page === 1) {
      data = await this.apiPage(path, params, null);
    } else {
      let walkCursor = null;
      for (let p = 1; p <= page; p++) {
        data = await this.apiPage(path, params, walkCursor);
        if (p === page) break;
        if (!data.hasMore || !data.nextCursor) return { items: [], page, hasNext: false };
        walkCursor = String(data.nextCursor);
      }
    }
    const items = data.posts.map((x) => this.item(x)).filter(Boolean);
    const hasNext = !!data.hasMore && !!data.nextCursor;
    return { items, page, hasNext, ...(hasNext ? { cursor: String(data.nextCursor) } : {}) };
  },

  async feed(key, { page, cursor } = {}) {
    if (!this.feeds.some((f) => f.key === key)) throw Park.error('CONFIG', '未知视频列表');
    return this.listing('/api/v1/posts', { type: key }, page, cursor);
  },

  async search({ keyword, page, cursor, filters } = {}) {
    const q = String(keyword || '').trim();
    if (!q) return { items: [], page: 1, hasNext: false };
    if (Array.from(q).length < 3) throw Park.error('CONFIG', '搜索关键词至少需要 3 个字符');
    if (Array.from(q).length > 100) throw Park.error('CONFIG', '搜索关键词过长');
    const sort = filters?.sort === 'likes' ? 'likes' : 'newest';
    return this.listing('/api/v1/posts/search', { q, sort }, page, cursor);
  },

  async detailPage(id) {
    const url = `${BASE}/zh-cn/posts/${id}`;
    const res = await this.http.get(url, { timeout: 30000 });
    if (res.status === 404) throw Park.error('NOT_FOUND', '帖子不存在');
    if (!res.ok) throw Park.error('HTTP', '站点返回 HTTP {status}', { status: res.status, params: { status: res.status } });
    return { url, doc: Park.html.parse(res.body) };
  },

  parseDetail(doc) {
    const handleEl = doc.querySelector('#author-handle span') || doc.querySelector('#author-handle');
    const handleRaw = (Park.html.text(handleEl) || '').trim();
    const handle = handleRaw.replace(/^@/, '').trim();
    const textEl = doc.querySelector('p.text-gray-200');
    const text = (Park.html.text(textEl) || '').trim();
    const videoEl = doc.querySelector('#video-link');
    const videoHref = videoEl ? videoEl.getAttribute('href') || '' : '';
    let likes;
    let duration;
    const stats = textEl && textEl.parentElement ? textEl.parentElement.querySelector('.mt-3') : null;
    if (stats) {
      const spans = stats.querySelectorAll('span');
      if (spans[0]) {
        const n = parseInt((Park.html.text(spans[0]) || '').replace(/[^0-9]/g, ''), 10);
        if (Number.isFinite(n)) likes = n;
      }
      if (spans[1]) duration = (Park.html.text(spans[1]) || '').trim() || undefined;
    }
    const related = [];
    const seen = new Set();
    for (const a of doc.querySelectorAll('a[href*="/zh-cn/posts/"]')) {
      const m = /\/zh-cn\/posts\/([0-9a-f-]{36})/i.exec(a.getAttribute('href') || '');
      if (!m || seen.has(m[1])) continue;
      const img = a.querySelector('img');
      if (!img) continue;
      seen.add(m[1]);
      related.push({ id: m[1], title: m[1], cover: img.getAttribute('src') || '', coverAspect: 16 / 9, mediaKind: 'video' });
    }
    return { handle, text, videoHref, likes, duration, related };
  },

  async detail(id, preview) {
    id = this.validId(id);
    const { url, doc } = await this.detailPage(id);
    const d = this.parseDetail(doc);
    if (!d.text && !d.videoHref) throw Park.error('NOT_FOUND', '帖子不存在');
    const title = d.text || id;
    const prev = preview && String(preview.id || '') === id ? preview : null;
    const cover = prev && /^https:\/\//.test(String(prev.cover || '')) ? String(prev.cover) : '';
    const out = {
      id,
      title,
      cover,
      url,
      description: d.text || '',
      chapters: null,
      mediaKind: 'video',
    };
    if (d.handle) {
      out.authors = [d.handle];
      out.uploader = d.handle;
    }
    const likes = d.likes !== undefined ? d.likes : prev?.likes;
    if (likes !== undefined) out.likes = likes;
    const duration = d.duration || prev?.duration;
    if (duration) out.duration = duration;
    if (d.related.length) out.related = d.related.filter((x) => x.id !== id);
    return out;
  },

  async videos(id) {
    id = this.validId(id);
    const { doc } = await this.detailPage(id);
    const d = this.parseDetail(doc);
    const m = /^\/r\/v\/(\d+)$/.exec(d.videoHref || '');
    if (!m) throw Park.error('UNSUPPORTED', '该帖子没有可用视频');
    const redirectUrl = BASE + d.videoHref;
    const res = await this.http.request({ url: redirectUrl, followRedirects: false, timeout: 30000 });
    let location = '';
    if (res.headers) {
      for (const [k, v] of Object.entries(res.headers)) {
        if (k.toLowerCase() === 'location') location = String(v);
      }
    }
    if (res.status >= 300 && res.status < 400 && location) {
      let u;
      try { u = new URL(location); } catch (_) { u = null; }
      if (!u || u.protocol !== 'https:' || u.hostname !== 'video.twimg.com' || !u.pathname.endsWith('.mp4')) {
        throw Park.error('PARSE', '视频地址解析失败');
      }
      return [{ url: u.href, format: 'mp4', label: '原画', preferred: true }];
    }
    if (res.ok) {
      // 站点若改为直出文件，退回跳转入口本身（媒体会话会逐跳授权）
      return [{ url: redirectUrl, format: 'mp4', label: '原画', preferred: true }];
    }
    throw Park.error('HTTP', '站点返回 HTTP {status}', { status: res.status, params: { status: res.status } });
  },
});
