#!/usr/bin/env bash
#
# Inicia uma instância PostgreSQL local e self-contained para desenvolvimento.
# Idempotente: pode ser executado a cada boot do ambiente sem duplicar processos
# nem reinicializar dados. Não usa sudo.
#
set -euo pipefail

PG_VERSION="${PG_VERSION:-16}"
PG_BIN="/usr/lib/postgresql/${PG_VERSION}/bin"
PGDATA="${SAFECIRCLE_PGDATA:-$HOME/.local/share/safecircle/pgdata}"
PGPORT="${SAFECIRCLE_PGPORT:-5432}"
PGSOCKET_DIR="/tmp"
DB_NAME="${SAFECIRCLE_DB_NAME:-safecircle}"
DB_USER="${SAFECIRCLE_DB_USER:-safecircle}"

if [ ! -x "${PG_BIN}/pg_ctl" ]; then
  echo "ERRO: binários do PostgreSQL ${PG_VERSION} não encontrados em ${PG_BIN}" >&2
  echo "Instale com: sudo apt-get install -y postgresql postgresql-contrib" >&2
  exit 1
fi

export PGPORT PGDATA

# 1. Inicializa o cluster apenas na primeira vez.
if [ ! -s "${PGDATA}/PG_VERSION" ]; then
  echo "==> Inicializando cluster PostgreSQL em ${PGDATA}"
  mkdir -p "${PGDATA}"
  "${PG_BIN}/initdb" \
    --pgdata="${PGDATA}" \
    --username="${DB_USER}" \
    --auth-local=trust \
    --auth-host=trust \
    --encoding=UTF8 >/dev/null
fi

# 2. Sobe o servidor apenas se ainda não estiver rodando (idempotência).
if "${PG_BIN}/pg_ctl" --pgdata="${PGDATA}" status >/dev/null 2>&1; then
  echo "==> PostgreSQL já está em execução (${PGDATA})"
else
  echo "==> Iniciando PostgreSQL em localhost:${PGPORT}"
  "${PG_BIN}/pg_ctl" \
    --pgdata="${PGDATA}" \
    --log="${PGDATA}/postgresql.log" \
    --options="-p ${PGPORT} -k ${PGSOCKET_DIR} -c listen_addresses=localhost" \
    --wait \
    start
fi

# 3. Aguarda prontidão.
for _ in $(seq 1 30); do
  if "${PG_BIN}/pg_isready" --host=localhost --port="${PGPORT}" --username="${DB_USER}" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# 4. Garante que o banco de aplicação exista (idempotente).
if ! "${PG_BIN}/psql" --host=localhost --port="${PGPORT}" --username="${DB_USER}" \
  --dbname=postgres --tuples-only --no-align \
  --command="SELECT 1 FROM pg_database WHERE datname = '${DB_NAME}'" | grep -q 1; then
  echo "==> Criando banco '${DB_NAME}'"
  "${PG_BIN}/createdb" --host=localhost --port="${PGPORT}" --username="${DB_USER}" "${DB_NAME}"
fi

echo "==> PostgreSQL pronto: postgres://${DB_USER}@localhost:${PGPORT}/${DB_NAME}"
