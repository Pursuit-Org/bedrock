/** Placeholder body for nav destinations whose page hasn't been built yet. */
export function ComingSoon({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-surface-2/40 px-6 py-16 text-center">
      <div className="text-[15px] font-semibold text-ink-2">{title}</div>
      {description ? <p className="mt-1 text-[13px] text-ink-3">{description}</p> : null}
    </div>
  );
}
