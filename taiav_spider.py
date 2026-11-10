# -*- coding: utf-8 -*-
"""Taiav (taiav.com) —— TVBox / CatVodSpider 源。

站点形态（2026-11-08 实测）：
  - JAV / 国产AV 聚合站，服务端渲染（UIkit），中文区在 /cn/ 下，
    影片 ID 为 MongoDB 风格 24 位十六进制
  - 列表卡片：<a href="/cn/movie/<24hex>"> 包 <img alt=全标题 src=海报>，
    海报在 img.storyofthepast.xyz/videos/<yyyymm>/<dd>/<id>/poster2.webp
  - 每页 15 条；分类/最新/标签/搜索都用 ?page=N 分页（无码共 174 页，
    最新 /cn/news 共 3566 页）；热门 /hots 是固定榜单 39 条、无分页
  - 分类来源：导航 4 个分类 + /discover 标签墙按数量取前 20 个标签写死
  - 详情页 <h1> 是干净标题，JSON-LD(VideoObject) 里有 thumbnailUrl 海报
    与 duration（如 PT52M）；页面 HTML 里没有流地址
  - 播放：GET /api/getmovie?type=1280&id=<id> 返回 {"m3u8": "/videos/.../
    index.m3u8?random=..&counts=5&timestamp=..&key=.."} —— 本站签名地址，
    有时效，每次播放现调现取。已实测：全新会话、只带 UA、无 cookie、
    无 Referer、无 X-Requested-With 冷调用即 200，播放器不需要预热
  - 播放列表是 AES-128 加密 HLS：EXT-X-KEY 的 URI 是本站相对签名路径
    （/videos/.../ts.key?...&sign=..，冷取 200、16 字节），分片在
    v11cdn.snmovie.com；标准 HLS AES，播放器可原生解密（已本地解密
    第 0/100/781 片验证解密后 0/188/376 字节均为 TS 同步字 0x47）
  - 站点整体偏慢：偶发 25s+ 读超时，_get 用 30s 超时 + 重试
"""
import re
import time
import json
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


class Spider(BaseSpider):
    BASE_URL = "https://taiav.com"
    FALLBACK_URLS = ["https://taiav.com"]
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    # 路径（相对 BASE_URL）-> 名称；顺序即分类栏顺序
    CLASSES = [
        ("cn/news", "最新"),
        ("hots", "热门"),
        ("cn/category/无码", "无码"),
        ("cn/category/有码", "有码"),
        ("cn/category/国产AV", "国产AV"),
        ("cn/category/网红主播", "网红主播"),
        # /discover 标签墙按影片数排序的前 20 个（2026-11-08 抓取写死）
        ("cn/tag/巨乳", "巨乳"),
        ("cn/tag/美腿", "美腿"),
        ("cn/tag/苗條", "苗條"),
        ("cn/tag/黑絲", "黑絲"),
        ("cn/tag/主播", "主播"),
        ("cn/tag/美尻", "美尻"),
        ("cn/tag/糖心vlog", "糖心vlog"),
        ("cn/tag/自慰", "自慰"),
        ("cn/tag/中国", "中国"),
        ("cn/tag/口交", "口交"),
        ("cn/tag/中出", "中出"),
        ("cn/tag/美少女", "美少女"),
        ("cn/tag/探花", "探花"),
        ("cn/tag/痴女", "痴女"),
        ("cn/tag/麻豆传媒映画", "麻豆传媒映画"),
        ("cn/tag/短髮", "短髮"),
        ("cn/tag/誘惑", "誘惑"),
        ("cn/tag/人妻", "人妻"),
        ("cn/tag/絲襪", "絲襪"),
        ("cn/tag/白虎", "白虎"),
    ]
    PAGE_SIZE = 15
    SINGLE_PAGE = {"hots"}          # 固定榜单，无分页

    def __init__(self):
        super().__init__()
        self.name = "Taiav"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------------- 对外接口 ----------------

    def homeContent(self, filter):
        html = self._get(self.BASE_URL + "/")
        return {"class": self._classes(), "filters": {},
                "list": self._parse_cards(html), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        return {"list": self._parse_cards(self._get(self.BASE_URL + "/"))}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        path = str(tid or "").strip().strip("/")
        if path in self.SINGLE_PAGE:
            if page > 1:
                return {"page": page, "pagecount": 1, "limit": self.PAGE_SIZE,
                        "total": 99999, "list": [], "parse": 0, "jx": 0}
            html = self._get(self.BASE_URL + "/" + path)
            data = self._parse_cards(html)
            return {"page": 1, "pagecount": 1, "limit": self.PAGE_SIZE,
                    "total": 99999, "list": data, "parse": 0, "jx": 0}
        url = self.BASE_URL + "/" + urllib.parse.quote(path, safe="/%")
        if page > 1:
            url += "?page=%d" % page
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": self.PAGE_SIZE, "total": 99999, "list": data,
                "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        mid = self._movie_id(ids[0])
        if not mid:
            return result
        url = "%s/cn/movie/%s" % (self.BASE_URL, mid)
        html = self._get(url)
        if not html:
            return result
        name = self._clean(self._match(html, r"<h1[^>]*>(.*?)</h1>"))
        if not name:
            t = self._clean(self._match(html, r"<title>(.*?)</title>"))
            name = re.split(r"\s*在线观看.*$|\s*-\s*Taiav", t)[0].strip()
        pic = self._match(html, r'"thumbnailUrl"\s*:\s*"([^"]+)"')
        if not pic:
            pic = self._match(html, r'(https://img\.storyofthepast\.xyz/videos/[^"\') ]*?'
                              + mid + r'/poster2\.(?:webp|jpg))')
        dur = self._duration_text(self._match(html, r'"duration"\s*:\s*"([^"]+)"'))
        content = self._clean(self._match(
            html, r'<meta[^>]+name=["\']description["\'][^>]+content=["\']([^"\']+)'))
        result["list"].append({
            "vod_id": url, "vod_name": name,
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
            "type_name": "", "vod_year": "", "vod_area": "",
            "vod_remarks": dur, "vod_actor": "", "vod_director": "",
            "vod_content": content,
            "vod_play_from": "播放",
            # 剧集 id 放详情页地址：签名 m3u8 有时效，playerContent 现调现取
            "vod_play_url": "播放$" + url,
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        url = "%s/cn/search?q=%s" % (
            self.BASE_URL, urllib.parse.quote(str(key), safe=""))
        if page > 1:
            url += "&page=%d" % page
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data)),
                "limit": self.PAGE_SIZE, "total": 99999, "list": data,
                "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        # 签名地址会过期：一律用影片 ID 现调 /api/getmovie 换新（冷调用已实测可通，
        # 只需要 UA，不用 cookie / Referer / 预热详情页）
        result = {"parse": 0, "playUrl": "", "url": "", "jx": 0,
                  "header": {"User-Agent": self.HEADERS["User-Agent"]}}
        mid = self._movie_id(id)
        if mid:
            m3u8 = self._resolve_m3u8(mid)
            if m3u8:
                result["url"] = m3u8
                return result
            result["url"] = "%s/cn/movie/%s" % (self.BASE_URL, mid)
            result["parse"] = 1
            return result
        result["url"] = id or ""
        return result

    # ---------------- 解析 ----------------

    def _classes(self):
        return [{"type_id": path, "type_name": name} for path, name in self.CLASSES]

    def _parse_cards(self, html):
        """卡片：<a href="/cn/movie/<24hex>"> 里包 <img alt=全标题 src=海报>。"""
        data, seen = [], set()
        for m in re.finditer(
                r'<a\b[^>]*href=["\']/cn/movie/([0-9a-f]{24})["\'][^>]*>(.*?)</a>',
                html or "", re.S | re.I):
            mid, chunk = m.group(1), m.group(2)
            if "<img" not in chunk or mid in seen:
                continue
            tag = self._match(chunk, r"(<img\b[^>]*>)")
            name = self._clean(self._match(tag, r'\balt=["\']([^"\']*)'))
            if not name:
                continue
            seen.add(mid)
            dur = self._match(chunk, r'(\d{1,2}:\d{2}(?::\d{2})?)')
            data.append({
                "vod_id": "%s/cn/movie/%s" % (self.BASE_URL, mid),
                "vod_name": name,
                "vod_pic": urllib.parse.urljoin(
                    self.BASE_URL, self._match(tag, r'\bsrc=["\']([^"\']+)')),
                "vod_remarks": dur,
            })
        return data

    def _pagecount(self, html, page, got):
        nums = [int(n) for n in re.findall(r'[?&]page=(\d+)', html or "")]
        nums = [n for n in nums if 0 < n < 1000000]
        if nums:
            return max(max(nums), page)
        return page if got < self.PAGE_SIZE else page + 1

    def _resolve_m3u8(self, mid):
        url = "%s/api/getmovie?type=1280&id=%s" % (self.BASE_URL, mid)
        text = self._get(url, headers={"Referer": ""})
        if not text:
            return ""
        try:
            path = json.loads(text).get("m3u8", "")
        except Exception:
            path = self._match(text, r'"m3u8"\s*:\s*"([^"]+)"')
        if not path:
            return ""
        return urllib.parse.urljoin(self.BASE_URL, path.replace("\\/", "/"))

    def _movie_id(self, id_or_url):
        m = re.search(r"([0-9a-f]{24})", str(id_or_url or ""))
        return m.group(1) if m else ""

    def _duration_text(self, iso):
        # JSON-LD 的 ISO8601 时长 PT52M / PT1H2M / PT45S -> 中文备注
        m = re.fullmatch(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", (iso or "").strip())
        if not m:
            return ""
        h, mi, s = (int(x) if x else 0 for x in m.groups())
        total = h * 60 + mi + (1 if s >= 30 else 0)
        if total <= 0:
            return ""
        return "时长 %d 分钟" % total if total < 60 else \
            "时长 %d小时%02d分" % (total // 60, total % 60)

    # ---------------- 工具 ----------------

    def _get(self, url, headers=None):
        # 站点偏慢：30s 超时 + 3 次重试；候选域名逐个试
        for real in self._candidate_urls(url):
            h = dict(self.HEADERS)
            if headers:
                h.update(headers)
            for attempt in range(3):
                try:
                    r = self.session.get(real, headers=h, timeout=30, verify=False)
                    r.encoding = "utf-8"
                    if r.status_code < 400 and "Just a moment" not in r.text \
                            and "cf-browser-verification" not in r.text:
                        return r.text
                    if r.status_code in (404, 410):
                        break
                except Exception:
                    pass
                if attempt < 2:
                    time.sleep(1.5)
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
                     ("&quot;", '"'), ("&#039;", "'"), ("&lt;", "<"), ("&gt;", ">")):
            text = text.replace(a, b)
        return re.sub(r"\s+", " ", text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
