"""Parse Garmin GPX exports into compact, simplified run tracks (JSON) for a /runs/ map page.

Usage (from the repo root):
    pip install defusedxml
    python3 runs/tools/parse_gpx.py <folder-of-gpx-files> runs/<page>/routes.json

Times are converted to America/Denver; tracks are simplified (Douglas-Peucker, 4 m)
so a few hundred km of runs stays around 150 KB. Climb uses a 3 m hysteresis filter.
"""
import json
import math
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from defusedxml.ElementTree import parse

NS = {"g": "http://www.topografix.com/GPX/1/1"}
TZ = ZoneInfo("America/Denver")
R = 6371008.8  # mean Earth radius, m


def hav(a, b):
    lat1, lon1, lat2, lon2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    d = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(d))


def rdp(pts, eps_m):
    """Ramer-Douglas-Peucker on a local equirectangular projection (metres)."""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(sum(p[0] for p in pts) / len(pts))
    xy = [(math.radians(p[1]) * R * math.cos(lat0), math.radians(p[0]) * R) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        s, e = stack.pop()
        (x1, y1), (x2, y2) = xy[s], xy[e]
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        best, idx = 0.0, -1
        for i in range(s + 1, e):
            px, py = xy[i]
            if seg2 == 0:
                d = math.hypot(px - x1, py - y1)
            else:
                t = max(0, min(1, ((px - x1) * dx + (py - y1) * dy) / seg2))
                d = math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
            if d > best:
                best, idx = d, i
        if best > eps_m and idx > 0:
            keep[idx] = True
            stack.append((s, idx))
            stack.append((idx, e))
    return [p for p, k in zip(pts, keep) if k]


def elev_gain(eles, thresh=3.0):
    """Hysteresis climb count to suppress altimeter noise."""
    if not eles:
        return 0.0
    gain, ref = 0.0, eles[0]
    for e in eles[1:]:
        if e - ref >= thresh:
            gain += e - ref
            ref = e
        elif ref - e >= thresh:
            ref = e
    return gain


def parse_file(path):
    root = parse(path).getroot()
    trk = root.find("g:trk", NS)
    name = (trk.findtext("g:name", default="", namespaces=NS) or "").strip()
    pts, eles, times = [], [], []
    for seg in trk.findall("g:trkseg", NS):
        for tp in seg.findall("g:trkpt", NS):
            lat, lon = float(tp.get("lat")), float(tp.get("lon"))
            pts.append((lat, lon))
            e = tp.findtext("g:ele", namespaces=NS)
            if e is not None:
                eles.append(float(e))
            t = tp.findtext("g:time", namespaces=NS)
            if t:
                times.append(datetime.fromisoformat(t.replace("Z", "+00:00")))
    dist = sum(hav(pts[i - 1], pts[i]) for i in range(1, len(pts)))
    start = times[0].astimezone(TZ) if times else None
    dur = (times[-1] - times[0]).total_seconds() if len(times) > 1 else 0
    simp = rdp(pts, 4.0)
    return {
        "id": path.stem.replace("activity_", ""),
        "name": name,
        "start": start.isoformat() if start else None,
        "date": start.strftime("%a %b %-d, %Y") if start else "",
        "dist_mi": round(dist / 1609.344, 2),
        "gain_ft": round(elev_gain(eles) * 3.28084),
        "max_ele_ft": round(max(eles) * 3.28084) if eles else None,
        "dur_s": round(dur),
        "n_raw": len(pts),
        "pts": [[round(a, 5), round(b, 5)] for a, b in simp],
    }


def main(src, out):
    runs = [parse_file(p) for p in sorted(Path(src).rglob("*.gpx"))]
    runs.sort(key=lambda r: r["start"] or "")
    Path(out).write_text(json.dumps(runs, separators=(",", ":")))
    for r in runs:
        print(f'{r["date"]:<18} {r["name"][:28]:<28} {r["dist_mi"]:>6.2f} mi {r["gain_ft"]:>5} ft '
              f'{r["dur_s"]//3600}:{r["dur_s"]%3600//60:02d}  raw={r["n_raw"]:>5} simp={len(r["pts"]):>4}  '
              f'start={r["pts"][0]}')
    print(f"\n{len(runs)} runs, {sum(r['dist_mi'] for r in runs):.1f} mi, "
          f"{sum(r['gain_ft'] for r in runs):,} ft, {sum(len(r['pts']) for r in runs)} pts, "
          f"{Path(out).stat().st_size/1024:.0f} KB")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
