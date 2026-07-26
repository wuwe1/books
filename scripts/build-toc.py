#!/usr/bin/env python3
"""从 PDF 生成多级目录 toc/<slug>.json（阅读器顶栏的目录下拉用）。

PDF 自带的书签大纲只有「部 + 章」两级，但正文里的小节标题带编号
（3.2 / 3.2.1 / 3.2.1.1），且排版用的是无衬线字体、在 pdftohtml -xml
里是独立的 <text> 块——即使四级标题与正文同行（run-in）也能切出来。
于是：书签大纲当骨架，编号小节按前缀挂到所属章下面。

    python3 scripts/build-toc.py inside-the-black-box

依赖 poppler 的 pdftohtml（brew install poppler）。
"""
import html
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 小节标题用无衬线字体排，正文是 Sabon 衬线体
HEADING_FONT = re.compile(r"helvetica", re.I)
NUMBERED = re.compile(r"^(\d+(?:\.\d+){1,3})\s+(\S.*)$")
FONTSPEC = re.compile(r'<fontspec id="(\d+)"[^>]*size="(\d+)"[^>]*family="([^"]*)"')
TEXT = re.compile(r'<text top="(\d+)"[^>]*font="(\d+)"[^>]*>(.*?)</text>', re.S)
PAGE = re.compile(r'<page number="(\d+)"')
OUTLINE_ITEM = re.compile(r'<item page="(\d+)"[^>]*>(.*?)</item>')


def strip_tags(s: str) -> str:
    return html.unescape(re.sub(r"<[^>]+>", "", s)).strip()


def pdf_xml(pdf: Path) -> str:
    return subprocess.run(
        ["pdftohtml", "-xml", "-i", "-stdout", str(pdf)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout


def parse_outline(xml: str):
    """PDF 书签大纲 → 嵌套节点树（<outline> 会套 <outline> 表示下一层）"""
    body = xml[xml.index("<outline>") :]
    roots: list[dict] = []
    stack = [roots]
    for tag in re.finditer(r"<outline>|</outline>|<item page=\"(\d+)\"[^>]*>(.*?)</item>", body, re.S):
        text = tag.group(0)
        if text == "<outline>":
            # 子层挂到上一个兄弟节点下
            siblings = stack[-1]
            stack.append(siblings[-1]["children"] if siblings else siblings)
        elif text == "</outline>":
            if len(stack) > 1:
                stack.pop()
        else:
            title = strip_tags(tag.group(2))
            if title:
                stack[-1].append(
                    {"title": title, "page": int(tag.group(1)), "children": []}
                )
    return roots


ACRONYMS = {
    "AI", "API", "ATS", "CPU", "ECN", "ETF", "ETFS", "GPU", "HFT", "IPO",
    "ML", "NBBO", "NYSE", "OTC", "SEC", "TWAP", "UK", "US", "VWAP",
}
SMALL_WORDS = {
    "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into",
    "nor", "of", "on", "or", "over", "the", "to", "versus", "via", "with",
}


def title_case(s: str) -> str:
    """二级标题在书里印成全大写，还原成书中目录页那样的 Title Case"""
    if s != s.upper():
        return s
    words = s.split(" ")
    out = []
    for i, w in enumerate(words):
        low = w.lower()
        core = low.strip(",:;()")
        # 缩写整体保持大写：常见的一批，外加「2–5 个字母且不含元音」的（HFT/NBBO…）
        if core.upper() in ACRONYMS or (
            2 <= len(core) <= 5 and core.isalpha() and not set(core) & set("aeiouy")
        ):
            out.append(w)
            continue
        keep_small = core in SMALL_WORDS and i > 0 and not out[-1].endswith(":")
        # 连字符复合词两截都要大写（Theory-Driven），但撇号后不大写（Kahn's）
        out.append(
            low
            if keep_small
            else re.sub(r"(?<![a-z'’])[a-z]", lambda m: m.group(0).upper(), low)
        )
    return " ".join(out)


def parse_sections(xml: str, fonts: dict[str, str], skip_before: int):
    """正文里的编号小节 → [(编号, 标题, PDF页)]"""
    out, seen = [], set()
    for chunk in xml.split("<page number=")[1:]:
        chunk = "<page number=" + chunk
        page = int(PAGE.search(chunk).group(1))
        if page < skip_before:
            continue  # 目录页本身也是「编号 + 标题」的形状，跳过
        items = [
            (int(top), fid, strip_tags(raw)) for top, fid, raw in TEXT.findall(chunk)
        ]
        for i, (top, fid, text) in enumerate(items):
            if not HEADING_FONT.search(fonts.get(fid, "")):
                continue
            m = NUMBERED.match(text)
            if not m:
                continue
            num, title = m.group(1), m.group(2).strip()
            # 标题换行时后半截是同字体的独立文本块，接回来
            prev_top = top
            for next_top, next_fid, next_text in items[i + 1 :]:
                if (
                    next_fid != fid
                    or next_top - prev_top > 30
                    or NUMBERED.match(next_text)
                    or not next_text
                ):
                    break
                title += " " + next_text.strip()
                prev_top = next_top
            title = re.sub(r"\s+", " ", title).strip()
            if not title or num in seen:
                continue
            seen.add(num)
            out.append((num, title_case(title), page))
    return out


def build(slug: str):
    books = json.loads((ROOT / "books.json").read_text())["books"]
    book = next(b for b in books if b["slug"] == slug)
    xml = pdf_xml(ROOT / book["pdf"])

    # -stdout 模式下 fontspec 只声明一次、id 全局唯一
    fonts = {fid: fam for fid, _size, fam in FONTSPEC.findall(xml)}
    roots = parse_outline(xml)

    # 章号 → 该章在树里的节点
    nodes: dict[str, dict] = {}

    def index(node: dict):
        m = re.match(r"^(\d+)\.\s", node["title"])
        if m:
            nodes[m.group(1)] = node
        for child in node["children"]:
            index(child)

    for node in roots:
        index(node)

    chapter_start = min((n["page"] for n in nodes.values()), default=20)
    sections = parse_sections(xml, fonts, chapter_start)

    orphans = 0
    for num, title, page in sorted(sections, key=lambda s: s[2]):
        parent = nodes.get(num.rsplit(".", 1)[0]) or nodes.get(num.split(".")[0])
        node = {"title": f"{num} {title}", "page": page, "children": []}
        if parent is None:
            orphans += 1
            roots.append(node)
        else:
            parent["children"].append(node)
        nodes[num] = node

    out = ROOT / "toc" / f"{slug}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(roots, ensure_ascii=False, indent=1) + "\n")

    depth = {}
    for num, _t, _p in sections:
        depth[num.count(".") + 1] = depth.get(num.count(".") + 1, 0) + 1
    print(f"{out}: {len(roots)} 顶层 / {len(sections)} 小节 / {orphans} 挂不上")
    print("各级小节数:", dict(sorted(depth.items())))


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "inside-the-black-box")
