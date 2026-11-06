import { useEffect, useState } from "react";
import { EMPTY_TRANSFERS, hasActiveTransfers } from "~/utils/transfer-state";
import { getTransferSnapshot, subscribeTransfers } from "~/utils/webtorrent.client";

export function useTransfers() {
  const [snapshot, setSnapshot] = useState(EMPTY_TRANSFERS);
  useEffect(() => {
    const update = () => setSnapshot(getTransferSnapshot());
    const unsubscribe = subscribeTransfers(update);
    update();
    return unsubscribe;
  }, []);
  return snapshot;
}

export default function TransferStatus() {
  const snapshot = useTransfers();
  const active = hasActiveTransfers(snapshot);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!active) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [active]);
  if (!active) return null;
  const parts = [
    snapshot.preparing ? "Preparing file" : "",
    snapshot.downloading ? `Downloading ${Math.floor(snapshot.progress * 100)}%` : "",
    snapshot.seeding ? `Seeding · ${snapshot.seeding} ${snapshot.seeding === 1 ? "file" : "files"}` : "",
  ].filter(Boolean);
  return (
    <div className={`transfer-status${paused ? " transfer-status--paused" : ""}`}>
      <div className="transfer-tape transfer-tape--top" aria-hidden="true" />
      <div className="transfer-tape transfer-tape--bottom" aria-hidden="true" />
      <div className="transfer-status-label">
        <span role="status" aria-live="polite">{parts.join(" · ")}</span>
        <span className="transfer-status-hint">Browse freely · keep this tab open</span>
        <button type="button" className="transfer-motion-toggle" onClick={() => setPaused(!paused)} aria-pressed={paused} title={paused ? "Resume animation (transfers keep running)" : "Pause animation (transfers keep running)"} aria-label={paused ? "Resume transfer animation" : "Pause transfer animation"}>
          <i className={`fas ${paused ? "fa-play" : "fa-pause"}`} aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
