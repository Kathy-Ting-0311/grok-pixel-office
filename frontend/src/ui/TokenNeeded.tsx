import { useState } from 'react';
import { unlockStream } from '../api';
import { useStore } from '../store';
import { Modal } from './common';

/** Shown when the server refuses the office stream for a missing or wrong access token (never the simulation). */
export function TokenNeeded() {
  const connection = useStore((s) => s.connection);
  const [token, setToken] = useState('');
  const [tried, setTried] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (connection !== 'token-needed' || hidden) return null;
  return (
    <Modal title="Token needed" onClose={() => setHidden(true)}>
      <form
        className="space-y-2 text-xs"
        data-testid="token-needed"
        onSubmit={(e) => {
          e.preventDefault();
          if (!token.trim()) return;
          setTried(true);
          unlockStream(token.trim());
          setToken('');
        }}
      >
        <p>This server needs its access token (OFFICE_TOKEN in .env). Nothing is shown or simulated until then.</p>
        {tried && <p className="text-rose-700">That token was not accepted.</p>}
        <div className="flex gap-1">
          <input
            className="field min-w-0 flex-1"
            type="password"
            autoComplete="off"
            placeholder="Access token for this server"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            aria-label="Access token"
            data-testid="token-input"
          />
          <button className="btn" data-testid="token-unlock">
            Unlock
          </button>
        </div>
      </form>
    </Modal>
  );
}
