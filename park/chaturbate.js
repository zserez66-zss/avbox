// Chaturbate 公开直播的 HentaiPark 站点插件（type video / category live）。
// 列表走站方公开 roomlist 接口（limit/offset 分页，genders=f/m/c/s 过滤，
// keywords= 为站方真搜索，匹配标签与用户名）；房间标题、封面、观看数均出自该接口。
// 播放：/api/chatvideocontext/<用户名>/ 返回 hls_source（edge*.live.mmcdn.com 的
// LL-HLS 主清单），但清单带 EXT-X-PART / SERVER-CONTROL 低延迟分片，HentaiPark 的
// 原生 HLS 管线不支持（真机实测报「HLS 使用了不支持的媒体格式」）。按协议的回退
// 机制处理：videos() 对可达房间抛 UNSUPPORTED，应用随即自动回退 webVideo 用站方
// 网页播放器播放（浏览器原生支持 LL-HLS）。不实现直播聊天（liveChat）。
const BASE = 'https://chaturbate.com';
const API = BASE + '/api/ts/roomlist/room-list/';
const PAGE_SIZE = 30;

const GENDER_FEEDS = { female: 'f', male: 'm', couple: 'c', trans: 't' };

// 站方对非浏览器 UA 的 API 请求返回年龄确认 HTML 页而非 JSON，必须显式带浏览器 UA
const REQ_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  Referer: BASE + '/',
};

function roomItem(r) {
  const item = {
    id: r.username,
    title: (r.room_subject || r.username || '').trim() || r.username,
    cover: r.img || '',
  };
  if (Array.isArray(r.tags) && r.tags.length) item.tags = r.tags.slice(0, 12);
  return item;
}

Park.register({
  key: 'chaturbate',
  name: 'Chaturbate',
  version: '0.0.2',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'live',
  language: 'en',
  homepage: BASE,
  domains: ['chaturbate.com'],
  linkPatterns: ['chaturbate\\.com/([A-Za-z0-9_]+)/?'],
  idPattern: '^[A-Za-z0-9_]{1,80}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: 'hot',
  feeds: [
    { key: 'hot', label: '热门' },
    { key: 'female', label: '女主播' },
    { key: 'male', label: '男主播' },
    { key: 'couple', label: '情侣' },
    { key: 'trans', label: '变性' },
  ],

  async roomList(extra, page) {
    const qs = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String((page - 1) * PAGE_SIZE),
      ...extra,
    });
    const r = await this.http.get(`${API}?${qs}`, { headers: REQ_HEADERS, timeout: 30000 });
    if (!r.ok) throw Park.error('HTTP', `房间列表请求失败（${r.status}）`, { status: r.status });
    let d;
    try { d = r.json(); } catch (_) { throw Park.error('PARSE', '房间列表数据无效'); }
    const rooms = Array.isArray(d.rooms) ? d.rooms : [];
    const total = typeof d.total_count === 'number' ? d.total_count : rooms.length;
    return {
      items: rooms.filter((x) => x && x.username).map(roomItem),
      page,
      hasNext: (page - 1) * PAGE_SIZE + rooms.length < total,
      totalPages: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    };
  },

  async feed(key, { page }) {
    if (key === 'hot') return this.roomList({}, page);
    const g = GENDER_FEEDS[key];
    if (!g) throw Park.error('CONFIG', '未知直播列表');
    return this.roomList({ genders: g }, page);
  },

  async search({ keyword, page }) {
    return this.roomList({ keywords: keyword }, page);
  },

  async roomContext(id) {
    const r = await this.http.get(`${BASE}/api/chatvideocontext/${encodeURIComponent(id)}/`, { headers: REQ_HEADERS, timeout: 30000 });
    if (!r.ok) throw Park.error(r.status === 404 ? 'NOT_FOUND' : 'HTTP', r.status === 404 ? '直播间不存在' : '直播请求失败', { status: r.status });
    try { return r.json(); } catch (_) { throw Park.error('PARSE', '直播数据无效'); }
  },

  async detail(id) {
    const d = await this.roomContext(id);
    return {
      id,
      title: (d.room_title || id).trim() || id,
      cover: d.summary_card_image || `https://thumb.live.mmcdn.com/ri/${id}.jpg`,
      url: `${BASE}/${id}/`,
      description: d.room_title || '',
      tags: [],
      chapters: null,
      mediaKind: 'video',
    };
  },

  async videos(id) {
    // 先确认房间存在（不存在按 NOT_FOUND 报错，不触发网页回退）；
    // 房间可达时一律 UNSUPPORTED —— 站方只有 LL-HLS 流，应用原生管线不支持，
    // 抛此错误后应用会自动回退到下面的 webVideo 网页播放。
    await this.roomContext(id);
    throw Park.error('UNSUPPORTED', '该站直播为低延迟 HLS，应用原生播放暂不支持，已转网页播放');
  },

  async webVideo(id) {
    return {
      url: `${BASE}/${id}/`,
      navigationDomains: ['chaturbate.com'],
      frameDomains: [],
    };
  },
});
