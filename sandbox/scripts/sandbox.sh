#!/usr/bin/env bash
# Local fault-injection sandbox driver (SPEC §9). Touches only the ipsb-* containers and
# sandbox/runtime/. It has no network path to production and no credentials.
#
#   sandbox.sh certs        generate the sandbox CA + leaf certificates (idempotent)
#   sandbox.sh up           healthy stack
#   sandbox.sh reset        restore the healthy stack (after any fault)
#   sandbox.sh inject N     inject scenario N (1-16) into the toy apps (see sandbox/README.md)
#   sandbox.sh spa          healthy single-page app on "a" (the baseline of scenarios 15 and 16)
#   sandbox.sh flap-recover end the 20 s outage of scenario 14
#   sandbox.sh status       docker ps for the stack
#   sandbox.sh down         stop and remove the stack
set -euo pipefail

SB="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$SB/.." && pwd)"
RT="$SB/runtime"
compose() { docker compose -p ipsb -f "$ROOT/compose.sandbox.yaml" "$@"; }

write_conf() { # $1 = app, $2 = upstream port, or "broken" for a syntax error
  local app="$1" up="$2"
  mkdir -p "$RT/$app/conf.d"
  if [ "$up" = "broken" ]; then
    cat > "$RT/$app/conf.d/default.conf" <<EOF
server {
  listen 443 ssl;
  server_name $app.localhost;
  ssl_certificate /certs/server.crt;
  ssl_certificate_key /certs/server.key;
  location / {
    proxy_pass http://$app-app:3000;
  }
}}
EOF
  else
    cat > "$RT/$app/conf.d/default.conf" <<EOF
server {
  listen 443 ssl;
  server_name $app.localhost;
  ssl_certificate /certs/server.crt;
  ssl_certificate_key /certs/server.key;
  resolver 127.0.0.11 valid=2s;
  location / {
    set \$upstream http://$app-app:$up;
    proxy_pass \$upstream;
    proxy_connect_timeout 2s;
    proxy_read_timeout 5s;
  }
}
EOF
  fi
}

set_cert() { # $1 = app, $2 = cert name in runtime/certs
  mkdir -p "$RT/$1/certs"
  cp "$RT/certs/$2.crt" "$RT/$1/certs/server.crt"
  cp "$RT/certs/$2.key" "$RT/$1/certs/server.key"
}

healthy_files() {
  "$SB/scripts/gen-certs.sh"
  write_conf a 3000; set_cert a a
  write_conf b 3000; set_cert b b
  write_conf p 3000; set_cert p p
}

case "${1:-}" in
  certs) "$SB/scripts/gen-certs.sh" ;;
  up)
    healthy_files
    compose up -d
    ;;
  reset)
    healthy_files
    # Clear any fault variables and recreate "a" from its healthy definition.
    env -u A_FAULT -u A_DATABASE_URL docker compose -p ipsb -f "$ROOT/compose.sandbox.yaml" up -d --force-recreate a-app a-nginx
    # "b" only ever gets a certificate fault (13); "p" only a pm2 fault (11).
    docker exec ipsb-b-nginx nginx -s reload >/dev/null 2>&1 || true
    docker exec ipsb-p-app pm2 start toy-api >/dev/null 2>&1 || docker restart ipsb-p-app >/dev/null
    ;;
  inject)
    case "${2:-}" in
      1) set_cert a a-expired; docker exec ipsb-a-nginx nginx -s reload ;;       # expired certificate
      2) set_cert a a-wronghost; docker exec ipsb-a-nginx nginx -s reload ;;     # certificate for another hostname
      3) docker stop ipsb-a-app >/dev/null ;;                                    # container stopped
      4) A_DATABASE_URL= compose up -d --force-recreate a-app ;;                 # crash loop: required env missing
      5) write_conf a 3999; docker exec ipsb-a-nginx nginx -s reload ;;          # nginx upstream on the wrong port
      6) write_conf a broken; docker restart ipsb-a-nginx >/dev/null || true ;;  # nginx config syntax error
      7) echo "scenario 7 (DNS record removed) leaves the stack healthy: the harness points the project at a name that no longer resolves" ;;
      8) A_FAULT=badcommit compose up -d --force-recreate a-app ;;               # 500s after a "bad commit"
      9) A_FAULT=slow compose up -d --force-recreate a-app ;;                    # slow endpoint (8 s): nginx answers 504 after 5 s
      10) A_FAULT=disk compose up -d --force-recreate a-app ;;                   # SIMULATED full disk: ENOSPC in the app's logs
      11) docker exec ipsb-p-app pm2 stop toy-api >/dev/null ;;                  # pm2 app stopped, container still up
      12) A_FAULT=injection compose up -d --force-recreate a-app ;;              # 500s + prompt injection in logs
      13) set_cert a a-expired; set_cert b b-expired                             # two projects, one shared cause: expired certificate
          docker exec ipsb-a-nginx nginx -s reload; docker exec ipsb-b-nginx nginx -s reload ;;
      14) docker stop ipsb-a-app >/dev/null ;;                                   # flapping: down now, `flap-recover` brings it back
      15) A_FAULT=mixed compose up -d --force-recreate a-app ;;                  # HTTPS page whose JS calls http://a.localhost:3003 (mixed content)
      16) A_FAULT=api502 compose up -d --force-recreate a-app ;;                 # page 200, but its API route answers 502
      *) echo "unknown scenario '${2:-}' (supported: 1-16)" >&2; exit 2 ;;
    esac
    ;;
  spa) A_FAULT=spa compose up -d --force-recreate a-app ;;                    # healthy single-page app
  flap-recover) docker start ipsb-a-app >/dev/null ;;
  status) docker ps -a --filter "name=ipsb-" --format 'table {{.Names}}\t{{.State}}\t{{.Status}}' ;;
  down) compose down ;;
  *) echo "usage: sandbox.sh certs|up|reset|spa|inject N|flap-recover|status|down" >&2; exit 2 ;;
esac
