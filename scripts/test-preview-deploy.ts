// preview-deploy.ts の純粋ロジックのユニット（npx tsx scripts/test-preview-deploy.ts）。
// previewName / previewImage / buildSubmitArgs / runDeployArgs / teardownArgs / isValidPreviewName。
// 設定は本番既定（env 未設定）で検証。spawn 系（deployPreview/teardownPreview）は VM 実機で確認。
import assert from "node:assert/strict";
import {
  previewName,
  previewImage,
  buildSubmitArgs,
  runDeployArgs,
  iapEnableArgs,
  iapInvokerArgs,
  iapBindArgs,
  listPreviewsArgs,
  parseExpiredPreviews,
  parseActiveCount,
  previewCapReached,
  teardownArgs,
  isValidPreviewName,
  buildRevisePrompt,
} from "../src/lib/preview-deploy";

let passed = 0;
function t(name: string, fn: () => void) { fn(); passed++; console.log(`  ✓ ${name}`); }

console.log("previewName");
t("preview-<id8>-<rand6> 形式・charset・長さ", () => {
  const n = previewName("cmpzABC123xyz", "Q1w2e3");
  assert.equal(n, "preview-cmpzabc1-q1w2e3"); // id 小文字化・8字、rand 小文字化6字
  assert.match(n, /^preview-[a-z0-9]+-[a-z0-9]{6}$/);
  assert.ok(n.length <= 63);
  assert.ok(isValidPreviewName(n));
});
t("非英数字を除去（記号/全角は落ちる）", () => {
  const n = previewName("AB_C-D.えf9", "x-y_z!1");
  assert.match(n, /^preview-[a-z0-9]{2,}-[a-z0-9]{6}$/);
  assert.ok(isValidPreviewName(n));
});
t("極端に短い id でも valid（padEnd）", () => {
  const n = previewName("a", "bcdef0");
  assert.ok(isValidPreviewName(n), n);
});
t("rand 省略でも形式 valid（内部生成）", () => {
  const n = previewName("cmpz1234");
  assert.ok(isValidPreviewName(n), n);
});

console.log("previewImage");
t("AR パス（spm-preview repo）", () => {
  assert.equal(
    previewImage("preview-cmpzabc1-q1w2e3"),
    "asia-northeast1-docker.pkg.dev/vets-biz-aigen-apps/spm-preview/preview-cmpzabc1-q1w2e3",
  );
});

console.log("buildSubmitArgs");
t("builds submit --pack + impersonate + 専用repo image", () => {
  const a = buildSubmitArgs("/home/u/proj", "asia-northeast1-docker.pkg.dev/vets-biz-aigen-apps/spm-preview/preview-x-yyyyyy");
  assert.deepEqual(a.slice(0, 3), ["builds", "submit", "/home/u/proj"]);
  assert.ok(a.includes("--pack"));
  assert.ok(a.some((x) => x.startsWith("image=asia-northeast1-docker.pkg.dev/vets-biz-aigen-apps/spm-preview/")));
  assert.ok(a.includes("--impersonate-service-account=preview-deployer@vets-biz-aigen-apps.iam.gserviceaccount.com"));
  assert.ok(a.includes("--project=vets-biz-aigen-apps"));
  assert.ok(a.includes("--suppress-logs"));
  assert.ok(a.includes("--default-buckets-behavior=REGIONAL_USER_OWNED_BUCKET"));
  assert.ok(a.includes("--service-account=projects/vets-biz-aigen-apps/serviceAccounts/preview-deployer@vets-biz-aigen-apps.iam.gserviceaccount.com"));
  assert.ok(a.includes("--quiet"));
});

console.log("runDeployArgs");
t("run deploy --image + impersonate + scale-to-zero + labels(ttl) + url format", () => {
  const a = runDeployArgs("preview-cmpz1234-abcdef", "IMG", "cmpz1234", 1780000000);
  assert.deepEqual(a.slice(0, 3), ["run", "deploy", "preview-cmpz1234-abcdef"]);
  assert.ok(a.includes("--image=IMG"));
  assert.ok(a.includes("--region=asia-northeast1"));
  assert.ok(a.includes("--impersonate-service-account=preview-deployer@vets-biz-aigen-apps.iam.gserviceaccount.com"));
  assert.ok(a.includes("--no-allow-unauthenticated")); // 公開しない（IAPで制御）
  assert.ok(!a.includes("--allow-unauthenticated") || a.includes("--no-allow-unauthenticated"));
  assert.ok(a.includes("--min-instances=0"));
  assert.ok(a.includes("--max-instances=1"));
  assert.ok(a.includes("--labels=spm-preview=true,spm-project=cmpz1234,spm-ttl=1780000000"));
  assert.ok(a.includes("--format=value(status.url)"));
});

console.log("iapEnableArgs / iapBindArgs");
t("IAP 有効化 args（run services update --iap・impersonate）", () => {
  const a = iapEnableArgs("preview-cmpz1234-abcdef");
  assert.deepEqual(a.slice(0, 4), ["run", "services", "update", "preview-cmpz1234-abcdef"]);
  assert.ok(a.includes("--iap"));
  assert.ok(a.includes("--region=asia-northeast1"));
  assert.ok(a.includes("--impersonate-service-account=preview-deployer@vets-biz-aigen-apps.iam.gserviceaccount.com"));
});
t("IAP domain 限定アクセス args（cloud-run・domain:peco-japan.com）", () => {
  const a = iapBindArgs("preview-cmpz1234-abcdef");
  assert.deepEqual(a.slice(0, 3), ["iap", "web", "add-iam-policy-binding"]);
  assert.ok(a.includes("--resource-type=cloud-run"));
  assert.ok(a.includes("--service=preview-cmpz1234-abcdef"));
  assert.ok(a.includes("--member=domain:peco-japan.com"));
  assert.ok(a.includes("--role=roles/iap.httpsResourceAccessor"));
});

t("IAP SA invoker 付与 args（対象サービス限定・run.invoker）", () => {
  const a = iapInvokerArgs("preview-cmpz1234-abcdef");
  assert.deepEqual(a.slice(0, 4), ["run", "services", "add-iam-policy-binding", "preview-cmpz1234-abcdef"]);
  assert.ok(a.includes("--member=serviceAccount:service-842623777962@gcp-sa-iap.iam.gserviceaccount.com"));
  assert.ok(a.includes("--role=roles/run.invoker"));
});

console.log("teardownArgs");
t("services delete ＋ AR image delete", () => {
  const { serviceDelete, imageDelete } = teardownArgs("preview-cmpz1234-abcdef");
  assert.deepEqual(serviceDelete.slice(0, 4), ["run", "services", "delete", "preview-cmpz1234-abcdef"]);
  assert.ok(serviceDelete.includes("--region=asia-northeast1"));
  assert.ok(serviceDelete.includes("--quiet"));
  assert.deepEqual(imageDelete.slice(0, 4), ["artifacts", "docker", "images", "delete"]);
  assert.ok(imageDelete.some((x) => x.includes("spm-preview/preview-cmpz1234-abcdef")));
  assert.ok(imageDelete.includes("--delete-tags"));
});

console.log("TTL / cap（2.3）");
t("listPreviewsArgs（label filter＋ttl 列）", () => {
  const a = listPreviewsArgs();
  assert.deepEqual(a.slice(0, 3), ["run", "services", "list"]);
  assert.ok(a.includes("--filter=metadata.labels.spm-preview=true"));
  assert.ok(a.some((x) => x.includes("spm-ttl")));
  assert.ok(a.includes("--impersonate-service-account=preview-deployer@vets-biz-aigen-apps.iam.gserviceaccount.com"));
});
t("parseExpiredPreviews：ttl<now のみ／不正名・NaN は除外", () => {
  const now = 1000;
  const out = `preview-aaaa1111-bbbbbb\t900\npreview-cccc2222-dddddd\t1500\npreview-eeee3333-ffffff\tNaN\nnot-a-preview\t1\npreview-gg-hhhhhh\t800`;
  const exp = parseExpiredPreviews(out, now);
  assert.deepEqual(exp.sort(), ["preview-aaaa1111-bbbbbb", "preview-gg-hhhhhh"].sort()); // 900<1000, 800<1000
  assert.ok(!exp.includes("preview-cccc2222-dddddd")); // 1500>1000
  assert.ok(!exp.includes("preview-eeee3333-ffffff")); // NaN→残す
  assert.ok(!exp.includes("not-a-preview")); // 不正名
});
t("parseActiveCount：有効 preview 行のみ計数", () => {
  const out = `preview-aaaa1111-bbbbbb\t900\nnot-a-preview\t1\npreview-cccc2222-dddddd\t1500\n`;
  assert.equal(parseActiveCount(out), 2);
  assert.equal(parseActiveCount(""), 0);
});
t("previewCapReached：既定上限3", () => {
  assert.equal(previewCapReached(2), false);
  assert.equal(previewCapReached(3), true);
  assert.equal(previewCapReached(5), true);
});

console.log("isValidPreviewName");
t("正/不正の判定", () => {
  assert.ok(isValidPreviewName("preview-cmpz1234-abcdef"));
  assert.ok(!isValidPreviewName("preview-x-AB!"));        // 記号
  assert.ok(!isValidPreviewName("svc-cmpz1234-abcdef"));  // 接頭辞違い
  assert.ok(!isValidPreviewName("preview-cmpz1234-abc"));  // rand 6字未満
});

console.log("buildRevisePrompt");
t("コメントを含む revise プロンプト（仕様外追加禁止・ビルド通過の指示込み）", () => {
  const p = buildRevisePrompt("ボタンの色を青に、受付は追加しないで");
  assert.match(p, /ボタンの色を青に、受付は追加しないで/);
  assert.match(p, /修正/);
  assert.match(p, /仕様にない要素は追加しない/);
  assert.match(p, /ビルドが通る/);
});

console.log(`\n✅ all ${passed} tests passed`);
