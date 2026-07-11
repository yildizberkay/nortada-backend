#!/usr/bin/env bash
# Enforces the module boundaries that the type system can't:
#   1. platform/* must not import from feature/* (shared kernel stays generic).
#   2. Direct DB access (Drizzle operators + dbClient) lives ONLY in
#      repositories — services/routes must go through a repository.
# See docs/architecture.md (Buckets/Katmanlar) + docs/reference/brandscale-architecture.md §1.

set -euo pipefail

FAILED=0

# ── 1. platform/* -> feature/* ────────────────────────────────────────────────
# Both the `@/` alias form and a relative `../feature/` escape.
BUCKET=$(grep -rEn "@/domains/feature/|from ['\"][./]+feature/" src/domains/platform/ --include='*.ts' || true)
if [ -n "$BUCKET" ]; then
  echo "ERROR: platform/* cannot import from feature/*"
  echo ""
  echo "$BUCKET"
  echo ""
  FAILED=1
fi

# ── 2. DB access outside repositories ─────────────────────────────────────────
# Drizzle value operators (`from "drizzle-orm"`) and the raw client accessors
# (getDBClient/getDBManager) may only appear in repository files. BaseRepository
# is the sanctioned holder of the accessors, so it is exempt.
DB_LEAK=$(grep -rEn "from ['\"]drizzle-orm['\"]|getDBClient|getDBManager" src/domains/ --include='*.ts' \
  | grep -vE "/repositories/|foundation/BaseRepository\.ts" || true)
if [ -n "$DB_LEAK" ]; then
  echo "ERROR: direct DB access (Drizzle operators / dbClient) is only allowed in repositories"
  echo ""
  echo "$DB_LEAK"
  echo ""
  FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi

echo "OK: module boundaries respected (platform↛feature, DB access in repositories only)."
