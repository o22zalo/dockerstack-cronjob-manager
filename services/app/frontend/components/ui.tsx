"use client";

import type { ReactNode } from "react";

export function StatusDot({ status }: { status?: string }) {
  const color =
    status === "ok" || status === "done" || status === "success"
      ? "bg-emerald-500 shadow-[0_0_4px_#10b98180]"
      : status === "failed" || status === "error"
        ? "bg-error shadow-[0_0_4px_rgba(186,26,26,0.5)]"
        : status === "processing" || status === "running" || status === "pending"
          ? "bg-primary animate-pulse"
          : "bg-outline-variant";
  return <span className={`w-2 h-2 rounded-full inline-block ${color}`} />;
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const map: Record<string, string> = {
    ok: "border-emerald-500/30 text-emerald-600 bg-emerald-500/5",
    done: "border-emerald-500/30 text-emerald-600 bg-emerald-500/5",
    success: "border-emerald-500/30 text-emerald-600 bg-emerald-500/5",
    running: "border-primary/30 text-primary bg-primary/5",
    processing: "border-primary/30 text-primary bg-primary/5",
    pending: "border-outline-variant/40 text-on-surface-variant",
    failed: "border-error/30 text-error bg-error/5",
    error: "border-error/30 text-error bg-error/5",
    disabled: "border-outline-variant/40 text-outline",
  };
  const cls = map[status] ?? "border-outline-variant/40 text-on-surface-variant";
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-label-caps uppercase border ${cls}`}
    >
      <StatusDot status={status} />
      {label ?? status}
    </span>
  );
}

export function Tag({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "prod" }) {
  const cls =
    tone === "prod"
      ? "bg-tertiary-container/10 text-tertiary-container border-tertiary-container/20"
      : "bg-surface-variant text-on-surface-variant border-outline-variant/30";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${cls}`}>
      {children}
    </span>
  );
}

export function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="relative inline-flex items-center cursor-pointer">
      <input
        type="checkbox"
        className="sr-only peer"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="w-7 h-4 bg-outline-variant/50 rounded-full peer peer-checked:bg-primary after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-full" />
    </label>
  );
}

export function Spinner() {
  return (
    <span className="material-symbols-outlined text-[16px] animate-spin-slow inline-block">
      progress_activity
    </span>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-surface-container-lowest border border-outline-variant/20 rounded-xl shadow-xl w-full max-w-sm">
        <div className="px-4 py-3 border-b border-outline-variant/20">
          <h3 className="text-h2 text-on-surface">{title}</h3>
        </div>
        <div className="p-4 space-y-4">
          <div className="text-body-sm text-on-surface-variant">{message}</div>
          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className="px-3 py-1.5 rounded-lg border border-outline-variant/30 text-body-sm">
              {cancelLabel}
            </button>
            <button onClick={onConfirm} className="px-4 py-1.5 rounded-lg bg-error text-on-error text-body-sm">
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
