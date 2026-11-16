// ASMR Library (asmrlib.com) 的 HentaiPark 站点插件。
// 站点形态：ASMR 帖子流，每个帖子 = 一部单集作品（站点播放器为视频，
// 媒体是带画面的 MP4，故按单集音声源处理：detail + videos，不伪造目录）。
// 列表：主页 /?page=N（12 条/页）与标签页 /tags/<标签>?page=N，卡片是 div.relative。
// 搜索：服务端搜索 /search/<关键词>?page=N。
// 详情：h1 是标题，.player 的 data-pic 是封面，[data-server] 按钮给线路：
// byse = BI（重型 JS 播放器，无静态直链，不使用），abyss = AB。
// 播放照本站 TVBox py 源复刻 abyss 链：外嵌页 const datas（base64 JSON）里
// media 是 AES-256-CTR 加密数据，密钥为 md5(user_id:slug:md5_id)；解出
// mp4 分辨率列表后，按 py 的签名算法（size 数字字节的 md5 作密钥加密路径）
// 拼带签名的直链。播放必须带 Referer=外嵌页地址，否则 CDN 回 403；
// abyssplayer.com 已按协议用 media.referrerDomains 声明为 Referer 例外域。
const BASE = 'https://asmrlib.com';

// feed key -> 站点标签名（URL 用站点原始大小写）
const TAGS = {
  asmr: 'ASMR',
  r18: 'R18',
  yoonying: 'yoonying',
  puffin: 'Puffin',
  maimy: 'Maimy',
  yeonchu: 'yeonchu',
  record: 'Record',
  hari: 'HARI',
};

function abs(u) {
  if (!u) return '';
  u = String(u).trim();
  if (u.startsWith('//')) return 'https:' + u;
  if (/^https?:\/\//.test(u)) return u;
  return BASE + (u.startsWith('/') ? '' : '/') + u;
}

// 列表封面是 i*.wp.com 的 Photon 代理地址；去代理回源站 videothumbs.me
// （详情页 data-pic 本来就是直连地址，两处保持一致）。
function coverUrl(u) {
  const a = abs(u);
  const m = /^https:\/\/i\d+\.wp\.com\/(.+)$/.exec(a);
  return m ? 'https://' + m[1] : a;
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function postId(href) {
  const m = /\/posts\/([0-9a-f]{32})/.exec(String(href || ''));
  return m ? m[1] : '';
}

// 列表卡片：div.relative 内有帖子链接、封面 img（alt 是标题）、<time> 日期。
function parseCards(doc) {
  const items = [];
  const seen = new Set();
  for (const el of doc.querySelectorAll('div.relative')) {
    const a = el.querySelector('a[href*="/posts/"]');
    const id = postId(a ? a.getAttribute('href') : '');
    if (!id || seen.has(id)) continue;
    const img = el.querySelector('img');
    let title = clean(img ? img.getAttribute('alt') : '');
    if (!title && el.parentElement) {
      const h = el.parentElement.querySelector('h2');
      title = clean(h ? Park.html.text(h) : '');
    }
    if (!title) continue;
    seen.add(id);
    const time = el.querySelector('time');
    const item = {
      id,
      title,
      cover: coverUrl(img ? (img.getAttribute('src') || img.getAttribute('data-src')) : ''),
    };
    const date = time ? (time.getAttribute('datetime') || clean(Park.html.text(time))) : '';
    if (date) item.uploaded = date;
    items.push(item);
  }
  return items;
}

function maxPageOf(doc) {
  let max = 1;
  for (const a of doc.querySelectorAll('a')) {
    const m = /[?&]page=(\d+)/.exec(a.getAttribute('href') || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// 站点连续请求偶发抖动：取页失败先重试一次再抛（与 py 源行为一致）。
async function fetchDoc(http, url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return Park.html.parse(await http.text(url));
    } catch (e) {
      lastErr = e;
      if (e && e.code === 'NOT_FOUND') throw e;
    }
  }
  throw lastErr;
}

// ---------------- 纯 JS MD5（按字节数组计算） ----------------
// abyss 签名密钥是「size 的十进制数字的数值字节」的 MD5，不是文本 MD5，
// 桥接的 md5Hex 只按 UTF-8 文本计算，故这里自带实现。
const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = [];
for (let i = 0; i < 64; i++) MD5_K.push(Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0);

function md5HexBytes(bytes) {
  const origLen = bytes.length;
  const data = Array.from(bytes);
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  const bitLen = origLen * 8;
  for (let i = 0; i < 8; i++) data.push(Math.floor(bitLen / Math.pow(2, 8 * i)) & 0xff);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
  for (let off = 0; off < data.length; off += 64) {
    const m = [];
    for (let j = 0; j < 16; j++) {
      m.push((data[off + 4 * j] | (data[off + 4 * j + 1] << 8) |
        (data[off + 4 * j + 2] << 16) | (data[off + 4 * j + 3] << 24)) >>> 0);
    }
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      b = (b + rotl((a + f + MD5_K[i] + m[g]) >>> 0, MD5_S[i])) >>> 0;
      a = tmp;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  let out = '';
  for (const v of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) out += ((v >>> (8 * i)) & 0xff).toString(16).padStart(2, '0');
  }
  return out;
}

// ---------------- 纯 JS AES-256-CTR（只用加密块，与 py 源同算法） ----------------
function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    a = ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
    b >>= 1;
  }
  return p;
}

const SBOX = (() => {
  const exp = new Array(512).fill(0);
  const log = new Array(256).fill(0);
  let x = 1;
  for (let i = 0; i < 255; i++) { exp[i] = x; log[x] = i; x = gfMul(x, 3); }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  const s = new Array(256).fill(0);
  for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : exp[255 - log[i]];
    let v = inv;
    for (const rot of [1, 2, 3, 4]) v ^= ((inv << rot) | (inv >> (8 - rot))) & 0xff;
    s[i] = (v ^ 0x63) & 0xff;
  }
  return s;
})();

function aes256Expand(key) {
  const w = [];
  for (let i = 0; i < 8; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  const rcon = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40];
  for (let i = 8; i < 60; i++) {
    let t = w[i - 1].slice();
    if (i % 8 === 0) t = [SBOX[t[1]] ^ rcon[i / 8 - 1], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
    else if (i % 8 === 4) t = t.map((b) => SBOX[b]);
    w.push([w[i - 8][0] ^ t[0], w[i - 8][1] ^ t[1], w[i - 8][2] ^ t[2], w[i - 8][3] ^ t[3]]);
  }
  return w;
}

function aes256EncryptBlock(w, block) {
  let st = Array.from(block); // 列优先：st[4*c + r]
  const addRk = (rnd) => {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) st[4 * c + r] ^= w[4 * rnd + c][r];
  };
  addRk(0);
  for (let rnd = 1; rnd <= 14; rnd++) {
    st = st.map((b) => SBOX[b]);
    st = Array.from({ length: 16 }, (_, i) => {
      const c = Math.floor(i / 4), r = i % 4;
      return st[4 * ((c + r) % 4) + r];
    });
    if (rnd < 14) {
      for (let c = 0; c < 4; c++) {
        const a = st.slice(4 * c, 4 * c + 4);
        st[4 * c] = gfMul(a[0], 2) ^ gfMul(a[1], 3) ^ a[2] ^ a[3];
        st[4 * c + 1] = a[0] ^ gfMul(a[1], 2) ^ gfMul(a[2], 3) ^ a[3];
        st[4 * c + 2] = a[0] ^ a[1] ^ gfMul(a[2], 2) ^ gfMul(a[3], 3);
        st[4 * c + 3] = gfMul(a[0], 3) ^ a[1] ^ a[2] ^ gfMul(a[3], 2);
      }
    }
    addRk(rnd);
  }
  return st;
}

// AES-256-CTR：IV = key 前 16 字节，计数器按 128 位大端递增。加解密同函数。
function aes256Ctr(keyBytes, dataBytes) {
  const w = aes256Expand(keyBytes);
  let counter = 0n;
  for (let i = 0; i < 16; i++) counter = (counter << 8n) | BigInt(keyBytes[i]);
  const out = new Array(dataBytes.length);
  for (let off = 0; off < dataBytes.length; off += 16) {
    const block = [];
    let v = counter;
    for (let i = 15; i >= 0; i--) { block[i] = Number(v & 0xffn); v >>= 8n; }
    const ks = aes256EncryptBlock(w, block);
    const n = Math.min(16, dataBytes.length - off);
    for (let i = 0; i < n; i++) out[off + i] = dataBytes[off + i] ^ ks[i];
    counter += 1n;
  }
  return out;
}

// ---------------- 字节工具 ----------------
function asciiBytes(s) {
  return Array.from(String(s), (ch) => ch.charCodeAt(0) & 0xff);
}
function utf8Bytes(s) {
  return Array.from(new TextEncoder().encode(String(s)));
}
function bytesToUtf8(bytes) {
  return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
}
function bytesToB64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.slice(i, i + 8192));
  }
  return btoa(bin);
}

// abyss 外嵌页 -> 带签名的 MP4 直链列表（照 py 源 _abyss_stream 复刻）。
async function abyssVideos(http, embedUrl) {
  let body = '';
  let lastErr;
  for (let attempt = 0; attempt < 2 && !body; attempt++) {
    try {
      const res = await http.get(embedUrl);
      if (!res.ok) throw Park.error('HTTP', '播放器返回 HTTP {status}', { status: res.status, params: { status: res.status } });
      body = res.body;
    } catch (e) { lastErr = e; }
  }
  if (!body) throw lastErr || Park.error('NETWORK', '播放器页面加载失败');
  const m = /const datas = "([^"]+)"/.exec(body);
  if (!m) throw Park.error('PARSE', '未解析到播放器数据');
  // datas 是 latin-1 字节串的 JSON：必须按 atob 的二进制字符串解析，
  // 若按 UTF-8 解码，media 密文字节会被破坏。
  let data;
  try {
    data = JSON.parse(atob(m[1] + '='.repeat((-m[1].length % 4 + 4) % 4)));
  } catch (_) {
    throw Park.error('PARSE', '播放器数据解析失败');
  }
  const mediaBytes = asciiBytes(data.media);
  const key1 = md5HexBytes(utf8Bytes(`${data.user_id}:${data.slug}:${data.md5_id}`));
  let media;
  try {
    media = JSON.parse(bytesToUtf8(aes256Ctr(asciiBytes(key1), mediaBytes)));
  } catch (_) {
    throw Park.error('PARSE', '媒体数据解密失败');
  }
  const mp4 = media.mp4 || {};
  const sources = (mp4.sources || []).filter((s) => s && s.status && s.codec !== 'av1');
  if (!sources.length) throw Park.error('UNSUPPORTED', '暂无可用播放源');
  sources.sort((a, b) => (b.res_id || 0) - (a.res_id || 0));
  const out = [];
  for (const src of sources) {
    const domain = (mp4.domains || []).find((d) => src.sub && String(d).includes(src.sub));
    if (!domain) continue;
    const path = `/mp4/${data.md5_id}/${src.res_id}/${src.size}?v=${data.slug}`;
    // 签名密钥的怪癖（同 py）：对 size 十进制数字的「数值字节」做 MD5。
    const key2 = md5HexBytes(Array.from(String(src.size), (ch) => ch.charCodeAt(0) - 48));
    const tokenCt = aes256Ctr(asciiBytes(key2), utf8Bytes(path));
    const inner = bytesToB64(tokenCt).replace(/=+$/, '');
    const token = btoa(inner).replace(/=+$/, '');
    const quality = parseInt(src.label, 10) || undefined;
    out.push({
      url: `https://${domain}/sora/${src.size}/${token}`,
      format: 'mp4',
      label: src.label || (quality ? quality + 'P' : '原画'),
      ...(quality ? { quality } : {}),
      headers: { Referer: embedUrl },
    });
  }
  if (!out.length) throw Park.error('UNSUPPORTED', '暂无可用播放源');
  out[0].preferred = true;
  return out;
}

Park.register({
  key: 'asmrlib',
  name: 'ASMRLIB',
  version: '0.0.1',
  minAppVersion: '0.9.2',
  type: 'voice',
  category: 'asmr',
  homepage: BASE,
  domains: ['asmrlib.com'],
  linkPatterns: ['asmrlib\\.com/posts/([0-9a-f]{32})'],
  idPattern: '^[0-9a-f]{32}$',
  imageHeaders: { Referer: BASE + '/' },
  network: { mode: 'auto', vpnHint: true },
  media: { mode: 'native', scope: 'session', origin: BASE, referrerDomains: ['abyssplayer.com'] },
  defaultFeed: 'latest',
  feeds: [
    { key: 'latest', label: '最新' },
    { key: 'asmr', label: 'ASMR' },
    { key: 'r18', label: 'R18' },
    { key: 'yoonying', label: 'yoonying' },
    { key: 'puffin', label: 'Puffin' },
    { key: 'maimy', label: 'Maimy' },
    { key: 'yeonchu', label: 'yeonchu' },
    { key: 'record', label: 'Record' },
    { key: 'hari', label: 'HARI' },
  ],

  async feed(key, { page }) {
    let url;
    if (key === 'latest') url = `${BASE}/?page=${page}`;
    else if (TAGS[key]) url = `${BASE}/tags/${encodeURIComponent(TAGS[key])}?page=${page}`;
    else throw Park.error('CONFIG', '未知列表');
    const doc = await fetchDoc(this.http, url);
    const items = parseCards(doc);
    if (!items.length && page === 1) throw Park.error('PARSE', '未解析到作品列表');
    const maxPage = Math.max(maxPageOf(doc), page);
    return { items, page, totalPages: maxPage, hasNext: page < maxPage };
  },

  async search({ keyword, page }) {
    const kw = String(keyword || '').trim();
    if (!kw) return { items: [], page: 1, hasNext: false };
    const doc = await fetchDoc(this.http, `${BASE}/search/${encodeURIComponent(kw)}?page=${page}`);
    const items = parseCards(doc);
    const maxPage = Math.max(maxPageOf(doc), page);
    return { items, page, totalPages: maxPage, hasNext: page < maxPage };
  },

  async detail(id) {
    if (!/^[0-9a-f]{32}$/.test(String(id))) throw Park.error('NOT_FOUND', '作品不存在');
    const url = `${BASE}/posts/${id}`;
    const doc = await fetchDoc(this.http, url);
    const title = clean(Park.html.text(doc.querySelector('h1')));
    if (!title) throw Park.error('PARSE', '未解析到作品标题');
    const player = doc.querySelector('.player');
    const cover = coverUrl(player ? player.getAttribute('data-pic') : '');
    const time = doc.querySelector('time');
    const uploaded = time ? (time.getAttribute('datetime') || clean(Park.html.text(time))) : '';
    // 作品标签：详情页正文的书签区——同一个 div 里直接含 fa-bookmark 图标
    // 与 /tags/ 链接（相关作品卡片的书签图标在独立小 div 里、标签云无图标，
    // 都不符合这个结构）。
    const tags = [];
    for (const div of doc.querySelectorAll('div')) {
      const kids = Array.from(div.children || []);
      const hasBookmark = kids.some((c) => c.tagName === 'I' &&
        String(c.className || '').split(/\s+/).includes('fa-bookmark'));
      if (!hasBookmark) continue;
      for (const a of kids) {
        if (a.tagName !== 'A' || !(a.getAttribute('href') || '').includes('/tags/')) continue;
        const name = clean(Park.html.text(a));
        if (name && !tags.some((t) => t.name === name)) tags.push({ name, keyword: name });
      }
      if (tags.length) break;
    }
    const related = parseCards(doc).filter((x) => x.id !== id);
    return {
      id,
      title,
      cover,
      url,
      ...(uploaded ? { uploaded } : {}),
      description: '',
      mediaKind: 'voice',
      ...(tags.length ? { tags: [{ namespace: 'tag', label: '标签', tags }] } : { tags: [] }),
      chapters: null,
      ...(related.length ? { related } : {}),
    };
  },

  async videos(id, episodeId) {
    if (!/^[0-9a-f]{32}$/.test(String(id))) throw Park.error('NOT_FOUND', '作品不存在');
    const url = `${BASE}/posts/${id}`;
    const doc = await fetchDoc(this.http, url);
    let embedUrl = '';
    for (const btn of doc.querySelectorAll('button[data-server]')) {
      const u = btn.getAttribute('data-url') || '';
      if (btn.getAttribute('data-server') === 'abyss' || u.includes('abyssplayer.com')) { embedUrl = u; break; }
    }
    if (!embedUrl) throw Park.error('UNSUPPORTED', '该作品暂无可解析的播放线路');
    return abyssVideos(this.http, embedUrl);
  },
});
