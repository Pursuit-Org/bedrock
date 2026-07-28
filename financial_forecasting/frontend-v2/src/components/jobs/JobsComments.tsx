import { useState } from "react";
import { Loader2, MoreHorizontal, Send } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import { cn } from "@/lib/utils";
import { initials } from "@/lib/format";
import { useCurrentUser } from "@/services/auth";
import { useStaffNameResolver } from "@/services/jobs";
import {
  useCreateJobsComment,
  useDeleteJobsComment,
  useJobsComments,
  useUpdateJobsComment,
  type JobsComment,
  type JobsCommentParentType,
} from "@/services/jobsComments";

const AVATAR_COLORS = [
  "bg-blue-400",
  "bg-purple-400",
  "bg-green-400",
  "bg-amber-400",
  "bg-rose-400",
  "bg-cyan-400",
] as const;

function avatarColor(name: string): string {
  return AVATAR_COLORS[(name.charCodeAt(0) ?? 0) % AVATAR_COLORS.length];
}

interface JobsCommentsProps {
  parentType: JobsCommentParentType;
  parentId: string;
}

/** Comment thread + composer for a jobs opportunity or prospect. Backed by
 *  /api/jobs/jobs-comments. Edit/delete shown only for the author. */
export function JobsComments({ parentType, parentId }: JobsCommentsProps) {
  const { data: comments = [], isLoading } = useJobsComments(parentType, parentId);
  const createComment = useCreateJobsComment(parentType, parentId);

  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-4">
        Comments {comments.length > 0 ? `(${comments.length})` : null}
      </p>

      {isLoading ? (
        <div className="flex items-center gap-2 py-3 text-[12px] text-ink-3">
          <Loader2 size={12} className="animate-spin" />
          Loading…
        </div>
      ) : comments.length === 0 ? (
        <p className="mb-3 text-[12px] text-ink-4">No comments yet.</p>
      ) : (
        <ul className="mb-3 space-y-3">
          {comments.map((c) => (
            <CommentItem key={c.id} comment={c} parentType={parentType} parentId={parentId} />
          ))}
        </ul>
      )}

      <CommentComposer
        onSubmit={async (content) => {
          await createComment.mutateAsync(content);
        }}
        submitting={createComment.isPending}
      />
    </div>
  );
}

interface CommentComposerProps {
  initial?: string;
  onSubmit: (content: string) => Promise<void>;
  onCancel?: () => void;
  submitting?: boolean;
  placeholder?: string;
  compact?: boolean;
}

/** Textarea + send button. Cmd/Ctrl+Enter submits. */
function CommentComposer({
  initial = "",
  onSubmit,
  onCancel,
  submitting,
  placeholder = "Add a comment…",
  compact,
}: CommentComposerProps) {
  const [value, setValue] = useState(initial);

  async function commit() {
    const trimmed = value.trim();
    if (!trimmed || submitting) return;
    try {
      await onSubmit(trimmed);
      setValue("");
    } catch {
      // Mutation hook already toasted; keep text so the user can retry.
    }
  }

  return (
    <div className="relative">
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            void commit();
          }
          if (e.key === "Escape" && onCancel) onCancel();
        }}
        rows={compact ? 2 : 3}
        placeholder={placeholder}
        className="w-full resize-none rounded border border-border-strong bg-surface px-2 py-1.5 text-[12.5px] text-ink outline-none placeholder:text-ink-4 focus:border-accent"
      />
      <div className="mt-1 flex items-center justify-between text-[10.5px] text-ink-4">
        <span>Cmd/Ctrl+Enter to {onCancel ? "save" : "send"}</span>
        <div className="flex items-center gap-1.5">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="rounded px-2 py-0.5 text-ink-3 hover:bg-surface-2 hover:text-ink"
            >
              Cancel
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void commit()}
            disabled={!value.trim() || submitting}
            className="inline-flex items-center gap-1 rounded bg-ink px-2 py-0.5 text-[11px] font-medium text-surface hover:opacity-90 disabled:opacity-40"
          >
            {submitting ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
            {onCancel ? "Save" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Single comment row with author header, body, and hover-revealed
 *  edit/delete for the author. */
function CommentItem({
  comment,
  parentType,
  parentId,
}: {
  comment: JobsComment;
  parentType: JobsCommentParentType;
  parentId: string;
}) {
  const { data: me } = useCurrentUser();
  const nameOf = useStaffNameResolver();
  const updateComment = useUpdateJobsComment(parentType, parentId);
  const deleteComment = useDeleteJobsComment(parentType, parentId);
  const [editing, setEditing] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);

  const isAuthor =
    !!comment.author_email && !!me?.email && comment.author_email === me.email;
  // Resolve the author's email to a full display name (e.g. "Kwame Assoku"),
  // falling back to a title-cased email local-part when staff lookup misses.
  const name = nameOf(comment.author_email);
  const when = comment.created_at
    ? formatDistanceToNow(new Date(comment.created_at), { addSuffix: true })
    : "";
  const edited =
    !!comment.updated_at &&
    !!comment.created_at &&
    comment.updated_at !== comment.created_at;

  if (editing) {
    return (
      <li className="rounded border border-border bg-surface-2/40 p-2">
        <CommentComposer
          initial={comment.content}
          compact
          onSubmit={async (content) => {
            await updateComment.mutateAsync({ commentId: comment.id, content });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
          submitting={updateComment.isPending}
        />
      </li>
    );
  }

  return (
    <li className="group/comment flex gap-2">
      <span
        className={cn(
          "mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white",
          avatarColor(name),
        )}
        title={name}
      >
        {initials(name)}
      </span>
      <div className="min-w-0 flex-1 rounded border border-border bg-surface px-2.5 py-1.5">
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="font-semibold text-ink">{name}</span>
          <span className="text-ink-4">·</span>
          <span className="text-ink-3">{when}</span>
          {edited ? <span className="text-ink-4">(edited)</span> : null}
          {isAuthor ? (
            <div className="relative ml-auto">
              <button
                type="button"
                onClick={() => setActionsOpen((o) => !o)}
                className="flex h-5 w-5 items-center justify-center rounded text-ink-4 opacity-0 group-hover/comment:opacity-100 hover:bg-surface-2 hover:text-ink"
                aria-label="Comment actions"
              >
                <MoreHorizontal size={12} />
              </button>
              {actionsOpen ? (
                <div className="absolute right-0 top-full z-50 mt-1 min-w-[120px] rounded-md border border-border-strong bg-surface shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(true);
                      setActionsOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] hover:bg-surface-2"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm("Delete this comment?")) {
                        deleteComment.mutate(comment.id);
                      }
                      setActionsOpen(false);
                    }}
                    className="block w-full px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-surface-2"
                  >
                    Delete
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-snug text-ink-2">
          {comment.content}
        </p>
      </div>
    </li>
  );
}
