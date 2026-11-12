#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPIKE-0002D：Decart 输出视频抽帧 + 九宫格 + 三图对比（key 到位、任务完成后运行）。

用法：
  python docs/dev/spike-0002d/scripts/extract-frames.py [输出mp4路径]
默认找 docs/dev/spike-0002d/evidence/decart-output-*.mp4 里最新的一个。

产物（docs/dev/spike-0002d/evidence/）：
  - decart-frame-start.png / decart-frame-mid.png / decart-frame-end.png
  - decart-contact-sheet.jpg（3x3）
  - decart-comparison.jpg（MAT-01 | P1 2D 换装结果 | Decart 末帧）
  - decart-frames-meta.json（视频/帧元信息、SHA256）
"""

import glob
import hashlib
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
SPIKE_DIR = os.path.join(REPO, "docs", "dev", "spike-0002d")
EVIDENCE = os.path.join(SPIKE_DIR, "evidence")
MAT01 = os.path.join(REPO, "tests", "fixtures", "mat", "mat-01-woman-fullbody.jpg")
P1_2D = os.path.join(
    REPO, "evidence", "2026-11-11", "real-runs", "20261111-233212", "t_92c75debd3c1b23cf6da2213.png"
)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def fit(img, size=(360, 640)):
    img = img.copy()
    img.thumbnail(size, Image.LANCZOS)
    canvas = Image.new("RGB", size, (255, 255, 255))
    canvas.paste(img, ((size[0] - img.size[0]) // 2, (size[1] - img.size[1]) // 2))
    return canvas


def main():
    os.makedirs(EVIDENCE, exist_ok=True)
    if len(sys.argv) > 1:
        video_path = sys.argv[1]
    else:
        cands = sorted(glob.glob(os.path.join(EVIDENCE, "decart-output-*.mp4")))
        if not cands:
            cands = sorted(glob.glob(os.path.join(os.environ.get("TEMP", "/tmp"), "sinn-spike2d", "*.mp4")))
        if not cands:
            print("no output mp4 found")
            return 1
        video_path = cands[-1]

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print("cannot open", video_path)
        return 1
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    if frame_count <= 0:
        print("no frames")
        return 1

    idxs = {"start": 0, "mid": frame_count // 2, "end": max(0, frame_count - 1)}
    frames = {}
    for name, idx in idxs.items():
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, fr = cap.read()
        if not ok:
            continue
        rgb = cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)
        img = Image.fromarray(rgb)
        out = os.path.join(EVIDENCE, "decart-frame-%s.png" % name)
        img.save(out)
        frames[name] = {"index": idx, "path": out, "sha256": sha256(out)}

    # 3x3 九宫格（均匀 9 帧）
    thumbs = []
    for i in range(9):
        idx = int(round((frame_count - 1) * i / 8.0))
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, fr = cap.read()
        if not ok:
            continue
        rgb = cv2.cvtColor(fr, cv2.COLOR_BGR2RGB)
        thumbs.append(fit(Image.fromarray(rgb), (300, 533)))
    cap.release()

    cell_w, cell_h = 300, 533
    sheet = Image.new("RGB", (cell_w * 3, cell_h * 3), (255, 255, 255))
    for i, th in enumerate(thumbs[:9]):
        sheet.paste(th, ((i % 3) * cell_w, (i // 3) * cell_h))
    sheet_path = os.path.join(EVIDENCE, "decart-contact-sheet.jpg")
    sheet.save(sheet_path, "JPEG", quality=90)

    # 三图对比：MAT-01 | P1 2D | Decart 末帧
    panel_size = (400, 640)
    panels = []
    if os.path.exists(MAT01):
        panels.append(("MAT-01 original", fit(Image.open(MAT01).convert("RGB"), panel_size)))
    if os.path.exists(P1_2D):
        panels.append(("P1 2D try-on result", fit(Image.open(P1_2D).convert("RGB"), panel_size)))
    if "end" in frames:
        panels.append(("Decart output (last frame)", fit(Image.open(frames["end"]["path"]).convert("RGB"), panel_size)))
    comp = Image.new("RGB", (panel_size[0] * len(panels), panel_size[1]), (255, 255, 255))
    for i, (_label, img) in enumerate(panels):
        comp.paste(img, (i * panel_size[0], 0))
    comp_path = os.path.join(EVIDENCE, "decart-comparison.jpg")
    comp.save(comp_path, "JPEG", quality=90)

    meta = {
        "video": {"path": video_path, "bytes": os.path.getsize(video_path), "sha256": sha256(video_path),
                   "width": width, "height": height, "fps": fps, "frame_count": frame_count},
        "frames": frames,
        "contactSheet": sheet_path,
        "comparison": comp_path,
    }
    meta_path = os.path.join(EVIDENCE, "decart-frames-meta.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
