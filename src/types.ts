/** The Gitea API objects the proxy reads, trimmed to the fields it uses. */

export interface GUser {
  id: number;
  login: string;
  full_name?: string;
  email?: string;
  avatar_url?: string;
  html_url?: string;
  is_admin?: boolean;
}

export interface GLabel {
  id: number;
  name: string;
  color: string;
  description?: string;
  url?: string;
}

export interface GRepo {
  id: number;
  name: string;
  full_name: string;
  owner: GUser;
  description?: string;
  private: boolean;
  fork: boolean;
  archived?: boolean;
  parent?: GRepo | null;
  html_url: string;
  clone_url: string;
  ssh_url?: string;
  default_branch: string;
  has_issues?: boolean;
  has_pull_requests?: boolean;
  created_at?: string;
  updated_at?: string;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

export interface GIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: GUser;
  labels: GLabel[];
  assignees: GUser[] | null;
  comments: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
  repository?: { id: number; name: string; owner: string; full_name: string };
  pull_request?: { merged: boolean; merged_at: string | null; draft?: boolean; html_url?: string } | null;
}

export interface GBranchRef {
  label: string;
  ref: string;
  sha: string;
  repo_id: number;
  repo?: GRepo | null;
}

export interface GPull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  draft: boolean;
  user: GUser;
  labels: GLabel[];
  assignees: GUser[] | null;
  requested_reviewers: GUser[] | null;
  mergeable: boolean;
  merged: boolean;
  merged_at: string | null;
  merged_by: GUser | null;
  merge_commit_sha: string | null;
  merge_base?: string;
  base: GBranchRef;
  head: GBranchRef;
  comments: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  html_url: string;
  url: string;
  diff_url: string;
}

export interface GComment {
  id: number;
  body: string;
  user: GUser;
  created_at: string;
  updated_at: string;
  html_url: string;
  issue_url?: string;
  pull_request_url?: string;
}

export interface GReview {
  id: number;
  body: string;
  user: GUser;
  state: "APPROVED" | "PENDING" | "COMMENT" | "REQUEST_CHANGES" | "REQUEST_REVIEW" | "";
  stale?: boolean;
  dismissed?: boolean;
  official?: boolean;
  commit_id: string;
  comments_count: number;
  submitted_at: string;
  updated_at?: string;
  html_url: string;
}

export interface GReviewComment {
  id: number;
  body: string;
  user: GUser;
  path: string;
  diff_hunk?: string;
  position: number;
  original_position: number;
  commit_id: string;
  original_commit_id: string;
  pull_request_review_id: number;
  created_at: string;
  updated_at: string;
  html_url: string;
  resolver?: GUser | null;
}

export interface GReaction {
  user: GUser;
  content: string;
  created_at: string;
}

export interface GStatus {
  id: number;
  context: string;
  status: "pending" | "success" | "error" | "failure" | "warning";
  description?: string;
  target_url: string;
  created_at: string;
  updated_at: string;
}

export interface GCombinedStatus {
  state: string;
  sha: string;
  total_count: number;
  statuses: GStatus[] | null;
}

export interface GCommit {
  sha: string;
  html_url?: string;
  commit: {
    message: string;
    author: { name: string; email: string; date: string };
    committer: { name: string; email: string; date: string };
  };
  author: GUser | null;
  committer: GUser | null;
  parents?: { sha: string }[];
  created?: string;
}

export interface GRelease {
  id: number;
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  created_at: string;
  published_at: string;
  html_url: string;
  tarball_url?: string;
  zipball_url?: string;
  target_commitish?: string;
  author: GUser;
  assets?: unknown[];
}

export interface GNotification {
  id: number;
  unread: boolean;
  pinned: boolean;
  updated_at: string;
  url: string;
  repository: GRepo;
  subject: {
    title: string;
    url: string;
    latest_comment_url: string;
    html_url: string;
    latest_comment_html_url?: string;
    type: "Issue" | "Pull" | "Commit" | "Repository";
    state: string;
  };
}

export interface GTimelineEvent {
  id: number;
  type: string;
  body?: string;
  user: GUser;
  created_at: string;
  label?: GLabel | null;
  assignee?: GUser | null;
  removed_assignee?: boolean;
}

export interface GActionRun {
  id: number;
  run_number?: number;
  display_title?: string;
  head_sha: string;
  head_branch?: string;
  status: string;
  conclusion?: string;
  html_url: string;
  event?: string;
}

export interface GActionJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion?: string;
  head_sha: string;
  html_url: string;
  started_at?: string;
  completed_at?: string;
}
