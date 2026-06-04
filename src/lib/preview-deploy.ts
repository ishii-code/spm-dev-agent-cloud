// E Phase2.1：ephemeral プレビューの deploy/teardown（VM 限定・キーレス ADC）。
// 2段 buildpacks：(1) gcloud builds submit --pack で spm-preview repo にイメージ push、
// (2) gcloud run deploy --image で Cloud Run に scale-to-zero デプロイ。実行は preview-deployer
// を impersonate（最小権限）。detached spawn＋/tmp の done/log/url ファイルで parallel-tick の
// inspectExec(doneFile, pid) と互換。URL は run deploy の --format=value(status.url) を urlFile へ。
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { promises as fs, readFileSync, existsSync } from "node:fs";

// 設定（env 上書き可。本番値を既定に）。
const PROJECT = process.env.GCP_PROJECT || "vets-biz-aigen-apps";
const REGION = process.env.GCP_REGION || "asia-northeast1";
const DEPLOYER =
  process.env.PREVIEW_DEPLOYER_SA || `preview-deployer@${PROJECT}.iam.gserviceaccount.com`;
const AR_REPO = "spm-preview";
const DEFAULT_TTL_SECONDS = Number(process.env.PREVIEW_TTL_SECONDS || 24 * 3600);
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
    `--project=${PROJECT}`,
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
    "--allow-unauthenticated",
    "--min-instances=0",
    "--max-instances=1",
    `--labels=spm-preview=true,spm-project=${projectId},spm-ttl=${ttlEpoch}`,
    "--format=value(status.url)",
    "--quiet",
  ];
}

// teardown の引数列（純粋）。services delete ＋ AR イメージ delete。
export function teardownArgs(name: string): { serviceDelete: string[]; imageDelete: string[] } {
  return {
    serviceDelete: ["run", "services", "delete", name, `--region=${REGION}`, `--project=${PROJECT}`, "--quiet"],
    imageDelete: ["artifacts", "docker", "images", "delete", previewImage(name), "--delete-tags", "--quiet"],
  };
}

// 名前の検証（純粋）。
export function isValidPreviewName(name: string): boolean {
  return /^preview-[a-z0-9]{2,}-[a-z0-9]{6}$/.test(name) && name.length <= 63;
}

// ---- 副作用（VM 限定の spawn） --------------------------------------------

// プレビューを deploy（detached）。SpawnedPreview を返す。完了は inspectExec(doneFile, pid)。
// 成功後に readPreviewUrl(urlFile) で URL を取得する。
export async function deployPreview(
  projectId: string,
  cwd: string,
  opts: { ttlSeconds?: number } = {},
): Promise<SpawnedPreview> {
  if (!existsSync(cwd)) throw new Error(`deployPreview: cwd 不在: ${cwd}`);
  const name = previewName(projectId);
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
  // builds submit → log、run deploy → URL を urlFile（stderr は log）。timeout で暴走防止。
  const shellCmd =
    `timeout ${DEPLOY_TIMEOUT_SECONDS} sh -c ${shq(
      `gcloud ${submit} >> ${shq(logFile)} 2>&1 && ` +
        `gcloud ${deploy} 2>> ${shq(logFile)} 1> ${shq(urlFile)}`,
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
