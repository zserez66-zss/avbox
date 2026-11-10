# -*- coding: utf-8 -*-
"""ASMRLIB (asmrlib.com) —— TVBox / CatVodSpider 源。

站点形态（2026-11-08 实测）：
  - Laravel + Cloudflare，路径里出现 '//' 会 404，拼 URL 时注意
  - 列表：主页流水 ?page=N（12 条/页，约 347 页）；卡片是 div.relative，
    封面 img 的 alt 是标题、src 是封面，<time> 是日期（作备注）
  - 分类：最新 '/' + 标签页 /tags/<t>（ASMR、R18、yoonying、Puffin、
    Maimy、yeonchu、Record、HARI），同卡片同分页
  - 搜索：/search/<关键词>?page=N，可用且能翻页
  - 详情：h1 是标题，.player 的 data-pic 是封面；[data-server] 按钮给线路：
    byse -> 线路名 BI，abyss -> 线路名 AB，各一条「播放$外嵌地址」

播放：
  - BI(byse)：重型 JS 播放器，无静态直链，playerContent 返回 parse:1 交 App 解析
  - AB(abyss)：外嵌页内嵌加密数据（datas），播放器在本地解密拼签名地址；
    本源用纯 Python 复刻了整条链（MD5 + 自带 AES-256-CTR，无第三方依赖），
    在 playerContent 里直接解出带时效无关签名的 mp4 直链（parse:0），
    播放必须带 Referer=外嵌页地址，否则 CDN 回 403。
"""
import base64
import hashlib
import json
import re
import time
import urllib.parse
import requests

try:
    import urllib3
    urllib3.disable_warnings()
except Exception:
    pass

try:
    from base.spider import Spider as BaseSpider
except ImportError:
    class BaseSpider:
        pass


# ----------------------------------------------------------------------
# 纯 Python AES-256（只用加密块） + CTR 模式
# TVBox 的 Python 环境不保证有 pycryptodome，所以自带实现。
# ----------------------------------------------------------------------

def _gf_mul(a, b):
    p = 0
    for _ in range(8):
        if b & 1:
            p ^= a
        a = ((a << 1) ^ (0x1B if a & 0x80 else 0)) & 0xFF
        b >>= 1
    return p


def _build_sbox():
    exp = [0] * 512
    log = [0] * 256
    x = 1
    for i in range(255):
        exp[i] = x
        log[x] = i
        x = _gf_mul(x, 3)
    for i in range(255, 512):
        exp[i] = exp[i - 255]
    sbox = [0] * 256
    for i in range(256):
        inv = 0 if i == 0 else exp[255 - log[i]]
        s = inv
        for rot in (1, 2, 3, 4):
            s ^= ((inv << rot) | (inv >> (8 - rot))) & 0xFF
        sbox[i] = (s ^ 0x63) & 0xFF
    return sbox


_SBOX = _build_sbox()


def _aes256_expand(key):
    """key: 32 字节 -> 60 个 4 字节轮密钥字。"""
    w = [list(key[4 * i:4 * i + 4]) for i in range(8)]
    rcon = (0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40)
    for i in range(8, 60):
        t = list(w[i - 1])
        if i % 8 == 0:
            t = [_SBOX[t[1]] ^ rcon[i // 8 - 1], _SBOX[t[2]], _SBOX[t[3]], _SBOX[t[0]]]
        elif i % 8 == 4:
            t = [_SBOX[b] for b in t]
        w.append([w[i - 8][j] ^ t[j] for j in range(4)])
    return w


def _aes256_encrypt_block(w, block):
    st = list(block)  # 状态按列优先：st[4*c + r]

    def add_rk(rnd):
        for c in range(4):
            for r in range(4):
                st[4 * c + r] ^= w[4 * rnd + c][r]

    add_rk(0)
    for rnd in range(1, 14):
        st = [_SBOX[b] for b in st]
        st = [st[4 * ((c + r) % 4) + r] for c in range(4) for r in range(4)]
        for c in range(4):
            a = st[4 * c:4 * c + 4]
            st[4 * c + 0] = _gf_mul(a[0], 2) ^ _gf_mul(a[1], 3) ^ a[2] ^ a[3]
            st[4 * c + 1] = a[0] ^ _gf_mul(a[1], 2) ^ _gf_mul(a[2], 3) ^ a[3]
            st[4 * c + 2] = a[0] ^ a[1] ^ _gf_mul(a[2], 2) ^ _gf_mul(a[3], 3)
            st[4 * c + 3] = _gf_mul(a[0], 3) ^ a[1] ^ a[2] ^ _gf_mul(a[3], 2)
        add_rk(rnd)
    st = [_SBOX[b] for b in st]
    st = [st[4 * ((c + r) % 4) + r] for c in range(4) for r in range(4)]
    add_rk(14)
    return bytes(st)


def _aes256_ctr(key, data):
    """AES-256-CTR：IV = key 前 16 字节，计数器按 128 位大端递增。加解密同函数。"""
    w = _aes256_expand(key)
    out = bytearray()
    counter = int.from_bytes(key[:16], "big")
    for off in range(0, len(data), 16):
        ks = _aes256_encrypt_block(w, counter.to_bytes(16, "big"))
        chunk = data[off:off + 16]
        out += bytes(b ^ ks[i] for i, b in enumerate(chunk))
        counter += 1
    return bytes(out)


# ----------------------------------------------------------------------
# Spider
# ----------------------------------------------------------------------

class Spider(BaseSpider):
    BASE_URL = "https://asmrlib.com"
    FALLBACK_URLS = ["https://asmrlib.com"]
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    TAGS = ["ASMR", "R18", "yoonying", "Puffin", "Maimy", "yeonchu", "Record", "HARI"]

    def __init__(self):
        super().__init__()
        self.name = "ASMRLIB"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------------- 对外接口 ----------------

    def homeContent(self, filter):
        html = self._get(self.BASE_URL + "/?page=1")
        return {"class": self._classes(), "filters": {},
                "list": self._parse_cards(html), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_cards(self._get(self.BASE_URL + "/?page=1"))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        if str(tid) in ("latest", "/", ""):
            url = "%s/?page=%d" % (self.BASE_URL, page)
        else:
            url = "%s/tags/%s?page=%d" % (self.BASE_URL, urllib.parse.quote(str(tid), safe=""), page)
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 12, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        url = self._detail_url(ids[0])
        html = self._get(url)
        if not html:
            return result
        name = self._clean(self._match(html, r"<h1[^>]*>(.*?)</h1>")
                           or self._match(html, r"<title>(.*?)</title>"))
        pic = ""
        tag = self._match(html, r'(<[^>]+class=["\'][^"\']*\bplayer\b[^"\']*["\'][^>]*>)')
        if tag:
            pic = self._match(tag, r'data-pic=["\']([^"\']+)')
        lines, eps = [], []
        for btn in re.findall(r"<button\b[^>]*>.*?</button>", html, re.S | re.I):
            server = self._match(btn, r'data-server=["\']([^"\']+)')
            eurl = self._match(btn, r'data-url=["\']([^"\']+)')
            label = self._clean(self._match(btn, r">(.*)</button>"))
            if not server or not eurl:
                continue
            lines.append(label or server)
            eps.append("播放$" + eurl)
        if not lines:
            lines, eps = ["asmrlib"], ["播放$" + url]
        result["list"].append({
            "vod_id": url, "vod_name": name,
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
            "type_name": "", "vod_year": "", "vod_area": "",
            "vod_remarks": "", "vod_actor": "", "vod_director": "",
            "vod_content": "",
            "vod_play_from": "$$$".join(lines),
            "vod_play_url": "$$$".join(eps),
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        url = "%s/search/%s?page=%d" % (self.BASE_URL, urllib.parse.quote(str(key), safe=""), page)
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": 12, "total": 99999, "list": data, "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0,
                  "header": {"User-Agent": self.HEADERS["User-Agent"],
                             "Referer": self.BASE_URL + "/"}}
        if not id:
            return result
        url = str(id)
        if "abyssplayer.com" in url:
            stream = ""
            try:
                stream = self._abyss_stream(url)
            except Exception:
                stream = ""
            if stream:
                result["url"] = stream
                result["header"] = {"User-Agent": self.HEADERS["User-Agent"],
                                    "Referer": url}
            else:
                # 解链失败兜底：把外嵌页交给 App 解析
                result["parse"] = 1
                result["jx"] = 1
            return result
        if "bysetayico.com" in url:
            result["parse"] = 1
            result["jx"] = 1
            return result
        result["parse"] = 1
        return result

    # ---------------- ABYSS 直链解析 ----------------

    def _abyss_stream(self, embed_url, force_res=None):
        """按 abyss 播放器自身的算法，从外嵌页解出签名 mp4 直链。失败返回 ''。"""
        r = requests.get(embed_url,
                         headers={"User-Agent": self.HEADERS["User-Agent"]},
                         timeout=15, verify=False)
        if r.status_code >= 400:
            return ""
        r.encoding = "utf-8"
        m = re.search(r'const datas = "([^"]+)"', r.text)
        if not m:
            return ""
        blob = m.group(1)
        blob += "=" * (-len(blob) % 4)
        data = json.loads(base64.b64decode(blob).decode("latin-1"))
        slug = data["slug"]
        md5_id = data["md5_id"]
        user_id = data["user_id"]
        media_ct = data["media"].encode("latin-1")
        key1 = hashlib.md5(("%s:%s:%s" % (user_id, slug, md5_id)).encode("utf-8")).hexdigest()
        media = json.loads(_aes256_ctr(key1.encode("ascii"), media_ct).decode("utf-8"))
        sources = [s for s in (media.get("mp4") or {}).get("sources") or []
                   if s.get("status") and s.get("codec") != "av1"]
        if not sources:
            return ""
        if force_res is not None:
            src = next((s for s in sources if s.get("res_id") == force_res), None)
        else:
            src = max(sources, key=lambda s: s.get("res_id") or 0)
        if not src:
            return ""
        domain = next((d for d in (media.get("mp4") or {}).get("domains") or []
                       if src.get("sub") and src["sub"] in d), "")
        if not domain:
            return ""
        path = "/mp4/%s/%s/%s?v=%s" % (md5_id, src["res_id"], src["size"], slug)
        # 签名密钥的怪癖：对 size 的十进制数字「数值字节」做 MD5，不是 ASCII 字符串
        key2 = hashlib.md5(bytes(int(ch) for ch in str(src["size"]))).hexdigest()
        token_ct = _aes256_ctr(key2.encode("ascii"), path.encode("utf-8"))
        token = base64.b64encode(
            base64.b64encode(token_ct).rstrip(b"=")).rstrip(b"=").decode("ascii")
        return "https://%s/sora/%s/%s" % (domain, src["size"], token)

    # ---------------- 解析 ----------------

    def _classes(self):
        cls = [{"type_id": "latest", "type_name": "最新"}]
        cls += [{"type_id": t, "type_name": t} for t in self.TAGS]
        return cls

    def _parse_cards(self, html):
        """列表卡片：按 div.relative 切块，块内取帖子链接/封面 alt 标题/日期。"""
        data, seen = [], set()
        starts = [m.start() for m in re.finditer(r'class="relative"', html or "")]
        for i, s in enumerate(starts):
            end = starts[i + 1] if i + 1 < len(starts) else s + 2500
            chunk = html[s:min(end, s + 2500)]
            href = self._match(chunk, r'href=["\'](https?://asmrlib\.com/posts/[0-9a-f]{32}|/posts/[0-9a-f]{32})["\']')
            if not href:
                continue
            full = urllib.parse.urljoin(self.BASE_URL, href)
            if full in seen:
                continue
            tag = self._match(chunk, r"(<img[^>]*>)")
            name = self._clean(self._match(tag, r'(?:^|\s)alt=["\']([^"\']*)')
                               or self._match(chunk, r"<h2[^>]*>(.*?)</h2>"))
            if not name:
                continue
            seen.add(full)
            data.append({"vod_id": full, "vod_name": name,
                         "vod_pic": urllib.parse.urljoin(
                             self.BASE_URL, self._match(tag, r'(?:^|\s)src=["\']([^"\']+)')),
                         "vod_remarks": self._clean(self._match(chunk, r"<time[^>]*>(.*?)</time>"))})
        return data

    def _pagecount(self, html, page, got):
        nums = [int(n) for n in re.findall(r"[?&]page=(\d+)", html or "")]
        nums = [n for n in nums if 0 < n < 100000]
        if nums:
            return max(nums)
        return page if got < 12 else page + 1

    # ---------------- 工具 ----------------

    def _detail_url(self, id_or_url):
        s = str(id_or_url or "").strip()
        if s.startswith("http"):
            return s
        m = re.search(r"([0-9a-f]{32})", s)
        if m:
            return self.BASE_URL + "/posts/" + m.group(1)
        return urllib.parse.urljoin(self.BASE_URL, s)

    def _get(self, url, headers=None):
        # 站点在连续请求时会间歇限流/挑战，失败短暂重试一次
        for real in self._candidate_urls(url):
            h = dict(self.HEADERS)
            if headers:
                h.update(headers)
            for attempt in range(2):
                try:
                    r = self.session.get(real, headers=h, timeout=15, verify=False)
                    r.encoding = "utf-8"
                    if r.status_code < 400 and "Just a moment" not in r.text \
                            and "cf-browser-verification" not in r.text:
                        return r.text
                except Exception:
                    pass
                if attempt == 0:
                    time.sleep(1)
        return ""

    def _candidate_urls(self, url):
        urls = [url]
        p = urllib.parse.urlparse(url)
        if p.netloc:
            for host in self.FALLBACK_URLS:
                hp = urllib.parse.urlparse(host)
                if hp.netloc != p.netloc:
                    urls.append(host + p.path + ("?" + p.query if p.query else ""))
        return list(dict.fromkeys(urls))

    def _match(self, text, pattern):
        m = re.search(pattern, text or "", re.S | re.I)
        return m.group(1).strip() if m and m.lastindex else ""

    def _clean(self, text):
        text = re.sub(r"<.*?>", "", text or "", flags=re.S)
        for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&#038;", "&"),
                     ("&quot;", '"'), ("&#039;", "'")):
            text = text.replace(a, b)
        return re.sub(r"\s+", " ", text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
