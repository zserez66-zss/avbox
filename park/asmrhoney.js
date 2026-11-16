// ASMRHoney (asmrhoney.com) 的 HentaiPark 站点插件。
// 站点形态（与本站 TVBox py 源的实测结论一致）：没有 HTML 列表页可抓，数据全是静态 JSON：
//   /data/clips-page-N.json   最新流（每页 48 条，页数见 /data/clips-meta.json）
//   /data/clips/<slug>.json   单个作品详情（含 videoUrl mp4 直链与 backgroundAudioUrl 背景音频）
//   /data/clips-search.json   全量索引（搜索与标签 / 创作者筛选都在这份索引上做，py 同款逻辑）
//   /data/audio.json          单曲音声（tracks，每条自带 audioUrl 的 mp3 / m4a 直链）与专辑（albums）
//   /data/triggers.json       标签中文名
// 类型定为 voice / asmr：clips 本体是视频形态的 ASMR（py 详情以 videoUrl 为主），
// 音声 tracks 是纯音频单曲；两者都用 videos() 返回当次直链，不做目录伪造——
// audio.json 的专辑不单独成作品，其曲目按单曲平铺进「音声」标签（每条标题、封面、
// 创作者均为数据文件明确字段）。作品带 subtitleTracks 时按协议声明 voiceSubtitles，
// 并实现 voiceResource 解析字幕文件。
const BASE = 'https://asmrhoney.com';
const DATA = BASE + '/data';
const PAGE_LATEST = 48; // clips-page-N.json 的固定页大小
const PAGE_POOL = 24; // 与 py 一致：筛选 / 搜索池的分页大小

const cache = new Map();
const CACHE_MS = 5 * 60 * 1000;

function slugOk(s) {
  return /^[a-z0-9][a-z0-9-]{0,180}$/.test(String(s || ''));
}

function fmtDur(sec) {
  const n = Math.floor(Number(sec) || 0);
  if (n <= 0) return '';
  const h = Math.floor(n / 3600), m = Math.floor((n % 3600) / 60), s = n % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
}

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

Park.register({
  key: 'asmrhoney',
  name: 'ASMRHoney',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'voice',
  category: 'asmr',
  color: '#9A6572',
  description: 'ASMR 音视频与单曲音声，支持标签、创作者筛选与搜索',
  homepage: BASE,
  domains: ['asmrhoney.com'],
  linkPatterns: ['asmrhoney\\.com/clip/([a-z0-9][a-z0-9-]*)'],
  idPattern: '^[a-z0-9][a-z0-9-]{0,180}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'audio', label: '音声' },
    { key: 'tag:sfw', label: '助眠向' },
    { key: 'tag:nsfw', label: '成人向' },
    { key: 'tag:mouth_sounds', label: '口腔音' },
    { key: 'tag:ear_licking', label: '耳舐' },
    { key: 'tag:trigger_sounds', label: '触发音' },
    { key: 'tag:roleplay', label: '角色扮演' },
    { key: 'tag:whisper', label: '耳语' },
    { key: 'creator:shuuukifan', label: 'ShuuukiFan' },
    { key: 'creator:susuxuejie', label: 'Susu学姐' },
    { key: 'creator:cherrycrush', label: 'CherryCrush' },
    { key: 'creator:yuuu226', label: 'Yuuu' },
  ],

  async _json(path) {
    const hit = cache.get(path);
    if (hit && Date.now() - hit.time < CACHE_MS) return hit.value;
    const value = await this.http.json(DATA + path);
    cache.set(path, { time: Date.now(), value });
    return value;
  },

  // 全量索引（py 的 _index：按 publishedAt 倒序）
  async _index() {
    const d = await this._json('/clips-search.json');
    const clips = Array.isArray(d && d.clips) ? d.clips.slice() : [];
    clips.sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
    return clips;
  },

  async _audioData() {
    const d = await this._json('/audio.json');
    return {
      albums: Array.isArray(d && d.albums) ? d.albums : [],
      tracks: Array.isArray(d && d.tracks) ? d.tracks : [],
    };
  },

  // 标签中文名；取不到时退回 slug 本身，不阻断列表
  async _labels() {
    try {
      const d = await this._json('/triggers.json');
      const map = {};
      for (const t of (d && d.triggers) || []) {
        if (t && t.slug) map[t.slug] = t.label_zh || t.label_en || t.slug;
      }
      return map;
    } catch (_) {
      return {};
    }
  },

  async _clipDetail(slug) {
    if (!slugOk(slug)) throw Park.error('NOT_FOUND', '内容不存在');
    const d = await this.http.json(`${DATA}/clips/${encodeURIComponent(slug)}.json`);
    const clip = d && d.clip;
    if (!clip || clip.slug !== slug) throw Park.error('PARSE', '详情数据无效');
    return clip;
  },

  _clipItem(c) {
    const item = {
      id: String(c.slug),
      title: String(c.title || c.slug),
      cover: abs(c.coverWebpUrl || c.coverUrl || ''),
      mediaKind: 'video',
      voiceMediaForm: c.audioOnly ? 'audioOnly' : 'videoOnly',
    };
    if (Number(c.duration) > 0) item.duration = Number(c.duration);
    if (c.creator) item.authors = [String(c.creator)];
    if (c.publishedAt) item.uploaded = String(c.publishedAt);
    return item;
  },

  _trackItem(t) {
    const item = {
      id: 'audio:' + String(t.slug),
      title: String(t.title || t.slug),
      cover: abs(t.coverUrl || t.coverWebpUrl || ''),
      mediaKind: 'voice',
      voiceMediaForm: 'audioOnly',
    };
    if (Number(t.duration) > 0) item.duration = Number(t.duration);
    if (t.creator) item.authors = [String(t.creator)];
    if (t.publishedAt) item.uploaded = String(t.publishedAt);
    return item;
  },

  _poolPage(pool, page, mapFn) {
    const start = (page - 1) * PAGE_POOL;
    return {
      items: pool.slice(start, start + PAGE_POOL).map(mapFn),
      page,
      total: pool.length,
      hasNext: start + PAGE_POOL < pool.length,
    };
  },

  async feed(key, { page }) {
    page = Math.max(1, Math.floor(Number(page) || 1));
    if (key === 'latest') {
      let data;
      try {
        data = await this.http.json(`${DATA}/clips-page-${page}.json`);
      } catch (e) {
        if (page > 1 && (e.code === 'NOT_FOUND' || e.code === 'HTTP')) {
          return { items: [], page, hasNext: false };
        }
        throw e;
      }
      const clips = Array.isArray(data && data.clips) ? data.clips : [];
      let totalPages = 0;
      try {
        const meta = await this._json('/clips-meta.json');
        totalPages = Number(meta && meta.pages) || 0;
      } catch (_) { /* 元数据取不到时按本页是否满页推断 */ }
      return {
        items: clips.map((c) => this._clipItem(c)),
        page,
        ...(totalPages ? { totalPages } : {}),
        hasNext: totalPages ? page < totalPages : clips.length === PAGE_LATEST,
      };
    }
    if (key === 'audio') {
      const { tracks } = await this._audioData();
      const pool = tracks
        .filter((t) => t && t.status === 'published' && t.audioUrl)
        .slice()
        .sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
      const start = (page - 1) * PAGE_LATEST;
      return {
        items: pool.slice(start, start + PAGE_LATEST).map((t) => this._trackItem(t)),
        page,
        total: pool.length,
        hasNext: start + PAGE_LATEST < pool.length,
      };
    }
    const m = /^(tag|creator):(.+)$/.exec(String(key || ''));
    if (!m) throw Park.error('CONFIG', '未知列表');
    const kind = m[1], val = m[2];
    const pool = (await this._index()).filter((c) => {
      if (!c || c.status !== 'published') return false;
      return kind === 'tag' ? Array.isArray(c.tags) && c.tags.includes(val) : c.creator === val;
    });
    return this._poolPage(pool, page, (c) => this._clipItem(c));
  },

  async search({ keyword, page }) {
    page = Math.max(1, Math.floor(Number(page) || 1));
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return { items: [], page, hasNext: false };
    // py 的搜索字段：title / title_en / title_ja / title_ko / creator；另加 tags slug，
    // 使详情页标签点击（keyword 为标签 slug）能落到真实结果。
    const clips = (await this._index()).filter((c) => {
      if (!c || c.status !== 'published') return false;
      const hay = [c.title, c.title_en, c.title_ja, c.title_ko, c.creator, ...(Array.isArray(c.tags) ? c.tags : [])]
        .map((x) => String(x || '')).join(' ').toLowerCase();
      return hay.includes(kw);
    });
    const { tracks } = await this._audioData();
    const audios = tracks.filter((t) => {
      if (!t || t.status !== 'published') return false;
      const hay = [t.title, t.originalTitle, t.creator].map((x) => String(x || '')).join(' ').toLowerCase();
      return hay.includes(kw);
    });
    const merged = [
      ...clips.map((c) => ({ at: String(c.publishedAt || ''), item: this._clipItem(c) })),
      ...audios.map((t) => ({ at: String(t.publishedAt || ''), item: this._trackItem(t) })),
    ].sort((a, b) => b.at.localeCompare(a.at));
    return this._poolPage(merged, page, (row) => row.item);
  },

  async detail(id) {
    id = String(id || '');
    if (id.startsWith('audio:')) {
      const slug = id.slice('audio:'.length);
      if (!slugOk(slug)) throw Park.error('NOT_FOUND', '内容不存在');
      const { tracks } = await this._audioData();
      const t = tracks.find((x) => x && x.slug === slug && x.status === 'published');
      if (!t) throw Park.error('NOT_FOUND', '音声不存在');
      const item = this._trackItem(t);
      const lines = [];
      if (t.creator) lines.push('作者：' + t.creator);
      if (fmtDur(t.duration)) lines.push('时长：' + fmtDur(t.duration));
      if (t.format) lines.push('格式：' + String(t.format).toUpperCase());
      return {
        ...item,
        url: BASE + '/',
        description: lines.join('\n'),
        chapters: null,
      };
    }
    if (!slugOk(id)) throw Park.error('NOT_FOUND', '内容不存在');
    const clip = await this._clipDetail(id);
    const item = this._clipItem(clip);
    const labels = await this._labels();
    const tagSlugs = (Array.isArray(clip.tags) ? clip.tags : []).slice(0, 8);
    const lines = [];
    if (clip.creator) lines.push('作者：' + clip.creator);
    if (fmtDur(clip.duration)) lines.push('时长：' + fmtDur(clip.duration));
    if (tagSlugs.length) lines.push('标签：' + tagSlugs.map((s) => labels[s] || s).join('、'));
    if (clip.description) lines.push(String(clip.description).slice(0, 300));
    const out = {
      ...item,
      url: `${BASE}/clip/${id}/`,
      description: lines.join('\n'),
      chapters: null,
    };
    if (tagSlugs.length) {
      out.tags = [{
        namespace: 'tag',
        label: '标签',
        tags: tagSlugs.map((s) => ({ name: labels[s] || s, keyword: s })),
      }];
    }
    // 原站明确给出的字幕轨（subtitleTracks）：按协议声明关联，voiceResource 解析
    if (Array.isArray(clip.subtitleTracks) && clip.subtitleTracks.length) {
      const subs = [];
      for (const st of clip.subtitleTracks) {
        const lang = String((st && st.srclang) || '').toLowerCase();
        if (!lang || !st.src) continue;
        subs.push({ id: `sub:${id}:${lang}`, language: lang });
      }
      if (subs.length) {
        out.voiceSubtitles = { _: subs.map((s) => s.id) };
        if (subs.some((s) => s.language === 'zh')) out.voiceLanguageStatus = 'chineseSubtitled';
      }
    }
    return out;
  },

  async voiceResource(id, nodeId) {
    const m = /^sub:([a-z0-9][a-z0-9-]{0,180}):([a-z]{2,3}(?:-[a-z0-9]{2,8})?)$/.exec(String(nodeId || ''));
    if (!m || String(id || '') !== m[1]) throw Park.error('NOT_FOUND', '字幕不存在');
    const clip = await this._clipDetail(m[1]);
    const track = (Array.isArray(clip.subtitleTracks) ? clip.subtitleTracks : [])
      .find((st) => st && String(st.srclang || '').toLowerCase() === m[2] && st.src);
    if (!track) throw Park.error('NOT_FOUND', '字幕不存在');
    return { url: abs(track.src), format: 'vtt' };
  },

  async videos(id, episodeId = '_') {
    id = String(id || '');
    if (id.startsWith('audio:')) {
      const slug = id.slice('audio:'.length);
      if (!slugOk(slug)) throw Park.error('NOT_FOUND', '内容不存在');
      const { tracks } = await this._audioData();
      const t = tracks.find((x) => x && x.slug === slug && x.status === 'published');
      if (!t || !t.audioUrl) throw Park.error('UNSUPPORTED', '此音声暂无可用播放地址');
      const format = String(t.format || '').toLowerCase();
      if (!['mp3', 'm4a'].includes(format)) throw Park.error('UNSUPPORTED', '媒体格式不支持');
      return [{
        url: abs(t.audioUrl),
        format,
        label: '音频',
        preferred: true,
        headers: { Referer: BASE + '/' },
      }];
    }
    if (!slugOk(id)) throw Park.error('NOT_FOUND', '内容不存在');
    const clip = await this._clipDetail(id);
    const out = [];
    if (clip.videoUrl) {
      out.push({
        url: abs(clip.videoUrl),
        format: 'mp4',
        label: '高清',
        preferred: true,
        headers: { Referer: BASE + '/' },
      });
    }
    if (clip.video480Url) {
      out.push({
        url: abs(clip.video480Url),
        format: 'mp4',
        label: '标清',
        headers: { Referer: BASE + '/' },
      });
    }
    if (!out.length && clip.backgroundAudioUrl) {
      out.push({
        url: abs(clip.backgroundAudioUrl),
        format: 'm4a',
        label: '音频',
        preferred: true,
        headers: { Referer: BASE + '/' },
      });
    }
    if (!out.length) throw Park.error('UNSUPPORTED', '此作品暂无可用播放地址');
    return out;
  },
});
