export type NoteType = "生词" | "多义" | "词组" | "术语" | "难句" | "语法" | "文化"

export const NOTE_TYPES: NoteType[] = ["多义", "词组", "生词", "术语", "难句", "语法", "文化"]

export interface NoteEntry {
  page: number
  type: NoteType
  raw: string
  trans: string
  note: string
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

export async function loadNotes(): Promise<NoteEntry[]> {
  const res = await fetch("/notes.csv", { cache: "no-store" })
  const rows = parseCSV(await res.text())
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
