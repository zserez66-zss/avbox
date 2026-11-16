// IdolComplex (idolcomplex.com) 的 HentaiPark 站点插件。
// 站点形态：Sankaku 系 booru 图站，网页是 SPA，数据走官方公开 API
// https://i.sankakuapi.com/posts（匿名可读，本插件的端点/参数/字段对齐本站 TVBox py 源）。
// 一个帖子 = 一个图集作品：帖子本身只有一张图（file_url 原图）；带 parent/children
// 关系的帖子是同一组图，chapter() 按父帖 + 子帖（tags=parent:<id> 实测可用）成组返回。
// 本站帖子流图片/视频混杂，本插件是图集源，只收 file_type=image/* 的帖子，视频帖不进列表。
// 搜索是 Sankaku 标签搜索：关键词原文就是 booru 查询串（空格 = AND，多词标签用下划线），
// 匿名 API 不能用排除标签（带 -xxx 会 429），故不做任何排除改写。
const BASE = 'https://www.idolcomplex.com';
const API = 'https://i.sankakuapi.com';
const LIMIT = 40;
const API_HEADERS = {
  Accept: 'application/vnd.sankaku.api+json;v=2',
  Referer: BASE + '/',
};

// feed key -> booru 查询串（对齐 py 源分类，视频版加 video 后缀，图集版不加、改为客户端过滤图片）
const FEEDS = {
  popular: 'order:popularity',
  latest: 'order:recent',
  score: 'order:score',
  quality: 'order:quality',
  cosplay: 'cosplay',
  portrait: 'portrait',
  uncensored: 'uncensored',
};

// 拼标题时跳过的元标签（与 py 源一致，另加图片侧常见元标签）
const META_TAGS = new Set([
  'video', 'mp4', 'webm', 'has_audio', 'animated', 'sound', 'video_duration',
  'large_filesize', 'small_filesize', 'medium_filesize',
]);

function isImagePost(post) {
  return !!post && String(post.file_type || '').startsWith('image/') && !!post.file_url;
}

// 标题：与 py 源同一规则——取 tag_names 前 4 个非元标签，下划线转空格拼接；没有可用标签时用帖号兜底。
function postTitle(post) {
  const names = [];
  for (const t of post.tag_names || []) {
    const raw = String(t);
    const tl = raw.toLowerCase();
    if (META_TAGS.has(tl) || tl.includes('aspect_ratio') || tl.endsWith('_(codec)')) continue;
    names.push(raw.replace(/_/g, ' '));
    if (names.length >= 4) break;
  }
  return names.length ? names.join(' · ') : `图片 #${post.id}`;
}

// 作者：只取 API 标签里 type=1（artist/人物类）的明确字段，不从标题猜；上传者走 uploader。
function postAuthors(post) {
  const out = [];
  for (const t of post.tags || []) {
    if (!t || t.type !== 1) continue;
    const name = String(t.name_en || t.name || '').trim();
    if (name && !out.includes(name)) out.push(name);
    if (out.length >= 5) break;
  }
  return out;
}

function postItem(post) {
  const item = {
    id: String(post.id),
    title: postTitle(post),
    // 封面用 sample_url（站点缩放图：jpeg 直图 / png 转 webp，均为真图）；preview_url 是 avif，不用。
    cover: post.sample_url || post.preview_url || post.file_url || '',
    pages: 1,
  };
  const authors = postAuthors(post);
  if (authors.length) item.authors = authors;
  if (post.author && post.author.display_name) item.uploader = String(post.author.display_name);
  if (post.fav_count) item.likes = post.fav_count;
  if (post.width && post.height) item.coverAspect = post.width / post.height;
  const parts = [];
  if (post.width && post.height) parts.push(`${post.width}×${post.height}`);
  if (post.total_score) parts.push(`★${post.total_score}`);
  if (parts.length) item.subtitle = parts.join(' · ');
  const s = post.created_at && post.created_at.s;
  if (s) item.uploaded = new Date(s * 1000).toISOString();
  return item;
}

// API 列表：返回原始帖子数组（未过滤）；结构不对直接抛 PARSE，不伪装空列表。
async function fetchPosts(http, tags, page) {
  const url = `${API}/posts?tags=${encodeURIComponent(tags)}&page=${page}&limit=${LIMIT}`;
  const data = await http.json(url, { headers: API_HEADERS });
  if (!Array.isArray(data)) throw Park.error('PARSE', '站点返回数据异常');
  return data;
}

async function fetchPost(http, id) {
  const data = await http.json(`${API}/posts/${id}`, { headers: API_HEADERS });
  if (!data || typeof data !== 'object' || !data.id) throw Park.error('PARSE', '站点返回数据异常');
  return data;
}

// 成组取图：帖子有 parent_id 时以父帖为组根；组根或本帖有子帖时用 parent:<组根> 拉子帖。
// 只收图片帖，按帖号升序（发帖顺序）。任何一步失败都退回本帖单图，不让组图查询拖垮单图帖。
async function groupImagePosts(http, post) {
  const byId = new Map();
  const add = (p) => { if (isImagePost(p)) byId.set(String(p.id), p); };
  add(post);
  try {
    const rootId = post.parent_id ? String(post.parent_id) : String(post.id);
    let root = null;
    if (rootId !== String(post.id)) {
      root = await fetchPost(http, rootId);
      add(root);
    }
    const anchor = root || post;
    if (anchor.has_children) {
      for (let page = 1; page <= 3; page++) {
        const children = await fetchPosts(http, `parent:${rootId}`, page);
        for (const c of children) add(c);
        if (children.length < LIMIT) break;
      }
    }
  } catch (_) {
    // 组图补全失败时保留已取到的本帖（及父帖）图片
  }
  return [...byId.values()].sort((a, b) => Number(a.id) - Number(b.id));
}

// 详情标签分组：type=1 人物、type=0 通用、其余归其他；keyword 用站内标签原名（下划线式）供点击搜索。
function detailTags(post) {
  const groups = [
    { namespace: 'artist', label: '人物', type: 1, tags: [] },
    { namespace: 'general', label: '标签', type: 0, tags: [] },
    { namespace: 'meta', label: '其他标签', type: -1, tags: [] },
  ];
  for (const t of post.tags || []) {
    if (!t) continue;
    const keyword = String(t.tagName || t.name_en || t.name || '').trim();
    const name = String(t.name_en || t.name || keyword).replace(/_/g, ' ').trim();
    if (!keyword || !name) continue;
    const g = t.type === 1 ? groups[0] : t.type === 0 ? groups[1] : groups[2];
    if (!g.tags.some((x) => x.keyword === keyword)) g.tags.push({ name, keyword });
  }
  return groups.filter((g) => g.tags.length);
}

Park.register({
  key: 'idolcomplex',
  name: 'IdolComplex',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'comic',
  category: 'gallery',
  description: 'IdolComplex 图片图集（Sankaku 公开 API，只收图片帖，视频帖不在本源）',
  homepage: BASE,
  domains: ['idolcomplex.com', 'sankakucomplex.com'],
  linkPatterns: ['idolcomplex\\.com/posts/(\\d+)'],
  idPattern: '^(\\d+)$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  searchHint: '标签搜索：空格表示 AND，多词标签用下划线，如 cosplay school_uniform',
  defaultFeed: 'popular',
  feeds: [
    { key: 'popular', label: '热门' },
    { key: 'latest', label: '最新' },
    { key: 'score', label: '高分' },
    { key: 'quality', label: '高质量' },
    { key: 'cosplay', label: 'Cosplay' },
    { key: 'portrait', label: '竖图' },
    { key: 'uncensored', label: '无码' },
  ],

  async feed(key, { page }) {
    const tags = FEEDS[key];
    if (!tags) throw Park.error('CONFIG', '未知列表');
    const raw = await fetchPosts(this.http, tags, page);
    const items = raw.filter(isImagePost).map(postItem);
    // 实测：最新流第 1 页 API 只回 14 条但第 2 页仍有整页 40 条，不能按整页判断到底；
    // 以 >=10 条粗判还有下一页，末页多探一次空页可接受。
    return { items, page, hasNext: raw.length >= 10 };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page, hasNext: false };
    const raw = await fetchPosts(this.http, kw, page);
    const items = raw.filter(isImagePost).map(postItem);
    return { items, page, hasNext: raw.length >= 10 };
  },

  async detail(id) {
    const post = await fetchPost(this.http, id);
    if (!isImagePost(post)) throw Park.error('UNSUPPORTED', '该帖子是视频帖，本图集源只收图片帖');
    const group = await groupImagePosts(this.http, post);
    const item = postItem(post);
    const tagNames = (post.tag_names || []).map((t) => String(t).replace(/_/g, ' '));
    const descParts = [];
    if (group.length > 1) descParts.push(`本帖与关联帖共 ${group.length} 张图片（原图）。`);
    else descParts.push('共 1 张图片（原图）。');
    if (post.file_size) descParts.push(`原图大小 ${(post.file_size / 1048576).toFixed(2)} MB。`);
    if (tagNames.length) descParts.push(`标签：${tagNames.slice(0, 20).join('、')}`);
    return {
      ...item,
      pages: group.length,
      url: `${BASE}/posts/${post.id}`,
      description: descParts.join(' '),
      tags: detailTags(post),
      chapters: null,
      singleChapterId: 'gallery',
    };
  },

  async chapter(id, chapterId) {
    const post = await fetchPost(this.http, id);
    if (!isImagePost(post)) throw Park.error('UNSUPPORTED', '该帖子是视频帖，本图集源只收图片帖');
    const group = await groupImagePosts(this.http, post);
    if (!group.length) throw Park.error('PARSE', '未解析到图集图片');
    return { pages: group.map((p) => ({ url: p.file_url, headers: { Referer: BASE + '/' } })) };
  },
});
