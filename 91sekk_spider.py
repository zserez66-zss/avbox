# -*- coding: utf-8 -*-
"""91sekk (www.91sekk.com) —— TVBox / CatVodSpider 源。

站点形态（2026-11-08 实测）：
  - 海洋CMS(seacms) 家族成人门户，IIS；页面是 UTF-8，但 requests 默认
    ISO-8859-1 会乱码，每次抓取必须强制 r.encoding='utf-8'
  - 视频列表：/mov/HHMP4/（在线视频，491 页）与 /mov/xvodx/（精彩电影，
    96 条/5 页），同构：20 卡/页，分页 /index-<N>.html；卡片是
    <a href="/mov/html/<id>.html" alt="标题"><img src="封面">，
    标题在 a 或 img 的 alt 里（h3 里的文字被截断，不能用），
    <span class="movie_date"> 是日期角标
  - 视频详情 /mov/html/<id>.html：<h1> 是干净标题，play-list-box 里是
    播放源与剧集锚点 /mov/player/<id>-<src>-<num>.html（实测样本均为
    单源单集「第1集」）
  - 播放页通过 <script src="/upload/playdata/<日期>/<id>/<id>.js"> 载入
    播放数据（日期目录逐片不同，必须从播放页现取，不能拼）；
    js 里 mac_url=unescape('https%3A%2F%2F...%2Findex.m3u8')，
    unquote 后就是 master m3u8 直链
  - 播放链实测：master -> variant -> 未加密 TS 分片，同步字 0x47 对齐；
    整条链不需要 Referer（带不带都 200），只回 UA。
    playerContent 里把 master 解析到最高码率 variant 再返回
  - 图片列表：/art/Tpic/（套图精选，185 页），纯文字列表 20 条/页，
    分页 /art/Tpic/index-<N>.html；条目 <span>05-19</span>标题[36p]
  - 图集详情 /art/html/<id>.html：正文图都在 <div class="content"> 里，
    图床随帖子变化（karayou.com / akabebe.com / touimg.com / 23img.com
    等），按容器提取、图数与标题 [Np] 对得上；详情拼 pics:// 交播放器。
    列表深处偶混纯文字帖（无图），详情会给空图集
  - 图床可用性（2026-11-08 沙箱探测）：解析与组图没问题，但图床本身
    状态差——当前列表图集清一色在 karayou.com，探测返回 Cloudflare
    522（源站连接超时，带不带 Referer 都一样）；akabebe.com 403、
    touimg.com 老图 404。属图床侧故障/防盗链，与本源解析无关，
    图集能否出图以真机为准
  - 搜索：/search.html?wd=、?searchword=、/vodsearch.html?wd= 全部
    302 到 404 页，站内无可用搜索，searchContent 恒空
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
    BASE_URL = "https://www.91sekk.com"
    FALLBACK_URLS = ["https://www.91sekk.com"]
    HEADERS = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": BASE_URL + "/",
    }
    # type_id -> (列表路径, 类型)
    CLASSES = [
        ("HHMP4", "在线视频"),
        ("xvodx", "精彩电影"),
        ("Tpic", "套图精选"),
    ]
    SECTION = {
        "HHMP4": "/mov/HHMP4/",
        "xvodx": "/mov/xvodx/",
        "Tpic": "/art/Tpic/",
    }
    PAGE_SIZE = 20

    def __init__(self):
        super().__init__()
        self.name = "91sekk"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)

    def init(self, extend="{}"):
        return None

    def getName(self):
        return self.name

    # ---------------- 对外接口 ----------------

    def homeContent(self, filter):
        html = self._get(self.BASE_URL + self.SECTION["HHMP4"])
        return {"class": self._classes(), "filters": {},
                "list": self._parse_videos(html), "parse": 0, "jx": 0}

    def homeVideoContent(self):
        html = self._get(self.BASE_URL + self.SECTION["HHMP4"])
        return {"list": self._parse_videos(html)}

    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        key = str(tid or "").strip().strip("/")
        key = key.split("/")[-1] if "/" in key else key
        base = self.SECTION.get(key, self.SECTION["HHMP4"])
        if page <= 1:
            url = self.BASE_URL + base
        else:
            url = "%s%sindex-%d.html" % (self.BASE_URL, base, page)
        html = self._get(url)
        if key == "Tpic":
            data = self._parse_pics(html)
        else:
            data = self._parse_videos(html)
        return {"page": page,
                "pagecount": self._pagecount(html, page, len(data)),
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
        if "/art/html/" in url:
            vod = self._art_detail(url, html)
        else:
            vod = self._video_detail(url, html)
        if vod:
            result["list"].append(vod)
        return result

    def searchContent(self, key, quick, pg="1"):
        # 实测 /search.html?wd=、?searchword=、/vodsearch.html?wd=
        # 全部 302 到 404 页，站内无可用搜索
        return {"page": 1, "pagecount": 1, "limit": 0, "total": 0,
                "list": [], "parse": 0, "jx": 0}

    def playerContent(self, flag, id, vipFlags):
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0,
                  "header": {"User-Agent": self.HEADERS["User-Agent"]}}
        if not id:
            return result
        sid = str(id)
        if sid.startswith("pics://"):
            return result
        if ".m3u8" in sid:
            result["url"] = self._best_variant(sid)
            return result
        # 播放页 -> playdata js -> mac_url
        page = self._get(sid if sid.startswith("http")
                         else urllib.parse.urljoin(self.BASE_URL, sid))
        if not page:
            result["parse"] = 1
            return result
        js_path = self._match(page, r'(?:src=["\'])(/upload/playdata/[^"\']+\.js)')
        if not js_path:
            result["parse"] = 1
            return result
        js = self._get(urllib.parse.urljoin(self.BASE_URL, js_path))
        raw = self._match(js, r"mac_url\s*=\s*unescape\(\s*'([^']+)'\s*\)")
        if not raw:
            raw = self._match(js, r"mac_url\s*=\s*'([^']+)'")
        if not raw:
            result["parse"] = 1
            return result
        urls = [urllib.parse.unquote(u).strip()
                for u in raw.split("#") if u.strip()]
        if not urls:
            result["parse"] = 1
            return result
        pick = 0
        mnum = re.search(r"-(\d+)\.html(?:$|\?)", sid)
        if mnum:
            pick = min(max(int(mnum.group(1)) - 1, 0), len(urls) - 1)
        result["url"] = self._best_variant(urls[pick])
        return result

    # ---------------- 解析 ----------------

    def _classes(self):
        return [{"type_id": tid, "type_name": name}
                for tid, name in self.CLASSES]

    def _parse_videos(self, html):
        """视频卡片：<a href=/mov/html/<id>.html alt=标题><img src=封面>…"""
        data, seen = [], set()
        pat = re.compile(
            r'<a\b(?P<attrs>[^>]*?href=["\'](/mov/html/\d+\.html)["\'][^>]*?)>'
            r'(?P<body>.*?)</a>', re.S | re.I)
        for m in pat.finditer(html or ""):
            attrs, path, body = m.group("attrs"), m.group(2), m.group("body")
            if "<img" not in body:
                continue
            full = urllib.parse.urljoin(self.BASE_URL, path)
            if full in seen:
                continue
            tag = self._match(body, r"(<img\b[^>]*>)")
            name = self._clean(self._match(attrs, r'\balt=["\']([^"\']*)')
                               or self._match(tag, r'\balt=["\']([^"\']*)'))
            if not name:
                continue
            seen.add(full)
            pic = self._match(tag, r'(?:^|\s)src=["\']([^"\']+)')
            date = self._clean(self._match(
                body, r'class=["\']movie_date["\'][^>]*>([^<]*)'))
            data.append({
                "vod_id": full, "vod_name": name,
                "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
                "vod_remarks": date,
            })
        return data

    def _parse_pics(self, html):
        """图集列表：纯文字条目 <span>05-19</span>标题[36p]，无缩略图。"""
        data, seen = [], set()
        for m in re.finditer(
                r'<a\b[^>]*href=["\'](/art/html/\d+\.html)["\'][^>]*>'
                r'(.*?)</a>', html or "", re.S | re.I):
            path, body = m.group(1), m.group(2)
            full = urllib.parse.urljoin(self.BASE_URL, path)
            if full in seen:
                continue
            date = self._match(body, r'<span[^>]*>(\d{2}-\d{2})</span>')
            name = self._clean(body)
            if date and name.startswith(date):
                name = name[len(date):].strip()
            if not name:
                continue
            seen.add(full)
            data.append({"vod_id": full, "vod_name": name,
                         "vod_pic": "", "vod_remarks": date})
        return data

    def _video_detail(self, url, html):
        name = self._clean(self._match(html, r"<h1[^>]*>(.*?)</h1>"))
        if not name:
            t = self._clean(self._match(html, r"<title>(.*?)</title>"))
            name = re.split(r"\s+在线播放", t)[0].strip()
        pic = self._match(html, r'class=["\']vcs["\'][^>]*>\s*<img[^>]+src=["\']([^"\']+)')
        if not pic:
            pic = self._match(html, r'(https?://g\d+\.lulugif\.com/p/[^\s"\']+?\.jpg)')
        # 播放源：每个 play-list-box 是一个源，title 是源名
        froms, plays = [], []
        boxes = list(re.finditer(
            r'<div[^>]+class=["\'][^"\']*play-list-box[^"\']*["\'][^>]*'
            r'title=["\']([^"\']*)', html or ""))
        for i, b in enumerate(boxes):
            end = boxes[i + 1].start() if i + 1 < len(boxes) else len(html)
            chunk = html[b.start():end]
            eps = []
            for a in re.finditer(
                    r'<a\b[^>]*href=["\'](/mov/player/[^"\']+)["\'][^>]*>'
                    r'(.*?)</a>', chunk, re.S | re.I):
                ep_name = self._clean(a.group(2)) or "第1集"
                eps.append("%s$%s" % (
                    ep_name, urllib.parse.urljoin(self.BASE_URL, a.group(1))))
            if eps:
                froms.append(b.group(1) or "HLS")
                plays.append("#".join(eps))
        if not plays:
            anchors = re.findall(r'href=["\'](/mov/player/[^"\']+)["\']', html)
            if anchors:
                froms = ["HLS"]
                plays = ["#".join(
                    "第%d集$%s" % (n + 1, urllib.parse.urljoin(self.BASE_URL, a))
                    for n, a in enumerate(dict.fromkeys(anchors)))]
        if not plays:
            return None
        return {
            "vod_id": url, "vod_name": name,
            "vod_pic": urllib.parse.urljoin(self.BASE_URL, pic),
            "type_name": "视频", "vod_year": "", "vod_area": "",
            "vod_remarks": "", "vod_actor": "", "vod_director": "",
            "vod_content": "",
            "vod_play_from": "$$$".join(froms),
            "vod_play_url": "$$$".join(plays),
        }

    def _art_detail(self, url, html):
        t = self._clean(self._match(html, r"<title>(.*?)</title>"))
        name = re.split(r"\s+-\s*", t)[0].strip() if t else ""
        imgs = self._gallery_images(html)
        return {
            "vod_id": url, "vod_name": name,
            "vod_pic": imgs[0] if imgs else "",
            "type_name": "图集", "vod_year": "", "vod_area": "",
            "vod_remarks": "%dP" % len(imgs) if imgs else "纯文字",
            "vod_actor": "", "vod_director": "",
            "vod_content": "共 %d 张图片" % len(imgs) if imgs else "纯文字帖，无图片",
            "vod_play_from": "图片",
            "vod_play_url": ("图集$pics://" + "###".join(imgs)) if imgs else "",
        }

    def _gallery_images(self, html):
        """正文图：<div class="content"> … </div> 内的 <img src>。

        图床随帖子而变，不能按域名过滤；容器外的页眉页脚图一律不要。
        标签可能被相邻标记粘连，按 '<img' 切开逐个取 src。
        """
        start = (html or "").find('<div class="content">')
        if start < 0:
            return []
        end = html.find("</div>", start)
        region = html[start:end if end > start else len(html)]
        imgs = []
        for part in region.split("<img"):
            m = re.search(r'(?:^|\s)src=["\'](https?://[^"\']+)', "<img" + part)
            if m and m.group(1) not in imgs:
                imgs.append(m.group(1))
        return imgs

    def _best_variant(self, m3u8_url):
        """master 播放列表解析到最高码率 variant；失败则原样返回。

        播放器播 master 也行，但返回 variant 能让分片链可直接校验，
        且本站 master 只有一个 variant，无画质损失。
        """
        try:
            body = self._get(m3u8_url)
            if body and "#EXT-X-STREAM-INF" in body:
                best, best_bw, pending_bw = "", -1, 0
                for line in body.splitlines():
                    line = line.strip()
                    if line.startswith("#EXT-X-STREAM-INF"):
                        mb = re.search(r"BANDWIDTH=(\d+)", line)
                        pending_bw = int(mb.group(1)) if mb else 0
                    elif line and not line.startswith("#"):
                        if pending_bw > best_bw:
                            best, best_bw = line, pending_bw
                        pending_bw = 0
                if best:
                    return urllib.parse.urljoin(m3u8_url, best)
        except Exception:
            pass
        return m3u8_url

    def _pagecount(self, html, page, got):
        m = re.search(r"当前\s*[:：]\s*\d+\s*/\s*(\d+)\s*页", html or "")
        if m:
            return max(int(m.group(1)), page)
        nums = [int(n) for n in re.findall(r"index-(\d+)\.html", html or "")]
        nums = [n for n in nums if 0 < n < 100000]
        if nums:
            return max(max(nums), page)
        return page if got < self.PAGE_SIZE else page + 1

    # ---------------- 工具 ----------------

    def _detail_url(self, id_or_url):
        s = str(id_or_url or "").strip()
        if s.startswith("http"):
            return s
        if s.startswith("/"):
            return self.BASE_URL + s
        m = re.search(r"(\d+)", s)
        if m:
            return self.BASE_URL + "/mov/html/" + m.group(1) + ".html"
        return urllib.parse.urljoin(self.BASE_URL, s)

    def _get(self, url, headers=None):
        for real in self._candidate_urls(url):
            h = dict(self.HEADERS)
            if headers:
                h.update(headers)
            for attempt in range(2):
                try:
                    r = self.session.get(real, headers=h, timeout=15,
                                         verify=False)
                    # 本站 UTF-8，requests 默认猜成 ISO-8859-1，必须纠正
                    r.encoding = "utf-8"
                    if r.status_code < 400:
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
                    urls.append(host + p.path
                                + ("?" + p.query if p.query else ""))
        return list(dict.fromkeys(urls))

    def _match(self, text, pattern):
        m = re.search(pattern, text or "", re.S | re.I)
        return m.group(1).strip() if m and m.lastindex else ""

    def _clean(self, text):
        text = re.sub(r"<.*?>", "", text or "", flags=re.S)
        for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&#038;", "&"),
                     ("&quot;", '"'), ("&#039;", "'"), ("&lt;", "<"),
                     ("&gt;", ">")):
            text = text.replace(a, b)
        return re.sub(r"\s+", " ", text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default
