#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPIKE-0002D：准备 Decart 输入素材（本地、不花钱）。

产物（docs/dev/spike-0002d/inputs/）：
  - mat-01-person-5s-720x1280.mp4：MAT-01 生成的 5s / 720x1280 / 9:16 视频（优先 avc1/H.264，失败退回 mp4v）
  - mat-08-garment-crop-1024.jpg：MAT-08 裁成纯衣服+白底 1024x1024 JPEG
同时把 SHA256/尺寸/命令写入 inputs/manifest.json。
"""

import hashlib
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
INPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "inputs")
MAT01 = os.path.join(REPO, "tests", "fixtures", "mat", "mat-01-woman-fullbody.jpg")
MAT08 = os.path.join(REPO, "tests", "fixtures", "mat", "mat-08-garment-flat.jpg")

WIDTH, HEIGHT = 720, 1280
FPS = 30
SECONDS = 5


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def crop_9x16(img):
    """把 1600x2545 人像裁成 9:16（保持全身，居中裁宽）。"""
    w, h = img.size
    target_ratio = WIDTH / HEIGHT
    if w / h > target_ratio:
        new_w = int(round(h * target_ratio))
        left = (w - new_w) // 2
        return img.crop((left, 0, left + new_w, h))
    new_h = int(round(w / target_ratio))
    top = (h - new_h) // 2
    return img.crop((0, top, w, top + new_h))


def make_video():
    img = Image.open(MAT01).convert("RGB")
    img = crop_9x16(img).resize((WIDTH, HEIGHT), Image.LANCZOS)
    frame = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)

    out_path = os.path.join(INPUT_DIR, "mat-01-person-5s-720x1280.mp4")
    tried = []
    writer = None
    used = None
    for fourcc_name in ("avc1", "H264", "mp4v"):
        fourcc = cv2.VideoWriter_fourcc(*fourcc_name)
        candidate = cv2.VideoWriter(out_path, fourcc, FPS, (WIDTH, HEIGHT))
        tried.append({"fourcc": fourcc_name, "opened": bool(candidate.isOpened())})
        if candidate.isOpened():
            writer = candidate
            used = fourcc_name
            break
        candidate.release()
    if writer is None:
        raise RuntimeError("no video writer available: " + json.dumps(tried))

    frames = FPS * SECONDS
    for i in range(frames):
        # 极轻微推近（1.00 -> 1.03），给供应商一点运动信号，避免完全静止
        t = i / float(max(1, frames - 1))
        scale = 1.0 + 0.03 * t
        if scale == 1.0:
            frame_out = frame
        else:
            crop_w = int(WIDTH / scale)
            crop_h = int(HEIGHT / scale)
            x0 = (WIDTH - crop_w) // 2
            y0 = (HEIGHT - crop_h) // 2
            crop = frame[y0:y0 + crop_h, x0:x0 + crop_w]
            frame_out = cv2.resize(crop, (WIDTH, HEIGHT), interpolation=cv2.INTER_LINEAR)
        writer.write(frame_out)
    writer.release()

    cap = cv2.VideoCapture(out_path)
    readable = cap.isOpened()
    frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) if readable else 0
    fps_meta = cap.get(cv2.CAP_PROP_FPS) if readable else 0
    cap.release()
    return {
        "path": out_path,
        "bytes": os.path.getsize(out_path),
        "sha256": sha256(out_path),
        "codec_attempts": tried,
        "codec_used": used,
        "width": WIDTH,
        "height": HEIGHT,
        "fps": FPS,
        "seconds": SECONDS,
        "frames_written": frames,
        "readback_frame_count": frame_count,
        "readback_fps": fps_meta,
    }


def make_garment():
    img = Image.open(MAT08).convert("RGB")
    w, h = img.size
    # MAT-08 是白底平铺针织衫；裁掉四周空白后居中放到 1024 白底画布
    crop = img.crop((int(w * 0.015), int(h * 0.09), int(w * 0.985), int(h * 0.79)))
    crop.thumbnail((940, 940), Image.LANCZOS)
    canvas = Image.new("RGB", (1024, 1024), (255, 255, 255))
    canvas.paste(crop, ((1024 - crop.size[0]) // 2, (1024 - crop.size[1]) // 2))
    out_path = os.path.join(INPUT_DIR, "mat-08-garment-crop-1024.jpg")
    canvas.save(out_path, "JPEG", quality=92)
    return {
        "path": out_path,
        "bytes": os.path.getsize(out_path),
        "sha256": sha256(out_path),
        "width": 1024,
        "height": 1024,
        "source": MAT08,
    }


def main():
    os.makedirs(INPUT_DIR, exist_ok=True)
    manifest = {
        "note": "SPIKE-0002D Decart 输入素材（本地生成，未调用任何付费 API）",
        "generatedAt": "2026-11-12",
        "person_video": make_video(),
        "garment_image": make_garment(),
    }
    out = os.path.join(INPUT_DIR, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    print(json.dumps(manifest, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
