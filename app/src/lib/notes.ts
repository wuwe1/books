export type NoteType = "生词" | "多义" | "词组" | "术语" | "难句" | "语法" | "文化"

export const NOTE_TYPES: NoteType[] = ["多义", "词组", "生词", "术语", "难句", "语法", "文化"]

export interface NoteEntry {
  page: number
  type: NoteType
  raw: string
  trans: string
  note: string
}

export interface Book {
  slug: string
  title: string
  author?: string
  pdf: string
  notes: string
  /** 词条 CSV 里的页码 + pageOffset = PDF 页码（正文从 PDF 第 pageOffset+1 页开始） */
  pageOffset: number
}

export async function loadBooks(): Promise<Book[]> {
  const res = await fetch("/books.json", { cache: "no-store" })
  const data = await res.json()
  return data.books ?? []
}

function parseCSV(text: string): string[][] {
  text = text.replace(/^﻿/, "")
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQ = false
      } else field += c
    } else {
      if (c === '"') inQ = true
      else if (c === ",") {
        row.push(field)
        field = ""
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++
        row.push(field)
        field = ""
        if (row.length > 1 || row[0] !== "") rows.push(row)
        row = []
      } else field += c
    }
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export async function loadNotes(path: string): Promise<NoteEntry[]> {
  const res = await fetch("/" + path, { cache: "no-store" })
  if (!res.ok) return []
  const rows = parseCSV(await res.text())
  if (!rows.length) return []
  const head = rows[0].map((s) => s.trim().toLowerCase())
  const idx = {
    page: head.indexOf("page"),
    type: head.indexOf("type"),
    raw: head.indexOf("raw"),
    translation: head.indexOf("translation"),
    note: head.indexOf("note"),
  }
  return rows
    .slice(1)
    .filter((r) => r.length >= 4)
    .map((r) => ({
      page: parseInt(r[idx.page], 10),
      type: (r[idx.type] || "").trim() as NoteType,
      raw: (r[idx.raw] || "").trim(),
      trans: (r[idx.translation] || "").trim(),
      note: (r[idx.note] || "").trim(),
    }))
    .filter((e) => !isNaN(e.page))
}

export function entryKey(e: NoteEntry): string {
  return `${e.page}|${e.raw}`
}
