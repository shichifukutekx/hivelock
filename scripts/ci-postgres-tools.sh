#!/usr/bin/env bash
# Installs the PostgreSQL 18 programs the tests use on a Debian or Ubuntu CI machine: psql and pg_dump for the
# backup tests, and initdb, pg_ctl and pgvector for the restore drill's throwaway server.
# The database the tests use runs as a CI service, so this starts no server of its own.
set -euo pipefail

sudo=""
if [ "$(id -u)" -ne 0 ]; then sudo="sudo"; fi

$sudo apt-get update -qq
$sudo apt-get install -y -qq --no-install-recommends postgresql-common ca-certificates
# Installing a server package would otherwise create and start a cluster of its own.
$sudo sed -i 's/^#\?\s*create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
grep -q '^create_main_cluster = false' /etc/postgresql-common/createcluster.conf \
  || echo 'create_main_cluster = false' | $sudo tee -a /etc/postgresql-common/createcluster.conf > /dev/null
$sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y > /dev/null
$sudo apt-get install -y -qq --no-install-recommends postgresql-client-18 postgresql-18 postgresql-18-pgvector
