#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SPIKE-0002C：GLB 纹理清晰度指标（Laplacian variance）与尺寸统计。

对每个 label 的第一张纹理（baseColor）计算：
  - 全分辨率尺寸/字节
  - 灰度 Laplacian 方差（越高越锐利/细节越多）
  - 1024x1024 中心裁剪后的 Laplacian 方差（可比口径）
输出：docs/dev/spike-0002c/evidence/texture-metrics.json
"""

import json
import os
import sys

import numpy as np
from PIL import Image

BASE = os.path.join(os.path.dirname(__file__), "..", "evidence")
LABELS = ["C1", "C2", "C3"]


def laplacian_var(gray):
    # 4-neighbour discrete Laplacian
    lap = (
        -4.0 * gray[1:-1, 1:-1]
        + gray[:-2, 1:-1]
        + gray[2:, 1:-1]
        + gray[1:-1, :-2]
        + gray[1:-1, 2:]
    )
    return float(lap.var())


def main():
    result = {"note": "Laplacian variance 越大纹理细节越多；1024 中心裁剪为可比口径", "labels": []}
    for label in LABELS:
        folder = os.path.join(BASE, "textures-" + label)
        files = sorted([f for f in os.listdir(folder) if f.startswith("image-") and "-preview" not in f])
        entry = {"label": label, "textures": []}
        for name in files:
            path = os.path.join(folder, name)
            img = Image.open(path).convert("RGB")
            w, h = img.size
            gray = np.asarray(img.convert("L")).astype(np.float32)
            full_var = laplacian_var(gray)
            side = min(w, h, 1024)
            left = (w - side) // 2
            top = (h - side) // 2
            crop = np.asarray(img.crop((left, top, left + side, top + side)).convert("L")).astype(np.float32)
            crop_var = laplacian_var(crop) if side > 2 else None
            entry["textures"].append(
                {
                    "file": name,
                    "width": w,
                    "height": h,
                    "bytes": os.path.getsize(path),
                    "laplacian_var_full": round(full_var, 2),
                    "laplacian_var_center1024": round(crop_var, 2) if crop_var is not None else None,
                }
            )
        result["labels"].append(entry)
    out = os.path.join(BASE, "texture-metrics.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
