#!/usr/bin/env python3
"""从 PDF 生成多级目录 toc/<slug>.json（阅读器顶栏的目录下拉用）。

    python3 scripts/build-toc.py <slug>            # 按 books.json 里的登记
    python3 scripts/build-toc.py --pdf a.pdf       # 只看结果不落盘，用来试新书

不同 PDF 的目录信息藏在不同地方，所以先探测再选路：

  A 路 · 书签够好   —— 书签本身就有 ≥3 层且不是扫描件那种垃圾书签，直接用；
                      标题带编号的话再按编号前缀纠正个别错误嵌套。
  B 路 · 靠排版抽   —— 书签太浅（往往只有部/章）。用书自己印的目录页当真值，
                      现场校准出「标题长什么样」，再去正文里捞书签和目录页都
                      没有的更深层级。没有编号的书就直接用目录页。

关键是不写死任何字体名/字号：正文样式取全书字符数的众数，页眉页码靠「同样式
同纵坐标跨多页重复」识别，编号形态（3.2.1 还是 A4.1）也是从文档里学出来的。

依赖 poppler 的 pdftohtml（brew install poppler）。
"""
from __future__ import annotations

import argparse
import html
import json
import re
import subprocess
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

FONTSPEC = re.compile(r'<fontspec id="(\d+)"[^>]*size="([\d.]+)"[^>]*family="([^"]*)"')
TEXT = re.compile(
    r'<text top="(-?\d+)" left="(-?\d+)" width="(\d+)" height="(\d+)" font="(\d+)">(.*?)</text>',
    re.S,
)
PAGE = re.compile(r'<page number="(\d+)"')
# 编号形态：纯数字（3.2.1.1）或字母打头（ARM 手册的 A4.1.1）
NUM_PATTERNS = [
    ("digit", re.compile(r"^(\d+(?:\.\d+){1,4})\.?\s+(\S.*)$")),
    ("alpha", re.compile(r"^([A-Z]\d+(?:\.\d+){1,3})\.?\s+(\S.*)$")),
]
# 目录页那种「标题 …… 页码」的行。页码可能带章前缀（ARM 手册是 A1-20 这种）
DOTTED = re.compile(r"^(.*?)[\s.·]*(?:[A-Za-z]{1,3}\d{0,2}[-–])?(\d{1,4})$")
# 章节标记本身不是目录条目
STRUCTURAL = re.compile(
    r"(chapter|part|appendix|section|book|unit|第\s*[一二三四五六七八九十百\d]*\s*[章篇部])",
    re.I,
)

Style = tuple[str, float]


def strip_tags(s: str) -> str:
    # 排版里大量使用不间断空格/窄空格，统一成普通空格，否则标题里会留下 \xa0
    text = html.unescape(re.sub(r"<[^>]+>", "", s))
    return re.sub(r"[     ]", " ", text).strip()


@dataclass
class Run:
    page: int
    top: int
    left: int
    width: int
    height: int
    style: Style
    text: str


@dataclass
class Doc:
    pages: int
    runs: list[Run]
    outline: list[dict]
    body: Style = ("", 0.0)
    furniture: set[tuple[Style, int]] = field(default_factory=set)

    def is_furniture(self, r: Run) -> bool:
        return (r.style, r.top // 20) in self.furniture


# ---------------------------------------------------------------- 解析


def load(pdf: Path) -> Doc:
    # 有些 PDF 会让 pdftohtml 报警并返回非零，但内容照样产出，所以看输出不看退出码
    proc = subprocess.run(
        ["pdftohtml", "-xml", "-i", "-stdout", str(pdf)],
        capture_output=True,
        text=True,
    )
    xml = proc.stdout
    if "<pdf2xml" not in xml:
        raise SystemExit(
            f"pdftohtml 没能解析这个 PDF：{proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else '无输出'}"
        )
    fonts = {
        fid: (fam.split("+")[-1], float(size))
        for fid, size, fam in FONTSPEC.findall(xml)
    }
    runs: list[Run] = []
    for chunk in xml.split("<page number=")[1:]:
        chunk = "<page number=" + chunk
        page = int(PAGE.search(chunk).group(1))
        for top, left, width, height, fid, raw in TEXT.findall(chunk):
            text = strip_tags(raw)
            if text:
                runs.append(
                    Run(
                        page,
                        int(top),
                        int(left),
                        int(width),
                        int(height),
                        fonts.get(fid, ("?", 0.0)),
                        text,
                    )
                )
    doc = Doc(pages=xml.count("<page number="), runs=runs, outline=parse_outline(xml))
    if not runs:
        raise SystemExit(
            "这个 PDF 没有文本层（大概率是扫描件），无法提取目录。\n"
            "注意它同样无法给词条画下划线——精读前需要先做 OCR。"
        )
    doc.body = modal_style(runs)
    doc.furniture = find_furniture(doc)
    return doc


def parse_outline(xml: str) -> list[dict]:
    """PDF 书签 → 嵌套树（<outline> 套 <outline> 表示下一层）"""
    if "<outline>" not in xml:
        return []
    body = xml[xml.index("<outline>") :]
    roots: list[dict] = []
    stack: list[list[dict]] = [roots]
    for tag in re.finditer(
        r'<outline>|</outline>|<item page="(\d+)"[^>]*>(.*?)</item>', body, re.S
    ):
        token = tag.group(0)
        if token == "<outline>":
            siblings = stack[-1]
            stack.append(siblings[-1]["children"] if siblings else siblings)
        elif token == "</outline>":
            if len(stack) > 1:
                stack.pop()
        else:
            title = strip_tags(tag.group(2))
            if title:
                stack[-1].append(
                    {"title": title, "page": int(tag.group(1)), "children": []}
                )
    return roots


def modal_style(runs: list[Run]) -> Style:
    """正文样式 = 字符数最多的 (字体, 字号)；实测各书都占 55–95%，非常稳"""
    chars: Counter[Style] = Counter()
    for r in runs:
        chars[r.style] += len(r.text)
    return chars.most_common(1)[0][0]


def find_furniture(doc: Doc) -> set[tuple[Style, int]]:
    """页眉/页脚/页码：同一样式固定出现在同一纵向位置，且跨越大量页面。

    正文样式必须排除在外——它在每一页的每个行位置都出现，否则会被整片误判
    （目录页里的小节条目往往就排成正文样式，一误判整页目录就没了）。
    """
    seen: dict[tuple[Style, int], set[int]] = defaultdict(set)
    for r in doc.runs:
        if r.style == doc.body:
            continue
        seen[(r.style, r.top // 20)].add(r.page)
    threshold = max(3, doc.pages * 0.3)
    return {k for k, pages in seen.items() if len(pages) >= threshold}


# ---------------------------------------------------------------- 目录页


def contents_entries(doc: Doc) -> list[tuple[str, int]]:
    """书自己印的目录页 → [(标题, 印刷页码)]，作为校验真值和大小写来源。

    判据：一页里有 ≥5 行「文字 + 末尾整数」，且这些整数基本递增。
    """
    by_page: dict[int, list[Run]] = defaultdict(list)
    for r in doc.runs:
        if not doc.is_furniture(r):
            by_page[r.page].append(r)

    best: list[tuple[str, int]] = []
    for page in sorted(by_page)[: max(30, doc.pages // 10)]:
        rows = merge_lines(by_page[page])
        hits: list[tuple[str, int]] = []
        pending: tuple[int, str] | None = None  # 上一行没带页码，可能是换行条目的前半截
        for left, text in rows:
            m = DOTTED.match(text)
            title = m.group(1).strip(" .·\t") if m else ""
            num = int(m.group(2)) if m else 0
            good = bool(m) and len(title) >= 4 and num <= doc.pages * 1.2
            # 「CHAPTER 1」「PART 3」不是目录条目，混进来会打乱页码序列
            if good and STRUCTURAL.fullmatch(title):
                good = False
            if not good:
                pending = (left, text)
                continue
            # 换行条目的后半截用悬挂缩进，且前半截没有页码（不以数字结尾）——
            # 这条件正好排除「CHAPTER 1」后面跟章标题那种情况
            if (
                pending
                and 0 <= left - pending[0] <= 150
                and len(pending[1]) >= 12
                and not pending[1][-1].isdigit()
            ):
                title = f"{pending[1]} {title}".strip()
            pending = None
            hits.append((title, num))
        nums = [n for _t, n in hits]
        rising = sum(1 for a, b in zip(nums, nums[1:]) if b >= a)
        if len(hits) >= 5 and rising >= 0.8 * max(1, len(nums) - 1):
            best.extend(hits)
    return best


def merge_lines(runs: list[Run]) -> list[tuple[int, str]]:
    """把同一视觉行的多个 run 拼成一行，返回 (行首 left, 文本)。

    目录页里标题和页码常是分开的两个 run，行首 left 用来判断续行缩进。
    """
    lines: dict[int, list[Run]] = defaultdict(list)
    for r in runs:
        lines[r.top // 8].append(r)
    out = []
    for key in sorted(lines):
        parts = sorted(lines[key], key=lambda r: r.left)
        out.append((parts[0].left, " ".join(p.text for p in parts).strip()))
    return out


def guess_offset(doc: Doc, entries: list[tuple[str, int]]) -> tuple[int | None, str]:
    """印刷页码 → PDF 页码的偏移，返回 (偏移, 说明)。

    首选看页眉页脚里印的页码——几乎每本书都有，比拿标题去正文里配对可靠。
    偏移不恒定（PDF 中间被增删过页）时明确报出来：本仓库的 CSV 页码映射
    依赖固定差值，这种书得先处理过再收。
    """
    # 页码在天头或地脚，且全书用同一个样式排在同一个纵向位置。按 (样式, 纵向位置)
    # 分桶再投票，否则脚注号、图表号也会来搅局。
    max_top = max((r.top for r in doc.runs), default=0)
    buckets: dict[tuple[Style, int], list[int]] = defaultdict(list)
    for r in doc.runs:
        if not r.text.isdigit():
            continue
        if not (r.top < 0.12 * max_top or r.top > 0.85 * max_top):
            continue
        n = int(r.text)
        if 1 <= n <= doc.pages and r.page >= n:
            buckets[(r.style, r.top // 20)].append(r.page - n)
    if buckets:
        offsets = max(buckets.values(), key=len)
        offset, n = Counter(offsets).most_common(1)[0]
        if n >= 5 and n >= 0.6 * len(offsets):
            return offset, f"页码推定 {offset}"
        if len(offsets) >= 50:
            spread = Counter(offsets).most_common(3)
            return None, f"⚠ 偏移不恒定（PDF 中间有增删页）：{spread}"

    if not entries:
        return None, "无从推定"
    index: dict[str, list[int]] = defaultdict(list)
    for r in doc.runs:
        if not doc.is_furniture(r):
            index[squash(r.text)].append(r.page)
            index[squash(strip_num(r.text))].append(r.page)
    votes: Counter[int] = Counter()
    for title, printed in entries:
        for pdf_page in index.get(squash(strip_num(title)), []):
            if pdf_page >= printed:
                votes[pdf_page - printed] += 1
    # 偏移必须让所有印刷页码都落在 PDF 页数之内，否则是索引页之类的巧合匹配
    lo, hi = min(p for _t, p in entries), max(p for _t, p in entries)
    ok = [(n, off) for off, n in votes.items() if hi + off <= doc.pages and lo + off >= 1]
    if not ok:
        return None, "无从推定"
    n, offset = max(ok)
    return (offset, f"标题配对推定 {offset}") if n >= 3 else (None, "无从推定")


def squash(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


def strip_num(s: str) -> str:
    """去掉标题前的编号，好让「3.1 Types of…」和目录页里的写法能对上"""
    return re.sub(r"^([A-Z]?\d+(?:\.\d+)*)[.\s]\s*", "", s).strip()


# ---------------------------------------------------------------- 书签质量


def tree_depth(nodes: list[dict]) -> int:
    return 1 + max((tree_depth(n["children"]) for n in nodes), default=0) if nodes else 0


def flatten(nodes: list[dict]):
    for n in nodes:
        yield n
        yield from flatten(n["children"])


def bookmarks_usable(doc: Doc) -> tuple[bool, str]:
    """扫描件常带一页一条的自动书签（ev0515 这种），要认出来丢掉"""
    items = list(flatten(doc.outline))
    if not items:
        return False, "无书签"
    depth = tree_depth(doc.outline)
    titles = [n["title"] for n in items]
    shapes = Counter(re.sub(r"\d+", "#", t) for t in titles)
    top_shape, top_n = shapes.most_common(1)[0]
    if top_n >= 0.8 * len(titles) and len(titles) >= 0.5 * doc.pages:
        return False, f"疑似扫描件自动书签（{top_n}/{len(titles)} 条形如 {top_shape!r}）"
    if depth < 3:
        return False, f"只有 {depth} 层，太浅"
    return True, f"{len(titles)} 条 / {depth} 层"


# ---------------------------------------------------------------- 编号


def learn_numbering(doc: Doc) -> tuple[str, re.Pattern] | None:
    """从候选标题里学出这本书用的是哪种编号形态"""
    best = None
    for name, pat in NUM_PATTERNS:
        n = sum(
            1
            for r in doc.runs
            if r.style != doc.body and not doc.is_furniture(r) and pat.match(r.text)
        )
        if n >= 8 and (best is None or n > best[0]):
            best = (n, name, pat)
    return (best[1], best[2]) if best else None


def num_depth(num: str) -> int:
    return num.count(".") + 1


# ---------------------------------------------------------------- 抽取标题


def heading_runs(doc: Doc, pat: re.Pattern, start_page: int) -> list[tuple[str, str, int]]:
    """正文里的编号标题 → [(编号, 标题, PDF页)]"""
    by_page: dict[int, list[Run]] = defaultdict(list)
    for r in doc.runs:
        by_page[r.page].append(r)

    out: list[tuple[str, str, int]] = []
    seen: set[str] = set()
    for page in sorted(by_page):
        if page < start_page:
            continue  # 目录页也是「编号 + 标题」的形状
        runs = sorted(by_page[page], key=lambda r: (r.top, r.left))
        for i, r in enumerate(runs):
            if r.style == doc.body or doc.is_furniture(r):
                continue
            m = pat.match(r.text)
            if not m:
                continue
            # 行首才算标题：同一行左边还有别的东西就是正文里的交叉引用
            if any(
                o.left < r.left - 2 and abs(o.top - r.top) <= max(4, r.height // 2)
                for o in runs
            ):
                continue
            num, title = m.group(1), m.group(2).strip()
            # 标题换行时后半截是同样式的独立 run，接回来
            prev_top = r.top
            for o in runs[i + 1 :]:
                if (
                    o.style != r.style
                    or o.top - prev_top > 2.2 * max(r.height, 1)
                    or o.top < prev_top
                    or pat.match(o.text)
                ):
                    break
                title += " " + o.text.strip()
                prev_top = o.top
            title = re.sub(r"\s+", " ", title).strip()
            if title and num not in seen:
                seen.add(num)
                out.append((num, title, page))
    return out


# ---------------------------------------------------------------- 大小写


SMALL_WORDS = {
    "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into",
    "nor", "of", "on", "or", "over", "the", "to", "versus", "via", "with",
}


def title_case(s: str) -> str:
    """有些书的小节标题印成全大写，还原成正常大小写（有目录页时优先抄目录页）"""
    if s != s.upper():
        return s
    words = s.split(" ")
    out: list[str] = []
    for i, w in enumerate(words):
        core = w.strip(",:;()").lower()
        # 缩写保持大写：2–5 个字母且不含元音（HFT / NBBO）
        if 2 <= len(core) <= 5 and core.isalpha() and not set(core) & set("aeiouy"):
            out.append(w)
            continue
        low = w.lower()
        if core in SMALL_WORDS and i > 0 and not out[-1].endswith(":"):
            out.append(low)
        else:
            out.append(re.sub(r"(?<![a-z'’])[a-z]", lambda m: m.group(0).upper(), low))
    return " ".join(out)


def prefer_printed(title: str, entries: list[tuple[str, int]]) -> str:
    """目录页里有同一条时用目录页的写法（大小写、断字都更规范）"""
    key = squash(strip_num(title))
    for printed, _page in entries:
        if squash(strip_num(printed)) == key:
            return strip_num(printed)
    return title_case(title)


# ---------------------------------------------------------------- 组树


def renest_by_number(nodes: list[dict]) -> list[dict]:
    """书签自带层级偶尔会错一两条，标题带编号时按编号前缀纠正"""
    flat = list(flatten(nodes))
    numbered = []
    for n in flat:
        for _name, pat in NUM_PATTERNS:
            m = pat.match(n["title"])
            if m:
                numbered.append((m.group(1), n))
                break
    if len(numbered) < 0.5 * len(flat):
        return nodes  # 编号不普遍，别乱动

    by_num = {num: n for num, n in numbered}
    moved = 0
    for num, node in numbered:
        parent_num = num.rsplit(".", 1)[0] if "." in num else None
        parent = by_num.get(parent_num)
        if parent is None or parent is node:
            continue
        if node in parent["children"]:
            continue
        for other in flat:
            if node in other["children"]:
                other["children"].remove(node)
                moved += 1
                break
        else:
            if node in nodes:
                nodes.remove(node)
                moved += 1
        parent["children"].append(node)
    for n in flat:
        n["children"].sort(key=lambda c: c["page"])
    if moved:
        print(f"  按编号纠正了 {moved} 处嵌套")
    return nodes


def attach_sections(
    roots: list[dict], sections: list[tuple[str, str, int]]
) -> tuple[list[dict], int]:
    """把编号小节挂到书签树里编号相符的章下面"""
    nodes: dict[str, dict] = {}

    def index(node: dict):
        for _name, pat in NUM_PATTERNS:
            m = re.match(r"^(\d+|[A-Z]\d+)[.\s]", node["title"])
            if m:
                nodes.setdefault(m.group(1), node)
                break
        for child in node["children"]:
            index(child)

    for node in roots:
        index(node)

    orphans = 0
    for num, title, page in sorted(sections, key=lambda s: s[2]):
        parent = nodes.get(num.rsplit(".", 1)[0]) or nodes.get(num.split(".")[0])
        node = {"title": f"{num} {title}", "page": page, "children": []}
        if parent is None or parent is node:
            orphans += 1
            roots.append(node)
        else:
            parent["children"].append(node)
        nodes[num] = node
    return roots, orphans


def tree_from_contents(
    doc: Doc, entries: list[tuple[str, int]], offset: int | None
) -> list[dict]:
    """只有目录页可用时：页码优先在正文里定位标题得到，其次才用偏移换算。

    定位比换算可靠——偏移不恒定的书（PDF 中间增删过页）照样能给出正确页码。
    """
    where = locate_titles(doc, [t for t, _p in entries])
    seen: set[str] = set()
    out = []
    for title, printed in entries:
        key = squash(strip_num(title))
        if key in seen:
            continue
        page = where.get(key) or (printed + offset if offset is not None else None)
        if page is None:
            continue
        seen.add(key)
        out.append({"title": title, "page": page, "children": []})
    return out


def locate_titles(doc: Doc, titles: list[str]) -> dict[str, int]:
    """在正文里找这些标题各自出现在哪一页（取第一次出现，跳过目录页本身）"""
    wanted = {squash(strip_num(t)) for t in titles}
    found: dict[str, int] = {}
    by_page: dict[int, list[Run]] = defaultdict(list)
    for r in doc.runs:
        by_page[r.page].append(r)
    for page in sorted(by_page):
        for _left, text in merge_lines(by_page[page]):
            key = squash(strip_num(text))
            if key in wanted and key not in found and len(key) >= 8:
                found[key] = page
    return found


# ---------------------------------------------------------------- 主流程


def build(pdf: Path, slug: str | None):
    print(f"\n=== {pdf.name[:70]}")
    doc = load(pdf)
    entries = contents_entries(doc)
    offset, note = guess_offset(doc, entries)
    print(f"  {doc.pages} 页 | 正文样式 {doc.body[0]} {doc.body[1]:g}pt")
    print(f"  目录页词条 {len(entries)} 条 | {note}")

    ok, why = bookmarks_usable(doc)
    numbering = learn_numbering(doc)
    print(f"  书签：{why}" + (f" | 编号形态 {numbering[0]}" if numbering else " | 无编号"))

    if ok:
        route = "A · 书签够好"
        roots = doc.outline
        if numbering:
            roots = renest_by_number(roots)
    elif numbering:
        route = "B · 排版抽取"
        body_start = min(
            (n["page"] for n in flatten(doc.outline) if re.match(r"^\d+[.\s]", n["title"])),
            default=(max((p + (offset or 0)) for _t, p in entries[:1]) if entries else 1),
        )
        sections = heading_runs(doc, numbering[1], body_start)
        sections = [(n, prefer_printed(t, entries), p) for n, t, p in sections]
        roots, orphans = attach_sections(doc.outline or [], sections)
        print(f"  抽出小节 {len(sections)} 条，挂不上 {orphans} 条")
    elif entries:
        route = "B · 仅目录页"
        roots = tree_from_contents(doc, entries, offset)
        if not roots:
            route = "退化 · 只用书签"
            roots = doc.outline
    else:
        route = "退化 · 只用书签"
        roots = doc.outline

    depths = Counter()
    for d, _n in walk(roots):
        depths[d + 1] += 1
    hit = coverage(roots, entries)
    print(f"  → 走 {route}；层级分布 {dict(sorted(depths.items()))}")
    if entries:
        print(f"  → 与目录页比对：{hit}/{len(entries)} 条对上（{100*hit/len(entries):.0f}%）")

    if len(list(walk(roots))) < 3:
        print("  ⚠ 结果太少，不落盘——app 会回退到 PDF 自带书签。")
        print("    这本书建议手写 toc/<slug>.json（结构就是 title/page/children 递归）。")
        return roots
    if hit and entries and hit < 0.5 * len(entries):
        print("  ⚠ 与目录页对不上大半，落盘前请人工过一眼。")

    if slug:
        out = ROOT / "toc" / f"{slug}.json"
        out.parent.mkdir(exist_ok=True)
        out.write_text(json.dumps(roots, ensure_ascii=False, indent=1) + "\n")
        print(f"  写入 {out.relative_to(ROOT)}")
    return roots


def walk(nodes: list[dict], d: int = 0):
    for n in nodes:
        yield d, n
        yield from walk(n["children"], d + 1)


def coverage(roots: list[dict], entries: list[tuple[str, int]]) -> int:
    have = {squash(strip_num(n["title"])) for _d, n in walk(roots)}
    return sum(1 for t, _p in entries if squash(strip_num(t)) in have)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("slug", nargs="?")
    ap.add_argument("--pdf", help="直接指定 PDF（试新书用，不写 toc/）")
    args = ap.parse_args()
    if args.pdf:
        build(Path(args.pdf), None)
        return
    if not args.slug:
        ap.error("要么给 slug，要么给 --pdf")
    books = json.loads((ROOT / "books.json").read_text())["books"]
    book = next(b for b in books if b["slug"] == args.slug)
    build(ROOT / book["pdf"], args.slug)


if __name__ == "__main__":
    main()
