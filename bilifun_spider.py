# -*- coding: utf-8 -*-
"""Bili影院 (www.bili-fun.com) —— TVBox / CatVodSpider 源。

站点形态（2026-11-08 实测）：
  - Next.js 服务端渲染，普通 requests 即可拿到卡片与播放地址，无 API
  - 列表卡片：<a href="/video/<数字id>"> 包 <img>，img 的 alt 是完整标题，
    src 是本站 cdn-cgi 图床代理地址（可剥壳还原 img.tphsck.com 原图）；
    卡片尾部有火焰图标 + 播放量（如 10.0K），作备注
  - 首页分页 /page/N（约 3700 页）；分类分页 /category/<slug>/page/N，
    第 1 页是裸的 /category/<slug>；每页 20 条，页面里有重复卡片需去重
  - 分类（抄自站内导航）：
      国产区 chinese-mainland / AV区 japanese-av / 欧美区 western
      动漫区 anime / 其他区 others（japanese-av 约 1006 页）
  - 详情页 <video> 自带 poster 封面与 title 全标题，
    <source src="...m3u8"> 是直链 master 播放列表
  - 播放：master -> variant -> AES-128 加密分片（播放器原生解密，
    已实测解密后为真 TS）；整条链不需要 Referer
  - 搜索：/search?q=<关键词>&page=N 服务端可用（关键词会被站方转小写）
"""
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


class Spider(BaseSpider):
    BASE_URL = "https://www.bili-fun.com"
    FALLBACK_URLS = ["https://www.bili-fun.com"]
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    CLASSES = [
        ("chinese-mainland", "国产区"),
        ("japanese-av", "AV区"),
        ("western", "欧美区"),
        ("anime", "动漫区"),
        ("others", "其他区"),
    ]
    PAGE_SIZE = 20

    def __init__(self):
        super().__init__()
        self.name = "Bili影院"
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
        slug = str(tid or "").strip().strip("/")
        if slug.startswith("category/"):
            slug = slug[len("category/"):]
        if page <= 1:
            url = "%s/category/%s" % (self.BASE_URL, slug)
        else:
            url = "%s/category/%s/page/%d" % (self.BASE_URL, slug, page)
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data), slug),
                "limit": self.PAGE_SIZE, "total": 99999, "list": data,
                "parse": 0, "jx": 0}

    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        url = self._detail_url(ids[0])
        html = self._get(url)
        if not html:
            return result
        vtag = self._match(html, r"(<video\b[^>]*>)")
        name = self._clean(self._match(vtag, r'\btitle=["\']([^"\']+)')
                           or self._match(vtag, r'aria-label=["\']([^"\']+)'))
        if not name:
            t = self._clean(self._match(html, r"<title>(.*?)</title>"))
            name = re.split(r"\s+-\s+作品详情|\s*\|\s*Bili", t)[0].strip()
        pic = self._match(vtag, r'\bposter=["\']([^"\']+)')
        m3u8 = self._match(html, r'<source\b[^>]*\bsrc=["\']([^"\']+\.m3u8[^"\']*)')
        if not m3u8:
            m3u8 = self._match(html, r'(https?://[^\s"\'<>\\]+\.m3u8[^\s"\'<>\\]*)')
        if not m3u8:
            return result
        result["list"].append({
            "vod_id": url, "vod_name": name,
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
            "type_name": "", "vod_year": "", "vod_area": "",
            "vod_remarks": "", "vod_actor": "", "vod_director": "",
            "vod_content": "",
            "vod_play_from": "播放",
            "vod_play_url": "播放$" + m3u8,
        })
        return result

    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        url = "%s/search?q=%s&page=%d" % (
            self.BASE_URL, urllib.parse.quote(str(key), safe=""), page)
        html = self._get(url)
        data = self._parse_cards(html)
        return {"page": page, "pagecount": self._pagecount(html, page, len(data), ""),
                "limit": self.PAGE_SIZE, "total": 99999, "list": data,
                "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        # 详情页给出的就是 master m3u8 直链，无令牌、无 Referer 要求，原样返回
        return {"parse": 0, "playUrl": "", "url": id or "", "jx": 0,
                "header": {"User-Agent": self.HEADERS["User-Agent"]}}

    # ---------------- 解析 ----------------

    def _classes(self):
        return [{"type_id": slug, "type_name": name} for slug, name in self.CLASSES]

    def _parse_cards(self, html):
        """卡片：<a href=/video/<id>> 包 <img alt=标题>，尾部火焰图标后是播放量。"""
        data, seen = [], set()
        for m in re.finditer(r'<a\b[^>]*href=["\'](/video/\d+)["\'][^>]*>(.*?)</a>',
                             html or "", re.S | re.I):
            path, chunk = m.group(1), m.group(2)
            if "<img" not in chunk:
                continue
            full = urllib.parse.urljoin(self.BASE_URL, path)
            if full in seen:
                continue
            tag = self._match(chunk, r"(<img\b[^>]*>)")
            name = self._clean(self._match(tag, r'\balt=["\']([^"\']*)'))
            if not name:
                continue
            seen.add(full)
            views = self._match(chunk, r'lucide-flame.*?</svg>\s*([\d.]+[KM]?)')
            data.append({
                "vod_id": full, "vod_name": name,
                "vod_pic": self._cover(tag),
                "vod_remarks": ("🔥" + views) if views else "",
            })
        return data

    def _cover(self, img_tag):
        src = self._match(img_tag, r'\bsrc=["\']([^"\']+)')
        if not src:
            ss = self._match(img_tag, r'\bsrcSet=["\']([^"\']+)')
            if ss:
                src = ss.split(",")[0].strip().split(" ")[0]
        # 剥掉本站 cdn-cgi 图床代理壳，还原原图地址
        m = re.search(r"/cdn-cgi/image/[^/]+/(https?://.+)$", src or "")
        if m:
            src = m.group(1)
        return urllib.parse.urljoin(self.BASE_URL, src)

    def _pagecount(self, html, page, got, slug):
        if slug:
            nums = [int(n) for n in re.findall(
                r"/category/%s/page/(\d+)" % re.escape(slug), html or "")]
        else:
            nums = [int(n) for n in re.findall(r'href="/page/(\d+)"', html or "")]
        nums = [n for n in nums if 0 < n < 1000000]
        if nums:
            return max(max(nums), page)
        return page if got < self.PAGE_SIZE else page + 1

    # ---------------- 工具 ----------------

    def _detail_url(self, id_or_url):
        s = str(id_or_url or "").strip()
        if s.startswith("http"):
            return s
        m = re.search(r"(\d+)", s)
        if m:
            return self.BASE_URL + "/video/" + m.group(1)
        return urllib.parse.urljoin(self.BASE_URL, s)

    def _get(self, url, headers=None):
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
                     ("&quot;", '"'), ("&#039;", "'"), ("&lt;", "<"), ("&gt;", ">")):
            text = text.replace(a, b)
        return re.sub(r"\s+", " ", text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
