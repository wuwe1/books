# books — 英文原著精读仓库

读者是中国人（英语 CEFR B1+，金融背景扎实），逐页精读英文原著。本仓库存书目、
学习词条、阅读标记和配套阅读器。完整工作流程（摸底测试、词条收录门槛、持续校准）
见 `prompt.md` —— 接手任何精读任务前先读它。

## 目录结构

- `books.json` — 书目登记：`slug/title/author/pdf/notes/pageOffset`。
  **CSV 页码 + pageOffset = PDF 物理页码**；app 内一律用 PDF 物理页码。
- `data/<slug>.pdf` — 书。**整个 data/ 被 gitignore，绝不 commit、绝不 push**
  （libgen 来源）。丢了可重下，不要试图绕过 ignore。
- `notes/<slug>.csv` — 学习词条（进 git）。列：`page,type,raw,translation,note`；
  type ∈ 生词/多义/词组/术语/难句/语法/文化；UTF-8 **带 BOM**（重写文件后用
  `printf '\xEF\xBB\xBF'` 重新加）；page 是书的正文页码（非 PDF 页码），
  前言等罗马数字页用负数（如 xi → -7，仍满足 page + pageOffset = PDF 页）。
  规则：单本书内词条不重复；note 只写客观辨析、禁止元信息；多义词标
  "本句义 vs 常见义"；难句整句翻译并拆结构。raw 必须逐字取自该页原文
  （阅读器靠它在 PDF 里定位画下划线），括号补的上下文除外。
- `marks/<slug>.json` — 读者在阅读器里的高亮/标记：`{id, page(PDF页),
  csvPage(正文页), text(选中原文), note(读者备注), color(yellow/green/red),
  rects(页内坐标), createdAt}`。
- `marks/progress.json` — 全局进度表，按 slug 键控：各书当前读到的 PDF 页。
  **开始工作前先看 progress 和最近的标记**，了解读者读到哪、在关注什么。
- `toc/<slug>.json` — 多级目录（顶栏「目录」下拉用），`{title, page(PDF页),
  children}` 递归。PDF 自带书签只有部/章两级，这里连正文里的 3.2.1.1 都有。
  用 `python3 scripts/build-toc.py <slug>` 生成（依赖 poppler 的 pdftohtml，
  靠字体区分标题与正文）。没有这个文件时 app 自动回退到 PDF 书签。
- `app/` — 阅读器（Vite + React + shadcn + Extend UI）。

## 阅读器 app

- 启动：`cd app && pnpm dev --port 8787`，或双击 `app/start.command`。
- `app/public/` 里的 `data`、`notes`、`toc`、`books.json` 是指向仓库根的软链接；
  改 CSV / books.json 后浏览器刷新即生效，无需重启。
- 标记与进度由 `app/vite.config.ts` 里的 dev 中间件（`/api/marks`、
  `/api/progress`）直接写入 `marks/`。只在 dev 模式下可用（这是预期用法）。
- ⚠ `app/src/components/extend/pdf-viewer.tsx` 是 shadcn 装入的源码，
  **手工打过补丁**（radix 兼容 ×3、onSelectionEnd、onBookmarksLoaded、
  工具栏布局）。不要重新执行 `shadcn add @extend/pdf-viewer`，会覆盖补丁。
- 构建校验用 `pnpm build`（含 tsc）。

## 加一本新书

1. 书放 `data/<slug>.pdf`（slug 小写连字符），确认正文页与 PDF 页的偏移；
2. 在 `books.json` 登记一条（app 自动出现书籍切换器，零代码改动），
   跑 `python3 scripts/build-toc.py <slug>` 生成多级目录；
3. 按 `prompt.md` 流程产出 `notes/<slug>.csv`（读者水平画像已在 prompt.md，
   跨书通用；量大可拆页区间并行提取后按词元去重合并）；
4. git commit。

## 约定

- 词条 CSV、marks、books.json 改动后要 commit；远端 `wuwe1/books`（private）。
- 读者的「这些我认识」清单（app 导出）→ 从对应 CSV 删行并抬高该类别收录门槛；
  「这个我不会」→ 加进 CSV 并降低门槛。改完 commit。
