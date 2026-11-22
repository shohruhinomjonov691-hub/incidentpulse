# IncidentPulse: production deploy (Phase 7)

Bu hujjat **serverda qo'lda bajariladigan** buyruqlar ketma-ketligi. Repo ichidagi hech narsa serverga o'zi ulanmaydi va hech narsa o'zi deploy qilmaydi. Har qadamdan keyin **Kutilgan natija** bor: natija boshqacha bo'lsa, keyingi qadamga o'tmang.

Barcha buyruqlar `root` bilan yoki `sudo` bilan. Qulaylik uchun avval root shell oching: `sudo -i`.

## 0. Nima o'rnatiladi

```
Internet ──► nginx (host, 80/443)
               ├─ incidentpulse.gotrips.cloud ──► 127.0.0.1:3100  (web, Docker; WEB_HOST_PORT)
               ├─ kervan.uz  (mavjud conf.d/kervan.conf) ──► localhost:3000  (Kervan, PM2; 3000 BAND)
               └─ boshqa saytlar (conf.d/*.conf; tegmaymiz)

Docker (compose.prod.yaml, jami 1832 MiB):
  postgres · redis · docker-proxy · docker-read-adapter · intake · orchestrator · web · debate-verifier · postmortem-crew
  hech qaysi port tashqariga ochilmaydi, faqat web 127.0.0.1:${WEB_HOST_PORT:-3100}

Host (systemd):
  incidentpulse-actions  ──  unix socket /run/incidentpulse/actions.sock
     alohida Unix user · sudoers (aniq buyruqlar) · approval token tekshiruvi · execFile
```

| Nima | Qayerda | Kim ko'radi / bajaradi |
|---|---|---|
| Konteyner ro'yxati va loglar | `docker-read-adapter` (`PROJECT_CONTAINERS_JSON` prefikslari, cheklangan tail) → `docker-proxy` | orchestrator (o'qish) |
| `pm2 jlist/logs`, `pm2_ports`, `nginx -T`, `certbot certificates` | host runner, **o'qish rejimi** | orchestrator (o'qish) |
| `certbot`, `nginx reload`, `pm2 restart`, `docker restart`, `nginx_site_proxy` | host runner, **faqat tasdiqlangan token bilan** | Telegram/web'da inson tasdig'idan keyin |
| Health poller | orchestrator ichida, **LLM'siz**, har 15 daqiqada | holat o'zgarsagina tergov boshlaydi |

**Telegram bot alohida konteyner emas.** U orchestrator ichida ishlaydi (grammY long polling): tasdiq tugmalari approvals bazasi va graph resume bilan bog'liq, ikkinchi jarayon bir xil bot tokenini so'rasa Telegram ikkalasiga ham `409 Conflict` qaytaradi.

**Sirlar** faqat `/opt/incidentpulse/secrets/.env` da (root, `chmod 600`). Repo'da faqat nomlar: `.env.production.example`.

---

## 1. Oldindan tekshiruv (hech narsani o'zgartirmaydi)

```bash
cat /etc/os-release | head -2
free -h
df -h / /var/lib/docker
docker --version && docker compose version
nginx -v 2>&1
certbot --version
certbot plugins 2>&1 | grep -i nginx
for b in sudo certbot nginx systemctl docker pm2 ss ps tar; do printf '%-10s' "$b"; command -v "$b" || echo "YO'Q"; done
ss -ltn | grep -E ':(3000|3100|8787|8790|8791)\b'
getent hosts incidentpulse.gotrips.cloud kervan.uz
/root/.nvm/versions/node/v16.17.0/bin/pm2 jlist | head -c 300; echo
ls /etc/nginx/conf.d/ /etc/nginx/sites-enabled/
cat /etc/nginx/conf.d/kervan.conf
nginx -T 2>/dev/null | grep -E '^# configuration file|^\s*server_name'
```

**Kutilgan natija**
- Ubuntu, `free -h` da ~4.5 GB bo'sh, `/var/lib/docker` uchun kamida **8 GB** bo'sh joy (Python imijlari katta).
- Docker va compose versiyalari chiqadi; `certbot plugins` ichida `nginx` bor (apt bilan o'rnatilgan certbot'da yo'q bo'lsa: `apt install python3-certbot-nginx`; snap certbot'da nginx plagini ichiga kiritilgan).
- Barcha binar'lar yo'li chiqadi. **Yo'llarni yozib oling**: 6.3-qadamda policy'ga kiradi (ayniqsa `certbot`). `pm2` shu serverda **nvm ostida** (`/root/.nvm/versions/node/v16.17.0/bin/pm2`), shuning uchun `command -v pm2` `YO'Q` deyishi mumkin: bu normal, 6.3-qadam `ip-pm2` wrapper yaratadi.
- `ss` faqat **`:3000`** ni ko'rsatadi: uni Kervan (node, PM2) ishlatyapti. **3100 bo'sh bo'lishi shart** (web shu portga chiqadi); bo'sh bo'lmasa 4-qadamda `WEB_HOST_PORT` ni boshqa bo'sh portga qo'ying. 8787/8790/8791 host'da umuman ochilmaydi (ichki tarmoq), ular ham chiqmasligi kerak.
- `getent hosts` har ikkala domen uchun: `incidentpulse.gotrips.cloud` va `kervan.uz` **shu serverning IP'si** bo'lishi kerak (yo'q bo'lsa, avval DNS A yozuvini qo'shing). `www.kervan.uz` tekshirilmaydi: birinchi chiqarishda faqat apex (`"www": false`).
- `pm2 jlist` ichida `KERVAN` va `KERVAN-REACT` ko'rinadi.
- **Kervan vhost'i BOR**, `sites-enabled` da emas, `/etc/nginx/conf.d/kervan.conf` da: `listen 80;`, `server_name kervan.uz;`, `proxy_pass http://localhost:3000/;`. **443 bloki va sertifikat yo'q**, `www.kervan.uz` `server_name` da yo'q. `sites-enabled` da faqat `default`; boshqa saytlar ham `conf.d/*.conf` da. IncidentPulse nginx'ni **faqat `nginx -T` orqali** (barcha `include`lar) o'qiydi, `sites-enabled` ga qarab emas. Shuning uchun Kervan uchun yangi vhost **yaratilmaydi**: yetishmayotgani faqat sertifikat va 443 bloki (12-bo'lim).

---

## 2. 2 GB swap qo'shish

Serverda swap yo'q: build yoki boshqa ilova RAM'ni to'ldirsa OOM-killer tasodifiy jarayonni o'ldiradi. Konteynerlar `memswap_limit = mem_limit` bilan swap ishlatmaydi, swap faqat host uchun xavfsizlik yostig'i.

```bash
swapon --show                      # bo'sh bo'lishi kerak
fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl vm.swappiness=10
echo 'vm.swappiness=10' > /etc/sysctl.d/99-incidentpulse-swap.conf
free -h
swapon --show
```

**Kutilgan natija**: `free -h` da `Swap: 2.0Gi`; `swapon --show` da `/swapfile file 2G`. Qayta yuklashdan keyin ham saqlanadi (`/etc/fstab`).

---

## 3. Repo: read-only GitHub deploy key bilan clone

```bash
install -d -m 0700 /opt/incidentpulse /opt/incidentpulse/secrets
ssh-keygen -t ed25519 -N '' -C 'incidentpulse-deploy-readonly' -f /root/.ssh/incidentpulse_deploy
cat /root/.ssh/incidentpulse_deploy.pub
```

Chiqqan **ochiq kalit**ni GitHub'da: repo → *Settings → Deploy keys → Add deploy key*. **"Allow write access" belgisini QO'YMANG.** Keyin:

```bash
export GIT_SSH_COMMAND='ssh -i /root/.ssh/incidentpulse_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new'
git clone git@github.com:shohruhinomjonov691-hub/incidentpulse.git /opt/incidentpulse/app
git -C /opt/incidentpulse/app config core.sshCommand "$GIT_SSH_COMMAND"
git -C /opt/incidentpulse/app log --oneline -1
git -C /opt/incidentpulse/app push --dry-run origin HEAD 2>&1 | tail -2
```

**Kutilgan natija**: clone muvaffaqiyatli; `log` oxirgi commit'ni ko'rsatadi; `push --dry-run` **xato** beradi (`Permission denied` / `The key you are using does not have write access`): kalit haqiqatan read-only ekanini shu tasdiqlaydi.

Aniq versiyani qotirib qo'ying (rollback uchun SHA'ni yozib oling):

```bash
cd /opt/incidentpulse/app && git rev-parse --short HEAD
```

---

## 4. Sirlar: `/opt/incidentpulse/secrets/.env`

```bash
umask 077
cat > /opt/incidentpulse/secrets/.env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 32)
APP_DB_PASSWORD=$(openssl rand -hex 32)
WEB_DB_PASSWORD=$(openssl rand -hex 32)
REDIS_PASSWORD=$(openssl rand -hex 32)
WEBHOOK_HMAC_SECRET=$(openssl rand -hex 32)
DEBATE_SHARED_SECRET=$(openssl rand -hex 32)
POSTMORTEM_SHARED_SECRET=$(openssl rand -hex 32)
APPROVAL_HMAC_SECRET=$(openssl rand -hex 32)
CALLBACK_HMAC_SECRET=$(openssl rand -hex 32)
WEB_PROXY_SECRET=$(openssl rand -hex 32)
WEB_ADMIN_PASSWORD=$(openssl rand -hex 24)
WEB_HOST_PORT=3100
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.4-mini
INCIDENT_BUDGET_USD=0.50
WEEKLY_BUDGET_USD=0.50
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALLOWED_USER_IDS=
EOF
chmod 600 /opt/incidentpulse/secrets/.env
chown root:root /opt/incidentpulse/secrets/.env
stat -c '%a %U:%G %n' /opt/incidentpulse/secrets/.env
```

**Kutilgan natija**: `600 root:root /opt/incidentpulse/secrets/.env`.

Endi qo'lda to'ldiring (`nano /opt/incidentpulse/secrets/.env`):
- `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`;
- `TELEGRAM_ALLOWED_USER_IDS`: tasdiq tugmasini bosa oladigan Telegram **user id**(lar), vergul bilan.
- `WEB_ADMIN_PASSWORD` allaqachon 48 belgilik tasodifiy; uni parol menejeriga saqlang: `grep ^WEB_ADMIN_PASSWORD /opt/incidentpulse/secrets/.env`.
- `WEB_HOST_PORT=3100`: web konteyneri host'da `127.0.0.1:3100` ga chiqadi (konteyner ichida har doim 3000). **3000 emas**: u Kervan'niki. Qiymat bo'sh yoki yo'q bo'lsa ham default 3100. Boshqa port tanlasangiz, 9-qadamdagi nginx vhost'ning `proxy_pass` porti bilan bir xil bo'lsin. Tekshirish: `ss -ltn | grep ':3100\b' || echo "bo'sh"`.

`POSTGRES_PASSWORD` migratsiyaning `incidentpulse` roliga tegishli. `APP_DB_PASSWORD` va `WEB_DB_PASSWORD` alohida runtime rollari uchun. `CALLBACK_HMAC_SECRET` Telegram/web tugmalarini imzolaydi. `APPROVAL_HMAC_SECRET` faqat orchestrator va runner'ga beriladi. `WEB_PROXY_SECRET` nginx va web orasida forwarding header'ini tasdiqlaydi.

JSON qiymatlar uchun 5-bo'limga qarang. Hamma qiymatlar to'ldirilganini tekshirish:

```bash
grep -nE '^(OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|TELEGRAM_ALLOWED_USER_IDS)=$' /opt/incidentpulse/secrets/.env || echo "to'ldirilgan"
grep -n '<' /opt/incidentpulse/secrets/.env || echo "placeholder qolmagan"
```

**Kutilgan natija**: ikkala buyruq ham `to'ldirilgan` / `placeholder qolmagan` deydi.

> Sirlar hech qachon git'ga tushmaydi: `.gitignore` da `.env.*` (faqat `.env.example` va `.env.production.example` mustasno) va `secrets/` bor.

---

## 5. Prod allowlist'lar

Ikki **mustaqil** allowlist bor: orchestrator'niki (shu bo'lim, `.env` ichida) va host runner'niki (6.3, `/etc/incidentpulse/actions-policy.json`). Runner orchestrator ruxsat bergan narsani ham rad etishi mumkin; shuning uchun ikkalasi ham kerak.

`.env` oxiriga qo'shing (`<...>` joylariga haqiqiy domen yozing, bilmaydigan loyihani butunlay olib tashlang: u poll ham, tekshiruv ham qilinmaydi):

```bash
cat >> /opt/incidentpulse/secrets/.env <<'EOF'
PROJECT_DOMAINS_JSON='{"kervan":["kervan.uz"],"codetrail":["codetrail.gotrips.cloud"],"gotrip":["<GOTRIP_DOMENI>"],"findit":["<FINDIT_DOMENI>"],"food-lens":["<FOODLENS_DOMENI>"],"camera-studio":["<CAMERA_STUDIO_DOMENI>"]}'
PROJECT_CONTAINERS_JSON='{"codetrail":["codetrail"],"food-lens":["food-lens"],"findit":["findit"],"camera-studio":["live-camera-studio"],"gotrip":["gotrip-"]}'
PROJECT_PM2_JSON='{"kervan":["KERVAN","KERVAN-REACT"]}'
PROJECT_ACTION_SCOPES_JSON='{"kervan":{"pm2":["KERVAN","KERVAN-REACT"],"nginx":true,"webroot":"/var/www/html","www":false}}'
HEALTH_POLL_URLS_JSON=
HEALTH_DEEP_JSON=
HEALTH_DEEP_INTERVAL_MIN=60
EOF
```

Nima nimani cheklaydi:

| O'zgaruvchi | Ma'nosi |
|---|---|
| `PROJECT_DOMAINS_JSON` | 6 loyiha domeni. tls/http/dns tekshiruvlari **faqat** shu domenlarga (va ularning subdomenlariga, masalan `www.`). Poller ham shularni `https://<domen>/` deb tekshiradi. Faqat apex yozing (`kervan.uz`), `www.` o'zi qamrab olinadi. |
| `PROJECT_CONTAINERS_JSON` | `docker ps/logs` ko'ra oladigan konteyner **nom prefikslari**. `gotrip-` = `gotrip-*`. |
| `PROJECT_PM2_JSON` | `pm2_list`, `pm2_logs`, `pm2_ports` ko'ra oladigan PM2 ilovalari: faqat `KERVAN`, `KERVAN-REACT`. |
| `PROJECT_ACTION_SCOPES_JSON` | Tasdiq bilan **o'zgartirish** mumkin bo'lgan narsa. Birinchi chiqarishda **faqat Kervan**: PM2 restart, nginx reload, `certbot_*`, `nginx_site_proxy`. Boshqa loyihalar faqat o'qiladi (qo'shish uchun bu yerga va 6.3 policy'ga aniq nomlarini yozing). **`www:false`** (policy, scope va 12-bo'lim bir xil): `www.kervan.uz` DNS'da ham, nginx `server_name` da ham yo'q, shuning uchun sertifikat faqat `-d kervan.uz` uchun. `www:true` qo'yilsa `www.kervan.uz` ham so'raladi va Let's Encrypt DNS'siz rad etadi. `nginx_site_proxy` Kervan uchun scope'da ruxsat etilgan, lekin Kervan vhost'i allaqachon bor: u **taklif qilinmaydi** va runner hamda root yordamchi `nginx -T` da `server_name` borligini ko'rsa qat'iy rad etadi (ikkinchi blok yaratilmaydi). |
| `HEALTH_POLL_URLS_JSON` | Bo'sh = `https://<domen>/`. Aniq health URL kerak bo'lsa: `'{"gotrip":["https://<domen>/api/health"]}'` (URL host'i loyiha domenlari ichida bo'lishi shart, aks holda start bo'lmaydi). |
| `HEALTH_DEEP_JSON` | Ixtiyoriy. Bo'sh = faqat mixed content tekshiruvi. API tekshiruvi uchun namuna: `'{"kervan":{"api":["https://kervan.uz:8443/<endpoint>"],"expect":[200,401]}}'`. `expect` yozilmasa `[200]`. API URL'ning **hostnomi loyiha domenlari ichida** bo'lishi shart (`kervan.uz:8443` mumkin, `evil.example` yoki `169.254.169.254` mumkin emas), aks holda **start bo'lmaydi** (xato loyiha nomini aytadi, URL'ni emas). |
| `HEALTH_DEEP_INTERVAL_MIN` | Deep tekshiruv oralig'i, daqiqada (default `60`; oddiy poll 15 da qoladi). `0` = deep o'chiq. |

`webroot` (`/var/www/html`) faqat `nginx_site_proxy` yaratadigan **yangi** vhost'larning `/.well-known/acme-challenge/` joyi uchun ishlatiladi (Ubuntu'da nginx default papkasi shu; tekshirish: `ls -ld /var/www/html`). Kervan sertifikati webroot'ga bog'liq emas. Tasdiqdan oldin runner vhost, DNS A, sertifikat holati va `nginx -t` ni tekshiradi. Tasdiqdan so'ng staging va real issuance nginx autentifikatoridan foydalanadi. VPS NAT ortida bo'lsa, host policy'dagi `publicIps` ro'yxatiga VPS'ning public IPv4 manzilini kiriting.

Poller qoidasi: URL `5xx`, ulanish xatosi yoki TLS xatosi bersa va 10 soniyadan keyin qayta tekshiruv ham xato bersa **Down**. `4xx` (masalan 401/404) ilovaning javobi, nosozlik emas. Tergov faqat holat **o'zgarganda** boshlanadi (ok→down, down→ok yoki birinchi ko'rishda down). O'sha holatda qolgan loyiha token ham, xabar ham sarflamaydi.

**Deep health** (LLM'siz, `$0`, har `HEALTH_DEEP_INTERVAL_MIN` daqiqada, shuningdek orchestrator ishga tushganda va **Down loyiha qaytganda darhol**): sahifa `200` bergan, lekin ishlamasligi mumkin bo'lgan holatni qidiradi. Natija **Degraded** (Down emas):

- **`mixed_content`**: bosh sahifa HTML'idagi `<script src>`, `<link href>`, `<img src>` ichida `http://`; shuningdek loyihaning o'z JS bundle'lari (har biri ≤ 5 MB, hammasi ≤ 10 MB, ko'pi bilan 20 ta, 15 s timeout; begona CDN skriptlari yuklanmaydi) ichida loyiha domenlari yoki server IP'siga yo'naltirilgan `http://...` va `ws://...`. W3C namespace'lari va begona hostlar e'tiborga olinmaydi. Bu **qator qidiruvi**: bundle ichidagi `http://kervan.uz/...` matni (masalan oddiy havola) ham topiladi, hatto so'rov yuborilmasa ham.
- **`api_down`**: `HEALTH_DEEP_JSON` dagi URL kutilgan statuslar ro'yxatida emas yoki ulanish xatosi (10 soniyadan keyin qayta tekshiruvdan so'ng).

Runbook yo'q, shuning uchun Degraded **hech qachon** tuzatish taklif qilmaydi: Telegram'ga LLM'siz qisqa xabar boradi (qaysi URL, qaysi fayl), tergov ochilmaydi. Xabar faqat o'zgarganda (yangi Degraded, yangi dalil, tiklanish) yuboriladi; o'zgarmagan Degraded kuniga (Seoul) ko'pi bilan **1 eslatma** beradi.

Byudjet: tergov boshiga `$0.50`, **haftasiga $0.50** (Dushanba 00:00 Asia/Seoul), xulosa keshi **7 kun**. Poller LLM'ni ishlatmaydi.

---

## 6. Host runner (`incidentpulse-actions`)

### 6.1 Foydalanuvchi va guruh

```bash
groupadd --system incidentpulse-ipc
useradd --system --gid incidentpulse-ipc --no-create-home --shell /usr/sbin/nologin incidentpulse-actions
id incidentpulse-actions
echo "IPC_GID=$(getent group incidentpulse-ipc | cut -d: -f3)" >> /opt/incidentpulse/secrets/.env
grep '^IPC_GID=' /opt/incidentpulse/secrets/.env
```

**Kutilgan natija**: `uid=... (incidentpulse-actions) gid=... (incidentpulse-ipc)`; `IPC_GID=<raqam>`.

### 6.2 Shaxsiy Node 24 (tizim `node`iga tegmaymiz)

Runner TypeScript'ni to'g'ridan-to'g'ri ishga tushiradi, shuning uchun Node 24 kerak. Serverdagi PM2/Kervan Node'i o'zgarmaydi.

```bash
NODE_VERSION=24.22.3
case "$(uname -m)" in x86_64) A=x64;; aarch64) A=arm64;; *) echo "noma'lum arxitektura"; false;; esac
cd /tmp
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${A}.tar.xz"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
grep " node-v${NODE_VERSION}-linux-${A}.tar.xz\$" SHASUMS256.txt | sha256sum -c -
mkdir -p /opt/incidentpulse/node
tar -xJf "node-v${NODE_VERSION}-linux-${A}.tar.xz" -C /opt/incidentpulse/node --strip-components=1
/opt/incidentpulse/node/bin/node -v
```

**Kutilgan natija**: `node-v24.22.3-linux-x64.tar.xz: OK` va `v24.22.3`.

### 6.3 Runner kodi va policy

Runner kodi **root egaligida** nusxalanadi (runner o'z kodini o'zgartira olmaydi):

```bash
rm -rf /opt/incidentpulse/actions-runner
install -d -m 0755 -o root -g root /opt/incidentpulse/actions-runner
cp -r /opt/incidentpulse/app/host/actions-runner/src /opt/incidentpulse/app/host/actions-runner/scripts /opt/incidentpulse/actions-runner/
chown -R root:root /opt/incidentpulse/actions-runner && chmod -R go-w /opt/incidentpulse/actions-runner
ls /opt/incidentpulse/actions-runner/src
```

Policy (host'ning o'z allowlist'i):

Avval `pm2` uchun wrapper. Bu serverda `pm2` nvm ostida, `sudo` esa `node` ni topa olmaydi (`PATH`); wrapper `PATH` ni o'zi qo'yadi, tizimga tegmaydi. sudoers aynan shu yo'lni yozadi:

```bash
printf '#!/bin/sh\nexport PATH="/root/.nvm/versions/node/v16.17.0/bin:$PATH"\nexec /root/.nvm/versions/node/v16.17.0/bin/pm2 "$@"\n' > /usr/local/sbin/ip-pm2
chown root:root /usr/local/sbin/ip-pm2 && chmod 755 /usr/local/sbin/ip-pm2
sudo -n -H /usr/local/sbin/ip-pm2 jlist | head -c 200; echo
```

**Kutilgan natija**: `[{"name":"KERVAN",...` (PM2 JSON ro'yxati). Keyin policy:

```bash
install -d -m 0755 /etc/incidentpulse
cp /opt/incidentpulse/app/deploy/actions-policy.example.json /etc/incidentpulse/actions-policy.json
chown root:root /etc/incidentpulse/actions-policy.json && chmod 644 /etc/incidentpulse/actions-policy.json
for b in certbot nginx systemctl docker pm2 ss ps tar; do printf '%-10s' "$b"; command -v "$b"; done
nano /etc/incidentpulse/actions-policy.json
```

Namuna bu server uchun allaqachon to'ldirilgan: `"pm2": "/usr/local/sbin/ip-pm2"` va Kervan uchun `"www": false`. `bins` ni 1-qadamdagi **haqiqiy yo'llar** bilan solishtiring va faqat default'dan farq qilganini qo'shing (masalan `"certbot": "/snap/bin/certbot"`). `sudo` sudoers aynan shu yo'llarni yozadi. `projects.kervan` ni tekshiring: `domains`, `www` (**false**), `pm2`, `webroot` 5-bo'limdagi bilan bir xil bo'lsin.

Policy to'g'riligini va sudoers'ni generatsiya qilib ko'ring:

```bash
/opt/incidentpulse/node/bin/node /opt/incidentpulse/actions-runner/scripts/render-sudoers.ts /etc/incidentpulse/actions-policy.json | head -30
```

**Kutilgan natija**: `# NN exact commands...` sarlavhasi va `/usr/local/sbin/ip-pm2 restart KERVAN`, `/usr/sbin/nginx -T`, `/usr/bin/certbot certificates`, `/usr/bin/certbot --nginx -d kervan.uz --non-interactive --redirect` kabi qatorlar (`www.kervan.uz` **yo'q**). Policy xato bo'lsa `PolicyError: ...` chiqadi (qaysi kalit xato ekanini aytadi).

### 6.4 sudoers (faqat aniq buyruqlar)

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
  /opt/incidentpulse/node/bin/node /opt/incidentpulse/actions-runner/scripts/render-sudoers.ts /etc/incidentpulse/actions-policy.json > "$sudoers_file"
  visudo -cf "$sudoers_file"
  install -m 0440 -o root -g root "$sudoers_file" /etc/sudoers.d/incidentpulse-actions
  visudo -c
)
sudo -l -U incidentpulse-actions | head -20
```

Root yaratgan vaqtinchalik katalog `0700`, render fayli `umask 077` bilan ochiladi. `visudo -cf` tekshirgan nusxa o'rnatiladi.

**Kutilgan natija**: `parsed OK` (har ikkala `visudo` da); `sudo -l` faqat ro'yxatdagi aniq buyruqlarni ko'rsatadi (`bash`, `sh`, `tee`, `rm`, `*` **yo'q**). Faqat `nginx_site_proxy` yordamchisi qatorida `[0-9]` belgi sinflari bor (4-5 xonali loopback port): yordamchi o'zi ham qayta tekshiradi.

Tekshiruv: sudoers ro'yxatida bo'lmagan buyruq rad etilishi kerak:

```bash
sudo -u incidentpulse-actions sudo -n /usr/bin/whoami; echo "exit=$?"
```

**Kutilgan natija**: `sudo: a password is required` (yoki shunga o'xshash) va `exit=1`.

### 6.5 Runner xizmati

Runner faqat `APPROVAL_HMAC_SECRET` ni biladi (token tekshirish uchun); OpenAI/Telegram kalitlari unda yo'q.

```bash
(
  set -eu
  umask 077
  install -m 0600 -o root -g root /dev/null /etc/incidentpulse/actions-runner.env
  grep '^APPROVAL_HMAC_SECRET=' /opt/incidentpulse/secrets/.env > /etc/incidentpulse/actions-runner.env
)
cp /opt/incidentpulse/app/host/actions-runner/deploy/incidentpulse-actions.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now incidentpulse-actions
sleep 2
systemctl is-active incidentpulse-actions
journalctl -u incidentpulse-actions -n 5 --no-pager
ls -l /run/incidentpulse/
```

**Kutilgan natija**: `active`; jurnalda `{"event":"listening","socketPath":"/run/incidentpulse/actions.sock","projects":["kervan"]}`; `srw-rw---- 1 incidentpulse-actions incidentpulse-ipc ... actions.sock`.

### 6.6 Runner tekshiruvi (o'qish rejimi)

```bash
S=/run/incidentpulse/actions.sock
curl -s --unix-socket $S http://localhost/v1/health; echo
curl -s --unix-socket $S -H 'content-type: application/json' -d '{"op":"pm2_jlist"}' http://localhost/v1/read; echo
curl -s --unix-socket $S -H 'content-type: application/json' -d '{"op":"pm2_ports"}' http://localhost/v1/read; echo
curl -s --unix-socket $S -H 'content-type: application/json' -d '{"op":"nginx_config"}' http://localhost/v1/read; echo
curl -s --unix-socket $S -H 'content-type: application/json' -d '{"op":"cert_list"}' http://localhost/v1/read; echo
curl -s --unix-socket $S -H 'content-type: application/json' -d '{"op":"pm2_logs","args":{"app":"BOSHQA"}}' http://localhost/v1/read; echo
```

**Kutilgan natija**
- `{"ok":true,"projects":1}`
- `pm2_jlist`: faqat `KERVAN` va `KERVAN-REACT` (boshqa PM2 ilovalari ko'rinmaydi), `status:"online"`.
- `pm2_ports`: har bir ilova uchun `ports:[...]` (masalan `{"app":"KERVAN","ports":[3000]}`). Portlarni aniqlash usuli 12-bo'limda.
- `nginx_config`: `servers:[{"names":["kervan.uz"],"listens":["80"],"ssl":false,"proxyPass":["http://localhost:3000/"]}]`: blok `conf.d/kervan.conf` dan, `nginx -T` orqali topiladi (boshqa saytlar ko'rinmaydi). `servers:[]` chiqsa, `nginx -T` kervan.uz'ni ko'rmayapti: 1-qadamdagi `cat /etc/nginx/conf.d/kervan.conf` ni tekshiring.
- `cert_list`: `certificates:[]` (kervan.uz sertifikati yo'q; boshqa domenlar sertifikatlari ko'rinmaydi).
- `pm2_logs` bilan ruxsatsiz ilova: `{"ok":false,"error":"pm2 app is not in the policy"}`.

Agar `pm2_jlist` `PM2_FAILED` bersa: `sudo -n -H /usr/local/sbin/ip-pm2 jlist` ni qo'lda sinang. Xato `node: not found` bo'lsa wrapper'dagi nvm yo'li (`/root/.nvm/versions/node/v16.17.0/bin`) noto'g'ri; xato `a password is required` bo'lsa policy'dagi `bins.pm2` sudoers'dagidan farq qiladi: 6.3 va 6.4 ni qayta bajaring, keyin `systemctl restart incidentpulse-actions`.

Token bilan himoyani tekshirish (tokensiz tasdiqlangan amal bajarilmasligi kerak):

```bash
curl -s --unix-socket $S -H 'content-type: application/json' \
  -d '{"project":"kervan","runbookId":"pm2_restart","params":{"app":"KERVAN"},"approvalId":"AAAAAAAAAAAAAAAA","incidentId":"test","approvalToken":"x","planDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tokenExpiresAt":1}' \
  http://localhost/v1/runbooks/execute; echo
pm2 jlist | grep -o '"restart_time":[0-9]*' | head -2
```

**Kutilgan natija**: `{"ok":false,"error":"Approval token is invalid"}`; `restart_time` o'zgarmagan.

---

## 7. Build

```bash
cd /opt/incidentpulse/app
export COMPOSE="docker compose --env-file /opt/incidentpulse/secrets/.env -f compose.prod.yaml"
export IP_TAG=$(git rev-parse --short HEAD)
$COMPOSE config --quiet && echo "compose OK"
$COMPOSE build
docker image ls | grep -E 'incidentpulse-(app|debate-verifier|postmortem-crew)'
```

Build ~10–20 daqiqa oladi (pnpm install, Next.js build, Python bog'liqliklari). Boshqa ilovalar sekinlashmasligi uchun kerak bo'lsa `nice -n 10 ionice -c3 $COMPOSE build`.

**Kutilgan natija**: `compose OK`; uchta imij `${IP_TAG}` tegi bilan: `incidentpulse-app`, `incidentpulse-debate-verifier`, `incidentpulse-postmortem-crew`. `intake` xizmati `incidentpulse-app` ni quradi; `orchestrator` va `web` o'sha imijni ishlatadi (qayta qurilmaydi).

---

## 8. Ishga tushirish

Avval runner ishlayotganini tekshiring (6.5), keyin:

```bash
cd /opt/incidentpulse/app
$COMPOSE up -d --wait postgres
$COMPOSE --profile migrate run --rm --no-deps migrate
$COMPOSE up -d
sleep 90
$COMPOSE ps
```

**Kutilgan natija**: Migratsiya `roles incidentpulse_app and incidentpulse_web are configured` deb chiqadi. 9 runtime xizmat `Up ... (healthy)` bo'ladi. Orchestrator adapter'ga `dockerread` orqali ulanadi. Adapter va proxy alohida `dockerproxy` tarmog'ida.

```bash
$COMPOSE logs --tail 30 orchestrator
```

**Kutilgan natija**: `orchestrator ready` qatori (`actionsEnabled: true, hostRunner: true, healthPoll: true, healthDeepEveryMinutes: 60`), keyin `health poll finished` va `deep health finished`.

Xotira va portlar:

```bash
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}'
ss -ltnp | grep -E ':(3000|3100|5432|6379|8787|8790|8791|2375)\b'
free -h
```

**Kutilgan natija**: har bir konteyner o'z limitidan past (`MemPerc` < 85%); `ss` ikkita qator ko'rsatadi: **`127.0.0.1:3100`** (IncidentPulse web, `docker-proxy` jarayoni) va Kervan'ning o'z **`:3000`** (node, PM2; unga tegmadik). Postgres/redis/intake/Python/proxy tashqarida ko'rinmaydi; `free -h` da host RAM yetarli.

---

## 9. Web: nginx vhost + certbot

Loopback upstream uchun nginx'ning proxy header'ini yarating. Nginx mijoz yuborgan `X-Forwarded-For` va `X-IncidentPulse-Proxy` qiymatlarini almashtiradi.

```bash
(
  set -eu
  umask 077
  proxy_secret="$(sed -n 's/^WEB_PROXY_SECRET=//p' /opt/incidentpulse/secrets/.env)"
  printf '%s\n' "$proxy_secret" | grep -Eq '^[a-f0-9]{64}$'
  install -m 0600 -o root -g root /dev/null /etc/nginx/snippets/incidentpulse-web-proxy.conf
  printf 'proxy_set_header X-IncidentPulse-Proxy "%s";\n' "$proxy_secret" > /etc/nginx/snippets/incidentpulse-web-proxy.conf
)
```

```bash
grep -n proxy_pass /opt/incidentpulse/app/deploy/nginx/incidentpulse.gotrips.cloud.conf     # http://127.0.0.1:3100 (WEB_HOST_PORT bilan bir xil bo'lsin)
cp /opt/incidentpulse/app/deploy/nginx/incidentpulse.gotrips.cloud.conf /etc/nginx/sites-available/incidentpulse.gotrips.cloud.conf
ln -s /etc/nginx/sites-available/incidentpulse.gotrips.cloud.conf /etc/nginx/sites-enabled/incidentpulse.gotrips.cloud.conf
nginx -t
systemctl reload nginx
curl -sI http://127.0.0.1:3100/login | head -1                                    # web to'g'ridan-to'g'ri
curl -sI -H 'Host: incidentpulse.gotrips.cloud' http://127.0.0.1/login | head -3   # nginx orqali
curl -sI -H 'Host: kervan.uz' http://127.0.0.1/ | head -1                          # Kervan o'zgarmagan bo'lishi kerak
```

**Kutilgan natija**: `nginx: configuration file ... test is successful`; `HTTP/1.1 200 OK` (yoki web hali ishga tushmagan bo'lsa `502`: `$COMPOSE ps` ni tekshiring). `WEB_HOST_PORT` ni 3100 dan boshqa qilgan bo'lsangiz, `sites-available` dagi nusxada `proxy_pass` portini avval tuzating. Uchinchi buyruq Kervan javobini beradi (u bilan hech narsa o'zgarmadi: bu vhost faqat `incidentpulse.gotrips.cloud` ga javob beradi).

Sertifikat (DNS A yozuvi shu serverga qaragan bo'lishi shart):

```bash
certbot --nginx -d incidentpulse.gotrips.cloud --redirect
nginx -t
curl -sI https://incidentpulse.gotrips.cloud/login | head -8
certbot certificates | grep -A3 incidentpulse
```

**Kutilgan natija**: `Successfully received certificate`; `HTTP/2 200` va `x-frame-options: DENY`, `x-content-type-options: nosniff`; `certbot certificates` da `incidentpulse.gotrips.cloud` va ~89 kun muddat. `http://` avtomatik `https://` ga yo'naltiriladi. Avto-yangilash: `systemctl list-timers | grep certbot` (yoki `certbot renew --dry-run`).

Brauzerda `https://incidentpulse.gotrips.cloud` → login → `WEB_ADMIN_PASSWORD` (4-qadam). Noto'g'ri parol bir necha marta urinilsa login cheklanadi.

---

## 10. To'liq tekshiruv

**a) Docker o'qish chegarasi**
```bash
$COMPOSE exec -T orchestrator node -e '
const base = process.env.DOCKER_READ_ADAPTER_URL;
for (const path of ["/containers/json?all=1", "/containers/example/json", "/containers/example/stats"]) {
  const response = await fetch(base + path);
  console.log(path, response.status);
  if (response.ok) console.log(await response.text());
}
'
```
**Kutilgan natija**: container ro'yxati `200`, nomlar allowlist prefikslariga mos, `Labels` va `Mounts` chiqmaydi. Inspect va stats `403`. `docker-proxy` orchestrator tarmog'iga ulanmagan.

**b) Orchestrator runner'ga yetadi**
```bash
$COMPOSE exec -T orchestrator node -e "require('node:http').get({socketPath:'/run/incidentpulse/actions.sock',path:'/v1/health'},r=>r.pipe(process.stdout))"; echo
```
**Kutilgan natija**: `{"ok":true,"projects":1}`.

**c) Poller (har 15 daqiqada)**
```bash
$COMPOSE logs orchestrator | grep -E 'health poll' | tail -3
```
**Kutilgan natija**: `health poll finished` qatorlari (`checked=` loyihalar soni, `changes=` o'zgarishlar). Birinchi ishga tushishda hozir Down bo'lgan loyihalar (Kervan) uchun `changes` 1 bo'ladi va Telegram'ga tergov hisoboti keladi (taxminan $0.01–0.02).

**d) Telegram**: botga `/status` yuboring.
**Kutilgan natija**: `Tergovlar: faol · pauzada 0` va `Haftalik xarajat: $0.xxxx / $0.50`. Ruxsat etilmagan foydalanuvchi buyruq yuborsa e'tiborga olinmaydi.

**e) Kill-switch**: `/stop` tergov va runner'ni pauzaga qo'yadi hamda bajarilayotgan va navbatdagi ishlarni ko'rsatadi. Joriy buyruq tugashi mumkin. Keyingi qadam pauzada boshlanmaydi. `/resume` ikkala pauzadan chiqaradi. Runner holatini Unix socket orqali `GET /v1/status` bilan tekshiring.

**f) Qo'lda tergov** (keshni chetlab o'tadi, haftalik byudjetdan ayriladi): Telegram'da `/investigate kervan`.

---

## 11. Rollback va yangilash

### Yangilash: approval, host runner va Docker o'qish chegaralari

Joriy ishlarning tugashini kuting, so'ng eski orchestrator va web'ni to'xtating. Env, runner kodi va nginx vhost nusxalarini root uchun yopiq katalogga oling. `POSTGRES_PASSWORD` qiymatini saqlang. Migratsiya reja digest'i bo'lmagan ochiq takliflarni yopib, audit'ga yozadi. Ular uchun yangi taklif kerak.

```bash
cd /opt/incidentpulse/app
export COMPOSE="docker compose --env-file /opt/incidentpulse/secrets/.env -f compose.prod.yaml"
$COMPOSE stop orchestrator web
systemctl stop incidentpulse-actions
backup="$(mktemp -d /opt/incidentpulse/secrets/before-hardening.XXXXXXXX)"
cp -a /opt/incidentpulse/secrets/.env /etc/incidentpulse/actions-runner.env "$backup/"
cp -a /opt/incidentpulse/actions-runner "$backup/runner"
cp -a /etc/nginx/sites-available/incidentpulse.gotrips.cloud.conf "$backup/"
git pull --ff-only
export IP_TAG=$(git rev-parse --short HEAD)
```

Birinchi yangilashda `APPROVAL_HMAC_SECRET` eski qiymatini `openssl rand -hex 32` bilan almashtiring. `CALLBACK_HMAC_SECRET`, `APP_DB_PASSWORD`, `WEB_DB_PASSWORD` va `WEB_PROXY_SECRET` uchun to'rtta alohida `openssl rand -hex 32` ishlating. 4-bo'limdagidek har nomga bitta qator qoldiring. 6.5-bo'limdagi blok bilan `/etc/incidentpulse/actions-runner.env` ni qayta yarating. Keyin runner kodini qayta nusxalang:

```bash
install -d -m 0755 -o root -g root /opt/incidentpulse/actions-runner
cp -r host/actions-runner/src host/actions-runner/scripts /opt/incidentpulse/actions-runner/
chown -R root:root /opt/incidentpulse/actions-runner
chmod -R go-w /opt/incidentpulse/actions-runner
```

6.4-bo'limdagi tartib bilan sudoers'ni qayta render qiling va tekshirilgan nusxani o'rnating:

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
  /opt/incidentpulse/node/bin/node /opt/incidentpulse/actions-runner/scripts/render-sudoers.ts /etc/incidentpulse/actions-policy.json > "$sudoers_file"
  visudo -cf "$sudoers_file"
  install -m 0440 -o root -g root "$sudoers_file" /etc/sudoers.d/incidentpulse-actions
  visudo -c
)
```

**Kutilgan natija**: ikkala `visudo` tekshiruvi muvaffaqiyatli. Shundan keyin runner va yangi runtime xizmatlarini ishga tushiring:

```bash
install -m 0644 host/actions-runner/deploy/incidentpulse-actions.service /etc/systemd/system/incidentpulse-actions.service
systemctl daemon-reload
systemctl restart incidentpulse-actions
systemctl is-active incidentpulse-actions
curl -fsS --unix-socket /run/incidentpulse/actions.sock http://localhost/v1/status
$COMPOSE config --quiet
$COMPOSE build
$COMPOSE up -d --wait postgres
$COMPOSE --profile migrate run --rm --no-deps migrate
$COMPOSE up -d --wait
$COMPOSE ps
```

9-bo'limdagi blok bilan nginx'ning `incidentpulse-web-proxy.conf` snippet'ini yarating. **Mavjud HTTPS vhost'ni saqlang.** Uning `location /` blokida `X-Forwarded-For` direktivasini `proxy_set_header X-Forwarded-For $remote_addr;` bilan almashtiring va undan keyin `include /etc/nginx/snippets/incidentpulse-web-proxy.conf;` ni qo'shing. `nginx -t && systemctl reload nginx` ni bajaring.

**Kutilgan natija**: runner `active`, socket status'i `paused` va navbatni ko'rsatadi. Migratsiya ikki runtime rolini tayyorlaydi. `docker-read-adapter` sog'lom, 10a tekshiruvi `200, 403, 403` beradi. HTTPS login ishlaydi. Keyingi yangi taklifda Telegram va web loyiha, aniq parametrlar va SHA-256 rejasini ko'rsatadi. `/stop` va `/resume` runner holatini ham bildiradi.

Bu yangilanishni qaytarishda eski imijlarni ishga tushirishdan avval `$backup` dan `.env`, `actions-runner.env`, runner kodi va nginx vhost'ni birgalikda tiklang. Eski runner kodi bilan 6.4 sudoers tartibini bajaring, runner'ni qayta ishga tushiring va `nginx -t && systemctl reload nginx` ni bajaring. Migratsiya yopgan eski takliflar yopiq qoladi.

### Yangilash (odatdagi tartib)
```bash
cd /opt/incidentpulse/app
git fetch origin && git log --oneline HEAD..origin/main     # nima kelayotganini ko'ring
git pull --ff-only
export IP_TAG=$(git rev-parse --short HEAD)
$COMPOSE build
$COMPOSE up -d --wait postgres
$COMPOSE --profile migrate run --rm --no-deps migrate
$COMPOSE up -d
```
**Yangilash: deep health (mixed content + API tekshiruvi)**

Bu yangilanish faqat orchestrator kodi va ikkita ixtiyoriy env o'zgaruvchisini qo'shadi. Runner, sudoers va policy **o'zgarmaydi** (6.3/6.4 kerak emas), yangi port ochilmaydi.

```bash
cd /opt/incidentpulse/app
git fetch origin && git log --oneline HEAD..origin/main
git diff --stat HEAD..origin/main -- host/        # bo'sh bo'lishi kerak: runner kodi o'zgarmagan
git pull --ff-only
export IP_TAG=$(git rev-parse --short HEAD)
```

Kervan API manzilini va uning oddiy statusini aniqlang (faqat o'qish; `<main.xxxx.js>` va `<endpoint>` ni o'zingiz topasiz):

```bash
curl -s https://kervan.uz/ | grep -o 'static/js/main[^"]*\.js'
curl -s https://kervan.uz/static/js/<main.xxxx.js> | grep -o 'kervan\.uz:8443[^" ]*' | sort -u
curl -s -o /dev/null -w '%{http_code}\n' https://kervan.uz:8443/<endpoint>      # shu kod (va 401, agar kirish talab qilinsa) "expect" ga
```

`/opt/incidentpulse/secrets/.env` ga qo'shing (JSON atrofida **bitta tirnoq**; shu nomli qator allaqachon bo'lsa, uni tahrirlang, takrorlamang):

```bash
cat >> /opt/incidentpulse/secrets/.env <<'EOF'
HEALTH_DEEP_JSON='{"kervan":{"api":["https://kervan.uz:8443/<endpoint>"],"expect":[200,401]}}'
HEALTH_DEEP_INTERVAL_MIN=60
EOF
$COMPOSE build && $COMPOSE up -d          # faqat orchestrator qayta yaratiladi
sleep 20 && $COMPOSE logs --tail 20 orchestrator | grep -E 'orchestrator ready|deep health|health poll'
```

**Kutilgan natija**: `orchestrator ready` da `healthDeepEveryMinutes: 60, healthDeepApis: 1`, so'ng `deep health finished` (`checked: 1, degraded: 0`). Hozir Kervan to'g'ri sozlangan (`https://kervan.uz:8443`), shuning uchun Telegram'ga **hech narsa** kelmasligi kerak. `HEALTH_DEEP_JSON` bo'sh bo'lsa faqat mixed content ishlaydi.

Agar orchestrator `... API URL is outside its domains` bilan yiqilsa: URL hostnomi `PROJECT_DOMAINS_JSON` dagi domen (yoki subdomen) emas; to'g'rilang, aks holda start bo'lmaydi. Sinash uchun (hech narsa o'zgarmaydi): `expect` ga atayin noto'g'ri kod (masalan `[418]`) yozib qayta ishga tushiring: taxminan 20 soniyada `🟠 Kervan — Degraded (api_down)` xabari kelishi kerak; keyin to'g'ri qiymatni qaytaring, `🟢 ... Degraded tugadi` keladi.

O'chirish/qaytarish: `HEALTH_DEEP_INTERVAL_MIN=0` (deep to'liq o'chadi) yoki `HEALTH_DEEP_JSON` ni bo'sh qoldirish (faqat API tekshiruvi o'chadi) va `$COMPOSE up -d`; yoki quyidagi "oldingi versiyaga qaytarish".

Runner kodi o'zgargan bo'lsa (`git diff --stat <eski>..HEAD -- host/`): 6.3 (nusxalash, **eskisini avval saqlang**: `cp -a /opt/incidentpulse/actions-runner /opt/incidentpulse/actions-runner.prev`), 6.4 (sudoers qayta generatsiya), keyin `systemctl restart incidentpulse-actions`.

**Servislarni oldingi versiyaga qaytarish**: eski imijlar diskda qoladi (`IP_TAG` bilan teglangan).
```bash
docker image ls | grep incidentpulse-app                      # eski teglar
git -C /opt/incidentpulse/app checkout <ESKI_SHA>
export IP_TAG=<ESKI_SHA>
$COMPOSE up -d
$COMPOSE ps
```
**Kutilgan natija**: barcha xizmatlar yana `healthy`. Ma'lumotlar (`pgdata`, `redisdata`) saqlanadi; jadvallar faqat qo'shiladi (`CREATE TABLE IF NOT EXISTS`), shuning uchun oldingi versiya ularni ko'taradi.

**Runner'ni qaytarish**
```bash
systemctl stop incidentpulse-actions
rm -rf /opt/incidentpulse/actions-runner && mv /opt/incidentpulse/actions-runner.prev /opt/incidentpulse/actions-runner
# sudoers'ni ham eski policy'dan qayta generatsiya qiling (6.4)
systemctl start incidentpulse-actions && journalctl -u incidentpulse-actions -n 3 --no-pager
```

**`nginx_site_proxy` yaratgan vhost'ni qaytarish** (avtomatik rollback faqat xato bo'lganda; keyinroq qo'lda qaytarish uchun):
```bash
ls -l /var/backups/incidentpulse/                            # har bir o'zgarishdan oldingi /etc/nginx nusxasi
rm /etc/nginx/sites-enabled/kervan.uz.conf /etc/nginx/sites-available/kervan.uz.conf
nginx -t && systemctl reload nginx
# butun /etc/nginx ni qaytarish kerak bo'lsa:
# tar -xzf /var/backups/incidentpulse/nginx-<vaqt>.tar.gz -C /etc && nginx -t && systemctl reload nginx
```
(`certbot --nginx` vhost'ga TLS qo'shgan bo'lsa, sertifikatni ham olib tashlash: `certbot delete --cert-name kervan.uz`.)

**Kervan'ning `certbot_nginx_issue` natijasini qaytarish.** Kervan vhost'ini IncidentPulse yaratmaydi: `certbot --nginx` mavjud `/etc/nginx/conf.d/kervan.conf` ni o'zi tahrirlaydi (443 bloki, sertifikat yo'llari, 80→443 redirect; qo'shilgan qatorlarda `# managed by Certbot`). 12-bo'limdagi qo'lda olingan zaxira bilan qaytariladi:
```bash
certbot delete --cert-name kervan.uz
tar -xzf /root/nginx-before-incidentpulse-<SANA>.tar.gz -C /etc && nginx -t && systemctl reload nginx
```

**Hammasini olib tashlash**
```bash
$COMPOSE down                       # ma'lumotlar qoladi; o'chirish uchun: down -v
systemctl disable --now incidentpulse-actions
rm -f /etc/sudoers.d/incidentpulse-actions /etc/systemd/system/incidentpulse-actions.service
systemctl daemon-reload && visudo -c
userdel incidentpulse-actions && groupdel incidentpulse-ipc
rm -f /etc/nginx/sites-enabled/incidentpulse.gotrips.cloud.conf && nginx -t && systemctl reload nginx
swapoff /swapfile && sed -i '\#^/swapfile #d' /etc/fstab && rm /swapfile        # faqat swap ham kerak bo'lmasa
```

---

## 12. Kervan'ni tuzatish rejasi

**Muammo (serverdan olingan haqiqiy holat)**: `kervan.uz` DNS'i shu serverga qaraydi va `/etc/nginx/conf.d/kervan.conf` da vhost **bor** (`listen 80`, `server_name kervan.uz`, `proxy_pass http://localhost:3000/`), lekin **443 bloki va sertifikat yo'q**. `https://kervan.uz/` ga kirganda nginx 443 da `kervan.uz` uchun blok topa olmaydi: boshqa saytning default serveri javob beradi (boshqa domen sertifikati, ya'ni TLS hostname mismatch) yoki ulanish rad etiladi. Sayt PM2 ostida ishlayapti (`KERVAN`, `KERVAN-REACT`, port 3000), `http://` ishlaydi. Boshqa saytlar ham `/etc/nginx/conf.d/*.conf` da; ularga tegilmaydi.

**Yechim**: yangi vhost **kerak emas**. Kerak narsa: mavjud blokka `listen 443 ssl` + sertifikat + 80→443 redirect. Buni `certbot --nginx -d kervan.uz --redirect` qiladi, va u aynan **bitta** tasdiqlanadigan runbook: `certbot_nginx_issue`. Birinchi chiqarishda `www.kervan.uz` yo'q (DNS ham, `server_name` ham), shuning uchun policy, scope va bu bo'lim **`"www": false`**: faqat `-d kervan.uz`.

**Oldindan shartlar** (bir marta, qo'lda):
```bash
getent hosts kervan.uz                        # shu serverning IP'si (www.kervan.uz kerak emas)
cat /etc/nginx/conf.d/kervan.conf             # 1-qadamdagidek: faqat listen 80, server_name kervan.uz
nginx -T 2>/dev/null | grep -nE 'server_name[^;]*kervan'   # aynan BITTA qator (ikkinchi blok bo'lmasin)
ls /etc/letsencrypt/accounts/ 2>/dev/null     # certbot akkaunti bor (yo'q bo'lsa: certbot register --agree-tos -m <email>)
certbot plugins 2>&1 | grep -i nginx          # nginx plagini bor
ss -ltn | grep -E ':(80|443)\b'               # nginx ikkala portda tinglaydi; ufw/firewall'da 80 va 443 ochiq
curl -sI http://127.0.0.1 -H 'Host: kervan.uz' | head -1       # Kervan javobi (http)
( umask 077; tar -czf /root/nginx-before-incidentpulse-$(date +%F).tar.gz -C /etc nginx )   # zaxira (qaytarish: 11-bo'lim)
```
`certbot_nginx_issue` `/etc/nginx` zaxirasini o'zi olmaydi (zaxirani faqat `nginx_site_proxy` yordamchisi oladi): `certbot --nginx` konfiguratsiyani xatoda o'zi qaytaradi, lekin yuqoridagi qo'lda zaxira ikkinchi himoya.

**Zanjir: bitta tasdiq.**

| # | Kim | Nima | Siz ko'radigan narsa |
|---|---|---|---|
| 1 | Poller (≤15 daq) | `https://kervan.uz/` ga GET → TLS/ulanish xatosi → 10 s dan keyin qayta tekshiruv → **Down** (holat o'zgardi) | `health poll finished ... changes=1` |
| 2 | Orchestrator | Qat'iy (LLM'siz) probe: `http_probe`, `tls_inspect`, `pm2_list` → tergov (kesh yo'q) | – |
| 3 | Infra mutaxassisi | `nginx_config` (`nginx -T`, barcha include'lar) → `kervan.uz vhost=present listen=80 ssl=false proxy=http://localhost:3000/`; `cert_list` → `kervan.uz cert=missing`; `tls_inspect` → `hostnameMatch=false` yoki ulanish xatosi | Dalil qatorlari |
| 4 | Logs mutaxassisi | `pm2_list` (ikkalasi `online`), `pm2_ports` → `KERVAN ports=3000…` | – |
| 5 | Debate verifier | Gipoteza "kervan.uz uchun 443 blok va sertifikat yo'q" ishonch ≥ 0.7 | – |
| 6 | Taklif | Ishonchli (LLM'siz) **inventar** (runner, `nginx -T` + `certbot certificates`): vhost **bor**, sertifikat **yo'q** → faqat `certbot_nginx_issue(kervan.uz)`. **`nginx_site_proxy` taklif qilinmaydi** (runner va root yordamchi ham `server_name` bor bo'lsa qat'iy rad etadi). Dry-run: runner vhost, DNS A, sertifikat holati va `nginx -t` ni tekshiradi | **Telegram**: `Taklif: certbot_nginx_issue(kervan.uz) · medium · dry-run ✅` + [✅ Bajar] [❌ Rad et] [🔍 Batafsil] |
| 7 | **Siz** | `🔍 Batafsil` bilan dalil va dry-run'ni o'qing, keyin **✅ Bajar** | `Tasdiqlandi.` |
| 8 | Runner | Token (HMAC, 15 daq, bir martalik) → inventar yana tekshiriladi → `certbot certonly --dry-run --non-interactive --nginx -d kervan.uz` (staging) → muvaffaqiyatli bo'lsa `certbot --nginx -d kervan.uz --non-interactive --redirect` (mavjud `conf.d/kervan.conf` blokiga 443 + sertifikat, va 80→443 redirect) → `nginx -t` | Natija `Batafsil` da |
| 9 | Recovery tekshiruvi | `https://kervan.uz/` → 200 → **recovered** | **Telegram: 🟢 tiklandi**, postmortem havolasi |
| 10 | Postmortem crew | Researcher → Reviewer → Writer, web'da `/postmortems/<id>` | – |

Bitta tergov, bitta tasdiq: oldingi reja (vhost yaratish + sertifikat, ikki tasdiq) endi kerak emas. Xarajat bir tergov va bir postmortem; RESUME.md dagi sandbox o'lchovlari bo'yicha ~$0.01–0.02 (haqiqiy serverda hali o'lchanmagan; haftalik $0.50 chegarasi ichida). Tasdiqsiz hech narsa o'zgarmaydi; taklif 60 daqiqada muddati o'tadi, token 15 daqiqa amal qiladi.

**Tekshiruv** (zanjirdan keyin yoki qo'lda):
```bash
curl -sI https://kervan.uz/ | head -3                       # HTTP/2 200
curl -sI http://kervan.uz/ | head -3                        # 301 -> https://kervan.uz/
certbot certificates | grep -A3 'Certificate Name: kervan.uz'
grep -n 'managed by Certbot' /etc/nginx/conf.d/kervan.conf   # certbot qo'shgan qatorlar
curl -sI https://incidentpulse.gotrips.cloud/login | head -1    # boshqa saytlar buzilmagan
```

### KERVAN va KERVAN-REACT portlarini qanday aniqlaymiz

Hozirgi zanjirda Kervan uchun `upstream` kerak emas (vhost allaqachon bor va `localhost:3000` ga yo'naltirilgan). Port aniqlash baribir dalil sifatida (`pm2_ports`) va kelajakda `nginx_site_proxy` kerak bo'lgan boshqa loyiha uchun ishlaydi. Tizim portni **taxmin qilmaydi va modelga topshirmaydi**. Host runner (`pm2_ports`, faqat policy'dagi PM2 ilovalari uchun) quyidagicha hisoblaydi:

1. `pm2 jlist` → har bir ilovaning `pid` si va holati (faqat `online` ilovalar port egasi bo'ladi).
2. `ps -eo pid=,ppid=` → shu `pid` ning **barcha avlodlari** (PM2 ko'pincha `npm start`/`sh -c` ni ishga tushiradi, haqiqiy server esa uning bolasi).
3. `ss -H -ltnp` → ro'yxatdagi TCP tinglovchilar. Egasi shu pid-daraxtda bo'lgan va `127.0.0.1` orqali yetib boriladigan (`0.0.0.0`, `127.0.0.1`, `[::]`) portlar ilovaning portlari.
4. Natija `127.0.0.1:PORT` ro'yxati: `nginx_site_proxy` taklif qilinganda **`upstream` qiymatlarining to'liq ro'yxati**. Model boshqa port tanlay olmaydi (tanlasa taklif rad etiladi).
5. Runner dry-run'da va bajarishdan oldin **yana** tekshiradi: port aynan shu loyihaning PM2 ilovasiga tegishli va `GET http://127.0.0.1:PORT/` `5xx` bermayapti. Yordamchi (root) esa portda haqiqatan tinglovchi borligini va `127.0.0.1` ekanini qayta tekshiradi.

Qo'lda tasdiqlash (har ikkala ilova uchun):
```bash
P=/root/.nvm/versions/node/v16.17.0/bin/pm2
$P jlist | grep -E '"name":"KERVAN(-REACT)?"|"pid":' | head
PIDS=$($P pid KERVAN; $P pid KERVAN-REACT)
ss -H -ltnp | grep -E "pid=($(echo $PIDS | tr ' ' '|'))\b"      # to'g'ridan-to'g'ri egasi bo'lsa
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
curl -s http://127.0.0.1:3000/ | head -c 300
```
(`ss` da bola jarayon pid'i chiqsa, `pstree -p <PM2_PID>` bilan bog'lang; runner buni avtomatik qiladi.)

**Cheklov**: `nginx_site_proxy` faqat vhost **yo'q** domen uchun va bitta `upstream` ga proksilaydi. Mavjud blokni (Kervan'niki kabi) u hech qachon o'zgartirmaydi.

**Agar zanjir to'xtasa** (hech narsa buzilmaydi, escalate qiladi):
- Dry-run `nginx already has a server block … but none names www.kervan.uz` → policy yoki scope'da `"www": true` qolib ketgan: ikkalasida `false` qiling (6.3, 5-bo'lim), runner'ni qayta ishga tushiring va orchestrator'ni qayta yarating (`$COMPOSE up -d --force-recreate orchestrator`).
- Dry-run `No nginx server block for kervan.uz; create the vhost first` → `nginx -T` `kervan.uz` ni ko'rmayapti (blok include qilinmagan?): `nginx -T | grep -n server_name`. `nginx_site_proxy` taklif qilinganini ko'rsangiz, ya'ni inventar vhost yo'q deb hisoblayapti: shu buyruq natijasini va 6.6 dagi `nginx_config` ni solishtiring.
- Dry-run `Certificates for these names already exist; use certbot_renew` → sertifikat allaqachon bor (`certbot certificates`); muammo boshqa joyda.
- Tasdiqdan keyingi staging `certbot ... --dry-run` xato → DNS A yozuvi shu serverga qaramaydi, 80-port firewall'da yopiq yoki Let's Encrypt staging limiti: `/var/log/letsencrypt/letsencrypt.log`. Dry-run webroot emas, nginx autentifikatori bilan ishlaydi (bu vaqtda certbot `conf.d/kervan.conf` ga vaqtincha challenge location qo'shib, nginx'ni reload qiladi va keyin qaytaradi; Kervan vhost'ida ACME location yo'q, shuning uchun webroot usuli ishlamas edi).
- Bajarishda xato → certbot konfiguratsiyani o'zi qaytaradi; `nginx -t` ni tekshiring, kerak bo'lsa 11-bo'limdagi qo'lda zaxiradan tiklang.
- Telegram'da tugma bosilmasa: 60 daqiqadan keyin `tasdiqlash muddati tugadi, inson ko'rigi kutilmoqda`; `/investigate kervan` bilan qayta boshlang.

---

## 13. Muammolar

| Belgi | Sabab va yechim |
|---|---|
| Poller hamma loyihani Down deydi (`ETIMEDOUT`) | Konteynerdan host'ning ommaviy IP'siga chiqish UFW tomonidan to'silgan. `ufw allow from 172.16.0.0/12 to any port 80,443 proto tcp`; tekshirish: `$COMPOSE exec orchestrator wget -qO- --spider https://kervan.uz/` |
| `orchestrator` `unhealthy` | `heartbeat` yangilanmayapti: `$COMPOSE logs --tail 100 orchestrator`. Odatda `.env` dagi noto'g'ri JSON (ConfigError nom bilan aytadi, qiymatni emas). |
| `IPC_GID` xatosi | `.env` da `IPC_GID=` bo'sh: 6.1. |
| Orchestrator socket'ga ulana olmaydi (`EACCES`) | `ls -ln /run/incidentpulse` dagi gid `IPC_GID` ga teng bo'lishi kerak; `docker compose up -d --force-recreate orchestrator`. |
| `pm2_*` `PM2_FAILED` | 6.6 oxiridagi `ip-pm2` yechimi. |
| `sudo: a password is required` runner jurnalida | policy `bins` yo'li sudoers'dagidan farq qiladi: 6.3 va 6.4 ni qayta bajaring. |
| `docker compose ps` da `docker-proxy` unhealthy | Imij tegi mavjud emas bo'lsa `docker pull tecnativa/docker-socket-proxy:0.3.0`; boshqa tegni `compose.prod.yaml` da yangilang. |
| Web `502` | `$COMPOSE ps web`, `curl -sI http://127.0.0.1:3100/login` (yoki `WEB_HOST_PORT` dagi port). nginx `proxy_pass` porti shu portga teng bo'lishi shart. |
| `$COMPOSE up` da `bind: address already in use` (web) | Host'dagi `WEB_HOST_PORT` (default 3100) band: `ss -ltnp \| grep ':3100\b'`. Boshqa bo'sh portni `.env` ga `WEB_HOST_PORT=<port>` deb yozing, nginx vhost'dagi `proxy_pass` ni o'sha portga o'zgartiring, `$COMPOSE up -d web && nginx -t && systemctl reload nginx`. **3000 ni tanlamang**: u Kervan'niki. |
