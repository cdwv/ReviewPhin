import type {
  MergeRequestSnapshotRecord,
  InteractionJobRecord,
  TenantRecord,
} from "../storage/contract/index.js";
import type { ProjectMemoryContext } from "../memory/types.js";

export interface GitLabUser {
  id: number;
  username: string;
  name: string;
  web_url?: string | undefined;
}

export interface GitLabDiffRefs {
  base_sha: string;
  start_sha: string;
  head_sha: string;
}

export interface GitLabMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: GitLabUser;
  diff_refs?: GitLabDiffRefs | undefined;
}

export interface GitLabMergeRequestVersion {
  id: number;
  base_commit_sha: string;
  start_commit_sha: string;
  head_commit_sha: string;
  created_at: string;
}

export interface GitLabMergeRequestChange {
  old_path: string;
  new_path: string;
  diff?: string;
  new_file: boolean;
  renamed_file: boolean;
  deleted_file: boolean;
}

export interface GitLabDiffPosition {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  position_type: "text";
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
}

export interface GitLabNote {
  id: number;
  body: string;
  author: GitLabUser;
  created_at: string;
  updated_at: string;
  system: boolean;
  resolvable?: boolean | undefined;
  resolved?: boolean | undefined;
  type?: string | null | undefined;
  position?: GitLabDiffPosition | null | undefined;
}

export interface GitLabAwardEmoji {
  id: number;
  name: string;
  user: GitLabUser;
  created_at: string;
}

export type TriggerNoteReference =
  | {
      kind: "merge-request-note";
      noteId: number;
    }
  | {
      kind: "discussion-note";
      discussionId: string;
      noteId: number;
    };

export interface GitLabDiscussion {
  id: string;
  individual_note: boolean;
  notes: GitLabNote[];
}

export interface GitLabRepositoryTreeItem {
  id: string;
  name: string;
  type: "tree" | "blob";
  path: string;
  mode: string;
}

export interface GitLabProject {
  id: number;
  web_url: string;
  path_with_namespace: string;
  http_url_to_repo: string;
}

export interface GitLabWikiPage {
  content?: string | undefined;
  format: string;
  slug: string;
  title: string;
  encoding?: string | undefined;
}

export interface GitLabNoteHookPayload {
  object_kind: "note";
  event_type?: string | undefined;
  project: {
    id: number;
    web_url?: string | undefined;
  };
  repository?:
    | {
        homepage?: string | undefined;
      }
    | undefined;
  merge_request: {
    iid: number;
    title: string;
    description: string;
    source_branch: string;
    target_branch: string;
    last_commit?:
      | {
          id: string;
        }
      | undefined;
    diff_refs?: GitLabDiffRefs | undefined;
  };
  object_attributes: {
    id: number;
    note: string;
    noteable_type: "MergeRequest";
    action?: "create" | "update" | undefined;
    draft?: boolean | undefined;
    author_id?: number | undefined;
    noteable_id?: number | null | undefined;
    system?: boolean | undefined;
    internal?: boolean | undefined;
    created_at?: string | undefined;
    updated_at?: string | undefined;
    url?: string | undefined;
  };
  user?: GitLabUser | undefined;
}

export interface InstructionFile {
  path: string;
  content: string;
}

export interface MaterializedWorkspace {
  rootPath: string;
  cleanupRoot: string;
  strategy: "git" | "archive" | "targeted-files";
  instructionFiles: InstructionFile[];
}

export interface MaterializedMergeRequestContext {
  tenant: TenantRecord;
  job: InteractionJobRecord;
  mergeRequest: GitLabMergeRequest;
  changes: GitLabMergeRequestChange[];
  notes: GitLabNote[];
  discussions: GitLabDiscussion[];
  workspace: MaterializedWorkspace;
  projectMemory: ProjectMemoryContext;
}

export interface HydratedMergeRequestContext extends MaterializedMergeRequestContext {
  versions: GitLabMergeRequestVersion[];
  latestVersion: GitLabMergeRequestVersion | null;
  snapshot: MergeRequestSnapshotRecord;
}

export type LightweightMergeRequestContext = MaterializedMergeRequestContext;
