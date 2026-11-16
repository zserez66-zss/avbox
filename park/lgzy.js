// 蓝光资源 (lgzyz.xyz) 的 HentaiPark 站点插件。
// 站点形态：MacCMS 资源站，列表/详情/搜索走官方接口站 lgapi.xyz 的
// /api.php/provide/vod/ 接口（ac=detail，t=分类、ids=详情、wd=搜索词）。
// 详情的 vod_play_url 是「集名$https://lgvideo.xyz/player/<码>」用 # 分集。
// 播放说明：lgvideo 链接本身直取返回 403，必须经解析站 vv00.xyz；vv00 现行
// 验证需要真实浏览器指纹与父页面（MacCMS 的 MacPlayer）消息通道，普通 HTTP
// 伪造 payload 两次实测均返回 {"success":false,"error":"verify failed"}，
// 未验证时 ruabo 播放地址返回 403，故本插件不实现 videos()，改用 webVideo
// 返回演示站 yanshi.lgzyz.xyz 的站内真实播放页（MacCMS 播放页，内嵌 vv00
// 解析 iframe 并提供 MacPlayer 通道，与用户在网页上观看的路径一致）。
const API = 'https://lgapi.xyz';
const SITE = 'https://lgzyz.xyz';
const PLAY_SITE = 'https://yanshi.lgzyz.xyz';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 与本站 TVBox 源一致的分类（type_id 为接口的 t 参数）。
const FEEDS = [
  { key: 'movie', label: '电影', tid: '1' },
  { key: 'series', label: '连续剧', tid: '13' },
  { key: 'anime', label: '动漫', tid: '53' },
  { key: 'variety', label: '综艺', tid: '57' },
  { key: 'sports', label: '体育赛事', tid: '61' },
  { key: 'short', label: '短剧', tid: '65' },
  { key: 'commentary', label: '电影解说', tid: '51' },
  { key: 'trailer', label: '预告片', tid: '52' },
];

function splitNames(s) {
  if (!s) return [];
  return String(s).split(/[,，、]/).map((x) => x.trim()).filter(Boolean);
}

function toItem(it) {
  const item = {
    id: String(it.vod_id),
    title: String(it.vod_name || '').trim(),
    cover: String(it.vod_pic || ''),
    coverAspect: 0.75,
  };
  const remarks = String(it.vod_remarks || '').trim();
  if (remarks) item.subtitle = remarks;
  const authors = splitNames(it.vod_actor);
  if (authors.length) item.authors = authors;
  return item;
}

function parseEpisodes(playUrl) {
  const first = String(playUrl || '').split('$$$')[0];
  const episodes = [];
  for (const part of first.split('#')) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf('$');
    const name = i >= 0 ? p.slice(0, i).trim() : '';
    const url = i >= 0 ? p.slice(i + 1).trim() : '';
    if (!url) continue;
    episodes.push({ id: String(episodes.length + 1), title: name || `第${episodes.length + 1}集` });
  }
  return episodes;
}

Park.register({
  key: 'lgzy',
  name: '蓝光资源',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'other',
  description: '蓝光资源影视站：电影、连续剧、动漫、综艺等，播放走站内网页播放器',
  homepage: SITE,
  domains: ['lgzyz.xyz', 'lgapi.xyz'],
  linkPatterns: [
    '(?:lgzyz\\.xyz|yanshi\\.lgzyz\\.xyz)/index\\.php/vod/detail/id/(\\d+)\\.html',
  ],
  idPattern: '^(\\d+)$',
  imageHeaders: { Referer: SITE + '/' },
  network: { mode: 'auto', vpnHint: true },
  defaultFeed: 'movie',
  feeds: FEEDS.map(({ key, label }) => ({ key, label })),
  searchHint: '搜索片名或演员',

  async api(params) {
    const qs = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const data = await this.http.json(`${API}/api.php/provide/vod/?ac=detail&${qs}`, {
      headers: { 'User-Agent': UA, Referer: SITE + '/' },
    });
    if (!data || data.code !== 1) throw Park.error('PARSE', '接口返回异常');
    return data;
  },

  listPage(data, page) {
    const items = (Array.isArray(data.list) ? data.list : [])
      .filter((it) => it && it.vod_id && it.vod_name)
      .map(toItem);
    const totalPages = Number(data.pagecount) || page;
    return { items, page, totalPages, total: Number(data.total) || undefined, hasNext: page < totalPages };
  },

  async feed(key, { page }) {
    const feed = FEEDS.find((f) => f.key === key);
    if (!feed) throw Park.error('CONFIG', '未知的分类');
    return this.listPage(await this.api({ t: feed.tid, pg: page }), page);
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page, hasNext: false };
    return this.listPage(await this.api({ wd: kw, pg: page }), page);
  },

  async detail(id) {
    if (!/^\d+$/.test(String(id))) throw Park.error('NOT_FOUND', '影片不存在');
    const data = await this.api({ ids: id });
    const it = Array.isArray(data.list) ? data.list[0] : null;
    if (!it) throw Park.error('NOT_FOUND', '影片不存在');
    const episodes = parseEpisodes(it.vod_play_url);
    const meta = [it.vod_year, it.vod_area, it.vod_class].map((x) => String(x || '').trim()).filter(Boolean);
    const director = String(it.vod_director || '').trim();
    if (director) meta.push(`导演：${director}`);
    let content = String(it.vod_content || '').trim();
    if (content === '暂无简介') content = '';
    if (!content) {
      const blurb = String(it.vod_blurb || '').trim();
      if (blurb && blurb !== '暂无简介') content = blurb;
    }
    const description = [meta.join(' · '), content].filter(Boolean).join('\n\n');
    const out = {
      id: String(id),
      title: String(it.vod_name || '').trim(),
      cover: String(it.vod_pic || ''),
      coverAspect: 0.75,
      url: `${PLAY_SITE}/index.php/vod/detail/id/${id}.html`,
      description,
      authors: splitNames(it.vod_actor),
    };
    const remarks = String(it.vod_remarks || '').trim();
    if (remarks) out.subtitle = remarks;
    if (episodes.length > 1) {
      out.chapters = episodes;
    } else if (episodes.length === 1) {
      out.chapters = null;
      out.singleChapterId = '1';
    } else {
      out.chapters = null;
    }
    return out;
  },

  async webVideo(id, episodeId = '_') {
    if (!/^\d+$/.test(String(id))) throw Park.error('NOT_FOUND', '影片不存在');
    const nid = episodeId && episodeId !== '_' ? String(episodeId) : '1';
    if (!/^\d+$/.test(nid)) throw Park.error('NOT_FOUND', '分集不存在');
    return {
      url: `${PLAY_SITE}/index.php/vod/play/id/${id}/sid/1/nid/${nid}.html`,
      navigationDomains: ['yanshi.lgzyz.xyz'],
      frameDomains: ['vv00.xyz'],
    };
  },
});
