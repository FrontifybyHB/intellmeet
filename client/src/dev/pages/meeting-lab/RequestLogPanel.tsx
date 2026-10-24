// Presentational panel for the lab's request/error log.

import type { RequestLog } from "@/dev/pages/meeting-lab/requestLog";

export function RequestLogPanel({ log }: { log: RequestLog }) {
  return (
    <section>
      <h3>Requests / errors</h3>
      <ul>
        {log.map((entry, index) => (
          <li key={`${entry.at}-${index}`}>
            {entry.method} {entry.path} → {entry.status} {entry.message}
          </li>
        ))}
      </ul>
    </section>
  );
}
