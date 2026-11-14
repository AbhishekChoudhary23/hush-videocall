import { useState } from "react";
import { ArrowRight, EyeOff, KeyRound, Plus, ShieldCheck } from "lucide-react";
import { parseCode } from "../lib/crypto";

export default function Home({ ended, onRejoin, onCreate, onJoin }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");

  const submit = (e) => {
    e.preventDefault();
    const code = parseCode(value);
    if (!code) {
      setError("That doesn't look like a valid invite. Paste the full link or the 20-character code.");
      return;
    }
    onJoin(code);
  };

  return (
    <div className="center-page">
      <main className="home">
        <div className="brand">
          <span className="brand-dot" />
          Hush
        </div>

        {ended ? (
          <>
            <h1>You left the call</h1>
            <p className="lede">Nothing from the call was kept. The chat is gone unless you saved it.</p>
          </>
        ) : (
          <>
            <h1>Private calls, no account.</h1>
            <p className="lede">Start a call, share the invite, talk. Nothing is stored anywhere.</p>
          </>
        )}

        <div className="home-actions">
          {ended && onRejoin && (
            <button className="btn btn-primary btn-lg" onClick={onRejoin}>
              Rejoin call <ArrowRight size={18} />
            </button>
          )}
          <button className={`btn btn-lg ${ended && onRejoin ? "btn-ghost" : "btn-primary"}`} onClick={onCreate}>
            <Plus size={18} /> New call
          </button>
        </div>

        <div className="divider">or join one</div>

        <form className="join-form" onSubmit={submit} noValidate>
          <input
            className="input mono"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError("");
            }}
            placeholder="Paste invite link or code"
            aria-label="Invite link or code"
            aria-invalid={!!error}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
          />
          <button className="btn btn-ghost" type="submit" disabled={!value.trim()}>
            Join
          </button>
        </form>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <ul className="assurances">
          <li>
            <ShieldCheck size={16} /> End-to-end encrypted
          </li>
          <li>
            <KeyRound size={16} /> The invite code is the key
          </li>
          <li>
            <EyeOff size={16} /> No sign-up, no history
          </li>
        </ul>
      </main>
    </div>
  );
}
