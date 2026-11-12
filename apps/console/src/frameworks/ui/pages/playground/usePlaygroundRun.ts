/**
 * The playground's runs: sending one, streaming its events into a turn, stopping it, and the
 * history of this session. Pages read the state; the gateway is reached only through useApi().
 */
import { useRef, useState } from "react";
import { ApiError } from "../../../../entities/errors";
import type { PlaygroundBody, PlaygroundEndpoint } from "../../../../entities/models";
import { applyEvent, type Turn, type TurnError } from "../../../../entities/playground";
import { useApi } from "../../hooks/api";

export interface RunRequest {
  endpoint: PlaygroundEndpoint;
  stream: boolean;
  body: PlaygroundBody;
  /** shown in the history and the answer card */
  question: string;
  system?: string;
  tenant: string;
  settings: Turn["settings"];
}

/** what went wrong, in words for the user */
function errorOf(e: unknown): TurnError {
  if (e instanceof ApiError) return { code: e.code, message: e.message, details: e.details };
  if ((e as Error)?.name === "AbortError") return { code: "cancelled", message: "You stopped this run." };
  return { code: "network", message: "Couldn't reach the gateway. Check your connection and try again." };
}

export function usePlaygroundRun() {
  const api = useApi();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const busy = turns.some((turn) => turn.streaming);
  const current = turns.find((turn) => turn.id === selectedId) ?? turns[turns.length - 1];
  const updateTurn = (id: number, change: (turn: Turn) => Turn) =>
    setTurns((all) => all.map((turn) => (turn.id === id ? change(turn) : turn)));

  async function send(run: RunRequest) {
    const id = Date.now();
    const turn: Turn = {
      id,
      endpoint: run.endpoint,
      stream: run.stream,
      raw: "",
      system: run.system,
      question: run.question,
      tenant: run.tenant,
      answer: "",
      attempts: [],
      reasoning: [],
      trace: [],
      streaming: true,
      settings: run.settings,
    };
    setTurns((all) => [...all, turn]);
    setSelectedId(id);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await api.playground(
        run.endpoint,
        run.body,
        run.stream,
        {
          onEvent: (event) => updateTurn(id, (t) => applyEvent(t, event)),
          onRaw: (raw) => updateTurn(id, (t) => ({ ...t, raw })),
        },
        controller.signal,
      );
    } catch (e) {
      updateTurn(id, (t) => ({ ...t, error: errorOf(e) }));
    } finally {
      updateTurn(id, (t) => ({ ...t, streaming: false }));
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  /** stops a running request and clears the history */
  function reset() {
    stop();
    setTurns([]);
    setSelectedId(null);
  }

  return { turns, current, busy, send, stop, reset, select: setSelectedId };
}
