// 秒看电影 (miaokan.cc) 的 HentaiPark 站点插件。
// 站点形态：MacCMS 变体（ewave 模板）的主流影视站。
// 列表：/label/new/、/mk/<分类>/、/label/ranking/ —— 站方列表没有真分页
// （?page=2、/page/2/ 返回的都是第 1 页原样），故 feed 只给单页：
// 第 1 页返回全部条目，第 2 页起返回空列表且 hasNext=false，避免重复。
// 搜索：走站点 suggest 接口 /index.php/ajax/suggest?mid=1&wd=关键词（JSON），
// 无结果时兜底解析搜索页 /sosomk/-------------/?wd=关键词。
// 详情：/miaokan/<id>/，播放列表 tab 是线路（sid），条目是集数；
// 本插件只把首选线路的分集作为 chapters（YZZY 线路排最后，与 py 源一致），
// videos() 取流失败时按 py 源逻辑换同集的其它线路再试。
// 播放：/mkvod/<id>-<线路>-<集数>/ 页里 var player_aaaa 的 url 即 m3u8（HLS）；
// 主清单（master）原样返回，由应用展开选档（py 源为 TVBox 播放器才预先解主清单）。
const BASE = 'https://miaokan.cc';

const FEED_PATHS = {
  new: 'label/new',
  dianying: 'mk/dianying',
  lianxuju: 'mk/lianxuju',
  zongyi: 'mk/zongyi',
  dongman: 'mk/dongman',
  duanju: 'mk/duanju',
  yingshijieshuo: 'mk/yingshijieshuo',
  ranking: 'label/ranking',
};

function clean(text) {
  let t = String(text || '').replace(/<.*?>/g, '');
  for (const [a, b] of [['&nbsp;', ' '], ['&amp;', '&'], ['&#038;', '&'], ['&quot;', '"'], ['&#039;', "'"]]) {
    t = t.split(a).join(b);
  }
  return t.replace(/\s+/g, ' ').trim();
}

function match(text, re) {
  const m = re.exec(text || '');
  return m ? m[1].trim() : '';
}

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 列表解析与 py 源 _parse_list 一致：按带 title 的详情链接提取，
// 在链接后 800 字符窗口内取封面与状态。
function parseList(html) {
  const items = [];
  const seen = new Set();
  const re = /<a[^>]+href="\/miaokan\/(\d+)\/"[^>]*>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const tag = m[0];
    const vid = m[1];
    if (seen.has(vid) || !tag.includes('title=')) continue;
    const win = html.slice(m.index, m.index + 800);
    const name = clean(match(tag, /title="([^"]+)"/i));
    const pic = match(win, /data-original="([^"]+)"/i)
      || match(win, /data-src="([^"]+)"/i)
      || match(win, /src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp))"/i);
    const remarks = clean(match(win, /class="(?:item-status|text-overflow)"[^>]*>([^<]{0,20})</i));
    if (!name) continue;
    seen.add(vid);
    const item = { id: vid, title: name, cover: abs(pic) };
    if (remarks) item.subtitle = remarks;
    items.push(item);
  }
  return items;
}

// 播放列表解析与 py 源 _playlist 一致：tab 的 sid 是线路号，
// 返回 [{sid, label, eps: [{href, title}]}]，YZZY 线路排到最后。
function parsePlaylist(html) {
  let tabs = [...(html || '').matchAll(/data-target="#ewave-playlist-(\d+)"[^>]*>\s*([^<]{1,16})\s*<em/g)]
    .map((m) => [m[1], clean(m[2])]);
  if (!tabs.length) {
    tabs = [...(html || '').matchAll(/id="ewave-playlist-(\d+)"/g)].map((m) => [m[1], '线路' + m[1]]);
  }
  const lines = [];
  for (const [sid, label] of tabs) {
    const block = new RegExp(`id="ewave-playlist-${sid}"[\\s\\S]*?</ul>`).exec(html || '');
    if (!block) continue;
    const eps = [...block[0].matchAll(new RegExp(`href="(/mkvod/\\d+-${sid}-\\d+/)"[^>]*>\\s*([^<]{1,20})\\s*<`, 'g'))]
      .map((e) => ({ href: e[1], title: clean(e[2]) }));
    if (!eps.length) continue;
    lines.push({ sid, label, eps });
  }
  const yzzy = (l) => (l.label.toUpperCase().startsWith('YZZY') ? 1 : 0);
  lines.sort((a, b) => yzzy(a) - yzzy(b));
  return lines;
}

// 集数 href /mkvod/<作品>-<线路>-<集数>/ → 章节 ID "<线路>-<集数>"
function episodeIdOf(href) {
  const m = /\/mkvod\/\d+-(\d+)-(\d+)\//.exec(href || '');
  return m ? `${m[1]}-${m[2]}` : '';
}

Park.register({
  key: 'miaokan',
  name: '秒看电影',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'video',
  category: 'other',
  description: '电影、电视剧、综艺、动漫与短剧，HLS 播放',
  homepage: BASE,
  domains: ['miaokan.cc'],
  linkPatterns: ['miaokan\\.cc/miaokan/(\\d+)'],
  idPattern: '^(\\d+)$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'browser', scope: 'session', origin: BASE },
  defaultFeed: 'new',
  feeds: [
    { key: 'new', label: '最近更新' },
    { key: 'dianying', label: '电影' },
    { key: 'lianxuju', label: '电视剧' },
    { key: 'zongyi', label: '综艺' },
    { key: 'dongman', label: '动漫' },
    { key: 'duanju', label: '短剧' },
    { key: 'yingshijieshuo', label: '影视解说' },
    { key: 'ranking', label: '排行榜' },
  ],
  searchHint: '搜索片名',

  validId(id) {
    const value = String(id || '').trim();
    if (!/^\d+$/.test(value)) throw Park.error('NOT_FOUND', '影片编号无效');
    return value;
  },

  async feed(key, { page }) {
    const path = FEED_PATHS[key];
    if (!path) throw Park.error('CONFIG', '未知列表');
    // 站方列表无真分页，第 2 页起按设计返回空（见文件头注释）。
    if (page > 1) return { items: [], page, hasNext: false };
    const html = await this.http.text(`${BASE}/${path}/`);
    return { items: parseList(html), page: 1, hasNext: false };
  },

  async search({ keyword, page }) {
    if (page > 1) return { items: [], page, hasNext: false };
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    let items = [];
    try {
      const data = await this.http.json(BASE + '/index.php/ajax/suggest?mid=1&wd=' + encodeURIComponent(kw));
      for (const it of (data && data.list) || []) {
        const id = String((it && it.id) || '');
        const title = String((it && it.name) || '').trim();
        if (!id || !title) continue;
        items.push({ id, title, cover: abs(it.pic || '') });
      }
    } catch (_) {
      items = [];
    }
    if (!items.length) {
      const html = await this.http.text(BASE + '/sosomk/-------------/?wd=' + encodeURIComponent(kw));
      items = parseList(html);
    }
    return { items, page: 1, hasNext: false };
  },

  async detail(id) {
    const vid = this.validId(id);
    const url = `${BASE}/miaokan/${vid}/`;
    const html = await this.http.text(url);
    const title = clean(match(html, /class="vod-info[\s\S]{0,800}?<h3>\s*<a[^>]*>(.*?)<\/a>/i)
      || match(html, /<title>(.*?)<\/title>/i).split('-')[0]);
    if (!title) throw Park.error('NOT_FOUND', '影片不存在');
    const cover = abs(match(html, /class="vod-info[\s\S]{0,800}?data-original="([^"]+)"/i));
    const metaDesc = clean(match(html, /<meta\s+name="description"\s+content="([^"]*)"/i));
    const info = {};
    for (const label of ['分类', '地区', '年份', '导演', '主演', '更新']) {
      const v = match(html, new RegExp(label + '：\\s*(?:<[^>]+>)*\\s*([^<]{0,120}?)\\s*(?:<|$)', 'i'));
      if (v) info[label] = clean(v);
    }
    const lines = parsePlaylist(html);
    if (!lines.length) throw Park.error('PARSE', '未解析到播放列表');
    const chapters = lines[0].eps
      .map((ep) => ({ id: episodeIdOf(ep.href), title: ep.title }))
      .filter((c) => c.id && c.title);
    if (!chapters.length) throw Park.error('PARSE', '未解析到分集列表');
    const authors = (info['主演'] || '')
      .split(/[,，、]/)
      .map((s) => s.trim())
      .filter((s) => s && s !== '未知' && s !== '暂无');
    const infoLine = ['地区', '年份', '导演', '主演', '更新']
      .filter((k) => info[k])
      .map((k) => `${k}：${info[k]}`)
      .join(' · ');
    const out = {
      id: vid,
      title,
      cover,
      url,
      description: [metaDesc, infoLine].filter(Boolean).join('\n'),
      chapters: chapters.length > 1 ? chapters : null,
    };
    if (chapters.length === 1) out.singleChapterId = chapters[0].id;
    if (authors.length) out.authors = authors;
    if (info['分类']) out.category = info['分类'];
    if (info['更新']) out.subtitle = info['更新'];
    return out;
  },

  // 播放页 → player_aaaa.url（与 py 源 _m3u8_of 一致）
  async m3u8Of(vid, sid, nid) {
    let html = '';
    try {
      const res = await this.http.get(`${BASE}/mkvod/${vid}-${sid}-${nid}/`, {
        headers: { Referer: BASE + '/' },
      });
      if (!res.ok) return '';
      html = res.body || '';
    } catch (_) {
      return '';
    }
    const pm = /var\s+player_aaaa\s*=\s*(\{.*?\})<\/script>/s.exec(html);
    if (pm) {
      try {
        const d = JSON.parse(pm[1]);
        if (d && d.url) return String(d.url);
      } catch (_) { /* 落到正则兜底 */ }
    }
    const m = /(https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*)/.exec(html);
    return m ? m[1] : '';
  },

  // 与 py 源 _alive 一致：m3u8 能拉到且以 #EXTM3U 开头才算活线。
  async alive(url) {
    try {
      const res = await this.http.get(url, {
        headers: { Referer: BASE + '/' },
        timeout: 12000,
      });
      return res.ok && String(res.body || '').includes('#EXTM3U');
    } catch (_) {
      return false;
    }
  },

  hlsEntry(url) {
    if (/\.m3u8(\?|$)/i.test(url)) {
      return { url, format: 'hls', label: '原画', preferred: true, headers: { Referer: BASE + '/' } };
    }
    return { url, label: '原画', preferred: true, headers: { Referer: BASE + '/' } };
  },

  async videos(id, episodeId = '_') {
    const vid = this.validId(id);
    let sid = '';
    let nid = '';
    const em = /^(\d+)-(\d+)$/.exec(String(episodeId || ''));
    if (em) {
      sid = em[1];
      nid = em[2];
    } else {
      const html = await this.http.text(`${BASE}/miaokan/${vid}/`);
      const lines = parsePlaylist(html);
      if (!lines.length) throw Park.error('PARSE', '未解析到播放列表');
      const first = episodeIdOf(lines[0].eps[0].href);
      const fm = /^(\d+)-(\d+)$/.exec(first);
      if (!fm) throw Park.error('PARSE', '未解析到分集列表');
      sid = fm[1];
      nid = fm[2];
    }
    const primary = await this.m3u8Of(vid, sid, nid);
    if (primary && await this.alive(primary)) return [this.hlsEntry(primary)];
    // 这条线挂了，换同集的其它线路试（与 py 源 _alt_line 一致）。
    for (let other = 1; other <= 8; other++) {
      if (String(other) === sid) continue;
      const alt = await this.m3u8Of(vid, String(other), nid);
      if (alt && alt !== primary && await this.alive(alt)) return [this.hlsEntry(alt)];
    }
    if (primary) return [this.hlsEntry(primary)];
    throw Park.error('UNSUPPORTED', '未解析到播放地址');
  },
});
