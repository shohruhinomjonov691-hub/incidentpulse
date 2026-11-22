# IncidentPulse xavfsizlik review’i

2026-11-22 · tekshirilgan commit `628105f6068ddeb5ada9a92ba867e1f6bb0e1687`

**Natija.** 4 ta High, 9 ta Medium, 1 ta Low. Eng muhimlari — sudoers’ni o‘rnatishdagi vaqtinchalik fayl, web va Postgres bilan bo‘lishilgan ijro vakolati, tasdiqsiz holatni o‘zgartiradigan dry-run hamda Docker proxy’ning keng o‘qish ruxsati. Ko‘rilgan koddan Internet orqali shartsiz root ijro zanjiri yoki Critical topilma aniqlanmadi.

Review repo kodi, namunaviy host policy, Compose va deploy hujjatlariga asoslangan. `CASE_STUDY.md` birinchi production deploy uchun `0eaa635` ni ko‘rsatadi, deep-health yangilanishi haqidagi qayd esa o‘sha paytda VPS’da hali ishlamaganini aytadi. Joriy VPS versiyasi, haqiqiy policy va sudoers, socket egaligi, firewall hamda TLS holati tekshirilmadi. Namunaviy policy’dan sudoers lokal render qilindi. `sudo`, runbook va production so‘rovlari bajarilmadi. [CASE_STUDY.md:17](CASE_STUDY.md#L17) · [CASE_STUDY.md:160](CASE_STUDY.md#L160)

## High

### H1. Sudoers o‘rnatilishi umumiy `/tmp` dagi faylga ishonadi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** Deploy root nomidan oldindan ma’lum `/tmp` yo‘liga yozadi. `visudo` va `install` shu yo‘lni alohida ochadi. Agar yo‘l yoki faylni mahalliy kam huquqli foydalanuvchi boshqara olsa, root o‘rnatadigan mazmun tekshirilgan mazmundan farq qilishi va root vakolati kengayishi mumkin. Ta’sir deploy yoki policy yangilanishi vaqtida yuzaga keladi. Ubuntu’ning sticky directory himoyasi va symlink hamda regular-file sysctl sozlamalari ehtimolni kamaytirishi mumkin. Ularning VPS’dagi qiymatlari tekshirilmagan.

**Tuzatish.** Faylni root’ga tegishli `0700` katalogda `umask 077` bilan yarating. Aynan shu nusxani `visudo` bilan tekshirib, root’ga tegishli yakuniy katalogga atomik o‘rnating. Birinchi deploy va qayta generatsiya uchun bir xil tartibni hujjatlashtiring. [docs/DEPLOY.md:282](DEPLOY.md#L282) · [docs/DEPLOY.md:510](DEPLOY.md#L510)

### H2. Web va Postgres approval chegarasini mustaqil himoya qilmaydi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** Prod `web` va `orchestrator` bir Postgres bootstrap rolidan va bir `APPROVAL_HMAC_SECRET` qiymatidan foydalanadi. Web’ga callback yaratish kerak, lekin unga berilgan kalit runner ijro tokenining ham imzolash kaliti. Orchestrator esa `approved` qatorning joriy `runbookId` va `params` qiymatlarini imzolaydi. Callback imzosi faqat ID va qaror amaliga bog‘langan. Web jarayoni yoki shu DB yozish vakolati komprometatsiyasida approval holati va asl ko‘rsatilgan amalning yaxlitligi yo‘qoladi. Orchestrator ishlayotgan bo‘lsa, o‘zgartirilgan approval uning normal ijro oqimiga kirishi mumkin. Runner’ning o‘z allowlist’i saqlanadi. Faqat web kalitiga ega bo‘lishning o‘zi socket’ga tarmoq yo‘lini bermaydi.

**Tuzatish.** Callback va ijro kalitlarini ajrating. Web’ga cheklangan qaror API yoki DB roli bering. Alohida migratsiya roli ishlating. Approval’ni loyiha, runbook, normallashtirilgan parametrlar va policy versiyasining o‘zgarmas digest’iga bog‘lang. Runner faqat qarorni tasdiqlash vakolatiga ega mustaqil signer imzosini tekshirsin. [compose.prod.yaml:50](../compose.prod.yaml#L50) · [compose.prod.yaml:180](../compose.prod.yaml#L180) · [compose.prod.yaml:244](../compose.prod.yaml#L244) · [mcp/actions/src/approvals.ts:70](../mcp/actions/src/approvals.ts#L70) · [mcp/actions/src/approvals.ts:196](../mcp/actions/src/approvals.ts#L196) · [mcp/actions/src/approvals.ts:238](../mcp/actions/src/approvals.ts#L238) · [mcp/actions/src/approvals.ts:296](../mcp/actions/src/approvals.ts#L296) · [apps/orchestrator/src/graph.ts:747](../apps/orchestrator/src/graph.ts#L747)

### H3. `certbot_nginx_issue` dry-run’i approval’dan oldin nginx’ni o‘zgartiradi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** Graph dry-run’ni approval qatorini yaratishdan oldin ishlatadi. Runner dry-run uchun IPC ruxsatiga va host policy’ga tayanadi. `certbot --nginx` autentifikatori challenge uchun live nginx konfiguratsiyasini vaqtincha tahrirlaydi va nginx’ni reload qiladi, so‘ng o‘zgarishni qaytaradi. Mos vhost mavjud va sertifikat yetishmasa, bu o‘zgarishlar inson qarorisiz sodir bo‘lishi mumkin. IPC mijozi takroriy dry-run bilan nginx va ACME resurslarini band qila oladi. Jarayon uzilsa, staging o‘zgarishlarining tozalanishi Certbot’ga bog‘liq.

**Tuzatish.** Approval oldidan inventar va statik konfiguratsiya tekshiruvi bilan cheklaning yoki staging’ni izolyatsiya qiling. Live nginx’ga tegadigan barcha qadamlarni tasdiq va audit ortiga o‘tkazing. Dry-run endpoint’iga navbat limiti va alohida ruxsat bering. [apps/orchestrator/src/graph.ts:676](../apps/orchestrator/src/graph.ts#L676) · [host/actions-runner/src/commands.ts:104](../host/actions-runner/src/commands.ts#L104) · [host/actions-runner/src/server.ts:265](../host/actions-runner/src/server.ts#L265) · [host/actions-runner/src/server.ts:349](../host/actions-runner/src/server.ts#L349) · [docs/DEPLOY.md:631](DEPLOY.md#L631)

### H4. Docker proxy barcha konteynerlar uchun keng o‘qish ruxsatini beradi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** `POST=0` bilan birga butun `CONTAINERS=1` API guruhi yoqilgan. Docker loyihasi bo‘yicha filtr faqat MCP kodida ishlaydi. `dockerapi` tarmog‘ida to‘g‘ridan-to‘g‘ri proxy’ga murojaat qila oladigan jarayon MCP filtridan tashqarida boshqa konteynerlarning inspect metama’lumotlari, env sirlari, loglari va o‘qishga ruxsat berilgan fayl ma’lumotlariga yetishi mumkin. Bu credential exposure va yonlama kirish xavfi. Raw Docker socket proxy konteynerining o‘ziga ulangan. Shu konteyner komprometatsiyasida `:ro` Unix socket orqali yuboriladigan Docker API amallarini cheklamaydi.

**Tuzatish.** Faqat zarur list va logs operatsiyalarini beradigan adapter ishlating. Adapter konteyner ID’sini ruxsat etilgan loyiha bilan bog‘lasin va inspect, archive hamda boshqa umumiy `/containers/` operatsiyalarini rad etsin. Imkon bo‘lsa, loglarni xostdan alohida eksport qiling va umumiy Docker socket’ni monitoring xizmatiga bermang. [compose.prod.yaml:99](../compose.prod.yaml#L99) · [compose.prod.yaml:224](../compose.prod.yaml#L224) · [compose.prod.yaml:338](../compose.prod.yaml#L338) · [mcp/infra/src/tools/docker.ts:53](../mcp/infra/src/tools/docker.ts#L53) · [mcp/infra/src/tools/docker.ts:95](../mcp/infra/src/tools/docker.ts#L95)

## Medium

### M1. Runner navbatda turgan approval muddatini qayta tekshirmaydi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** HMAC va expiry navbatga kirishdan oldin tekshiriladi. Uzoq Certbot ishlari yoki takroriy dry-run’lar ortida so‘rov kutsa, muddati tugagan ish ledger’da claim qilinib boshlanishi mumkin. Endpoint navbat uzunligini cheklamaydi va HTTP client uzilganda allaqachon navbatga olingan ish avtomatik bekor bo‘lmaydi.

**Tuzatish.** Navbatdan ish olinganda va birinchi o‘zgartiruvchi qadam oldidan expiry’ni tekshiring. Navbat va IPC mijozlari uchun limit, request cancellation hamda rad etilgan ishlar auditi qo‘shing. [host/actions-runner/src/server.ts:56](../host/actions-runner/src/server.ts#L56) · [host/actions-runner/src/server.ts:275](../host/actions-runner/src/server.ts#L275) · [host/actions-runner/src/server.ts:389](../host/actions-runner/src/server.ts#L389) · [host/actions-runner/src/token.ts:36](../host/actions-runner/src/token.ts#L36)

### M2. Telegram `/stop` runner’ga yuborilgan ishlarni to‘xtatmaydi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** Bot Redis flag qo‘yadi. Orchestrator resume, graph va `execute_runbook` kirishida flag’ni ko‘radi. Ammo oxirgi check va runner’ga jo‘natish orasida DB amali bor. Runner navbatida yoki ichida flag tekshiruvi yo‘q. Operator `/stop` tasdig‘ini ko‘rgandan keyin ham oldin jo‘natilgan runbook boshlanishi yoki qolgan qadamlarini bajarishi mumkin.

**Tuzatish.** Runner’da mustaqil pause holati bo‘lsin. Uni navbatdan chiqishda va xavfsiz qadam chegaralarida tekshiring. `/stop` javobi navbatdagi va bajarilayotgan ishlar holatini ko‘rsatsin. Allaqachon boshlagan Certbot yoki nginx o‘zgarishini to‘xtatishda rollback yakunlanishini hisobga oling. [apps/telegram-bot/src/investigate.ts:36](../apps/telegram-bot/src/investigate.ts#L36) · [apps/orchestrator/src/action-flow.ts:22](../apps/orchestrator/src/action-flow.ts#L22) · [apps/orchestrator/src/continuations.ts:14](../apps/orchestrator/src/continuations.ts#L14) · [mcp/actions/src/server.ts:134](../mcp/actions/src/server.ts#L134) · [host/actions-runner/src/server.ts:298](../host/actions-runner/src/server.ts#L298)

### M3. Root helper loyiha upstream’ini mustaqil tekshirmaydi

Status: deferred (single-admin VPS)

**Shart va ta’sir.** Runner PM2 PID daraxti va loopback HTTP orqali portning loyihaga tegishliligini tekshiradi. Sudoers root helper’ni port andozasi bilan ochadi. Helper o‘zi faqat domen, port diapazoni va TCP tinglovchini tekshiradi. Runner Unix akkaunti komprometatsiyasida sudoers doirasida root helper orqali ichki xizmatni yangi ommaviy vhost’ga ulash mumkin bo‘lib qoladi. Standart yo‘lda ham PID/port tekshiruvi va reload orasida listener almashishi mumkin. Case study’dagi Kervan domenining exact vhost’i mavjudligi bu holatni shu domen uchun to‘sadi. `nginx -T` tahlilida mavjudlik exact nom bo‘yicha tekshirilgani sababli wildcard yoki regex vhost ishlatiladigan muhitlarda routing o‘zgarishi ham mumkin.

**Tuzatish.** Root helper’da ham domen, loyiha va upstream bog‘lanishini tekshiring. Imkon bo‘lsa, oldindan belgilangan port yoki loyiha Unix socket’idan foydalaning. Bir xil host lock ostida config va listener’ni qayta tekshiring. Wildcard hamda regex vhost semantikasini hisobga oling va rollback’ni aynan shu ish yaratgan fayllar bilan cheklang. [host/actions-runner/src/server.ts:152](../host/actions-runner/src/server.ts#L152) · [host/actions-runner/src/commands.ts:251](../host/actions-runner/src/commands.ts#L251) · [host/actions-runner/src/nginx-site.ts:104](../host/actions-runner/src/nginx-site.ts#L104) · [host/actions-runner/src/nginx-site.ts:163](../host/actions-runner/src/nginx-site.ts#L163) · [docs/CASE_STUDY.md:54](CASE_STUDY.md#L54)

### M4. Ijro tokeni yakuniy host qadamlarini to‘liq bog‘lamaydi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** Imzo runbook ID va request parametrlarini qoplaydi. Host policy’dan keladigan `www`, webroot, Compose fayli va binar yo‘llari imzolanmaydi. Runner so‘rov kelganda qadamlarni joriy policy’dan qayta hisoblaydi. Operator policy’ni tasdiq jarayonida yangilasa yoki orchestrator va host konfiguratsiyasi farqlansa, tasdiqlangan domen va runbook amalda boshqa scope’ga ega bo‘lishi mumkin. Web tasdiq kartasida parametrlar alohida chiqarilmaydi. `nginx_site_proxy` dry-run xulosasi ayrim qiymatlarni ko‘rsatadi, boshqa runbook’larda ko‘rinish command output’iga bog‘liq.

**Tuzatish.** Runner qaytargan canonical reja va policy digest’ini proposal, web/Telegram tasdiqi, token va ijroga bog‘lang. Har ikki UI’da aniq target va parametrlarni ko‘rsating. Reja yoki policy o‘zgarsa, yangi tasdiq talab qiling. [host/actions-runner/src/token.ts:22](../host/actions-runner/src/token.ts#L22) · [host/actions-runner/src/commands.ts:59](../host/actions-runner/src/commands.ts#L59) · [host/actions-runner/src/commands.ts:169](../host/actions-runner/src/commands.ts#L169) · [host/actions-runner/src/server.ts:228](../host/actions-runner/src/server.ts#L228) · [apps/web/src/app/(admin)/incidents/[id]/page.tsx:49](../apps/web/src/app/%28admin%29/incidents/%5Bid%5D/page.tsx#L49)

### M5. Ishonchsiz dalil ruxsat etilgan runbook tanloviga ta’sir qiladi

Status: deferred (single-admin VPS)

**Shart va ta’sir.** Log, Codetrail excerpt va commit matni regex bilan filtrlanadi, so‘ng dalil sifatida modelga boradi. Grounding guardrail iqtibos ID’si mavjudligini tekshiradi. U matndan chiqarilgan sababning to‘g‘riligini isbotlamaydi. Masalan, `certbot_renew` kandidati uchun expiry belgisi istalgan dalil excerpt’idan olinadi. Log matnini, commit’ni yoki probed endpoint’ning ayrim metadata qiymatlarini boshqaradigan tomon xulosani va ruxsatli runbook taklifini chalg‘itishi mumkin. Noto‘g‘ri taklifning oddiy ijrosi uchun inson tasdig‘i va runner policy talab qilinadi. Live Certbot dry-run istisnosi H3’da qayd etilgan. `compose.prod.yaml` CodeTrail/GitHub credential’larini uzatmaydi, shu sabab commit yo‘li bu deploy namunasida konfiguratsiyaga bog‘liq.

**Tuzatish.** Restart, reload va sertifikat amallariga nomzodlarni typed, qayta o‘lchangan faktlardan deterministik chiqaring. TLS expiry uchun sertifikat inventari yoki strukturali TLS o‘lchoviga tayaning. Model xulosasi bilan operator qaroriga asos bo‘lgan faktlarni UI’da aniq belgilang. [apps/orchestrator/src/guardrails.ts:19](../apps/orchestrator/src/guardrails.ts#L19) · [apps/orchestrator/src/guardrails.ts:172](../apps/orchestrator/src/guardrails.ts#L172) · [apps/orchestrator/src/evidence.ts:94](../apps/orchestrator/src/evidence.ts#L94) · [apps/orchestrator/src/evidence.ts:157](../apps/orchestrator/src/evidence.ts#L157) · [apps/orchestrator/src/remediation-proposer.ts:41](../apps/orchestrator/src/remediation-proposer.ts#L41) · [apps/orchestrator/src/remediation-proposer.ts:124](../apps/orchestrator/src/remediation-proposer.ts#L124)

### M6. HTTP va TLS allowlist’i ulanish IP’sini cheklamaydi

Status: deferred (single-admin VPS)

**Shart va ta’sir.** HTTP redirect’larning har bir bosqichida hostname va port tekshiriladi. Shu tekshiruv ruxsatli subdomenlarni ham qamraydi. HTTP va TLS klientlari DNS natijasi yoki haqiqiy ulanish IP’sini private, loopback va link-local manzillarga nisbatan tekshirmaydi. Ruxsatli DNS nomini yoki tegishli redirect’ni boshqara oladigan tomon orchestrator tarmog‘idan ichki HTTP GET yoki TLS handshake yuzaga kelishiga sabab bo‘lishi mumkin. Oddiy `http_probe` body’ni bekor qiladi, lekin status va redirect metama’lumotlari chiqadi. Deep health body’ni limit bilan o‘qiydi va URL topilmalarini xabarga uzatadi.

**Tuzatish.** Har ulanish va redirect uchun DNS natijasini egress policy bo‘yicha tekshiring va socket’ni tasdiqlangan IP’ga bog‘lang. TLS SNI hamda Host nomini saqlang. Ichki tarmoqdagi kerakli maqsadlar uchun alohida exact opt-in qo‘llang. [mcp/infra/src/allowlist.ts:35](../mcp/infra/src/allowlist.ts#L35) · [mcp/infra/src/tools/http.ts:45](../mcp/infra/src/tools/http.ts#L45) · [mcp/infra/src/tools/tls.ts:99](../mcp/infra/src/tools/tls.ts#L99) · [apps/orchestrator/src/deep-health.ts:118](../apps/orchestrator/src/deep-health.ts#L118)

### M7. Login limiti bitta global hisoblagich orqali adminni bloklaydi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** Hamma manbalar bitta Redis kalitida 15 daqiqaga 8 ta urinishni bo‘lishadi. Hisoblagich parol tekshiruvidan oldin ishlaydi. Internetdan parolga ega bo‘lmagan mijoz shu umumiy limitni band qilsa, to‘g‘ri parol bilan yangi session ochish ham `429` oladi. `Origin` tekshiruvi brauzer CSRF’ini cheklaydi. Brauzerdan tashqari mijoz HTTP origin header’ini belgilay oladi. Amaldagi session’lar ta’sirlanmaydi.

**Tuzatish.** Ishonchli reverse proxy tasdiqlagan manba identitetiga asoslangan limit, progressive backoff va global yuk himoyasini qo‘llang. Global himoya qonuniy operatorning favqulodda login yo‘lini to‘smasin. [apps/web/src/app/api/session/route.ts:12](../apps/web/src/app/api/session/route.ts#L12) · [apps/web/src/server/store.ts:50](../apps/web/src/server/store.ts#L50) · [apps/web/src/server/session.ts:46](../apps/web/src/server/session.ts#L46)

### M8. Umumiy Redis credential `/stop` va queue vakolatini bo‘lishadi

Status: deferred (single-admin VPS)

**Shart va ta’sir.** Intake, web va orchestrator bir Redis parolini ishlatadi. Prod konfiguratsiyasida ular uchun ACL chegarasi ko‘rsatilmagan. Intake yoki web jarayoni komprometatsiyasida Redis orqali pause holati, BullMQ navbati va byudjet hisobiga ta’sir qilish mumkin. Intake HTTP’dagi webhook HMAC navbatga Redis orqali bevosita yozishni himoyalamaydi. Bu approval qarori yoki host tokenini o‘zi bermaydi.

**Tuzatish.** Har servisga alohida Redis ACL user va zarur command/key huquqlarini bering. Intake’ning enqueue vakolatini va web’ning login/byudjet vakolatini action controls’dan ajrating. Zarur bo‘lsa qo‘shma queue yozish huquqini broker API bilan cheklang. [compose.prod.yaml:75](../compose.prod.yaml#L75) · [compose.prod.yaml:153](../compose.prod.yaml#L153) · [compose.prod.yaml:180](../compose.prod.yaml#L180) · [compose.prod.yaml:244](../compose.prod.yaml#L244) · [apps/intake/src/server.ts:39](../apps/intake/src/server.ts#L39) · [apps/orchestrator/src/worker.ts:141](../apps/orchestrator/src/worker.ts#L141) · [apps/orchestrator/src/action-flow.ts:22](../apps/orchestrator/src/action-flow.ts#L22)

### M9. Log va dry-run chiqishida redaction to‘liq qo‘llanmaydi

Status: fixed (`f72ea26`)

**Shart va ta’sir.** Host va Docker loglari satrni avval qisqartiradi, so‘ng redaction qiladi. Bu uzun secret yoki ko‘p qatorli private key’ni to‘liq shakliga mos pattern’dan chiqarib yuborishi mumkin. Host dry-run chiqishi runner regex’idan o‘tadi va orchestrator’da qayta redact qilinmasdan approval jadvaliga yoziladi. Web shu qiymatni ko‘rsatadi. PM2, nginx yoki Certbot chiqishida noma’lum formatdagi secret bo‘lsa, uning fragmenti dalil, model so‘rovi yoki DB/web tarixiga yetishi mumkin. Runner xato jurnali ham `error.message` ni o‘z redactor’idan o‘tkazmaydi.

**Tuzatish.** Redaction’ni satrlarga ajratish va truncation’dan oldin bajaring. Remote dry-run natijasini DB’ga yozishdan oldin umumiy redactor bilan tozalang. Diagnostika uchun structured allowlist maydonlarini saqlang va host xato jurnalini kod darajasidagi error kodlari bilan cheklang. [host/actions-runner/src/parse.ts:5](../host/actions-runner/src/parse.ts#L5) · [host/actions-runner/src/parse.ts:53](../host/actions-runner/src/parse.ts#L53) · [host/actions-runner/src/server.ts:349](../host/actions-runner/src/server.ts#L349) · [mcp/infra/src/tools/docker.ts:113](../mcp/infra/src/tools/docker.ts#L113) · [mcp/actions/src/remote.ts:30](../mcp/actions/src/remote.ts#L30) · [apps/orchestrator/src/graph.ts:684](../apps/orchestrator/src/graph.ts#L684) · [apps/web/src/app/(admin)/incidents/[id]/page.tsx:61](../apps/web/src/app/%28admin%29/incidents/%5Bid%5D/page.tsx#L61)

## Low

### L1. Logout avval olingan session’ni serverda bekor qilmaydi

Status: deferred (single-admin VPS)

**Shart va ta’sir.** Session stateless HMAC bilan imzolanadi va sakkiz soat amal qiladi. Logout cookie’ni faqat joriy brauzerdan o‘chiradi. Agar session nusxasi oldin sizib chiqqan bo‘lsa, u expiry yoki admin paroli almashishigacha dashboard va approval API uchun amal qiladi. Ushbu topilma session o‘g‘irlanishining alohida yo‘lini ko‘rsatmaydi.

**Tuzatish.** Server-side session ID, revocation va alohida signing key qo‘llang. Imtiyozli approval uchun qisqa amal muddati yoki qayta autentifikatsiya ishlating. [apps/web/src/server/session.ts:5](../apps/web/src/server/session.ts#L5) · [apps/web/src/server/session.ts:21](../apps/web/src/server/session.ts#L21) · [apps/web/src/app/api/session/route.ts:34](../apps/web/src/app/api/session/route.ts#L34)

## Tekshirilgan himoyalar va chegaralar

- **HMAC va replay.** Signer va runner approval ID, incident ID, loyiha, runbook, tartiblangan parametrlar va epoch expiry’ni HMAC-SHA256 bilan bog‘laydi. `timingSafeEqual`, 15 daqiqalik token va kelajakdagi expiry limiti bor. Web/Telegram qarori SQL’da faqat pending va muddati o‘tmagan qatorga yoziladi. Postgres token hash bilan claim qiladi. Host ledger claim’ni qadamlar boshlanishidan oldin `fsync` qiladi va restart’da qayta o‘qiydi. Bir runner instance’i va saqlangan state katalogi sharoitida oddiy replay yo‘li topilmadi. [mcp/actions/src/approvals.ts:163](../mcp/actions/src/approvals.ts#L163) · [mcp/actions/src/approvals.ts:238](../mcp/actions/src/approvals.ts#L238) · [host/actions-runner/src/token.ts:22](../host/actions-runner/src/token.ts#L22) · [host/actions-runner/src/token.ts:65](../host/actions-runner/src/token.ts#L65)
- **Parametrdan argv’gacha.** Modelga loyiha bo‘yicha nomzodlar beriladi. Proposer takroriy kalitlar va ro‘yxatdan tashqari qiymatlarni rad etadi. Registry parametrlarni strict schema bilan tekshiradi. Approval oqimi saqlangan tanlovni uzatadi. Remote executor socket orqali runbook ID, parametrlar va token claim’larini jo‘natadi. Host mustaqil policy’dan argv quradi. Binar yo‘llari absolut, `execFile` shell’ni o‘chiradi va env cheklangan. Oddiy model natijasidan argv yoki runbook allowlist’ini chetlab o‘tish yo‘li topilmadi. [apps/orchestrator/src/remediation-proposer.ts:101](../apps/orchestrator/src/remediation-proposer.ts#L101) · [mcp/actions/src/registry.ts:135](../mcp/actions/src/registry.ts#L135) · [apps/orchestrator/src/action-flow.ts:109](../apps/orchestrator/src/action-flow.ts#L109) · [mcp/actions/src/remote.ts:42](../mcp/actions/src/remote.ts#L42) · [host/actions-runner/src/commands.ts:44](../host/actions-runner/src/commands.ts#L44) · [host/actions-runner/src/exec.ts:17](../host/actions-runner/src/exec.ts#L17)
- **Render va nginx helper.** Namunada 20 qoida chiqdi, shundan 16 tasi literal va 4 tasi `check`/`apply` uchun 4 yoki 5 xonali `[0-9]` andozasi. Render sarlavhasidagi «20 exact commands» andozali qatorlarni ham sanaydi. Ochiq `*` wildcard, ixtiyoriy command yoki argumentga bo‘sh joy va metabelgi qo‘shish uchun request orqali yo‘l topilmadi. Policy nom va path formatlarini tekshiradi. Root helper qat’iy argv soni, root-owned policy, port oralig‘i va mavjud exact vhost’ni tekshiradi. U exclusive fayl yozuvi, backup, `nginx -t`, reload va rollback’dan foydalanadi. Sample’da Docker restart va Compose runbook’lari yoqilmagan. Ular keyin yoqilsa, Compose fayli va u o‘qiydigan konfiguratsiyalarning egaligi ham root chegarasining bir qismi bo‘ladi. [host/actions-runner/scripts/render-sudoers.ts:16](../host/actions-runner/scripts/render-sudoers.ts#L16) · [host/actions-runner/src/policy.ts:62](../host/actions-runner/src/policy.ts#L62) · [host/actions-runner/src/commands.ts:251](../host/actions-runner/src/commands.ts#L251) · [host/actions-runner/src/nginx-site.ts:187](../host/actions-runner/src/nginx-site.ts#L187) · [host/actions-runner/src/nginx-site.ts:235](../host/actions-runner/src/nginx-site.ts#L235) · [host/actions-runner/src/nginx-site.ts:294](../host/actions-runner/src/nginx-site.ts#L294) · [deploy/actions-policy.example.json:1](../deploy/actions-policy.example.json#L1)
- **Unix socket.** Unit dedicated user va guruh, `0750` runtime katalogi, `0700` state katalogidan foydalanadi. Socket `0660`. Prod Compose’da faqat orchestrator IPC guruhiga qo‘shiladi va runner katalogini `:ro` mount qiladi. `:ro` socket’dan so‘rov jo‘natishga ruxsatni o‘zgartirmaydi. Read va dry-run OS socket huquqiga tayanadi. Read javobi PM2 bo‘yicha tanlangan maydonlarni, nginx bo‘yicha vhost qismini va certbot bo‘yicha sertifikat metama’lumotini chiqaradi. [host/actions-runner/deploy/incidentpulse-actions.service:7](../host/actions-runner/deploy/incidentpulse-actions.service#L7) · [host/actions-runner/src/main.ts:41](../host/actions-runner/src/main.ts#L41) · [host/actions-runner/src/server.ts:89](../host/actions-runner/src/server.ts#L89) · [compose.prod.yaml:175](../compose.prod.yaml#L175)
- **HTML, log va commit.** Oddiy HTTP probe HTML body’ni modelga bermaydi. Deep-health HTML va JS’ni hajm hamda vaqt limitlari bilan skanerlaydi, kodni bajarmaydi va shu topilmalardan agent/runbook ochmaydi. Log va commit excerpt’lari esa model kontekstiga kiradi. Default `strip` ma’lum injection shakllarini filtrlaydi va `<untrusted>` wrapper ishlatiladi. Mutaxassis MCP ro‘yxati read-only. `execute_runbook` alohida in-memory action flow’da. [mcp/infra/src/tools/http.ts:30](../mcp/infra/src/tools/http.ts#L30) · [apps/orchestrator/src/deep-health.ts:7](../apps/orchestrator/src/deep-health.ts#L7) · [apps/orchestrator/src/health-poller.ts:137](../apps/orchestrator/src/health-poller.ts#L137) · [apps/orchestrator/src/guarded-mcp.ts:61](../apps/orchestrator/src/guarded-mcp.ts#L61) · [apps/orchestrator/src/agents/specialists.ts:131](../apps/orchestrator/src/agents/specialists.ts#L131) · [apps/orchestrator/src/action-flow.ts:64](../apps/orchestrator/src/action-flow.ts#L64) · [packages/config/src/index.ts:106](../packages/config/src/index.ts#L106)
- **Web CSRF va Approve.** Password taqqoslash hash ustida constant-time. Prod cookie `HttpOnly`, `SameSite=Strict`, `Secure`. Login, logout, chat va approval POST’lari exact `Origin` talab qiladi. Approve qo‘shimcha ravishda admin session, imzolangan action va approval ID, incident bilan bog‘lanish va DB’dagi pending holatni tekshiradi. SSE session’ni ulanish davomida qayta tekshiradi. Postmortem render’i raw HTML va rasmlarni o‘chiradi, matndagi linklarni oddiy span sifatida chiqaradi. Ko‘rilgan route’larda CSRF, imzosiz Approve yoki raw HTML ijro yo‘li topilmadi. [apps/web/src/server/session.ts:10](../apps/web/src/server/session.ts#L10) · [apps/web/src/server/session.ts:46](../apps/web/src/server/session.ts#L46) · [apps/web/src/app/api/incidents/[id]/approval/route.ts:5](../apps/web/src/app/api/incidents/%5Bid%5D/approval/route.ts#L5) · [apps/web/src/app/api/incidents/[id]/events/route.ts:24](../apps/web/src/app/api/incidents/%5Bid%5D/events/route.ts#L24) · [apps/web/src/app/(admin)/postmortems/[id]/page.tsx:19](../apps/web/src/app/%28admin%29/postmortems/%5Bid%5D/page.tsx#L19)
- **Telegram autentifikatsiyasi.** Bot long polling ishlatadi, `/investigate`, `/stop`, `/resume`, `/status` va callback uchun chat ID hamda user ID birga tekshiriladi. Allowlist bo‘sh bo‘lsa polling boshlanmaydi. HMAC callback ID va action’ni bog‘laydi. Approve/reject muddati va qayta ishlatilishi DB’da tekshiriladi. Batafsil tugmasi faqat ruxsatli user’ga redacted tafsilot yuboradi, approval holatini o‘zgartirmaydi. Notifier markup rejimini yoqmaydi. [apps/telegram-bot/src/investigate.ts:21](../apps/telegram-bot/src/investigate.ts#L21) · [apps/orchestrator/src/runtime.ts:306](../apps/orchestrator/src/runtime.ts#L306) · [mcp/actions/src/approvals.ts:296](../mcp/actions/src/approvals.ts#L296) · [apps/orchestrator/src/action-flow.ts:133](../apps/orchestrator/src/action-flow.ts#L133) · [apps/telegram-bot/src/index.ts:42](../apps/telegram-bot/src/index.ts#L42)
- **Sirlar va portlar.** Git’dagi env fayllar namuna fayllar. Docker build context `.env` va `secrets/` ni chiqarib tashlaydi. Orchestrator logger va ixtiyoriy Langfuse mask ishlatadi. OpenAI Agents SDK tracing o‘chirilgan. Prod Compose faqat web’ni `127.0.0.1` ga publish qiladi. Postgres, Redis, intake, Python servislar va Docker proxy’da publish yo‘q. Repo nginx shabloni dastlab HTTP, deploy TLS va redirect’ni Certbot orqali qo‘shadi. Case study Kervan’ning raw 3000/3003 portlari tashqaridan ochiqligini alohida qayd etadi. Ularning bugungi holati koddan tasdiqlanmaydi. [docs/DEPLOY.md:116](DEPLOY.md#L116) · [.dockerignore:11](../.dockerignore#L11) · [apps/orchestrator/src/log.ts:9](../apps/orchestrator/src/log.ts#L9) · [apps/orchestrator/src/agents/sdk.ts:7](../apps/orchestrator/src/agents/sdk.ts#L7) · [packages/telemetry/src/index.ts:145](../packages/telemetry/src/index.ts#L145) · [compose.prod.yaml:232](../compose.prod.yaml#L232) · [docs/DEPLOY.md:418](DEPLOY.md#L418) · [docs/CASE_STUDY.md:162](CASE_STUDY.md#L162)
