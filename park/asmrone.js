// ASMR.one (www.asmr.one) 的 HentaiPark 站点插件。
// 站点形态：同人音声目录站。作品列表走公开 API（api.asmr-200.com）：
//   列表 /api/works?page=N&pageSize=24&order=<字段>&sort=<方向>
//   搜索 /api/search/<关键词>?page=N（每页 20 条，服务端搜索）
//   详情 /api/work/<id>；目录树 /api/tracks/<id>?v=2
// 目录树是多文件结构：folder 节点（无 hash，用索引路径作稳定 ID）下有
// audio / text / image / other 文件（hash 即稳定文件 ID）。音频同目录常有
// 同名 .vtt 字幕（type 为 text，按扩展名识别为字幕节点并与音频关联）。
// 音频直链取节点的 mediaStreamUrl（匿名可播，另有 streamLowQualityUrl 低码率版）；
// 无 mediaStreamUrl 时回退 /api/media/stream/<hash>。纯图片等无音频作品
// 在目录里如实呈现其文件，不伪造音频。
const BASE = 'https://www.asmr.one';
const API = 'https://api.asmr-200.com/api';
const PAGE_SIZE = 24;
const SEARCH_PAGE_SIZE = 20;
const DIR_PAGE_SIZE = 100;
const SUB_EXTS = ['vtt', 'lrc', 'srt'];
const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus'];

const FEEDS = {
  latest: { order: 'release', sort: 'desc' },
  popular: { order: 'dl_count', sort: 'desc' },
  rating: { order: 'rate_average_2dp', sort: 'desc' },
  price: { order: 'price', sort: 'asc' },
};
// 关键词标签页：本站没有对应分类接口，用服务端搜索实现（与搜索同一接口）。
const KEYWORD_FEEDS = {
  chinese: '简体中文',
  lick: '耳舐め',
  whisper: 'ささやき',
  binaural: 'バイノーラル',
};

function extOf(title) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(title || '').trim());
  return m ? m[1].toLowerCase() : '';
}

function tagName(t) {
  if (!t || typeof t !== 'object') return String(t || '');
  const i18n = t.i18n || {};
  for (const k of ['zh-cn', 'zh-tw', 'ja-jp', 'en-us']) {
    if (i18n[k] && i18n[k].name) return String(i18n[k].name);
  }
  return String(t.name || t.id || '');
}

function workItem(w) {
  const id = String(w.id || '');
  const vas = (Array.isArray(w.vas) ? w.vas : []).map((v) => String((v && v.name) || '')).filter(Boolean);
  const item = {
    id,
    title: String(w.title || ''),
    cover: String(w.mainCoverUrl || w.samCoverUrl || w.thumbnailCoverUrl || ''),
    mediaKind: 'voice',
  };
  const circle = String(w.name || (w.circle && w.circle.name) || '');
  if (circle) item.subtitle = circle;
  if (vas.length) item.authors = vas;
  const dur = Number(w.duration);
  if (dur > 0) item.duration = dur;
  const rating = Number(w.rate_average_2dp);
  if (rating > 0) item.rating = rating;
  if (w.release) item.uploaded = String(w.release);
  if (w.source_id) item.workCode = String(w.source_id);
  const lang = String((w.translation_info && w.translation_info.lang) || '');
  if (lang === 'CHI_HANS' || lang === 'CHI_HANT') item.voiceLanguageStatus = 'chineseSubtitled';
  return item;
}

// 把目录树整理成 directoryId -> 子节点列表、fileId -> 原始节点 两张表。
// folder 无 hash：用从根开始的索引路径作 ID（如 d/0/2），同一份树内稳定。
function indexTree(tree) {
  const dirs = new Map();
  const files = new Map();
  const walk = (nodes, dirId) => {
    const list = Array.isArray(nodes) ? nodes : [];
    dirs.set(dirId, list);
    list.forEach((node, i) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'folder') {
        walk(node.children || [], dirId === '' ? `d/${i}` : `${dirId}/${i}`);
      } else if (node.hash) {
        files.set(String(node.hash), node);
      }
    });
  };
  walk(tree, '');
  return { dirs, files };
}

function streamUrl(node) {
  if (node.mediaStreamUrl) return String(node.mediaStreamUrl);
  if (node.hash) return `${API}/media/stream/${String(node.hash).split('/').map(encodeURIComponent).join('/')}`;
  return '';
}

Park.register({
  key: 'asmrone',
  name: 'ASMR.one',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'voice',
  category: 'asmr',
  color: '#7C4DBD',
  description: '同人音声目录：多音轨、字幕与台本文件',
  homepage: BASE,
  domains: ['asmr.one', 'asmr-200.com'],
  idPattern: '^(\\d+)$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: 'popular',
  feeds: [
    { key: 'popular', label: '最热门' },
    { key: 'latest', label: '最新发布' },
    { key: 'rating', label: '评分最高' },
    { key: 'price', label: '价格从低' },
    { key: 'chinese', label: '中文版' },
    { key: 'lick', label: '舔耳' },
    { key: 'whisper', label: '耳语' },
    { key: 'binaural', label: '双耳录音' },
  ],

  async api(path) {
    const res = await this.http.get(API + path, {
      headers: { Accept: 'application/json', Referer: BASE + '/', Origin: BASE },
      timeout: 30000,
    });
    if (res.status === 404) throw Park.error('NOT_FOUND', '内容不存在或已被删除');
    if (!res.ok) throw Park.error('HTTP', '站点返回 HTTP {status}', { status: res.status, params: { status: res.status } });
    try {
      return res.json();
    } catch (_) {
      throw Park.error('PARSE', '站点返回的数据无效');
    }
  },

  validId(value) {
    const id = String(value || '').trim();
    if (!/^\d+$/.test(id)) throw Park.error('NOT_FOUND', '作品编号无效');
    return id;
  },

  async listing(page, order, sort) {
    const data = await this.api(`/works?page=${page}&pageSize=${PAGE_SIZE}&order=${order}&sort=${sort}`);
    const works = Array.isArray(data && data.works) ? data.works : [];
    const total = Number((data && data.pagination && data.pagination.totalCount) || 0);
    const items = works.filter((w) => w && w.id != null && w.title).map(workItem);
    return { items, page, total, hasNext: total > 0 ? page * PAGE_SIZE < total : works.length === PAGE_SIZE };
  },

  async searchPage(keyword, page) {
    const data = await this.api(`/search/${encodeURIComponent(keyword)}?page=${page}`);
    const works = Array.isArray(data && data.works) ? data.works : [];
    const total = Number((data && data.pagination && data.pagination.totalCount) || 0);
    const items = works.filter((w) => w && w.id != null && w.title).map(workItem);
    return { items, page, total, hasNext: total > 0 ? page * SEARCH_PAGE_SIZE < total : works.length === SEARCH_PAGE_SIZE };
  },

  async feed(key, { page }) {
    const p = Math.max(1, Math.floor(Number(page) || 1));
    if (Object.prototype.hasOwnProperty.call(KEYWORD_FEEDS, key)) {
      return this.searchPage(KEYWORD_FEEDS[key], p);
    }
    const cfg = FEEDS[key];
    if (!cfg) throw Park.error('CONFIG', '未知列表');
    return this.listing(p, cfg.order, cfg.sort);
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    return this.searchPage(kw, Math.max(1, Math.floor(Number(page) || 1)));
  },

  async loadWork(id) {
    const work = await this.api(`/work/${id}`);
    if (!work || work.id == null) throw Park.error('NOT_FOUND', '作品不存在');
    const tree = await this.api(`/tracks/${id}?v=2`);
    return { work, tree: Array.isArray(tree) ? tree : [] };
  },

  async detail(id) {
    const wid = this.validId(id);
    const { work, tree } = await this.loadWork(wid);
    const { files } = indexTree(tree);
    let hasAudio = false;
    let hasVideo = false;
    for (const node of files.values()) {
      if (node.type === 'audio') hasAudio = true;
      if (node.type === 'video') hasVideo = true;
    }
    const item = workItem(work);
    const tags = (Array.isArray(work.tags) ? work.tags : []).map(tagName).filter(Boolean);
    const vas = (Array.isArray(work.vas) ? work.vas : []).map((v) => String((v && v.name) || '')).filter(Boolean);
    const lines = [];
    if (work.name) lines.push(`社团：${work.name}`);
    if (vas.length) lines.push(`声优：${vas.join('、')}`);
    if (work.release) lines.push(`发行：${work.release}`);
    if (!hasAudio) lines.push('此作品没有音频文件（仅图片/文本等附件），可在目录中查看其文件。');
    const out = {
      ...item,
      url: `${BASE}/work/${wid}`,
      description: lines.join('\n'),
      chapters: null,
      voiceMediaForm: hasAudio && hasVideo ? 'mixed' : hasAudio ? 'audioOnly' : hasVideo ? 'videoOnly' : 'unknown',
    };
    if (tags.length) {
      out.tags = [{ namespace: 'tag', label: '标签', tags: tags.map((name) => ({ name, keyword: name })) }];
    }
    if (tree.length) out.voiceRoot = { id: wid, name: item.title, type: 'directory' };
    return out;
  },

  // 目录 ID：根为作品 ID 本身，子目录为其索引路径（d/...）。
  dirKey(workId, directoryId) {
    const d = String(directoryId || '');
    if (d === String(workId)) return '';
    if (/^d\/\d+(?:\/\d+)*$/.test(d)) return d;
    throw Park.error('NOT_FOUND', '目录不存在');
  },

  async voiceDirectory(workId, directoryId, options = {}) {
    const wid = this.validId(workId);
    const dirId = this.dirKey(wid, directoryId);
    const { tree } = await this.loadWork(wid);
    const { dirs } = indexTree(tree);
    const children = dirs.get(dirId);
    if (!children) throw Park.error('NOT_FOUND', '目录不存在');
    const items = [];
    children.forEach((node, i) => {
      if (!node || typeof node !== 'object') return;
      const title = String(node.title || '');
      if (node.type === 'folder') {
        items.push({ id: dirId === '' ? `d/${i}` : `${dirId}/${i}`, name: title, type: 'directory' });
        return;
      }
      if (!node.hash) return;
      const nodeId = String(node.hash);
      const ext = extOf(title);
      if (node.type === 'audio' || node.type === 'video') {
        const entry = { id: nodeId, name: title, type: node.type };
        // 同目录字幕：文件名 = 音频文件名 + 字幕扩展名（如 xx.wav.vtt），
        // 或与音频同主名（xx.mp3 对 xx.vtt）。
        const base = title.replace(/\.[^.]+$/, '');
        const subs = [];
        for (const sib of children) {
          if (!sib || !sib.hash || sib === node) continue;
          const sTitle = String(sib.title || '');
          const sExt = extOf(sTitle);
          if (!SUB_EXTS.includes(sExt)) continue;
          if (sTitle === `${title}.${sExt}` || sTitle.replace(/\.[^.]+$/, '') === base) subs.push(String(sib.hash));
        }
        if (subs.length) entry.subtitleIds = [...new Set(subs)].slice(0, 50);
        items.push(entry);
        return;
      }
      if (node.type === 'image') {
        items.push({ id: nodeId, name: title, type: 'image' });
        return;
      }
      if (node.type === 'text') {
        items.push({ id: nodeId, name: title, type: SUB_EXTS.includes(ext) ? 'subtitle' : 'script' });
        return;
      }
      items.push({ id: nodeId, name: title, type: 'other' });
    });
    const page = Math.max(1, Math.floor(Number(options.page) || 1));
    return {
      items: items.slice((page - 1) * DIR_PAGE_SIZE, page * DIR_PAGE_SIZE),
      hasNext: page * DIR_PAGE_SIZE < items.length,
    };
  },

  async findNode(workId, nodeId) {
    const wid = this.validId(workId);
    const { tree } = await this.loadWork(wid);
    const { files } = indexTree(tree);
    const node = files.get(String(nodeId || ''));
    if (!node) throw Park.error('NOT_FOUND', '文件不存在');
    return node;
  },

  async voiceResource(workId, nodeId) {
    const node = await this.findNode(workId, nodeId);
    const url = streamUrl(node);
    if (!url) throw Park.error('PARSE', '文件地址无效');
    return { url, format: extOf(node.title) || 'txt' };
  },

  async videos(workId, episodeId) {
    const node = await this.findNode(workId, episodeId);
    if (node.type !== 'audio' && node.type !== 'video') {
      throw Park.error('UNSUPPORTED', '此文件不是音频');
    }
    const url = streamUrl(node);
    if (!url) throw Park.error('PARSE', '音频地址无效');
    const out = [{
      url,
      format: extOf(node.title) || 'mp3',
      label: '原音',
      preferred: true,
      headers: { Referer: BASE + '/' },
    }];
    const low = String(node.streamLowQualityUrl || '');
    if (low && low !== url) {
      out.push({ url: low, format: extOf(low.split('?')[0]) || 'm4a', label: '流畅', headers: { Referer: BASE + '/' } });
    }
    return out;
  },
});
