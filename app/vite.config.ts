import path from "node:path"
import fs from "node:fs"
import { defineConfig, type Plugin, type Connect } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const REPO_ROOT = path.resolve(__dirname, "..")
const MARKS_DIR = path.join(REPO_ROOT, "marks")

function readBody(req: Connect.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (c) => (data += c))
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

function safeSlug(s: unknown): string | null {
  return typeof s === "string" && /^[a-z0-9-]+$/.test(s) ? s : null
}

function marksFile(slug: string) {
  return path.join(MARKS_DIR, `${slug}.json`)
}

function readMarks(slug: string): any[] {
  try {
    return JSON.parse(fs.readFileSync(marksFile(slug), "utf8"))
  } catch {
    return []
  }
}

function writeMarks(slug: string, marks: any[]) {
  fs.mkdirSync(MARKS_DIR, { recursive: true })
  fs.writeFileSync(marksFile(slug), JSON.stringify(marks, null, 2) + "\n")
}

function json(res: any, code: number, body: any) {
  res.statusCode = code
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

/** 本地 API：标记与阅读进度直接写进仓库 marks/，供 git 与 agent 使用 */
function marksApi(): Plugin {
  return {
    name: "marks-api",
    configureServer(server) {
      server.middlewares.use("/api/marks", async (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost")
          if (req.method === "GET") {
            const slug = safeSlug(url.searchParams.get("slug"))
            if (!slug) return json(res, 400, { error: "bad slug" })
            return json(res, 200, readMarks(slug))
          }
          if (req.method === "POST") {
            const body = await readBody(req)
            const slug = safeSlug(body.slug)
            if (!slug) return json(res, 400, { error: "bad slug" })
            const marks = readMarks(slug)
            const mark = {
              id: Date.now().toString(36),
              page: body.page,
              csvPage: body.csvPage,
              text: body.text || undefined,
              note: body.note || undefined,
              color: body.color || undefined,
              rects: body.rects || undefined,
              createdAt: new Date().toISOString(),
            }
            marks.push(mark)
            writeMarks(slug, marks)
            return json(res, 200, mark)
          }
          if (req.method === "DELETE") {
            const slug = safeSlug(url.searchParams.get("slug"))
            const id = url.searchParams.get("id")
            if (!slug || !id) return json(res, 400, { error: "bad params" })
            writeMarks(
              slug,
              readMarks(slug).filter((m) => m.id !== id)
            )
            return json(res, 200, { ok: true })
          }
          json(res, 405, { error: "method not allowed" })
        } catch (e) {
          json(res, 500, { error: String(e) })
        }
      })

      server.middlewares.use("/api/progress", async (req, res) => {
        try {
          if (req.method !== "POST") return json(res, 405, {})
          const body = await readBody(req)
          const slug = safeSlug(body.slug)
          if (!slug) return json(res, 400, { error: "bad slug" })
          const file = path.join(MARKS_DIR, "progress.json")
          let progress: Record<string, any> = {}
          try {
            progress = JSON.parse(fs.readFileSync(file, "utf8"))
          } catch {
            /* first write */
          }
          progress[slug] = {
            page: body.page,
            csvPage: body.csvPage,
            updatedAt: new Date().toISOString(),
          }
          fs.mkdirSync(MARKS_DIR, { recursive: true })
          fs.writeFileSync(file, JSON.stringify(progress, null, 2) + "\n")
          json(res, 200, { ok: true })
        } catch (e) {
          json(res, 500, { error: String(e) })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), marksApi()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
})
