// Chat / presence panel for the contract lab.
//
// Presentational: the screen owns the socket and hands the traffic and the
// handlers down. The panel never connects on its own.

import type { ChatMessage, SocketState } from "@/dev/pages/meeting-lab/useMeetingSocket";

export function ChatPanel({
  socketState,
  messages,
  presence,
  chatText,
  onChatTextChange,
  onConnect,
  onJoinRoom,
  onSend,
  onRaiseHand,
  onReact,
}: {
  socketState: SocketState;
  messages: ChatMessage[];
  presence: string[];
  chatText: string;
  onChatTextChange: (value: string) => void;
  onConnect: () => void;
  onJoinRoom: () => void;
  onSend: () => void;
  onRaiseHand: () => void;
  onReact: () => void;
}) {
  return (
    <section>
      <p data-testid="socket-state">Socket: {socketState}</p>
      <button type="button" onClick={onConnect}>
        Socket connect
      </button>
      <button type="button" onClick={onJoinRoom}>
        Socket join
      </button>
      <input
        value={chatText}
        onChange={(event) => onChatTextChange(event.target.value)}
        placeholder="chat text"
      />
      <button type="button" onClick={onSend}>
        Send chat
      </button>
      <button type="button" onClick={onRaiseHand}>
        Raise hand
      </button>
      <button type="button" onClick={onReact}>
        👍
      </button>
      <ul>
        {messages.map((message) => (
          <li key={message.id}>{message.text}</li>
        ))}
      </ul>
      <p>Presence: {presence.join(", ")}</p>
    </section>
  );
}
