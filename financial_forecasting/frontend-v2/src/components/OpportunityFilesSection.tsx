import { useRef, useState } from "react";
import { FileText, Loader2, Trash2, Upload } from "lucide-react";

import { fmtDate } from "@/lib/format";
import {
  fileDownloadUrl,
  useDeleteOpportunityFile,
  useOpportunityFiles,
  useUploadOpportunityFile,
} from "@/services/files";

const EXT_COLORS: Record<string, string> = {
  pdf: "bg-red-100 text-red-700",
  doc: "bg-blue-100 text-blue-700",
  docx: "bg-blue-100 text-blue-700",
  ppt: "bg-orange-100 text-orange-700",
  pptx: "bg-orange-100 text-orange-700",
  xls: "bg-green-100 text-green-700",
  xlsx: "bg-green-100 text-green-700",
};

function ExtBadge({ ext }: { ext: string | null }) {
  const label = (ext ?? "").toLowerCase();
  const colors = EXT_COLORS[label] ?? "bg-surface-2 text-ink-3";
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-none ${colors}`}
    >
      {label || "file"}
    </span>
  );
}

function uploadErrorMessage(err: unknown): string {
  if (!err) return "try again";
  const e = err as { response?: { data?: { detail?: string } }; message?: string };
  return e.response?.data?.detail ?? e.message ?? "try again";
}

/**
 * Upload button intended for use in a SectionCard `action` slot.
 * Keeps all upload state co-located with the file list below.
 */
export function OpportunityFilesUploadAction({ opportunityId }: { opportunityId: string }) {
  const upload = useUploadOpportunityFile(opportunityId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingName, setPendingName] = useState<string | null>(null);

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      setPendingName(files.length > 1 ? `${file.name} (${i + 1}/${files.length})` : file.name);
      try {
        await upload.mutateAsync({ file });
      } catch {
        // individual failure surfaced via upload.isError; continue with remaining files
      }
    }
    setPendingName(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="flex items-center gap-2">
      {upload.isError ? (
        <span className="text-[11px] text-red-600" title={uploadErrorMessage(upload.error)}>
          Upload failed
        </span>
      ) : null}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={upload.isPending}
        className="inline-flex items-center gap-1 rounded border border-border-strong bg-surface px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-50"
      >
        {upload.isPending ? (
          <>
            <Loader2 size={11} className="animate-spin" />
            {pendingName ? `Uploading ${pendingName}` : "Uploading…"}
          </>
        ) : (
          <>
            <Upload size={11} aria-hidden="true" /> Upload file
          </>
        )}
      </button>
    </div>
  );
}

/**
 * Files table for an Opportunity record. Shows all SF Files linked via
 * ContentDocumentLink with delete. Upload action lives in the SectionCard header.
 * Designed to render inside a SectionCard — no card wrapper of its own.
 */
export function OpportunityFilesSection({ opportunityId }: { opportunityId: string }) {
  const filesQ = useOpportunityFiles(opportunityId);
  const deleteFile = useDeleteOpportunityFile(opportunityId);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const files = filesQ.data ?? [];

  const handleDelete = async (contentDocumentId: string, title: string | null) => {
    if (!window.confirm(`Remove "${title ?? "this file"}" from this record? The file itself stays in Salesforce.`)) return;
    setDeletingId(contentDocumentId);
    try {
      await deleteFile.mutateAsync(contentDocumentId);
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="flex flex-col">
      {/* File table */}
      {filesQ.isLoading ? (
        <div className="px-4 py-6 text-center text-[12px] text-ink-3">
          <Loader2 size={13} className="mr-1 inline animate-spin" /> Loading files…
        </div>
      ) : files.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px] italic text-ink-3">
          No files attached to this opportunity.
        </div>
      ) : (
        <table className="w-full border-collapse text-[12.5px]">
          <thead className="bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3">
            <tr>
              <th className="px-4 py-1.5 text-left font-semibold">Type</th>
              <th className="px-4 py-1.5 text-left font-semibold">Name</th>
              <th className="px-4 py-1.5 text-left font-semibold">Added by</th>
              <th className="px-4 py-1.5 text-left font-semibold">Date added</th>
              <th className="px-4 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const url = fileDownloadUrl(f.latest_version_id);
              const isDeleting = deletingId === f.content_document_id;
              return (
                <tr
                  key={f.content_document_id}
                  className="border-t border-border-strong hover:bg-surface-2/40"
                >
                  <td className="px-4 py-2.5">
                    <ExtBadge ext={f.extension} />
                  </td>
                  <td className="px-4 py-2.5">
                    {url ? (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="flex items-center gap-1.5 font-medium text-ink hover:underline"
                        title={`${f.title ?? ""}${f.extension ? `.${f.extension}` : ""}`}
                      >
                        <FileText size={13} className="flex-shrink-0 text-ink-3" />
                        <span className="truncate">
                          {f.title ?? "(no title)"}
                          {f.extension ? `.${f.extension}` : ""}
                        </span>
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-ink">
                        <FileText size={13} className="flex-shrink-0 text-ink-3" />
                        {f.title ?? "(no title)"}
                        {f.extension ? `.${f.extension}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink-3">{f.created_by ?? "—"}</td>
                  <td className="mono px-4 py-2.5 text-ink-3">{fmtDate(f.created_date)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => void handleDelete(f.content_document_id, f.title)}
                      disabled={isDeleting}
                      className="rounded p-1 text-ink-4 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                      title="Delete file"
                    >
                      {isDeleting ? (
                        <Loader2 size={13} className="animate-spin" />
                      ) : (
                        <Trash2 size={13} />
                      )}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
