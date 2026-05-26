export type AgentType = "orchestrator" | "requirements" | "pm" | "qa";

export type MessageRole = "user" | "orchestrator" | "agent1" | "agent2" | "agent3";

export type ApprovalType = "security" | "db_schema" | "auth" | "external_api";

export type DocumentType = "requirements" | "sprint" | "test_report" | "summary";

export type ProjectStatus = "active" | "completed" | "archived";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface SecurityCheckResult {
  requiresApproval: boolean;
  type: ApprovalType | null;
  matchedKeywords: string[];
}

export interface ClaudeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequestBody {
  sessionId: string;
  projectId: string;
  message: string;
}

export interface SSEChunk {
  type:
    | "text"
    | "agent"
    | "agent_start"
    | "agent_complete"
    | "document"
    | "approval"
    | "execute_log"
    | "execute_done"
    | "phase_start"
    | "phase_complete"
    | "parallel_suggestion"
    | "parallel_part_status"
    | "parallel_part_log"
    | "done"
    | "error"
    | "warning";
  data: unknown;
}
