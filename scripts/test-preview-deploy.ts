// preview-deploy.ts の純粋ロジックのユニット（npx tsx scripts/test-preview-deploy.ts）。
// previewName / previewImage / buildSubmitArgs / runDeployArgs / teardownArgs / isValidPreviewName。
// 設定は本番既定（env 未設定）で検証。spawn 系（deployPreview/teardownPreview）は VM 実機で確認。
import assert from "node:assert/strict";
import {
  previewName,
  previewImage,
  buildSubmitArgs,
  runDeployArgs,
  teardownArgs,
  isValidPreviewName,
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
  assert.ok(a.includes("--quiet"));
});

console.log("runDeployArgs");
t("run deploy --image + impersonate + scale-to-zero + labels(ttl) + url format", () => {
  const a = runDeployArgs("preview-cmpz1234-abcdef", "IMG", "cmpz1234", 1780000000);
  assert.deepEqual(a.slice(0, 3), ["run", "deploy", "preview-cmpz1234-abcdef"]);
  assert.ok(a.includes("--image=IMG"));
  assert.ok(a.includes("--region=asia-northeast1"));
  assert.ok(a.includes("--impersonate-service-account=preview-deployer@vets-biz-aigen-apps.iam.gserviceaccount.com"));
  assert.ok(a.includes("--allow-unauthenticated"));
  assert.ok(a.includes("--min-instances=0"));
  assert.ok(a.includes("--max-instances=1"));
  assert.ok(a.includes("--labels=spm-preview=true,spm-project=cmpz1234,spm-ttl=1780000000"));
  assert.ok(a.includes("--format=value(status.url)"));
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

console.log("isValidPreviewName");
t("正/不正の判定", () => {
  assert.ok(isValidPreviewName("preview-cmpz1234-abcdef"));
  assert.ok(!isValidPreviewName("preview-x-AB!"));        // 記号
  assert.ok(!isValidPreviewName("svc-cmpz1234-abcdef"));  // 接頭辞違い
  assert.ok(!isValidPreviewName("preview-cmpz1234-abc"));  // rand 6字未満
});

console.log(`\n✅ all ${passed} tests passed`);
