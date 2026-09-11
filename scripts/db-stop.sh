#!/usr/bin/env bash
#
# Para a instância PostgreSQL local de desenvolvimento (se estiver rodando).
#
set -euo pipefail

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
PGDATA="${SAFECIRCLE_PGDATA:-$HOME/.local/share/safecircle/pgdata}"

if "${PG_BIN}/pg_ctl" --pgdata="${PGDATA}" status >/dev/null 2>&1; then
  echo "==> Parando PostgreSQL (${PGDATA})"
  "${PG_BIN}/pg_ctl" --pgdata="${PGDATA}" --mode=fast --wait stop
else
  echo "==> PostgreSQL não está em execução"
fi
