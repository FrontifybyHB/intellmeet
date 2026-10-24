// Transcript + intelligence panel for the post-meeting lab.
//
// Presentational: the screen owns the fetching and hands the payloads down.

export function TranscriptPanel({
  transcript,
  intelligence,
}: {
  transcript: object | null;
  intelligence: object | null;
}) {
  return (
    <>
      {transcript && <pre>transcript: {JSON.stringify(transcript, null, 2).slice(0, 2000)}</pre>}
      {intelligence && (
        <pre>intelligence: {JSON.stringify(intelligence, null, 2).slice(0, 3000)}</pre>
      )}
    </>
  );
}
