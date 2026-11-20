#!/usr/bin/env bash
# Generates a throw-away CA and leaf certificates for the sandbox (idempotent).
#   a.crt          valid for a.localhost
#   a-expired.crt  same names, but it expired in January 2025  (scenario 1)
#   a-wronghost    valid, but issued for wronghost.example      (scenario 2)
#   b.crt          valid for b.localhost
# Everything lands in sandbox/runtime/certs (git-ignored). The CA is trusted by the sandbox
# harness only, via NODE_EXTRA_CA_CERTS; nothing is added to the system trust store.
set -euo pipefail

SB="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$SB/runtime/certs"
mkdir -p "$OUT"
cd "$OUT"
if [ -f ca.pem ] && [ -f a.crt ] && [ -f a-expired.crt ] && [ -f a-wronghost.crt ] && [ -f b.crt ]; then exit 0; fi

stamp() { # $1 = offset like -1d / +25d, prints YYYYMMDDHHMMSSZ in UTC (BSD or GNU date)
  date -u -v"$1" +%Y%m%d%H%M%SZ 2>/dev/null || date -u -d "${1/d/ day}" +%Y%m%d%H%M%SZ
}

rm -rf ca.db ca.cnf ./*.crt ./*.key ./*.csr ./*.ext ./ca.pem
mkdir -p ca.db/newcerts
: > ca.db/index.txt
echo 1000 > ca.db/serial

openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 30 \
  -subj "/CN=IncidentPulse Sandbox CA" >/dev/null 2>&1

cat > ca.cnf <<EOF
[ca]
default_ca = CA_default
[CA_default]
dir = $OUT/ca.db
database = \$dir/index.txt
new_certs_dir = \$dir/newcerts
serial = \$dir/serial
certificate = $OUT/ca.pem
private_key = $OUT/ca.key
default_md = sha256
policy = policy_any
unique_subject = no
[policy_any]
commonName = supplied
EOF

issue() { # name cn san start end
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$2" >/dev/null 2>&1
  printf '[ext]\nsubjectAltName=%s\nbasicConstraints=CA:FALSE\n' "$3" > "$1.ext"
  openssl ca -config ca.cnf -batch -notext -in "$1.csr" -out "$1.crt" \
    -extfile "$1.ext" -extensions ext -startdate "$4" -enddate "$5" >/dev/null 2>&1
  chmod 600 "$1.key"
}

NOT_BEFORE="$(stamp -1d)"
NOT_AFTER="$(stamp +25d)"
issue a            a.localhost          "DNS:a.localhost"          "$NOT_BEFORE" "$NOT_AFTER"
issue a-expired    a.localhost          "DNS:a.localhost"          20250101000000Z 20250131000000Z
issue a-wronghost  wronghost.example    "DNS:wronghost.example"    "$NOT_BEFORE" "$NOT_AFTER"
issue b            b.localhost          "DNS:b.localhost"          "$NOT_BEFORE" "$NOT_AFTER"
echo "sandbox certificates written to $OUT"
