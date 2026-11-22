# IncidentPulse yangilanishi `628105f` → `150e547`

Bu buyruqlar [DEPLOY.md](DEPLOY.md) dagi 4, 6.3–6.6 va 7–11-bo‘limlarga asoslangan. VPS’da texnik xizmat vaqtini ajrating. Amaldagi runner ishlari tugashini kuting va yangilash vaqtida approval bermang. Compose build ham shu vaqtga kiradi.

## 1. Versiyalar va server yo‘llarini tekshirish

VPS’da `sudo -i` bilan root shell oching. 1–8-qadamlarni shu Bash sessiyasida bajaring. Buyruq xato bersa, natijani tekshirib, keyingi blokka o‘tishdan oldin sababini bartaraf eting yoki rollback qiling.

```bash
set +x
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
APP=/opt/incidentpulse/app
ENV_FILE=/opt/incidentpulse/secrets/.env
BACKUP=/opt/incidentpulse/secrets/upgrade-150e547
RUNNER=/opt/incidentpulse/actions-runner
NODE=/opt/incidentpulse/node/bin/node
VHOST=/etc/nginx/sites-available/incidentpulse.gotrips.cloud.conf
SNIPPET=/etc/nginx/snippets/incidentpulse-web-proxy.conf
BASE=628105f6068ddeb5ada9a92ba867e1f6bb0e1687
TARGET=150e5473134acd73b80e24fceb6b66a290d8bd43
export IP_TAG=628105f
unset APPROVAL_HMAC_SECRET CALLBACK_HMAC_SECRET APP_DB_PASSWORD WEB_DB_PASSWORD WEB_PROXY_SECRET POSTGRES_PASSWORD WEB_HOST_PORT
dc() { docker compose --project-name incidentpulse --env-file "$ENV_FILE" -f "$APP/compose.prod.yaml" "$@"; }

cd "$APP"
test "$(git rev-parse HEAD)" = "$BASE"
test -z "$(git status --porcelain)"
git fetch origin main
git merge-base --is-ancestor "$TARGET" FETCH_HEAD
git show -s --format='%h %s' "$TARGET"
test "$(stat -c '%a:%u:%g' "$ENV_FILE")" = '600:0:0'
"$NODE" -p 'process.versions.node.split(".")[0]' | grep -x 24
test -x /usr/local/sbin/ip-pm2
test "$(readlink -f /etc/nginx/sites-enabled/incidentpulse.gotrips.cloud.conf)" = "$VHOST"
test "$(grep -Ec '^[[:space:]]*proxy_pass[[:space:]]+http://127\.0\.0\.1:3100;' "$VHOST")" -eq 1
test "$(grep -Eic '^[[:space:]]*proxy_set_header[[:space:]]+X-Forwarded-For[[:space:]]' "$VHOST")" -eq 1
systemctl is-active incidentpulse-actions
test "$(dc port web 3000)" = '127.0.0.1:3100'
dc ps
```

**Kutilgan natija.** Checkout `628105f`, fetch qilingan `main` tarixida `150e547` bor. Node 24, runner `active`, web `127.0.0.1:3100` da. Keyingi checkout to‘liq target SHA bo‘yicha amalga oshiriladi.

## 2. Rollback uchun fayllar, imijlar va Postgres zaxirasi

```bash
mkdir -m 0700 "$BACKUP"
cp -a "$ENV_FILE" "$BACKUP/.env"
cp -a /etc/incidentpulse/actions-runner.env /etc/incidentpulse/actions-policy.json "$BACKUP/"
cp -a /etc/systemd/system/incidentpulse-actions.service "$BACKUP/"
cp -a "$RUNNER" "$BACKUP/runner"
cp -a "$VHOST" "$BACKUP/vhost.conf"
if test -f "$SNIPPET"; then cp -a "$SNIPPET" "$BACKUP/proxy-snippet.conf"; fi

# Rollback tegi uchun aynan ishlayotgan konteynerlarning imij ID’larini oling.
running_image() { docker inspect --format '{{.Image}}' "$(dc ps -q "$1")"; }
OLD_APP="$(running_image orchestrator)"
test "$(running_image web)" = "$OLD_APP"
test "$(running_image intake)" = "$OLD_APP"
docker image tag "$OLD_APP" incidentpulse-app:rollback-628105f
docker image tag "$(running_image debate-verifier)" incidentpulse-debate-verifier:rollback-628105f
docker image tag "$(running_image postmortem-crew)" incidentpulse-postmortem-crew:rollback-628105f

dc exec -T postgres pg_dump -U incidentpulse -d incidentpulse -Fc > "$BACKUP/postgres.dump"
dc exec -T postgres pg_restore --list < "$BACKUP/postgres.dump" > "$BACKUP/postgres.contents"
test -s "$BACKUP/postgres.contents"
touch "$BACKUP/ready"
dc stop orchestrator web
systemctl stop incidentpulse-actions
```

**Kutilgan natija.** `$BACKUP` root’ga tegishli `0700` katalog, `postgres.contents` bo‘sh emas. Uchala rollback imiji teglandi. Orchestrator, web va runner to‘xtagan, Postgres va Redis ishlayapti. `ready` yaratilgach 3-qadamga o‘ting.

## 3. Target checkout va beshta yangi sir

```bash
git switch --detach "$TARGET"
test "$(git rev-parse HEAD)" = "$TARGET"
export IP_TAG=150e547

env_tmp="$(mktemp /opt/incidentpulse/secrets/.env.150e547.XXXXXXXX)"
awk '!/^[[:space:]]*(export[[:space:]]+)?(APPROVAL_HMAC_SECRET|CALLBACK_HMAC_SECRET|APP_DB_PASSWORD|WEB_DB_PASSWORD|WEB_PROXY_SECRET)[[:space:]]*=/' \
  "$BACKUP/.env" > "$env_tmp"
for name in APPROVAL_HMAC_SECRET CALLBACK_HMAC_SECRET APP_DB_PASSWORD WEB_DB_PASSWORD WEB_PROXY_SECRET; do
  value="$(openssl rand -hex 32)"
  printf '%s=%s\n' "$name" "$value" >> "$env_tmp"
done
unset value
chown root:root "$env_tmp"
chmod 0600 "$env_tmp"
mv -T "$env_tmp" "$ENV_FILE"

runner_env_tmp="$(mktemp /etc/incidentpulse/actions-runner.env.XXXXXXXX)"
grep '^APPROVAL_HMAC_SECRET=' "$ENV_FILE" > "$runner_env_tmp"
test "$(wc -l < "$runner_env_tmp")" -eq 1
chown root:root "$runner_env_tmp"
chmod 0600 "$runner_env_tmp"
mv -T "$runner_env_tmp" /etc/incidentpulse/actions-runner.env
stat -c '%a %U:%G %n' "$ENV_FILE" /etc/incidentpulse/actions-runner.env
```

**Kutilgan natija.** Checkout `150e547`. Ikkala env fayli `600 root:root`. Asosiy `.env` da quyidagi beshta kalitning har biri yangi va alohida qiymatga ega.

| Kalit | Ishlatadigan servis |
|---|---|
| `APPROVAL_HMAC_SECRET` | Orchestrator va `/etc/incidentpulse/actions-runner.env` orqali runner |
| `CALLBACK_HMAC_SECRET` | Orchestrator ichidagi Telegram bot va web |
| `APP_DB_PASSWORD` | `incidentpulse_app` roli orqali orchestrator |
| `WEB_DB_PASSWORD` | `incidentpulse_web` roli orqali web |
| `WEB_PROXY_SECRET` | Web va 7-qadamdagi nginx snippet |

Mavjud `POSTGRES_PASSWORD` saqlanadi. Migratsiya shu parol bilan `incidentpulse` rolidan foydalanadi.

## 4. Runner kodi, sudoers va systemd

```bash
runner_stage="$(mktemp -d /opt/incidentpulse/.runner-150e547.XXXXXXXX)"
cp -R "$APP/host/actions-runner/src" "$APP/host/actions-runner/scripts" "$runner_stage/"
chown -R root:root "$runner_stage"
chmod -R u=rwX,go=rX "$runner_stage"
mv -T "$RUNNER" "$BACKUP/runner-before-swap"
mv -T "$runner_stage" "$RUNNER"

render_sudoers() (
  set -eu
  test "$(id -u)" -eq 0
  umask 077
  sudoers_dir="$(mktemp -d /tmp/incidentpulse-sudoers.XXXXXXXX)"
  sudoers_file="$sudoers_dir/incidentpulse-actions"
  cleanup_sudoers() {
    if test -f "$sudoers_file"; then unlink "$sudoers_file"; fi
    rmdir "$sudoers_dir"
  }
  trap cleanup_sudoers EXIT
  chmod 0700 "$sudoers_dir"
  "$NODE" "$RUNNER/scripts/render-sudoers.ts" /etc/incidentpulse/actions-policy.json > "$sudoers_file"
  visudo -cf "$sudoers_file"
  install -m 0440 -o root -g root "$sudoers_file" /etc/sudoers.d/incidentpulse-actions
  visudo -c
)
render_sudoers
sudo -l -U incidentpulse-actions | grep -F /usr/local/sbin/ip-pm2
if sudo -u incidentpulse-actions sudo -n /usr/bin/whoami; then
  printf '%s\n' 'Sudoers tekshiruvi muvaffaqiyatsiz: runner uchun whoami ruxsat etilgan.' >&2
  exit 1
fi

install -o root -g root -m 0644 "$APP/host/actions-runner/deploy/incidentpulse-actions.service" \
  /etc/systemd/system/incidentpulse-actions.service
systemctl daemon-reload
systemctl restart incidentpulse-actions
systemctl is-active incidentpulse-actions
curl --retry 10 --retry-connrefused --retry-delay 1 -fsS \
  --unix-socket /run/incidentpulse/actions.sock http://localhost/v1/status
echo
```

**Kutilgan natija.** `visudo -cf` va `visudo -c` muvaffaqiyatli. Root’ga tegishli `0700` katalogda render qilingan, aynan tekshirilgan nusxa o‘rnatildi. Sudoers ro‘yxatida `/usr/local/sbin/ip-pm2` bor, `whoami` rad etiladi. Runner `active` va statusda `ok:true`, `paused`, `running` hamda `queued` bor.

## 5. Compose build va Postgres migratsiyasi

```bash
dc config --quiet
dc --profile migrate config --quiet
dc build
docker image inspect --format '{{index .RepoTags 0}}' \
  incidentpulse-app:150e547 incidentpulse-debate-verifier:150e547 incidentpulse-postmortem-crew:150e547

dc up -d --wait postgres
dc --profile migrate run --rm --no-deps migrate
dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -U incidentpulse -d incidentpulse \
  -c "SELECT rolname, rolcanlogin, rolsuper FROM pg_roles WHERE rolname IN ('incidentpulse_app','incidentpulse_web') ORDER BY rolname;"
```

**Kutilgan natija.** Compose konfiguratsiyasi tekshirildi va uchta `150e547` imiji qurildi. Migratsiya `roles incidentpulse_app and incidentpulse_web are configured` deb chiqadi. Har ikki rol uchun `rolcanlogin=t`, `rolsuper=f`. Migratsiya digest’i bo‘lmagan ochiq approval’larni yopib auditga yozadi. Ular uchun yangi taklif kerak.

## 6. Docker adapter va runtime servislar

```bash
dc up -d --wait --wait-timeout 180 docker-proxy docker-read-adapter
dc up -d --wait --wait-timeout 240
dc ps
test "$(dc port web 3000)" = '127.0.0.1:3100'

dc exec -T orchestrator node --input-type=module -e '
import assert from "node:assert/strict";
const base = process.env.DOCKER_READ_ADAPTER_URL;
assert.equal(base, "http://docker-read-adapter:2376");
assert.equal(process.env.DOCKER_HOST, undefined);
const list = await fetch(base + "/containers/json?all=1");
assert.equal(list.status, 200);
for (const row of await list.json()) {
  assert.ok(!Object.hasOwn(row, "Labels") && !Object.hasOwn(row, "Mounts"));
}
for (const path of ["/containers/example/json", "/containers/example/stats"]) {
  assert.equal((await fetch(base + path)).status, 403);
}
console.log("Docker adapter: 200, 403, 403");
'
for service in orchestrator docker-read-adapter docker-proxy; do
  printf '%s ' "$service"
  docker inspect --format '{{range $name, $config := .NetworkSettings.Networks}}{{$name}} {{end}}' "$(dc ps -q "$service")"
done
```

**Kutilgan natija.** 9 runtime servis sog‘lom. Orchestrator `incidentpulse_backend` va `incidentpulse_dockerread` da, adapter `incidentpulse_dockerread` va `incidentpulse_dockerproxy` da, proxy faqat `incidentpulse_dockerproxy` da. Adapter ro‘yxat uchun `200`, inspect va stats uchun `403` qaytaradi.

## 7. Mavjud HTTPS vhost’ga proxy header qo‘shish

```bash
(
  proxy_secret="$(sed -n 's/^WEB_PROXY_SECRET=//p' "$ENV_FILE")"
  printf '%s\n' "$proxy_secret" | grep -Eq '^[a-f0-9]{64}$'
  snippet_tmp="$(mktemp /etc/nginx/snippets/.incidentpulse-web-proxy.XXXXXXXX)"
  printf 'proxy_set_header X-IncidentPulse-Proxy "%s";\n' "$proxy_secret" > "$snippet_tmp"
  chown root:root "$snippet_tmp"
  chmod 0600 "$snippet_tmp"
  mv -T "$snippet_tmp" "$SNIPPET"
)
vhost_tmp="$(mktemp /etc/nginx/sites-available/.incidentpulse-150e547.XXXXXXXX)"
awk '
  tolower($1) == "proxy_set_header" && tolower($2) == "x-forwarded-for" {
    match($0, /^[[:space:]]*/)
    indent = substr($0, 1, RLENGTH)
    print indent "proxy_set_header X-Forwarded-For $remote_addr;"
    print indent "include /etc/nginx/snippets/incidentpulse-web-proxy.conf;"
    next
  }
  { print }
' "$VHOST" > "$vhost_tmp"
chown --reference="$VHOST" "$vhost_tmp"
chmod --reference="$VHOST" "$vhost_tmp"
mv -T "$vhost_tmp" "$VHOST"
nginx -t
systemctl reload nginx
```

**Kutilgan natija.** `nginx -t` muvaffaqiyatli. Mavjud HTTPS blok va 3100 upstream saqlangan. Nginx mijoz yuborgan forwarding qiymatini `$remote_addr` bilan, proxy autentifikatsiya header’ini esa root uchun yopiq snippet qiymati bilan almashtiradi.

## 8. Yakuniy tekshiruv

```bash
test "$(curl -fsS -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/login)" = 200
test "$(curl -fsS -o /dev/null -w '%{http_code}' \
  --resolve incidentpulse.gotrips.cloud:443:127.0.0.1 https://incidentpulse.gotrips.cloud/login)" = 200
dc exec -T orchestrator node --input-type=module -e '
import { request } from "node:http";
const req = request({socketPath:"/run/incidentpulse/actions.sock", path:"/v1/health"}, (res) => {
  if (res.statusCode !== 200) process.exitCode = 1;
  res.pipe(process.stdout);
});
req.on("error", () => { process.exitCode = 1; });
req.end();
'
echo
dc logs --tail 30 orchestrator | grep -F 'orchestrator ready'
git rev-parse --short HEAD
```

**Kutilgan natija.** Lokal va HTTPS login `200`, orchestrator runner socket’dan `ok:true` oladi, logda `orchestrator ready` bor va checkout `150e547`. Telegram’da `/status` runner holati va navbatni ko‘rsatadi. Keyingi tabiiy taklifda Telegram va web kartasidan loyiha, parametrlar va reja digest’ini tekshiring.

## Rollback → `628105f`

2-qadamdagi `ready` belgisi bo‘lsa ishlating. Joriy runner ishi tugashini kuting. Root Bash sessiyasida bloklarni tartib bilan bajaring. Rollback Postgres va Redis volume’laridagi yozuvlarni saqlaydi.

```bash
set +x
set -euo pipefail
umask 077
test "$(id -u)" -eq 0
APP=/opt/incidentpulse/app
ENV_FILE=/opt/incidentpulse/secrets/.env
BACKUP=/opt/incidentpulse/secrets/upgrade-150e547
RUNNER=/opt/incidentpulse/actions-runner
NODE=/opt/incidentpulse/node/bin/node
VHOST=/etc/nginx/sites-available/incidentpulse.gotrips.cloud.conf
SNIPPET=/etc/nginx/snippets/incidentpulse-web-proxy.conf
test -f "$BACKUP/ready"
docker image inspect --format '{{.Id}}' \
  incidentpulse-app:rollback-628105f incidentpulse-debate-verifier:rollback-628105f incidentpulse-postmortem-crew:rollback-628105f
cd "$APP"

# Checkout yoki .env qaysi qadamdaligidan qat’i nazar, prod konteynerlarini label orqali toping.
for service in orchestrator web docker-read-adapter; do
  id="$(docker ps -q --filter label=com.docker.compose.project=incidentpulse \
    --filter "label=com.docker.compose.service=$service")"
  if test -n "$id"; then docker stop "$id"; fi
done
systemctl stop incidentpulse-actions
git switch --detach 628105f6068ddeb5ada9a92ba867e1f6bb0e1687
install -o root -g root -m 0600 "$BACKUP/.env" "$ENV_FILE"
install -o root -g root -m 0600 "$BACKUP/actions-runner.env" /etc/incidentpulse/actions-runner.env
cp -a "$BACKUP/actions-policy.json" /etc/incidentpulse/actions-policy.json
cp -a "$BACKUP/incidentpulse-actions.service" /etc/systemd/system/incidentpulse-actions.service
if test -d "$RUNNER"; then
  recovery_dir="$(mktemp -d "$BACKUP/runner-rollback.XXXXXXXX")"
  mv -T "$RUNNER" "$recovery_dir/runner"
fi
cp -a "$BACKUP/runner" "$RUNNER"
cp -a "$BACKUP/vhost.conf" "$VHOST"
if test -f "$BACKUP/proxy-snippet.conf"; then
  cp -a "$BACKUP/proxy-snippet.conf" "$SNIPPET"
elif test -f "$SNIPPET"; then
  unlink "$SNIPPET"
fi
nginx -t
systemctl reload nginx
```

**Kutilgan natija.** Checkout, env, runner kodi, unit, policy va nginx vhost 628105f bilan ishlagan nusxaga qaytdi. Nginx konfiguratsiyasi muvaffaqiyatli yuklandi.

```bash
(
  set -eu
  test "$(id -u)" -eq 0
  umask 077
  sudoers_dir="$(mktemp -d /tmp/incidentpulse-sudoers.XXXXXXXX)"
  sudoers_file="$sudoers_dir/incidentpulse-actions"
  cleanup_sudoers() {
    if test -f "$sudoers_file"; then unlink "$sudoers_file"; fi
    rmdir "$sudoers_dir"
  }
  trap cleanup_sudoers EXIT
  chmod 0700 "$sudoers_dir"
  "$NODE" "$RUNNER/scripts/render-sudoers.ts" /etc/incidentpulse/actions-policy.json > "$sudoers_file"
  visudo -cf "$sudoers_file"
  install -m 0440 -o root -g root "$sudoers_file" /etc/sudoers.d/incidentpulse-actions
  visudo -c
)

export IP_TAG=rollback-628105f
unset APPROVAL_HMAC_SECRET CALLBACK_HMAC_SECRET APP_DB_PASSWORD WEB_DB_PASSWORD WEB_PROXY_SECRET POSTGRES_PASSWORD WEB_HOST_PORT
dc() { docker compose --project-name incidentpulse --env-file "$ENV_FILE" -f "$APP/compose.prod.yaml" "$@"; }
dc config --quiet
dc up -d --wait postgres

# 628105f qaror auditini ilova ichida yozadi. Yangi trigger bilan audit ikki marta yozilar edi.
dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -U incidentpulse -d incidentpulse <<'SQL'
BEGIN;
DROP TRIGGER IF EXISTS incidentpulse_approvals_audit ON public.incidentpulse_approvals;
DROP TRIGGER IF EXISTS incidentpulse_approvals_guard ON public.incidentpulse_approvals;
DO $rollback$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='incidentpulse_approvals' AND column_name='plan_digest'
  ) THEN
    WITH closed AS (
      UPDATE public.incidentpulse_approvals
      SET status=CASE WHEN status='pending' THEN 'expired' ELSE 'rejected' END,
          closed_at=now(), decided_at=COALESCE(decided_at,now()), decided_by=COALESCE(decided_by,'system')
      WHERE plan_digest IS NOT NULL AND closed_at IS NULL AND consumed_at IS NULL
        AND status IN ('pending','approved')
      RETURNING id
    )
    INSERT INTO public.incidentpulse_action_audit(approval_id,event,actor,at,detail)
    SELECT id,'closed_on_rollback_150e547','system',now(),'{}'::jsonb FROM closed;
  END IF;
END;
$rollback$;
COMMIT;
SQL

systemctl daemon-reload
systemctl restart incidentpulse-actions
systemctl is-active incidentpulse-actions
dc up -d --remove-orphans --wait --wait-timeout 240
dc ps
test "$(dc port web 3000)" = '127.0.0.1:3100'
test "$(curl -fsS -o /dev/null -w '%{http_code}' \
  --resolve incidentpulse.gotrips.cloud:443:127.0.0.1 https://incidentpulse.gotrips.cloud/login)" = 200
git rev-parse --short HEAD
```

**Kutilgan natija.** Har ikkala `visudo` tekshiruvi muvaffaqiyatli, Postgres tranzaksiyasi `COMMIT`, runner `active`. `docker-read-adapter` olib tashlangan, 8 ta eski runtime servis sog‘lom va HTTPS login `200`. Checkout `628105f`. Digest bilan ochilgan, hali bajarilmagan takliflar yopilgan va audit saqlangan. Migratsiya yaratgan rollar va ustunlar bazada qoladi. `postgres.dump` avariya tiklashi uchun zaxira bo‘lib qoladi.
