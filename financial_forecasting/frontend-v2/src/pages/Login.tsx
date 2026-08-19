import { useSearchParams } from "react-router-dom";
import { LogIn } from "lucide-react";

import { startGoogleLogin } from "@/services/auth";

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "Sign-in was cancelled.",
  auth_failed: "Authentication failed. Please try again.",
  not_authenticated: "Please sign in to continue.",
};

export function LoginPage() {
  const [searchParams] = useSearchParams();
  const errorCode = searchParams.get("error");
  const errorMessage = errorCode
    ? ERROR_MESSAGES[errorCode] ?? `Sign-in error: ${errorCode}`
    : null;

  return (
    <div className="grid min-h-screen place-items-center bg-bg p-6">
      <div className="w-full max-w-[400px] rounded-lg border border-border-strong bg-surface p-7 shadow-lg">
        <div className="mb-6 flex items-center gap-2.5">
          <img
            src="/bedrock-logo.png"
            alt="Bedrock"
            className="h-11 w-11 flex-shrink-0 rounded-xl"
          />
          <div className="flex flex-col leading-tight">
            <span className="text-[18px] font-semibold tracking-tight">
              Bedrock
            </span>
            <span className="text-[11px] text-ink-3">Pursuit · Workspace</span>
          </div>
        </div>

        <h1 className="text-[22px] font-bold tracking-tight">Sign in</h1>
        <p className="mt-1 text-[13px] text-ink-3">
          Use your Pursuit Google account to continue.
        </p>

        {errorMessage ? (
          <div className="mt-4 rounded border border-red bg-red-soft px-3 py-2 text-[12.5px] text-red">
            {errorMessage}
          </div>
        ) : null}

        <button
          onClick={startGoogleLogin}
          className="mt-5 flex h-10 w-full items-center justify-center gap-2 rounded-md border border-ink bg-ink text-[14px] font-medium text-surface hover:opacity-90"
        >
          <LogIn size={16} />
          Sign in with Google
        </button>

        <p className="mt-4 text-center text-[11px] text-ink-4">
          Authorized Pursuit users only
        </p>
      </div>
    </div>
  );
}
