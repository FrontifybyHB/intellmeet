// Consent + host-action panel for the contract lab.
//
// The panel is presentational: the screen performs the contract calls and
// passes the handler down, so the lab keeps one place that talks HTTP.

export type HostAction = "consent" | "start" | "stop" | "end" | "intelligence";

export function ConsentPanel({
  aiStatus,
  onHostAction,
}: {
  aiStatus: object | null;
  onHostAction: (action: HostAction) => void;
}) {
  return (
    <section>
      <button type="button" onClick={() => onHostAction("consent")}>
        Consent approve
      </button>
      <button type="button" onClick={() => onHostAction("start")}>
        Recording start
      </button>
      <button type="button" onClick={() => onHostAction("end")}>
        End meeting
      </button>
      <button type="button" onClick={() => onHostAction("intelligence")}>
        Refresh intelligence
      </button>
      {aiStatus && (
        <pre data-testid="ai-status">{JSON.stringify(aiStatus, null, 2).slice(0, 2000)}</pre>
      )}
    </section>
  );
}
