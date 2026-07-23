import * as React from "react"
import {
  PDFViewer,
  type PDFViewerHandle,
  type PDFViewerPageOverlayProps,
  type PDFViewerSelectionSnapshot,
  type PDFViewerBookmarkItem,
} from "@/components/extend/pdf-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  Moon,
  Sun,
  Check,
  ClipboardCopy,
  RotateCcw,
  BookOpen,
  Bookmark,
  BookmarkPlus,
  Trash2,
  Pencil,
  List,
} from "lucide-react"
import {
  loadBooks,
  loadNotes,
  entryKey,
  NOTE_TYPES,
  type Book,
  type NoteEntry,
  type NoteType,
} from "@/lib/notes"
import { findEntryUnderlines, type UnderlineSeg } from "@/lib/underline"

const TYPE_STYLES: Record<NoteType, string> = {
  多义: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  词组: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  生词: "bg-muted text-muted-foreground",
  术语: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  难句: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  语法: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
  文化: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
}

type MarkColor = "yellow" | "green" | "red"

interface MarkRects {
  pageIndex: number
  rects: {
    origin: { x: number; y: number }
    size: { width: number; height: number }
  }[]
}

interface Mark {
  id: string
  page: number
  csvPage: number
  text?: string
  note?: string
  color?: MarkColor
  rects?: MarkRects[]
  createdAt: string
}

const HIGHLIGHT_FILL: Record<MarkColor, string> = {
  yellow: "rgba(253, 224, 71, 0.45)",
  green: "rgba(134, 239, 172, 0.5)",
  red: "rgba(252, 165, 165, 0.5)",
}

const COLOR_DOT: Record<MarkColor, string> = {
  yellow: "bg-yellow-300",
  green: "bg-green-300",
  red: "bg-red-300",
}

const MARK_COLORS: MarkColor[] = ["yellow", "green", "red"]

function serializeSel(sel: PDFViewerSelectionSnapshot): MarkRects[] {
  return sel.pages.map((p) => ({
    pageIndex: p.pageIndex,
    rects: p.segmentRects.map((r) => ({
      origin: { x: r.origin.x, y: r.origin.y },
      size: { width: r.size.width, height: r.size.height },
    })),
  }))
}

const NO_ENTRIES: NoteEntry[] = []

// 给本页有词条的原文画下划线（按 raw 在 PDF 文本里定位）。
// hover 显示词条序号（与右侧卡片编号一致），点击联动右侧卡片。
function UnderlineLayer({
  src,
  pageNumber,
  scale,
  entries,
  onPick,
}: {
  src: string
  pageNumber: number
  scale: number
  entries: NoteEntry[]
  onPick: (e: NoteEntry) => void
}) {
  const [segsByEntry, setSegsByEntry] = React.useState<UnderlineSeg[][]>([])
  const [hover, setHover] = React.useState(-1)
  React.useEffect(() => {
    setHover(-1)
    if (!entries.length) {
      setSegsByEntry([])
      return
    }
    let alive = true
    findEntryUnderlines(
      src,
      pageNumber - 1,
      entries.map((e) => e.raw)
    )
      .then((r) => {
        if (alive) setSegsByEntry(r)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [src, pageNumber, entries])
  return (
    <>
      {segsByEntry.map((segs, ei) =>
        segs.map((s, si) => {
          const active = hover === ei
          return (
            <React.Fragment key={`${ei}-${si}`}>
              <div
                className="pointer-events-none absolute"
                style={{
                  left: s.x * scale,
                  top: s.lineY * scale,
                  width: s.width * scale,
                  borderTop: active
                    ? "2px solid rgba(59, 130, 246, 0.9)"
                    : "2px dotted rgba(59, 130, 246, 0.65)",
                }}
              />
              {/* 命中区：盖住下划线附近一窄条，便于 hover/点击而不挡选字 */}
              <div
                className="absolute z-10 cursor-pointer"
                style={{
                  left: s.x * scale - 2,
                  top: s.lineY * scale - 3,
                  width: s.width * scale + 4,
                  height: 9,
                }}
                onMouseEnter={() => setHover(ei)}
                onMouseLeave={() => setHover(-1)}
                onClick={() => onPick(entries[ei])}
              />
              {active && si === 0 && (
                <div
                  className="pointer-events-none absolute z-20 flex h-4 min-w-4 items-center justify-center rounded-full bg-blue-500 px-1 text-[10px] font-semibold text-white shadow-sm"
                  style={{
                    left: (s.x - s.height) * scale,
                    top: s.y * scale,
                    transform: "translate(-115%, -15%)",
                  }}
                >
                  {ei + 1}
                </div>
              )}
            </React.Fragment>
          )
        })
      )}
    </>
  )
}

function TocList({
  items,
  depth,
  onJump,
}: {
  items: PDFViewerBookmarkItem[]
  depth: number
  onJump: (page: number) => void
}) {
  return (
    <>
      {items.map((item, i) => (
        <React.Fragment key={`${depth}-${i}-${item.title}`}>
          <button
            disabled={item.pageNumber === null}
            onClick={() => item.pageNumber && onJump(item.pageNumber)}
            className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left text-[13px] transition-colors hover:bg-muted ${
              depth === 0 ? "font-semibold" : "text-muted-foreground"
            }`}
            style={{ paddingLeft: 8 + depth * 14 }}
          >
            <span className="min-w-0 flex-1">{item.title}</span>
            {item.pageNumber !== null && (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {item.pageNumber}
              </span>
            )}
          </button>
          {item.children.length > 0 && (
            <TocList items={item.children} depth={depth + 1} onJump={onJump} />
          )}
        </React.Fragment>
      ))}
    </>
  )
}

function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  React.useEffect(() => {
    localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])
  return [value, setValue] as const
}

export default function App() {
  const [books, setBooks] = React.useState<Book[] | null>(null)
  const [slug, setSlug] = useLocalStorage("bb.book", "")
  const [dark, setDark] = useLocalStorage(
    "bb.dark",
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )

  React.useEffect(() => {
    loadBooks().then(setBooks)
  }, [])

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])

  if (!books) return null
  const book = books.find((b) => b.slug === slug) ?? books[0]
  if (!book)
    return (
      <div className="flex h-screen items-center justify-center text-sm text-muted-foreground">
        books.json 里还没有登记任何书
      </div>
    )

  return (
    <Reader
      key={book.slug}
      book={book}
      books={books}
      onSwitchBook={setSlug}
      dark={dark}
      onToggleDark={() => setDark(!dark)}
    />
  )
}

function Reader({
  book,
  books,
  onSwitchBook,
  dark,
  onToggleDark,
}: {
  book: Book
  books: Book[]
  onSwitchBook: (slug: string) => void
  dark: boolean
  onToggleDark: () => void
}) {
  const viewerRef = React.useRef<PDFViewerHandle>(null)
  const [entries, setEntries] = React.useState<NoteEntry[]>([])
  const [numPages, setNumPages] = React.useState(0)
  const [page, setPage] = useLocalStorage(
    `bb.${book.slug}.page`,
    book.pageOffset + 1
  )
  const [search, setSearch] = React.useState("")
  const [activeTypes, setActiveTypes] = useLocalStorage<NoteType[]>(
    "bb.types",
    NOTE_TYPES
  )
  const [known, setKnown] = useLocalStorage<string[]>(
    `bb.${book.slug}.known`,
    []
  )
  const [toast, setToast] = React.useState("")
  const [view, setView] = React.useState<"notes" | "marks" | "toc">("notes")
  const [toc, setToc] = React.useState<PDFViewerBookmarkItem[]>([])
  const onBookmarksLoaded = React.useCallback(
    (items: PDFViewerBookmarkItem[]) => setToc(items),
    []
  )
  const [marks, setMarks] = React.useState<Mark[]>([])
  const [pendingSel, setPendingSel] =
    React.useState<PDFViewerSelectionSnapshot | null>(null)
  const [markDraft, setMarkDraft] = React.useState<{
    text: string
    note: string
    color: MarkColor
    page: number
    rects?: MarkRects[]
  } | null>(null)
  const knownSet = React.useMemo(() => new Set(known), [known])
  const activeSet = React.useMemo(() => new Set(activeTypes), [activeTypes])
  const suppressSync = React.useRef(false)

  React.useEffect(() => {
    loadNotes(book.notes).then(setEntries)
  }, [book.notes])

  const loadMarks = React.useCallback(() => {
    fetch(`/api/marks?slug=${book.slug}`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setMarks)
      .catch(() => {})
  }, [book.slug])

  React.useEffect(() => {
    loadMarks()
  }, [loadMarks])

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(""), 2200)
  }

  // 跳转：滚动 PDF 到对应页；onActivePageChange 会回写 page
  const goTo = React.useCallback(
    (p: number) => {
      const next = Math.min(Math.max(p, 1), numPages || Infinity)
      setPage(next)
      suppressSync.current = true
      viewerRef.current?.scrollToPage(next)
      window.setTimeout(() => (suppressSync.current = false), 600)
    },
    [numPages, setPage]
  )

  const onActivePageChange = React.useCallback(
    (pdfPage: number) => {
      if (suppressSync.current) return
      setPage(pdfPage)
    },
    [setPage]
  )

  const onSelectionEnd = React.useCallback(
    (sel: PDFViewerSelectionSnapshot | null) => setPendingSel(sel),
    []
  )

  const saveMarkRecord = React.useCallback(
    async (record: {
      page: number
      text?: string
      note?: string
      color?: MarkColor
      rects?: MarkRects[]
    }) => {
      await fetch("/api/marks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: book.slug,
          csvPage: record.page - book.pageOffset,
          ...record,
        }),
      }).catch(() => {})
      loadMarks()
    },
    [book.slug, book.pageOffset, loadMarks]
  )

  // 选区工具条：点颜色 = 直接保存高亮
  const highlightSel = async (color: MarkColor) => {
    if (!pendingSel) return
    const sel = pendingSel
    const text = await sel.getText()
    await saveMarkRecord({
      page: sel.pages[0].pageIndex + 1,
      text: text.trim() || undefined,
      color,
      rects: serializeSel(sel),
    })
    sel.clear()
    setPendingSel(null)
    showToast("已高亮")
  }

  // 编辑图标 / M 键：打开备注表单（有选区带选区，无选区标整页）
  const openMarkDraft = React.useCallback(async () => {
    if (pendingSel) {
      const text = await pendingSel.getText()
      setMarkDraft({
        text: text.trim(),
        note: "",
        color: "yellow",
        page: pendingSel.pages[0].pageIndex + 1,
        rects: serializeSel(pendingSel),
      })
    } else {
      setMarkDraft({ text: "", note: "", color: "yellow", page })
    }
  }, [pendingSel, page])

  const saveMark = async () => {
    if (!markDraft) return
    await saveMarkRecord({
      page: markDraft.page,
      text: markDraft.text || undefined,
      note: markDraft.note.trim() || undefined,
      color: markDraft.color,
      rects: markDraft.rects,
    })
    pendingSel?.clear()
    setPendingSel(null)
    setMarkDraft(null)
    showToast(`已标记 p.${markDraft.page}`)
  }

  const deleteMark = async (id: string) => {
    await fetch(`/api/marks?slug=${book.slug}&id=${id}`, {
      method: "DELETE",
    }).catch(() => {})
    loadMarks()
  }

  // 阅读进度落盘（marks/progress.json），停留 2 秒才算
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      fetch("/api/progress", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug: book.slug,
          page,
          csvPage: page - book.pageOffset,
        }),
      }).catch(() => {})
    }, 2000)
    return () => window.clearTimeout(t)
  }, [book.slug, book.pageOffset, page])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === "INPUT" || tag === "TEXTAREA") return
      if (e.key === "ArrowLeft") goTo(page - 1)
      if (e.key === "ArrowRight") goTo(page + 1)
      if (e.key === "m" || e.key === "M") openMarkDraft()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [page, goTo, openMarkDraft])

  // 点击 PDF 里的下划线 → 右侧对应卡片滚动到可见并闪烁
  const [focusKey, setFocusKey] = React.useState<string | null>(null)
  const focusTimer = React.useRef(0)
  const pickEntry = React.useCallback((e: NoteEntry) => {
    const k = entryKey(e)
    setView("notes")
    setSearch("")
    setFocusKey(k)
    window.clearTimeout(focusTimer.current)
    focusTimer.current = window.setTimeout(() => setFocusKey(null), 1600)
    window.setTimeout(() => {
      document
        .querySelector(`[data-ek="${CSS.escape(k)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" })
    }, 60)
  }, [])

  // PDF 页码 → 该页要画下划线的词条（与右侧面板同一套类型/认识过滤）
  const entriesByPdfPage = React.useMemo(() => {
    const m = new Map<number, NoteEntry[]>()
    for (const e of entries) {
      if (!activeSet.has(e.type) || knownSet.has(entryKey(e))) continue
      const p = e.page + book.pageOffset
      const list = m.get(p)
      if (list) list.push(e)
      else m.set(p, [e])
    }
    return m
  }, [entries, activeSet, knownSet, book.pageOffset])

  const q = search.trim().toLowerCase()
  const visible = React.useMemo(() => {
    const list = q
      ? entries.filter((e) =>
          `${e.raw} ${e.trans} ${e.note}`.toLowerCase().includes(q)
        )
      : entries.filter((e) => e.page + book.pageOffset === page)
    return list.filter(
      (e) => activeSet.has(e.type) && !knownSet.has(entryKey(e))
    )
  }, [entries, q, page, book.pageOffset, activeSet, knownSet])

  const toggleType = (t: NoteType) => {
    if (activeSet.has(t) && activeTypes.length === 1) setActiveTypes(NOTE_TYPES)
    else if (activeTypes.length === NOTE_TYPES.length) setActiveTypes([t])
    else if (activeSet.has(t))
      setActiveTypes(activeTypes.filter((x) => x !== t))
    else setActiveTypes([...activeTypes, t])
  }

  const exportKnown = async () => {
    if (!known.length) return showToast("还没有标记任何词条")
    const words = known.map((k) => k.split("|").slice(1).join("|"))
    const text =
      `《${book.title}》里这些我认识，请从 ${book.notes} 删除并抬高对应类别门槛：\n` +
      words.map((w) => "- " + w).join("\n")
    await navigator.clipboard.writeText(text)
    showToast(`已复制 ${known.length} 条，可直接粘贴给 Claude`)
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* header */}
      <header className="flex h-13 flex-none items-center gap-3 border-b px-4">
        <BookOpen className="size-4 flex-none text-muted-foreground" />
        {books.length > 1 ? (
          <Select value={book.slug} onValueChange={onSwitchBook}>
            <SelectTrigger className="h-8 w-56 text-sm font-semibold">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {books.map((b) => (
                <SelectItem key={b.slug} value={b.slug}>
                  {b.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="text-sm font-semibold tracking-tight whitespace-nowrap">
            {book.title}
          </div>
        )}
        <span className="text-xs font-normal whitespace-nowrap text-muted-foreground">
          精读词条
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索全部词条…"
            className="h-8 w-52"
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon-sm" onClick={openMarkDraft}>
                <BookmarkPlus />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              标记本页（先选中文字可一并记录）· 快捷键 M
            </TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" onClick={onToggleDark}>
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      {/* main */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-[1.4]">
          <PDFViewer
            ref={viewerRef}
            src={"/" + book.pdf}
            className="h-full"
            showUpload={false}
            showDownload={false}
            onActivePageChange={onActivePageChange}
            onDocumentLoadSuccess={setNumPages}
            onSelectionEnd={onSelectionEnd}
            onBookmarksLoaded={onBookmarksLoaded}
            renderPageOverlay={({ pageNumber, scale }: PDFViewerPageOverlayProps) => {
              const pageIndex = pageNumber - 1
              const hl: React.ReactNode[] = []
              for (const m of marks) {
                for (const pr of m.rects ?? []) {
                  if (pr.pageIndex !== pageIndex) continue
                  pr.rects.forEach((r, i) =>
                    hl.push(
                      <div
                        key={`${m.id}-${pr.pageIndex}-${i}`}
                        className="pointer-events-none absolute"
                        style={{
                          left: r.origin.x * scale,
                          top: r.origin.y * scale,
                          width: r.size.width * scale,
                          height: r.size.height * scale,
                          background: HIGHLIGHT_FILL[m.color ?? "yellow"],
                          mixBlendMode: "multiply",
                        }}
                      />
                    )
                  )
                }
              }
              const tail = pendingSel?.pages[pendingSel.pages.length - 1]
              const showBar = tail && tail.pageIndex === pageIndex && !markDraft
              return (
                <>
                  <UnderlineLayer
                    src={"/" + book.pdf}
                    pageNumber={pageNumber}
                    scale={scale}
                    entries={entriesByPdfPage.get(pageNumber) ?? NO_ENTRIES}
                    onPick={pickEntry}
                  />
                  {hl}
                  {showBar && (
                    <div
                      className="absolute z-30 flex items-center gap-1.5 rounded-lg border bg-popover p-1.5 shadow-md"
                      style={{
                        left:
                          (tail.rect.origin.x + tail.rect.size.width / 2) *
                          scale,
                        top:
                          (tail.rect.origin.y + tail.rect.size.height) * scale +
                          8,
                        transform: "translateX(-50%)",
                      }}
                      onPointerDownCapture={(e: React.PointerEvent) =>
                        e.stopPropagation()
                      }
                      onMouseDownCapture={(e: React.MouseEvent) =>
                        e.stopPropagation()
                      }
                      onPointerUpCapture={(e: React.PointerEvent) =>
                        e.stopPropagation()
                      }
                    >
                      {MARK_COLORS.map((c) => (
                        <button
                          key={c}
                          onClick={() => highlightSel(c)}
                          className={`size-5 rounded-full border border-black/15 transition-transform hover:scale-115 ${COLOR_DOT[c]}`}
                        />
                      ))}
                      <div className="mx-0.5 h-4 w-px bg-border" />
                      <button
                        onClick={openMarkDraft}
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    </div>
                  )}
                </>
              )
            }}
          />
        </div>
        {/* notes panel */}
        <div className="flex w-105 max-w-[46vw] flex-none flex-col border-l">
          <div className="flex h-12 flex-none items-center border-b px-4">
            <div className="flex w-full items-center gap-2">
              <button
                onClick={() => setView("notes")}
                className={`text-[13px] font-semibold transition-colors ${
                  view === "notes"
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {q ? `搜索“${search.trim()}”` : "本页词条"}
              </button>
              <button
                onClick={() => setView("marks")}
                className={`flex items-center gap-1 text-[13px] font-semibold transition-colors ${
                  view === "marks"
                    ? "text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Bookmark className="size-3" /> 标记
                {marks.length ? ` ${marks.length}` : ""}
              </button>
              {toc.length > 0 && (
                <button
                  onClick={() => setView("toc")}
                  className={`flex items-center gap-1 text-[13px] font-semibold transition-colors ${
                    view === "toc"
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <List className="size-3" /> 目录
                </button>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {view === "notes" && visible.length
                  ? `${visible.length} 条`
                  : ""}
              </span>
            </div>
          </div>
          {view === "notes" && (
            <div className="flex flex-none flex-wrap gap-1.5 border-b px-4 py-2">
              {NOTE_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => toggleType(t)}
                  className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                    activeSet.has(t)
                      ? "border-foreground bg-foreground text-background"
                      : "border-border text-muted-foreground hover:bg-muted"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2.5 px-4 py-3">
              {view === "toc" && (
                <div className="-mx-1 space-y-0.5">
                  <TocList items={toc} depth={0} onJump={goTo} />
                </div>
              )}
              {view === "marks" && marks.length === 0 && (
                <div className="py-16 text-center text-[13px] text-muted-foreground">
                  还没有标记 —— 选中一段文字按 M，或点顶栏书签按钮
                </div>
              )}
              {view === "marks" &&
                [...marks]
                  .sort((a, b) => a.page - b.page)
                  .map((m) => (
                    <div
                      key={m.id}
                      className="group relative rounded-lg border bg-card p-3 shadow-xs"
                    >
                      <div className="flex items-center gap-2">
                        {m.color && (
                          <span
                            className={`size-2.5 flex-none rounded-full ${COLOR_DOT[m.color]}`}
                          />
                        )}
                        <button
                          className="text-[11px] text-muted-foreground hover:text-primary"
                          onClick={() => goTo(m.page)}
                        >
                          p.{m.page} ↗
                        </button>
                        <span className="text-[10px] text-muted-foreground">
                          {m.createdAt.slice(0, 10)}
                        </span>
                      </div>
                      {m.text && (
                        <div className="mt-1.5 border-l-2 pl-2 text-[13px] leading-snug italic">
                          {m.text}
                        </div>
                      )}
                      {m.note && (
                        <div className="mt-1.5 text-[13px]">{m.note}</div>
                      )}
                      <button
                        onClick={() => deleteMark(m.id)}
                        className="absolute top-2 right-2 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-muted hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
              {view === "notes" && visible.length === 0 && (
                <div className="py-16 text-center text-[13px] text-muted-foreground">
                  {q
                    ? "没有匹配的词条"
                    : entries.length === 0
                      ? "这本书还没有词条 CSV"
                      : "本页没有词条 —— 都在你水平线以下 🎉"}
                </div>
              )}
              {view === "notes" &&
                visible.slice(0, 200).map((e, i) => (
                <div
                  key={entryKey(e)}
                  data-ek={entryKey(e)}
                  className={`group relative rounded-lg border bg-card p-3 shadow-xs transition-shadow ${
                    focusKey === entryKey(e)
                      ? "border-blue-500 ring-2 ring-blue-500/60"
                      : ""
                  }`}
                >
                  <div className="flex items-start gap-2">
                    {!q && (
                      <span className="mt-0.5 flex-none text-[10px] font-semibold tabular-nums text-blue-500/80">
                        {i + 1}
                      </span>
                    )}
                    <div
                      className={`flex-1 text-[13px] leading-snug break-words ${
                        e.type === "难句"
                          ? "font-medium italic"
                          : "font-semibold"
                      }`}
                    >
                      {e.raw}
                    </div>
                    <span
                      className={`mt-0.5 flex-none rounded px-1.5 py-px text-[10px] font-medium transition-opacity group-hover:opacity-0 ${TYPE_STYLES[e.type] ?? "bg-muted"}`}
                    >
                      {e.type}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[13px]">{e.trans}</div>
                  {e.note && (
                    <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {e.note}
                    </div>
                  )}
                  {q && (
                    <button
                      className="mt-1.5 text-[11px] text-muted-foreground hover:text-primary"
                      onClick={() => {
                        setSearch("")
                        goTo(e.page + book.pageOffset)
                      }}
                    >
                      p.{e.page + book.pageOffset} ↗
                    </button>
                  )}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setKnown([...known, entryKey(e)])}
                        className="absolute top-2 right-2 rounded-full border border-transparent px-2 py-px text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:border-border hover:bg-muted"
                      >
                        认识 <Check className="inline size-3" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      标记后隐藏，可导出清单发给 Claude
                    </TooltipContent>
                  </Tooltip>
                </div>
              ))}
            </div>
          </ScrollArea>

          <div className="flex flex-none items-center gap-2 border-t px-4 py-2 text-xs text-muted-foreground">
            <span>{known.length ? `已认识 ${known.length}` : ""}</span>
            <Button variant="outline" size="xs" onClick={exportKnown}>
              <ClipboardCopy /> 导出「认识」清单
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setKnown([])
                showToast("已清空")
              }}
            >
              <RotateCcw /> 清空标记
            </Button>
          </div>
        </div>
      </div>

      {markDraft && (
        <div className="fixed top-16 right-6 z-50 w-80 rounded-xl border bg-popover p-3 shadow-lg">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[13px] font-semibold">
              标记 p.{markDraft.page}
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              {MARK_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setMarkDraft({ ...markDraft, color: c })}
                  className={`size-4.5 rounded-full border transition-transform hover:scale-110 ${COLOR_DOT[c]} ${
                    markDraft.color === c
                      ? "border-foreground ring-1 ring-foreground"
                      : "border-black/15"
                  }`}
                />
              ))}
            </div>
          </div>
          {markDraft.text ? (
            <div className="mb-2 max-h-24 overflow-y-auto border-l-2 pl-2 text-xs leading-relaxed text-muted-foreground italic">
              {markDraft.text}
            </div>
          ) : (
            <div className="mb-2 text-xs text-muted-foreground">
              未选中文字，仅标记整页
            </div>
          )}
          <textarea
            autoFocus
            value={markDraft.note}
            onChange={(e) =>
              setMarkDraft({ ...markDraft, note: e.target.value })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveMark()
              if (e.key === "Escape") setMarkDraft(null)
            }}
            placeholder="为什么好？（可空）…"
            className="mb-2 h-16 w-full resize-none rounded-md border bg-background p-2 text-[13px] outline-none focus:border-ring"
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="xs" onClick={() => setMarkDraft(null)}>
              取消
            </Button>
            <Button size="xs" onClick={saveMark}>
              保存 ⌘↩
            </Button>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-4 py-1.5 text-xs text-background shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
