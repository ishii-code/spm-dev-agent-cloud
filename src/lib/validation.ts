import type { ChatRequestBody } from "@/types";
import { isSystemId } from "@/lib/systems";
import { isBusinessCategory, DEFAULT_BUSINESS_CATEGORY, type BusinessCategoryId } from "@/lib/categories";

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 5000;
export const MAX_MESSAGE_LENGTH = 10000;

export function isNonEmptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

export function isValidNewRepoName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,49}$/.test(value);
}

export type ProjectType = "existing" | "new";

export function isProjectType(value: unknown): value is ProjectType {
  return value === "existing" || value === "new";
}

export interface ValidationError {
  field: string;
  message: string;
}

export function validateChatRequest(body: unknown):
  | { ok: true; value: ChatRequestBody }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, errors: [{ field: "body", message: "JSONオブジェクトが必要です" }] };
  }

  const obj = body as Record<string, unknown>;

  if (!isNonEmptyString(obj.sessionId, 100)) {
    errors.push({ field: "sessionId", message: "sessionIdは必須です（最大100文字）" });
  }
  if (!isNonEmptyString(obj.projectId, 100)) {
    errors.push({ field: "projectId", message: "projectIdは必須です（最大100文字）" });
  }
  if (!isNonEmptyString(obj.message, MAX_MESSAGE_LENGTH)) {
    errors.push({
      field: "message",
      message: `messageは必須です（最大${MAX_MESSAGE_LENGTH}文字）`,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      sessionId: obj.sessionId as string,
      projectId: obj.projectId as string,
      message: (obj.message as string).trim(),
    },
  };
}

export interface ProjectInput {
  title: string;
  description: string | null;
  projectType: "existing" | "new";
  targetSystem: string | null;
  targetLabel: string | null;
  skipRequirements: boolean;
  businessCategory: BusinessCategoryId;
}

export function validateProjectInput(body: unknown):
  | { ok: true; value: ProjectInput }
  | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!body || typeof body !== "object") {
    return { ok: false, errors: [{ field: "body", message: "JSONオブジェクトが必要です" }] };
  }

  const obj = body as Record<string, unknown>;

  if (!isNonEmptyString(obj.title, MAX_TITLE_LENGTH)) {
    errors.push({
      field: "title",
      message: `titleは必須です（最大${MAX_TITLE_LENGTH}文字）`,
    });
  }

  const description =
    typeof obj.description === "string"
      ? obj.description.slice(0, MAX_DESCRIPTION_LENGTH)
      : null;

  const rawType = obj.projectType;
  const projectType: ProjectInput["projectType"] =
    rawType === "new" ? "new" : rawType === undefined || rawType === "existing" ? "existing" : "existing";
  if (rawType !== undefined && rawType !== "existing" && rawType !== "new") {
    errors.push({
      field: "projectType",
      message: "projectTypeは existing または new",
    });
  }

  let targetSystem: string | null = null;
  let targetLabel: string | null = null;

  if (projectType === "existing") {
    const ts = obj.targetSystem;
    if (typeof ts === "string" && ts.length > 0) {
      if (!isSystemId(ts)) {
        errors.push({ field: "targetSystem", message: "targetSystemが不正です" });
      } else {
        targetSystem = ts;
      }
    } else {
      errors.push({
        field: "targetSystem",
        message: "既存アプリの場合はtargetSystemが必須です",
      });
    }

    const tl = obj.targetLabel;
    if (typeof tl === "string" && tl.length > 0) {
      targetLabel = tl.slice(0, 100).trim();
    }
  } else {
    // new: repositoryName を targetSystem として保存する
    const ts = obj.targetSystem;
    if (typeof ts === "string" && ts.length > 0) {
      if (!isValidNewRepoName(ts)) {
        errors.push({
          field: "targetSystem",
          message: "リポジトリ名は小文字英数字とハイフンのみ（例：spm-clinic-pos）",
        });
      } else {
        targetSystem = ts;
      }
    } else {
      errors.push({
        field: "targetSystem",
        message: "新規アプリの場合はリポジトリ名が必須です",
      });
    }
    const tl = obj.targetLabel;
    if (typeof tl === "string" && tl.length > 0) {
      targetLabel = tl.slice(0, 100).trim();
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const skipRequirements = obj.skipRequirements === true;

  // businessCategory は任意。不正値・未指定はデフォルト（uncategorized）として扱い、エラーにしない。
  const businessCategory: BusinessCategoryId = isBusinessCategory(obj.businessCategory)
    ? obj.businessCategory
    : DEFAULT_BUSINESS_CATEGORY;

  return {
    ok: true,
    value: {
      title: (obj.title as string).trim(),
      description: description ? description.trim() : null,
      projectType,
      targetSystem,
      targetLabel,
      skipRequirements,
      businessCategory,
    },
  };
}
