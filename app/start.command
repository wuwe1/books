#!/bin/zsh
cd "$(dirname "$0")"
(sleep 2 && open "http://localhost:8787") &
pnpm dev --port 8787
