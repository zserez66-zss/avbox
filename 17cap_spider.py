# -*- coding: utf-8 -*-
"""
17cap.cc (91网址) TVBox / 影视仓 / CatVodSpider 源
单文件、仅依赖 requests、Python 3。

站点形态（2026-11 实测）：
  列表卡片  li > div > a[href=/video/play/<id>-1-1.html] > img[alt=标题][data-src=封面]
  详情页    JSON-LD 里 "contentUrl": "https://m3u8.xxx/videos/.../index.m3u8"
           部分条目是协议相对地址 "//m3u8.xxx/...m3u8"，需补 "https:"
  分类页    /video/Categories/<id>.html?page=N（N 可到 600+）
  搜索页    /search/keyword/wd/<kw>.html，翻页 /search/keyword/page/N/wd/<kw>.html
  播放      m3u8 分片为真实 TS，无需 Referer 鉴权
"""
import json
import html as html_lib
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
    class BaseSpider(object):
        pass


class Spider(BaseSpider):
    BASE_URL = "https://17cap.cc"
    FALLBACK_URLS = ["https://17cap.cc"]
    HEADERS = {
        "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Referer": "https://17cap.cc/",
    }

    # 分类 id 全部取自真实导航 /video/Categories/N.html，实测每页 20 条
    CLASSES = [
        ("1", "国产"),
        ("2", "日韩"),
        ("3", "欧美"),
        ("4", "伦理"),
        ("5", "动漫"),
        ("6", "同性恋"),
        ("9", "成人AI"),
        ("16", "福利姬"),
        ("18", "成人主播"),
        ("19", "无码中字"),
        ("20", "JAV自拍"),
        ("21", "中文字幕"),
        ("22", "JAV无码"),
        ("23", "AV解说"),
        ("25", "欧美黑人"),
        ("26", "留学生"),
        ("27", "港台三级"),
        ("28", "日韩三级"),
        ("29", "欧美三级"),
        ("30", "3D动漫"),
        ("32", "男同"),
        ("33", "女同百合"),
        ("36", "AI短剧"),
    ]

    def __init__(self):
        super().__init__()
        self.name = "17cap"
        self.session = requests.Session()
        self.session.headers.update(self.HEADERS)
        self._class_cache = None
        self._page_cache = {}

    def init(self, extend=""):
        return None

    def getName(self):
        return self.name

    def isVideoFormat(self, url):
        return bool(url) and (".m3u8" in url or ".mp4" in url)

    def manualVideoCheck(self):
        return False

    def destroy(self):
        try:
            self.session.close()
        except Exception:
            pass

    # ---------------- 首页 ----------------
    def homeContent(self, filter):
        html = self._get(self.BASE_URL + "/vod")
        return {
            "class": self._classes(),
            "filters": {},
            "list": self._parse_list(html),
            "parse": 0,
            "jx": 0,
        }

    def homeVideoContent(self):
        return {"list": self._parse_list(self._get(self.BASE_URL + "/vod"))}

    # ---------------- 分类 ----------------
    def categoryContent(self, tid, pg, filter, extend):
        page = self._to_int(pg, 1)
        if page < 1:
            page = 1
        tid = str(tid or "1").strip().strip("/")

        if tid in ("", "vod", "latest", "home"):
            # /vod?page=N 实测不随页码变化，首页分类的翻页一律走分类 1
            if page <= 1:
                url = self.BASE_URL + "/vod"
            else:
                url = self.BASE_URL + "/video/Categories/1.html?page=%d" % page
        else:
            url = self.BASE_URL + "/video/Categories/%s.html" % tid
            if page > 1:
                url += "?page=%d" % page

        html = self._get(url)
        data = self._parse_list(html)
        return {
            "page": page,
            "pagecount": self._pagecount(html, page, len(data)),
            "limit": 20,
            "total": 999999,
            "list": data,
            "parse": 0,
            "jx": 0,
        }

    # ---------------- 详情 ----------------
    def detailContent(self, ids):
        result = {"list": [], "parse": 0, "jx": 0}
        if not ids:
            return result
        raw = ids[0] if isinstance(ids, (list, tuple)) else ids
        url = self._detail_url(raw)
        html = self._get(url)
        if not html:
            return result

        name = self._clean(
            self._match(html, r"<h1[^>]*>(.*?)</h1>")
            or self._match(html, r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)')
            or self._match(html, r"<title>(.*?)</title>")
        )
        name = re.sub(r"\s*[-_|]\s*91网址.*$", "", name).strip()

        pic = (self._match(html, r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)')
               or self._match(html, r'<video[^>]+poster=["\']([^"\']+)'))
        if pic:
            pic = urllib.parse.urljoin(self.BASE_URL + "/", pic)

        content = self._clean(
            self._match(html, r'"description"\s*:\s*"([^"]{0,600})"')
            or self._match(html, r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)')
        ).replace("\\n", " ")

        genre = self._match(html, r'"genre"\s*:\s*"([^"]*)"') or ""
        tags = re.findall(r'"keywords"\s*:\s*\[([^\]]{0,200})\]', html)
        if tags and not genre:
            genre = self._clean(','.join(re.findall(r'"([^"]+)"', tags[0]))[:20])

        upload = self._match(html, r'"uploadDate"\s*:\s*"([^"]*)"') or ""
        ym = re.match(r"(\d{4})", upload)
        year = ym.group(1) if ym else ""

        dur = self._match(html, r'"duration"\s*:\s*"PT(\d+)S"')
        remarks = ""
        if dur:
            sec = self._to_int(dur, 0)
            remarks = "%02d:%02d" % (sec // 60, sec % 60)

        m3u8 = self._m3u8(html)
        if m3u8:
            self._page_cache[m3u8] = url

        result["list"].append({
            "vod_id": url,
            "vod_name": name,
            "vod_pic": pic,
            "type_name": genre,
            "vod_year": year,
            "vod_area": "",
            "vod_remarks": remarks,
            "vod_actor": "",
            "vod_director": "",
            "vod_content": content,
            "vod_play_from": "17cap",
            "vod_play_url": "正片$" + (m3u8 or url),
        })
        return result

    # ---------------- 搜索 ----------------
    def searchContent(self, key, quick, pg="1"):
        page = self._to_int(pg, 1)
        if page < 1:
            page = 1
        q = urllib.parse.quote(str(key or "").strip())
        if page <= 1:
            url = self.BASE_URL + "/search/keyword/wd/%s.html" % q
        else:
            url = self.BASE_URL + "/search/keyword/page/%d/wd/%s.html" % (page, q)
        html = self._get(url)
        data = self._parse_list(html)
        return {
            "page": page,
            "pagecount": self._pagecount(html, page, len(data)),
            "limit": 24,
            "total": 999999,
            "list": data,
            "parse": 0,
            "jx": 0,
        }

    # ---------------- 播放 ----------------
    def playerContent(self, flag, id, vipFlags):
        headers = {
            "User-Agent": self.HEADERS["User-Agent"],
            "Referer": self.BASE_URL + "/",
        }
        result = {"parse": 0, "playUrl": "", "url": id or "", "jx": 0, "header": headers}
        if not id:
            return result
        pid = str(id).strip()

        if ".m3u8" in pid or ".mp4" in pid:
            pid = self._fix_url(pid)
            if not self._token_alive(pid):
                page = self._page_cache.get(pid)
                if page:
                    fresh = self._m3u8(self._get(page))
                    if fresh:
                        pid = fresh
            result["url"] = pid
            return result

        page = self._detail_url(pid)
        html = self._get(page)
        m3u8 = self._m3u8(html)
        if m3u8:
            self._page_cache[m3u8] = page
            result["url"] = m3u8
            result["header"] = {
                "User-Agent": self.HEADERS["User-Agent"],
                "Referer": page,
                "Origin": self.BASE_URL,
            }
        else:
            result["url"] = page
            result["parse"] = 1
        return result

    # ---------------- 内部 ----------------
    def _classes(self):
        if self._class_cache:
            return self._class_cache
        self._class_cache = [{"type_id": t, "type_name": n} for t, n in self.CLASSES]
        return self._class_cache

    def _detail_url(self, raw):
        raw = str(raw or "").strip()
        if raw.startswith("http"):
            return raw
        m = re.match(r"^(\d+)", raw)
        if m:
            return self.BASE_URL + "/video/play/%s-1-1.html" % m.group(1)
        return self.BASE_URL + "/video/play/%s-1-1.html" % raw.strip("/")

    def _pagecount(self, html, page, got):
        html = html or ""
        nums = []
        for h in re.findall(r'href=["\']([^"\']+)["\']', html):
            nums += [int(n) for n in re.findall(r"[?&]page=(\d+)", h)]
            nums += [int(n) for n in re.findall(r"/search/keyword/page/(\d+)/", h)]
            nums += [int(n) for n in re.findall(r"/video/Categories/\d+/(\d+)\.html", h)]
        nums = [n for n in nums if 0 < n < 100000]
        if nums:
            return max(nums)
        if got <= 0:
            return page
        # 站点不渲染分页条，实测可一直翻；按 page+1 递进，空页自然停止
        return page + 1

    def _parse_list(self, html):
        data, seen = [], set()
        html = html or ""
        blocks = re.findall(
            r'<li[^>]*>([\s\S]{0,2400}?/video/play/[\s\S]{0,2400}?)</li>',
            html, re.S | re.I)
        for item in blocks:
            href = self._match(item, r'href=["\']((?:https?://[^"\']+)?/video/play/[^"\']+)["\']')
            if not href:
                continue
            pid = self._match(item, r'/video/play/(\d+)-')
            if not pid:
                continue
            name = (self._match(item, r'<img[^>]+alt=["\']([^"\']+)["\']')
                    or self._match(item, r'title=["\']([^"\']+)["\']'))
            name = self._clean(name)
            if not name or re.fullmatch(r"\d{1,2}:\d{2}(?::\d{2})?", name):
                continue
            if re.search(r"\[广告\]|推广|APP下载|立即下载", name):
                continue
            pic = (self._match(item, r'(?:data-src|data-original|data-lazy-src)=["\']([^"\']+)["\']')
                   or self._match(item, r'<img[^>]+src=["\']([^"\']+)["\']'))
            remarks = self._match(item, r'class=["\'][^"\']*\bdur\b[^"\']*["\'][^>]*>\s*([\d:]{4,8})\s*<')
            full = self.BASE_URL + "/video/play/%s-1-1.html" % pid
            if full in seen:
                continue
            seen.add(full)
            data.append({
                "vod_id": full,
                "vod_name": name,
                "vod_pic": urllib.parse.urljoin(self.BASE_URL + "/", pic) if pic else "",
                "vod_remarks": remarks,
            })
        # 兜底：li 结构变化时按 a[href] + img 的顺序成对抓
        if not data:
            for m in re.finditer(
                    r'<a[^>]+href=["\'](?:https?://[^"\']+)?/video/play/(\d+)-[^"\']*["\'][\s\S]{0,1200}?<img[^>]+alt=["\']([^"\']+)["\'][^>]*?(?:data-src|src)=["\']([^"\']+)["\']',
                    html, re.S | re.I):
                pid, name, pic = m.group(1), self._clean(m.group(2)), m.group(3)
                if not name or re.fullmatch(r"\d{1,2}:\d{2}(?::\d{2})?", name):
                    continue
                full = self.BASE_URL + "/video/play/%s-1-1.html" % pid
                if full in seen:
                    continue
                seen.add(full)
                data.append({
                    "vod_id": full,
                    "vod_name": name,
                    "vod_pic": urllib.parse.urljoin(self.BASE_URL + "/", pic),
                    "vod_remarks": "",
                })
        return data

    def _get(self, url, headers=None):
        for real in self._candidate_urls(self._fix_url(url)):
            h = dict(self.HEADERS)
            if headers:
                h.update(headers)
            try:
                r = self.session.get(real, headers=h, timeout=15, verify=False)
                if r.status_code < 400 and "Just a moment" not in r.text and "cf-browser-verification" not in r.text:
                    r.encoding = "utf-8"
                    return r.text
            except Exception:
                continue
        return ""

    def _candidate_urls(self, url):
        urls = [url]
        p = urllib.parse.urlparse(url)
        if p.netloc:
            for host in self.FALLBACK_URLS:
                if urllib.parse.urlparse(host).netloc != p.netloc:
                    urls.append(host + p.path + ("?" + p.query if p.query else ""))
        return list(dict.fromkeys(urls))

    def _fix_url(self, url):
        url = str(url or "").strip()
        if url.startswith("//"):
            return "https:" + url
        if url and not url.startswith("http"):
            return urllib.parse.urljoin(self.BASE_URL + "/", url)
        return url

    def _token_alive(self, url):
        m = re.search(r"[?&]expires=(\d{9,13})", str(url or ""))
        if not m:
            return True
        exp = int(m.group(1))
        if exp > 99999999999:
            exp //= 1000
        return exp - 60 > time.time()

    def _m3u8(self, html):
        html = html or ""
        raw = (self._match(html, r'"contentUrl"\s*:\s*"([^"]+\.m3u8[^"]*)"')
               or self._match(html, r'var\s+hlsUrl\s*=\s*["\']([^"\']+\.m3u8[^"\']*)')
               or self._match(html, r'["\']((?:https?:)?//[^"\']+\.m3u8[^"\']*)')
               or self._match(html, r'["\']([^"\']*?/index\.m3u8[^"\']*)'))
        if not raw:
            return ""
        raw = raw.replace("\\/", "/").strip()
        return self._fix_url(raw)

    def _match(self, text, pattern):
        m = re.search(pattern, text or "", re.S | re.I)
        return m.group(1).strip() if m and m.lastindex else ""

    def _clean(self, text):
        text = re.sub(r"<[^>]*>", "", text or "")
        try:
            text = html_lib.unescape(text)
        except Exception:
            pass
        for a, b in (("&nbsp;", " "), ("&amp;", "&"), ("&#038;", "&"), ("&quot;", chr(34)),
                     ("&#039;", "'"), ("&lt;", "<"), ("&gt;", ">"), ("\\u0026", "&")):
            text = text.replace(a, b)
        return re.sub(r"\s+", " ", text).strip()

    def _to_int(self, value, default=0):
        try:
            return int(str(value).strip())
        except Exception:
            return default


if __name__ == "__main__":
    sp = Spider()
    out = sp.homeContent(False)
    print("classes:", len(out["class"]))
    print(json.dumps(out["list"][:3], ensure_ascii=False, indent=2))
