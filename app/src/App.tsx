import * as React from "react"
import { PDFViewer, type PDFViewerHandle } from "@/components/extend/pdf-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ChevronLeft,
  ChevronRight,
  Moon,
  Sun,
  Check,
  ClipboardCopy,
  RotateCcw,
} from "lucide-react"
import {
  loadNotes,
  entryKey,
  NOTE_TYPES,
  type NoteEntry,
  type NoteType,
} from "@/lib/notes"

const PAGE_OFFSET = 20 // PDF 页码 = 正文页码 + 20
const MIN_PAGE = 1
const MAX_PAGE = 306

const TYPE_STYLES: Record<NoteType, string> = {
  多义: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  词组: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  生词: "bg-muted text-muted-foreground",
  术语: "bg-fuchsia-50 text-fuchsia-700 dark:bg-fuchsia-950 dark:text-fuchsia-300",
  难句: "bg-orange-50 text-orange-700 dark:bg-orange-950 dark:text-orange-300",
  语法: "bg-yellow-50 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300",
  文化: "bg-teal-50 text-teal-700 dark:bg-teal-950 dark:text-teal-300",
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
  const viewerRef = React.useRef<PDFViewerHandle>(null)
  const [entries, setEntries] = React.useState<NoteEntry[]>([])
  const [bookPage, setBookPage] = useLocalStorage("bb.page", 3)
  const [search, setSearch] = React.useState("")
  const [activeTypes, setActiveTypes] = useLocalStorage<NoteType[]>(
    "bb.types",
    NOTE_TYPES
  )
  const [known, setKnown] = useLocalStorage<string[]>("bb.known", [])
  const [dark, setDark] = useLocalStorage(
    "bb.dark",
    window.matchMedia("(prefers-color-scheme: dark)").matches
  )
  const [toast, setToast] = React.useState("")
  const knownSet = React.useMemo(() => new Set(known), [known])
  const activeSet = React.useMemo(() => new Set(activeTypes), [activeTypes])
  const suppressSync = React.useRef(false)

  React.useEffect(() => {
    loadNotes().then(setEntries)
  }, [])

  React.useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(""), 2200)
  }

  // 跳转：滚动 PDF 到对应页；onActivePageChange 会回写 bookPage
  const goTo = React.useCallback(
    (p: number) => {
      const page = Math.min(Math.max(p, MIN_PAGE), MAX_PAGE)
      setBookPage(page)
      suppressSync.current = true
      viewerRef.current?.scrollToPage(page + PAGE_OFFSET)
      window.setTimeout(() => (suppressSync.current = false), 600)
    },
    [setBookPage]
  )

  const onActivePageChange = React.useCallback(
    (pdfPage: number) => {
      if (suppressSync.current) return
      setBookPage(Math.min(Math.max(pdfPage - PAGE_OFFSET, MIN_PAGE), MAX_PAGE))
    },
    [setBookPage]
  )

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT") return
      if (e.key === "ArrowLeft") goTo(bookPage - 1)
      if (e.key === "ArrowRight") goTo(bookPage + 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [bookPage, goTo])

  const q = search.trim().toLowerCase()
  const visible = React.useMemo(() => {
    const list = q
      ? entries.filter((e) =>
          `${e.raw} ${e.trans} ${e.note}`.toLowerCase().includes(q)
        )
      : entries.filter((e) => e.page === bookPage)
    return list.filter(
      (e) => activeSet.has(e.type) && !knownSet.has(entryKey(e))
    )
  }, [entries, q, bookPage, activeSet, knownSet])

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
      "这些我认识，请从 CSV 删除并抬高对应类别门槛：\n" +
      words.map((w) => "- " + w).join("\n")
    await navigator.clipboard.writeText(text)
    showToast(`已复制 ${known.length} 条，可直接粘贴给 Claude`)
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* header */}
      <header className="flex h-13 flex-none items-center gap-3 border-b px-4">
        <div className="text-sm font-semibold tracking-tight whitespace-nowrap">
          Inside the Black Box
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            精读词条
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索全部词条…"
            className="h-8 w-52"
          />
          <Button variant="outline" size="icon-sm" onClick={() => goTo(bookPage - 1)}>
            <ChevronLeft />
          </Button>
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            正文 <b className="text-foreground">{bookPage}</b> / {MAX_PAGE}
          </span>
          <Button variant="outline" size="icon-sm" onClick={() => goTo(bookPage + 1)}>
            <ChevronRight />
          </Button>
          <Input
            type="number"
            min={MIN_PAGE}
            max={MAX_PAGE}
            placeholder="页码"
            className="h-8 w-18"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = parseInt((e.target as HTMLInputElement).value, 10)
                if (!isNaN(v)) {
                  goTo(v)
                  ;(e.target as HTMLInputElement).value = ""
                  ;(e.target as HTMLInputElement).blur()
                }
              }
            }}
          />
          <Button variant="ghost" size="icon-sm" onClick={() => setDark(!dark)}>
            {dark ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      {/* main */}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-[1.4]">
          <PDFViewer
            ref={viewerRef}
            src="/book.pdf"
            className="h-full"
            showUpload={false}
            showDownload={false}
            onActivePageChange={onActivePageChange}
          />
        </div>
        <Separator orientation="vertical" />

        {/* notes panel */}
        <div className="flex w-105 max-w-[46vw] flex-none flex-col">
          <div className="flex-none border-b px-4 pt-3 pb-2.5">
            <div className="mb-2 flex items-baseline gap-2">
              <h2 className="text-[13px] font-semibold">
                {q ? `搜索“${search.trim()}”` : "本页词条"}
              </h2>
              <span className="text-xs text-muted-foreground">
                {visible.length ? `${visible.length} 条` : ""}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
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
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-2.5 px-4 py-3">
              {visible.length === 0 && (
                <div className="py-16 text-center text-[13px] text-muted-foreground">
                  {q ? "没有匹配的词条" : "本页没有词条 —— 都在你水平线以下 🎉"}
                </div>
              )}
              {visible.slice(0, 200).map((e) => (
                <div
                  key={entryKey(e)}
                  className="group relative rounded-lg border bg-card p-3 shadow-xs"
                >
                  <div className="flex items-start gap-2">
                    <div
                      className={`flex-1 text-[13px] leading-snug break-words ${
                        e.type === "难句" ? "font-medium italic" : "font-semibold"
                      }`}
                    >
                      {e.raw}
                    </div>
                    <span
                      className={`mt-0.5 flex-none rounded px-1.5 py-px text-[10px] font-medium ${TYPE_STYLES[e.type] ?? "bg-muted"}`}
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
                        goTo(e.page)
                      }}
                    >
                      p.{e.page} ↗
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
                    <TooltipContent>标记后隐藏，可导出清单发给 Claude</TooltipContent>
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

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-foreground px-4 py-1.5 text-xs text-background shadow-lg">
          {toast}
        </div>
      )}
    </div>
  )
}
