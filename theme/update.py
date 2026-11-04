from datetime import datetime, timezone, timedelta
from io import BytesIO
from urllib.request import Request, urlopen
from urllib.parse import urljoin, urlsplit
from pathlib import Path
import colorsys, json, re, sys
from bs4 import BeautifulSoup
from PIL import Image

ROOT = "https://doodles.google/"
ALLOWED = {"doodles.google","www.google.com","www.gstatic.com","gstatic.com","lh3.googleusercontent.com"}
def fetch(url):
    def check(u):
        p=urlsplit(u)
        if p.scheme!="https" or p.hostname not in ALLOWED: raise ValueError("Unsupported Google media host")
    check(url)
    with urlopen(Request(url,headers={"User-Agent":"PersonalLedgerTheme/1.0 (public artwork palette)","Accept-Language":"en-US,en;q=0.9"}),timeout=16) as r:
        check(r.geturl()); data=r.read(16_000_001)
        if len(data)>16_000_000: raise ValueError("Image too large")
        return data
def palette(data):
    with Image.open(BytesIO(data)) as im:
        im.thumbnail((128,128))
        bins={}
        for r,g,b,a in im.convert("RGBA").getdata():
            if a<180: continue
            h,l,s=colorsys.rgb_to_hls(r/255,g/255,b/255)
            if .10<l<.94 and s>.17:
                k=int(h*24)%24; bins[k]=bins.get(k,0)+s**.5
        if not bins:return None
        h=(max(bins,key=bins.get)+.5)/24
        def color(l,s):
            return "#"+"".join(f"{round(v*255):02x}" for v in colorsys.hls_to_rgb(h,l,s))
        return dict(ink=color(.27,.43),soft=color(.92,.28),wash=color(.98,.17))
def discover(html,day):
    soup=BeautifulSoup(html,"html.parser")
    for a in soup.select("a[href]"):
        u=urljoin(ROOT,a["href"])
        if not u.startswith(ROOT+"doodle/"):continue
        label=" ".join([a.get_text(" ",strip=True),a.get("aria-label","")])
        for t in a.select("time[datetime]"):
            if t["datetime"][:10]==day.isoformat():return u
        m=re.search(r"\b([A-Z][a-z]{2,8} \d{1,2}, \d{4})\b",label)
        if m:
            for fmt in ("%b %d, %Y","%B %d, %Y"):
                try:
                    if datetime.strptime(m[1],fmt).date()==day:return u
                except ValueError:pass
    return None
def run():
    day=datetime.now(timezone(timedelta(hours=8))).date()
    url=discover(fetch(ROOT+"?hl=en"),day)
    out={"date":day.isoformat(),"colors":None}
    if url:
        page=BeautifulSoup(fetch(url),"html.parser")
        img=page.select_one('meta[property="og:image"]')
        if not img:raise ValueError("No artwork metadata")
        out.update(source=url,colors=palette(fetch(urljoin(url,img["content"]))))
    Path("theme/daily.json").write_text(json.dumps(out,indent=2)+"\n",encoding="utf-8")
if __name__=="__main__":run()
