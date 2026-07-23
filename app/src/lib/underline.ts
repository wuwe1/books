import { loadPdfDocument, loadSharedPdfEngine } from "./pdf-thumbnail-utils"

/** 页面坐标系（与 marks/选区 rects 同空间，乘 scale 即像素） */
export interface UnderlineSeg {
  x: number
  y: number
  width: number
  height: number
  /** 下划线应画的 y：行内字符 tight box 底边（≈基线）中位数略下方 */
  lineY: number
}

/** 单字符盒：loose box 用于分行，tight box（墨迹边界）用于精确画线 */
interface CharBox {
  x: number
  y: number
  width: number
  height: number
  bx0: number
  bx1: number
  bottom: number
}

interface PageTextIndex {
  /** 归一化后的页面全文（仅 a-z0-9，小写，NFKD 展开连字） */
  normText: string
  /** 归一化下标 → pdfium 字符下标 */
  charIdxOf: number[]
  /** pdfium 字符下标 → glyph 矩形 */
  rects: Map<number, CharBox>
}

/**
 * 归一化：小写 + NFKD（拆连字 ﬁ→fi、去变音）后只保留字母数字。
 * 这样跨行断词（thor-\noughness）、弯引号、空白差异都不影响匹配。
 * map[i] = 归一化第 i 个字符来自源串的哪个下标。
 */
function normalize(src: string): { text: string; map: number[] } {
  let text = ""
  const map: number[] = []
  for (let i = 0; i < src.length; i++) {
    for (const c of src[i].normalize("NFKD").toLowerCase()) {
      if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) {
        text += c
        map.push(i)
      }
    }
  }
  return { text, map }
}

const GLYPH_EMPTY = 2

const pageIndexCache = new Map<string, Promise<PageTextIndex | null>>()

function getPageTextIndex(url: string, pageIndex: number) {
  const key = `${url}#${pageIndex}`
  let p = pageIndexCache.get(key)
  if (!p) {
    p = buildPageTextIndex(url, pageIndex).catch(() => null)
    pageIndexCache.set(key, p)
  }
  return p
}

async function buildPageTextIndex(
  url: string,
  pageIndex: number
): Promise<PageTextIndex | null> {
  const [engine, doc] = await Promise.all([
    loadSharedPdfEngine(),
    loadPdfDocument(url),
  ])
  const page = doc.pages[pageIndex]
  if (!page) return null
  const geo = await engine.getPageGeometry(doc, page).toPromise()
  const rects = new Map<number, CharBox>()
  let charCount = 0
  for (const run of geo.runs) {
    for (let i = 0; i < run.glyphs.length; i++) {
      const g = run.glyphs[i]
      const ci = run.charStart + i
      if (ci + 1 > charCount) charCount = ci + 1
      if (g.flags !== GLYPH_EMPTY)
        rects.set(ci, {
          x: g.x,
          y: g.y,
          width: g.width,
          height: g.height,
          bx0: g.tightX ?? g.x,
          bx1: (g.tightX ?? g.x) + (g.tightWidth ?? g.width),
          bottom: (g.tightY ?? g.y) + (g.tightHeight ?? g.height),
        })
    }
  }
  if (!charCount) return null
  const [text] = await engine
    .getTextSlices(doc, [{ pageIndex, charIndex: 0, charCount }])
    .toPromise()
  const { text: normText, map } = normalize(text ?? "")
  return { normText, charIdxOf: map, rects }
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

/** 把一段匹配到的归一化区间按行合并成矩形 */
function groupIntoLines(
  idx: PageTextIndex,
  start: number,
  len: number
): UnderlineSeg[] {
  const out: UnderlineSeg[] = []
  let minX = 0,
    maxX = 0,
    minY = 0,
    maxY = 0,
    open = false
  let bottoms: number[] = []
  const flush = () => {
    if (open) {
      // 大多数字符坐在基线上：tight 底边中位数 ≈ 基线（排除 g/p/y 下伸）
      const base = median(bottoms)
      const gap = Math.min(Math.max((maxY - minY) * 0.06, 0.6), 2)
      out.push({
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
        lineY: base + gap,
      })
    }
    open = false
    bottoms = []
  }
  for (let n = start; n < start + len; n++) {
    const r = idx.rects.get(idx.charIdxOf[n])
    if (!r) continue
    const sameLine = open && r.y < maxY && r.y + r.height > minY
    if (!sameLine) {
      flush()
      minX = r.bx0
      maxX = r.bx1
      minY = r.y
      maxY = r.y + r.height
      open = true
    } else {
      if (r.bx0 < minX) minX = r.bx0
      if (r.bx1 > maxX) maxX = r.bx1
      if (r.y < minY) minY = r.y
      if (r.y + r.height > maxY) maxY = r.y + r.height
    }
    bottoms.push(r.bottom)
  }
  flush()
  return out
}

/** 在页面里找 needle（归一化串）的全部出现并产出行矩形 */
function matchAll(idx: PageTextIndex, needle: string): UnderlineSeg[] {
  if (needle.length < 2) return []
  const out: UnderlineSeg[] = []
  let from = 0
  for (;;) {
    const at = idx.normText.indexOf(needle, from)
    if (at === -1) break
    out.push(...groupIntoLines(idx, at, needle.length))
    from = at + needle.length
  }
  return out
}

/**
 * 词条 raw → 页内下划线矩形。逐级回退：
 * 1. 整条 raw 直接匹配（括号补全的短语通常就是原文）；
 * 2. 去掉括号注记再匹配（括号内容不是原文的情况）；
 * 3. 按 " / "、省略号、分号拆段，各段独立匹配（如 "debatable / questionable"）。
 */
function findRawSegs(idx: PageTextIndex, raw: string): UnderlineSeg[] {
  let segs = matchAll(idx, normalize(raw).text)
  if (segs.length) return segs
  const noParen = raw.replace(/[（(][^）)]*[）)]/g, " ")
  if (noParen !== raw) {
    segs = matchAll(idx, normalize(noParen).text)
    if (segs.length) return segs
  }
  const parts = noParen.split(/\s*(?:\/|…|\.\.\.|;|；)\s*/)
  if (parts.length > 1) {
    for (const part of parts) segs.push(...matchAll(idx, normalize(part).text))
  }
  return segs
}

/**
 * 按页内出现位置（先行后列）给词条排序，返回 entry 下标的排列。
 * 找不到原文的词条排在最后，保持原有相对顺序。
 */
export function readingOrder(segsByEntry: UnderlineSeg[][]): number[] {
  return segsByEntry
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = segsByEntry[a][0]
      const rb = segsByEntry[b][0]
      if (!ra && !rb) return a - b
      if (!ra) return 1
      if (!rb) return -1
      const dy = ra.lineY - rb.lineY
      if (Math.abs(dy) > 2) return dy
      return ra.x - rb.x
    })
}

/**
 * 给一页上的一组词条原文定位。返回数组与 raws 一一对应，
 * 每项是该词条在页内的下划线矩形（可能多行/多处，找不到则为空）。
 */
export async function findEntryUnderlines(
  url: string,
  pageIndex: number,
  raws: string[]
): Promise<UnderlineSeg[][]> {
  const idx = await getPageTextIndex(url, pageIndex)
  if (!idx) return raws.map(() => [])
  return raws.map((raw) => findRawSegs(idx, raw))
}
