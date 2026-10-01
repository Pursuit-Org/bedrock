/** Confirmation gate for deprioritizing an account.
 *
 *  Shared because deprioritize has two entry points — the fundraising account
 *  detail page and the jobs account detail page — and both trigger the same
 *  backend side effect (a 6-month reminder task). The jobs-side button had no
 *  confirmation at all, so the same irreversible-feeling action behaved
 *  differently depending on which page you happened to be on.
 */
export function ConfirmDeprioritizeDialog({
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
    >
      <div className="w-full max-w-md rounded-lg border border-border-strong bg-surface shadow-2xl">
        <div className="px-5 py-4 text-[13px] text-ink-2">
          <p>
            Are you sure you want to Deprioritize this account? Proceeding will update the account
            status to <strong>'Deprioritized'</strong> and a task will be set with a due date in 6
            months for the account owner to re-evaluate if this stage still accurately reflects the
            relationship.
          </p>
          {error ? (
            <p className="mt-3 rounded border border-red/40 bg-red-soft px-3 py-2 text-[12.5px] text-red">
              {error}
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border-strong px-5 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-surface-2 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="rounded border border-border-strong bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink-2 transition-colors hover:border-red/40 hover:bg-red-soft hover:text-red disabled:opacity-60"
          >
            {busy ? "Deprioritizing…" : "Deprioritize"}
          </button>
        </div>
      </div>
    </div>
  );
}
