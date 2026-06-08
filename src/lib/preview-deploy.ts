// E Phase2.1：ephemeral プレビューの deploy/teardown（VM 限定・キーレス ADC）。
// 2段 buildpacks：(1) gcloud builds submit --pack で spm-preview repo にイメージ push、
// (2) gcloud run deploy --image で Cloud Run に scale-to-zero デプロイ。実行は preview-deployer
// を impersonate（最小権限）。detached spawn＋/tmp の done/log/url ファイルで parallel-tick の
// inspectExec(doneFile, pid) と互換。URL は run deploy の --format=value(status.url) を urlFile へ。
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs, readFileSync, existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

// 設定（env 上書き可。本番値を既定に）。
const PROJECT = process.env.GCP_PROJECT || "vets-biz-aigen-apps";
const REGION = process.env.GCP_REGION || "asia-northeast1";
const DEPLOYER =
  process.env.PREVIEW_DEPLOYER_SA || `preview-deployer@${PROJECT}.iam.gserviceaccount.com`;
const AR_REPO = "spm-preview";
// プレビューのアクセス許可ドメイン（直結 IAP）。
const IAP_DOMAIN = process.env.PREVIEW_IAP_DOMAIN || "peco-japan.com";
// IAP サービスエージェント（IAP→Cloud Run 呼び出し主体）。
const PROJECT_NUMBER = process.env.GCP_PROJECT_NUMBER || "842623777962";
const IAP_SA = `service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com`;
const DEFAULT_TTL_SECONDS = Number(process.env.PREVIEW_TTL_SECONDS || 24 * 3600);
// 同時プレビュー数の上限（超過時は新規 deploy を待機）。
const MAX_CONCURRENT_PREVIEWS = Number(process.env.PREVIEW_MAX_CONCURRENT || 3);
const DEPLOY_TIMEOUT_SECONDS = Number(process.env.PREVIEW_DEPLOY_TIMEOUT_SECONDS || 1200); // 20分
const MAX_LOG_BYTES = 200_000;

export interface SpawnedPreview {
  name: string;
  image: string;
  pid: number;
  doneFile: string;
  logFile: string;
  urlFile: string;
}

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- 純粋ロジック（テスト対象） -------------------------------------------

// Cloud Run サービス名：preview-<id8>-<rand6>。[a-z0-9-]・先頭英字・<=63字。
// rand を渡せば純関数（テスト可）。省略時は内部生成。
export function previewName(projectId: string, rand?: string): string {
  const id8 = (projectId || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8)
    .padEnd(2, "0"); // 極端に短い id でも2字以上確保
  const r = (rand ?? randSuffix()).toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(6, "0");
  const name = `preview-${id8}-${r}`;
  return name.slice(0, 63);
}

export function randSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 6);
}

// プレビューイメージの AR パス（純粋）。
export function previewImage(name: string): string {
  return `${REGION}-docker.pkg.dev/${PROJECT}/${AR_REPO}/${name}`;
}

// gcloud builds submit（--pack）の引数列（純粋）。
export function buildSubmitArgs(cwd: string, image: string): string[] {
  return [
    "builds", "submit", cwd,
    "--pack", `image=${image}`,
    `--impersonate-service-account=${DEPLOYER}`,
    // ビルド実行 SA も deployer に固定（既定の compute SA を実行系から外す＝触らない）。
    `--service-account=projects/${PROJECT}/serviceAccounts/${DEPLOYER}`,
    `--project=${PROJECT}`,
    // user-specified SA は default logs bucket を使えないため、SA 所有のリージョナルバケットに
    // source/logs を置く（必須）。さらに client 側 stream も抑止。
    "--default-buckets-behavior=REGIONAL_USER_OWNED_BUCKET",
    "--suppress-logs",
    "--quiet",
  ];
}

// gcloud run deploy（--image）の引数列（純粋）。
export function runDeployArgs(name: string, image: string, projectId: string, ttlEpoch: number): string[] {
  return [
    "run", "deploy", name,
    `--image=${image}`,
    `--region=${REGION}`,
    `--project=${PROJECT}`,
    `--impersonate-service-account=${DEPLOYER}`,
    // 公開しない。アクセス制御は直結 IAP（domain:peco-japan.com）で行う。
    "--no-allow-unauthenticated",
    "--min-instances=0",
    "--max-instances=1",
    `--labels=spm-preview=true,spm-project=${projectId},spm-ttl=${ttlEpoch}`,
    "--format=value(status.url)",
    "--quiet",
  ];
}

// teardown の引数列（純粋）。services delete ＋ AR イメージ delete。
export function teardownArgs(name: string): { serviceDelete: string[]; imageDelete: string[] } {
  // deploy 系（buildSubmitArgs/runDeployArgs/iap*/listPreviewsArgs）と同様に deployer を impersonate する。
  // これが無いと VM 既定の compute SA で実行され、削除権限が無く teardown が黙って失敗していた
  // （detached + stdio:ignore のため握り潰され、service/image が残存しキャップを埋める欠陥の修正）。
  return {
    serviceDelete: ["run", "services", "delete", name, `--region=${REGION}`, `--project=${PROJECT}`, `--impersonate-service-account=${DEPLOYER}`, "--quiet"],
    imageDelete: ["artifacts", "docker", "images", "delete", previewImage(name), "--delete-tags", `--impersonate-service-account=${DEPLOYER}`, "--quiet"],
  };
}

// IAP 有効化の引数列（純粋）。デプロイ後に Cloud Run 直結 IAP を ON にする。
export function iapEnableArgs(name: string): string[] {
  return [
    "run", "services", "update", name,
    "--iap",
    `--region=${REGION}`,
    `--project=${PROJECT}`,
    `--impersonate-service-account=${DEPLOYER}`,
    "--quiet",
  ];
}

// IAP→Cloud Run 呼び出しのため IAP サービスエージェントに run.invoker を付与（対象サービス限定）。
export function iapInvokerArgs(name: string): string[] {
  return [
    "run", "services", "add-iam-policy-binding", name,
    `--region=${REGION}`,
    `--project=${PROJECT}`,
    `--member=serviceAccount:${IAP_SA}`,
    "--role=roles/run.invoker",
    `--impersonate-service-account=${DEPLOYER}`,
    "--quiet",
  ];
}

// IAP アクセス権（domain 限定）付与の引数列（純粋）。
export function iapBindArgs(name: string): string[] {
  return [
    "iap", "web", "add-iam-policy-binding",
    "--resource-type=cloud-run",
    `--service=${name}`,
    `--region=${REGION}`,
    `--project=${PROJECT}`,
    `--member=domain:${IAP_DOMAIN}`,
    "--role=roles/iap.httpsResourceAccessor",
    `--impersonate-service-account=${DEPLOYER}`,
    "--quiet",
  ];
}

// 名前の検証（純粋）。
export function isValidPreviewName(name: string): boolean {
  return /^preview-[a-z0-9]{2,}-[a-z0-9]{6}$/.test(name) && name.length <= 63;
}

// プレビュー一覧取得の引数列（純粋）。spm-preview=true ラベルの Cloud Run サービスを
// `name<TAB>ttl` 形式で出す。
export function listPreviewsArgs(): string[] {
  return [
    "run", "services", "list",
    "--filter=metadata.labels.spm-preview=true",
    `--region=${REGION}`,
    `--project=${PROJECT}`,
    "--format=value(metadata.name,metadata.labels.spm-ttl)",
    `--impersonate-service-account=${DEPLOYER}`,
    "--quiet",
  ];
}

// 一覧出力（"name\tttl" 行）から TTL 切れ（spm-ttl < now）の preview 名を返す（純粋）。
export function parseExpiredPreviews(listOutput: string, nowEpoch: number): string[] {
  const out: string[] = [];
  for (const line of (listOutput || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    const [name, ttlRaw] = t.split(/\s+/);
    if (!name || !isValidPreviewName(name)) continue;
    const ttl = Number.parseInt(ttlRaw ?? "", 10);
    // ttl 不明（NaN）は安全側で残す（誤 teardown 回避）。
    if (!Number.isNaN(ttl) && ttl < nowEpoch) out.push(name);
  }
  return out;
}

// 一覧出力から有効な preview 行数（同時数）を数える（純粋）。
export function parseActiveCount(listOutput: string): number {
  return (listOutput || "")
    .split(/\r?\n/)
    .map((l) => l.trim().split(/\s+/)[0])
    .filter((n) => n && isValidPreviewName(n)).length;
}

// cap 到達判定（純粋）。
export function previewCapReached(activeCount: number): boolean {
  return activeCount >= MAX_CONCURRENT_PREVIEWS;
}

// QA コメント → 実装 revise プロンプト（純粋）。プレビューへのフィードバックを既存実装に反映させる。
export function buildRevisePrompt(comment: string): string {
  return (
    `# プレビューレビューの反映（修正パス）\n` +
    `デプロイ済みプレビューに対して、レビュー担当から次のフィードバックがありました。\n` +
    `この内容を**既存の実装（このディレクトリ）に対する修正**として反映してください。\n` +
    `要件・設計の範囲内で対応し、仕様にない要素は追加しないこと。完了後はビルドが通る状態にすること。\n\n` +
    `## フィードバック\n${(comment || "(指摘内容なし)").slice(0, 4000)}\n`
  );
}

// ---- 副作用（VM 限定の spawn） --------------------------------------------

// プレビューを deploy（detached）。SpawnedPreview を返す。完了は inspectExec(doneFile, pid)。
// 成功後に readPreviewUrl(urlFile) で URL を取得する。
export async function deployPreview(
  projectId: string,
  cwd: string,
  opts: { ttlSeconds?: number; name?: string } = {},
): Promise<SpawnedPreview> {
  if (!existsSync(cwd)) throw new Error(`deployPreview: cwd 不在: ${cwd}`);
  // opts.name 指定時はそれを再利用（同名 = 同 Cloud Run サービス = 同 URL の再デプロイ）。
  const name = opts.name && isValidPreviewName(opts.name) ? opts.name : previewName(projectId);
  if (!isValidPreviewName(name)) throw new Error(`deployPreview: 不正な name: ${name}`);
  const image = previewImage(name);
  const ttlEpoch = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);

  const id = randomUUID();
  const tmp = os.tmpdir();
  const doneFile = path.join(tmp, `claude-done-${id}`); // inspectExec 互換命名
  const logFile = path.join(tmp, `claude-log-${id}`);
  const urlFile = path.join(tmp, `claude-url-${id}`);

  const submit = buildSubmitArgs(cwd, image).map(shq).join(" ");
  const deploy = runDeployArgs(name, image, projectId, ttlEpoch).map(shq).join(" ");
  const iapEnable = iapEnableArgs(name).map(shq).join(" ");
  const iapInvoker = iapInvokerArgs(name).map(shq).join(" ");
  const iapBind = iapBindArgs(name).map(shq).join(" ");
  // builds submit → log、run deploy → URL を urlFile（stderr は log）。
  // その後 IAP 有効化＋domain 限定アクセス付与（公開せず社内ドメインのみ）。timeout で暴走防止。
  const shellCmd =
    `timeout ${DEPLOY_TIMEOUT_SECONDS} sh -c ${shq(
      `gcloud ${submit} >> ${shq(logFile)} 2>&1 && ` +
        `gcloud ${deploy} 2>> ${shq(logFile)} 1> ${shq(urlFile)} && ` +
        `gcloud ${iapEnable} >> ${shq(logFile)} 2>&1 && ` +
        `gcloud ${iapInvoker} >> ${shq(logFile)} 2>&1 && ` +
        `gcloud ${iapBind} >> ${shq(logFile)} 2>&1`,
    )}; echo $? > ${shq(doneFile)}`;

  const { spawn } = await import("child_process");
  const shell = process.env.SHELL || "/bin/bash";
  let proc: import("child_process").ChildProcess;
  try {
    proc = spawn(shell, ["-c", shellCmd], { detached: true, stdio: "ignore", env: { ...process.env } });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await fs.writeFile(logFile, `[preview spawn失敗] ${msg}`, "utf-8").catch(() => {});
    await fs.writeFile(doneFile, "127", "utf-8").catch(() => {});
    throw new Error(`deployPreview spawn失敗: ${msg}`);
  }
  proc.on("error", (err) => {
    void fs.writeFile(logFile, `[preview spawn失敗:async] ${err.message}`, "utf-8").catch(() => {});
    void fs.writeFile(doneFile, "127", "utf-8").catch(() => {});
  });
  if (typeof proc.pid !== "number") throw new Error("deployPreview: pid undefined");
  proc.unref();
  console.log(`[PREVIEW] deploy spawned pid=${proc.pid} name=${name}`);
  return { name, image, pid: proc.pid, doneFile, logFile, urlFile };
}

// 成功後に URL を取得（urlFile の先頭 https 行）。無ければ null。
export function readPreviewUrl(urlFile: string): string | null {
  try {
    const raw = readFileSync(urlFile, "utf-8");
    const m = raw.match(/https:\/\/\S+/);
    return m ? m[0].trim() : null;
  } catch {
    return null;
  }
}

// ログ抜粋（上限つき・診断用）。
export function readPreviewLog(logFile: string): string {
  try {
    const raw = readFileSync(logFile, "utf-8");
    return raw.length > MAX_LOG_BYTES ? raw.slice(-MAX_LOG_BYTES) : raw;
  } catch {
    return "";
  }
}

// プレビューを teardown（detached・best-effort）。サービス削除＋イメージ削除。
export async function teardownPreview(name: string): Promise<{ pid: number; doneFile: string; logFile: string }> {
  if (!isValidPreviewName(name)) throw new Error(`teardownPreview: 不正な name: ${name}`);
  const { serviceDelete, imageDelete } = teardownArgs(name);
  const id = randomUUID();
  const tmp = os.tmpdir();
  const doneFile = path.join(tmp, `claude-done-${id}`);
  const logFile = path.join(tmp, `claude-log-${id}`);
  const svc = serviceDelete.map(shq).join(" ");
  const img = imageDelete.map(shq).join(" ");
  // サービス削除は必須、イメージ削除は失敗しても続行（|| true）。
  const shellCmd =
    `sh -c ${shq(`gcloud ${svc} >> ${shq(logFile)} 2>&1; gcloud ${img} >> ${shq(logFile)} 2>&1 || true`)}` +
    `; echo $? > ${shq(doneFile)}`;
  const { spawn } = await import("child_process");
  const shell = process.env.SHELL || "/bin/bash";
  const proc = spawn(shell, ["-c", shellCmd], { detached: true, stdio: "ignore", env: { ...process.env } });
  proc.on("error", (err) => {
    void fs.writeFile(doneFile, "127", "utf-8").catch(() => {});
    void fs.writeFile(logFile, `[teardown spawn失敗] ${err.message}`, "utf-8").catch(() => {});
  });
  if (typeof proc.pid !== "number") throw new Error("teardownPreview: pid undefined");
  proc.unref();
  console.log(`[PREVIEW] teardown spawned pid=${proc.pid} name=${name}`);
  return { pid: proc.pid, doneFile, logFile };
}

// プレビュー一覧を取得（gcloud・deployer impersonate）。失敗時は空文字。
async function listPreviewsRaw(): Promise<string> {
  try {
    const { stdout } = await execFileP("gcloud", listPreviewsArgs(), { timeout: 60000 });
    return stdout ?? "";
  } catch {
    return "";
  }
}

// 現在の同時プレビュー数。
export async function countActivePreviews(): Promise<number> {
  return parseActiveCount(await listPreviewsRaw());
}

// TTL 切れプレビューを teardown（svc+image）。teardown した名前一覧を返す。
export async function sweepExpiredPreviews(nowEpoch: number = Math.floor(Date.now() / 1000)): Promise<string[]> {
  const expired = parseExpiredPreviews(await listPreviewsRaw(), nowEpoch);
  for (const name of expired) {
    try {
      await teardownPreview(name);
      console.log(`[PREVIEW] TTL teardown: ${name}`);
    } catch (e) {
      console.warn(`[PREVIEW] TTL teardown 失敗 ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return expired;
}
