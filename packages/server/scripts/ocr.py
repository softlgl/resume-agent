# -*- coding: utf-8 -*-
# 调用官方 rapidocr(onnxruntime) 识别图片，stdout 输出 JSON 供 Node 解析
# 依赖：pip install rapidocr onnxruntime （内置中英文模型，无需另下载语言包）
import sys
import json
import os


def main() -> int:
    if len(sys.argv) < 2:
        print(json.dumps({"texts": [], "error": "no image provided"}), flush=True)
        return 2
    try:
        from rapidocr import RapidOCR
    except Exception:
        print(json.dumps({"texts": [], "error": "rapidocr not installed, run: pip install rapidocr onnxruntime"}), flush=True)
        return 3

    engine = RapidOCR()
    result = []
    for idx, img in enumerate(sys.argv[1:]):
        if not os.path.exists(img):
            result.append({"pageIndex": idx, "text": ""})
            continue
        try:
            res = engine(img)
            lines = getattr(res, "txts", None) or []
            parts = []
            for r in lines:
                # 兼容 元组/列表 (box, text, score) 或带 .text 的对象
                if isinstance(r, (list, tuple)) and len(r) >= 2:
                    parts.append(str(r[1]))
                elif hasattr(r, "text"):
                    parts.append(str(r.text))
            result.append({"pageIndex": idx, "text": "\n".join(parts)})
        except Exception:
            result.append({"pageIndex": idx, "text": ""})
    print(json.dumps({"texts": result}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())